#include "executor_harness.h"

#include <chrono>
#include <csignal>
#include <csetjmp>
#include <dlfcn.h>
#include <iostream>
#include <sstream>

#include <google/protobuf/descriptor.h>
#include <google/protobuf/dynamic_message.h>
#include <google/protobuf/message.h>

#include "task/executor/executor.hpp"
#include "core/class_factory.hpp"
#include "common/facilities.h"

using namespace neolix::nexis;

namespace harness {

static sigjmp_buf s_jumpBuf;
static volatile sig_atomic_t s_inProcess = 0;

static void segvHandler(int sig) {
    if (s_inProcess) {
        siglongjmp(s_jumpBuf, sig);
    }
    std::_Exit(128 + sig);
}

static std::string statusToString(task::ExecutorStatus s) {
    switch (s) {
        case task::ExecutorStatus::kUninited: return "kUninited";
        case task::ExecutorStatus::kReady: return "kReady";
        case task::ExecutorStatus::kProcessOk: return "kProcessOk";
        case task::ExecutorStatus::kSuspend: return "kSuspend";
        case task::ExecutorStatus::kTimeOut: return "kTimeOut";
        case task::ExecutorStatus::kResetFail: return "kResetFail";
        case task::ExecutorStatus::kInvalidInput: return "kInvalidInput";
        case task::ExecutorStatus::kInvalidOutput: return "kInvalidOutput";
        case task::ExecutorStatus::kProcessFailed: return "kProcessFailed";
        case task::ExecutorStatus::kUnknownError: return "kUnknownError";
        default: return "status_" + std::to_string(static_cast<int>(s));
    }
}

ExecutorHarness::ExecutorHarness() {
    struct sigaction sa{};
    sa.sa_handler = segvHandler;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0;
    sigaction(SIGSEGV, &sa, nullptr);
    sigaction(SIGABRT, &sa, nullptr);
}

ExecutorHarness::~ExecutorHarness() {
    unload();
}

bool ExecutorHarness::loadModule(const HarnessConfig& config, std::string& errorOut) {
    unload();

    void* protoLib = dlopen("libcommon_message.so", RTLD_NOW | RTLD_GLOBAL);
    if (protoLib) {
        std::cerr << "[Harness] Loaded libcommon_message.so (proto descriptors)" << std::endl;
    } else {
        std::cerr << "[Harness] Warning: libcommon_message.so not found, proto deserialization may fail" << std::endl;
    }

    _soHandle = dlopen(config.soPath.c_str(), RTLD_LAZY | RTLD_GLOBAL);
    if (!_soHandle) {
        errorOut = std::string("dlopen failed: ") + dlerror();
        return false;
    }

    try {
        using CreateFnPtr = task::IExecutor*(*)(void);
        auto createFn = FeatureClassFactory.createcb<CreateFnPtr>(config.executorClass);
        if (!createFn) {
            errorOut = "FeatureClassFactory: no factory for class: " + config.executorClass;
            dlclose(_soHandle);
            _soHandle = nullptr;
            return false;
        }
        auto* executor = createFn();
        if (!executor) {
            errorOut = "Factory returned null for class: " + config.executorClass;
            dlclose(_soHandle);
            _soHandle = nullptr;
            return false;
        }
        _executor = executor;
        _outputDataNames = config.outputDataNames;

        auto status = executor->initial(config.configPaths);
        if (status != task::ExecutorStatus::kReady) {
            errorOut = "initial() returned " + statusToString(status) + ": " + executor->error();
            executor->release();
            delete executor;
            _executor = nullptr;
            dlclose(_soHandle);
            _soHandle = nullptr;
            return false;
        }

        _initialized = true;
        return true;
    } catch (const std::exception& e) {
        errorOut = std::string("Exception during load: ") + e.what();
        if (_soHandle) { dlclose(_soHandle); _soHandle = nullptr; }
        return false;
    }
}

FrameResult ExecutorHarness::processFrame(const std::vector<FrameInput>& inputs) {
    FrameResult result;
    result.timestampNs = inputs.empty() ? 0 : inputs[0].timestampNs;

    if (!_executor || !_initialized) {
        result.statusCode = -1;
        result.statusName = "not_initialized";
        result.errorMsg = "Executor not loaded or initialized";
        result.processTimeMs = 0;
        return result;
    }

    auto* executor = static_cast<task::IExecutor*>(_executor);

    std::vector<std::unique_ptr<google::protobuf::Message>> deserializedMsgs;
    task::IExecutor::InputDataType inputMap;
    bool firstInput = true;
    int totalInputs = 0, emptyData = 0, noProtoType = 0, noDescriptor = 0, parseFailed = 0, succeeded = 0;
    static int frameCount = 0;
    frameCount++;

    for (const auto& fi : inputs) {
        totalInputs++;
        if (frameCount <= 2) {
            std::cerr << "[Frame" << frameCount << "] input: " << fi.dataName
                      << " type=" << (fi.protoType.empty() ? "(empty)" : fi.protoType)
                      << " data=" << fi.protoData.size() << "B" << std::endl;
        }
        if (fi.protoData.empty()) { emptyData++; continue; }
        if (fi.protoType.empty()) { noProtoType++; continue; }

        ID dataId = NXFacility.generator(fi.dataName);
        if (ID_IS_INVALID(dataId)) { continue; }

        const google::protobuf::Message* msgPtr = nullptr;
        auto* pool = google::protobuf::DescriptorPool::generated_pool();
        auto* desc = pool->FindMessageTypeByName(fi.protoType);
        if (!desc) { noDescriptor++; continue; }

        auto* factory = google::protobuf::MessageFactory::generated_factory();
        auto* prototype = factory->GetPrototype(desc);
        if (!prototype) { noDescriptor++; continue; }

        auto msg = std::unique_ptr<google::protobuf::Message>(prototype->New());
        if (!msg->ParseFromArray(fi.protoData.data(), static_cast<int>(fi.protoData.size()))) {
            parseFailed++;
            std::cerr << "[Harness] ParseFromArray failed: " << fi.dataName
                      << " (" << fi.protoType << ", " << fi.protoData.size() << "B)" << std::endl;
            continue;
        }

        msgPtr = msg.get();
        deserializedMsgs.push_back(std::move(msg));
        succeeded++;

        task::IExecutor::InputData id;
        id.name = fi.dataName;
        id.timestamp_ns = fi.timestampNs;
        id.trigger = firstInput;
        id.data = msgPtr;
        inputMap.emplace(dataId, std::move(id));
        firstInput = false;
    }

    if (frameCount <= 2) {
        std::cerr << "[Frame" << frameCount << "] DESER: total=" << totalInputs
                  << " ok=" << succeeded << " empty=" << emptyData
                  << " no_type=" << noProtoType << " no_desc=" << noDescriptor
                  << " parse_fail=" << parseFailed
                  << " inputMap=" << inputMap.size() << std::endl;
    }

    result.outputJson["_deser"] = Json::Value(Json::objectValue);
    result.outputJson["_deser"]["total"] = totalInputs;
    result.outputJson["_deser"]["ok"] = succeeded;
    result.outputJson["_deser"]["empty"] = emptyData;
    result.outputJson["_deser"]["no_type"] = noProtoType;
    result.outputJson["_deser"]["no_desc"] = noDescriptor;
    result.outputJson["_deser"]["parse_fail"] = parseFailed;

    if (inputMap.empty()) {
        result.statusCode = 0;
        result.statusName = "kSkipped";
        result.errorMsg = "No valid inputs (total=" + std::to_string(totalInputs)
            + " empty=" + std::to_string(emptyData)
            + " no_type=" + std::to_string(noProtoType)
            + " no_desc=" + std::to_string(noDescriptor)
            + " parse_fail=" + std::to_string(parseFailed) + ")";
        result.processTimeMs = 0;
        return result;
    }

    task::IExecutor::OutputDataType outputMap;
    std::vector<std::vector<uint8_t>> outputBuffers;

    if (_outputDataNames.empty()) {
        _outputDataNames.push_back("output");
    }
    for (const auto& oname : _outputDataNames) {
        outputBuffers.emplace_back(256 * 1024, 0);
        task::IExecutor::OutputData od;
        od.name = oname;
        od.data = outputBuffers.back().data();
        ID oid = NXFacility.generator(oname);
        outputMap.emplace(oid, std::move(od));
    }

    auto t0 = std::chrono::high_resolution_clock::now();

    s_inProcess = 1;
    if (sigsetjmp(s_jumpBuf, 1) != 0) {
        s_inProcess = 0;
        auto t1 = std::chrono::high_resolution_clock::now();
        result.statusCode = -3;
        result.statusName = "SIGSEGV";
        result.errorMsg = "process() crashed (signal caught)";
        result.processTimeMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
        return result;
    }

    try {
        auto status = executor->process(inputMap, outputMap);
        s_inProcess = 0;
        auto t1 = std::chrono::high_resolution_clock::now();

        result.statusCode = static_cast<int>(status);
        result.statusName = statusToString(status);
        result.processTimeMs = std::chrono::duration<double, std::milli>(t1 - t0).count();

        if (status != task::ExecutorStatus::kProcessOk) {
            result.errorMsg = executor->error();
        }

        result.outputJson = Json::Value(Json::objectValue);
        for (auto& [key, od] : outputMap) {
            Json::Value outEntry;
            outEntry["name"] = od.name;
            outEntry["timestamp_ns"] = Json::Value::UInt64(od.timestamp_ns);
            outEntry["has_data"] = (od.data != nullptr);
            result.outputJson[od.name] = outEntry;
        }

    } catch (const std::exception& e) {
        s_inProcess = 0;
        auto t1 = std::chrono::high_resolution_clock::now();
        result.statusCode = -2;
        result.statusName = "exception";
        result.errorMsg = e.what();
        result.processTimeMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
    }

    return result;
}

void ExecutorHarness::reset() {
    if (_executor && _initialized) {
        auto* executor = static_cast<task::IExecutor*>(_executor);
        executor->reset();
    }
}

void ExecutorHarness::unload() {
    if (_executor) {
        auto* executor = static_cast<task::IExecutor*>(_executor);
        if (_initialized) {
            executor->release();
        }
        delete executor;
        _executor = nullptr;
    }
    _initialized = false;
    _outputDataNames.clear();
    if (_soHandle) {
        dlclose(_soHandle);
        _soHandle = nullptr;
    }
}

} // namespace harness
