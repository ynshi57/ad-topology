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
#include "common/facilities_inl.hpp"

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
        InputMetric im;
        im.name = fi.dataName;
        im.protoType = fi.protoType;
        im.timestampNs = fi.timestampNs;
        im.dataSize = fi.protoData.size();

        if (frameCount <= 2) {
            std::cerr << "[Frame" << frameCount << "] input: " << fi.dataName
                      << " type=" << (fi.protoType.empty() ? "(empty)" : fi.protoType)
                      << " data=" << fi.protoData.size() << "B" << std::endl;
        }
        if (fi.protoData.empty()) { emptyData++; im.skipReason = "empty_data"; result.inputMetrics.push_back(std::move(im)); continue; }
        if (fi.protoType.empty()) { noProtoType++; im.skipReason = "no_proto_type"; result.inputMetrics.push_back(std::move(im)); continue; }

        cmn::FacilityInl<cmn::Data>::Instance().push(fi.dataName);
        ID dataId = NXFacility.idata(fi.dataName);
        im.idValid = !ID_IS_INVALID(dataId);
        if (ID_IS_INVALID(dataId)) { im.skipReason = "invalid_id"; result.inputMetrics.push_back(std::move(im)); continue; }

        const google::protobuf::Message* msgPtr = nullptr;
        auto* pool = google::protobuf::DescriptorPool::generated_pool();
        auto* desc = pool->FindMessageTypeByName(fi.protoType);
        if (!desc) { noDescriptor++; im.skipReason = "no_descriptor"; result.inputMetrics.push_back(std::move(im)); continue; }

        auto* factory = google::protobuf::MessageFactory::generated_factory();
        auto* prototype = factory->GetPrototype(desc);
        if (!prototype) { noDescriptor++; im.skipReason = "no_prototype"; result.inputMetrics.push_back(std::move(im)); continue; }

        auto msg = std::unique_ptr<google::protobuf::Message>(prototype->New());
        if (!msg->ParseFromArray(fi.protoData.data(), static_cast<int>(fi.protoData.size()))) {
            parseFailed++;
            im.skipReason = "parse_failed";
            std::cerr << "[Harness] ParseFromArray failed: " << fi.dataName
                      << " (" << fi.protoType << ", " << fi.protoData.size() << "B)" << std::endl;
            result.inputMetrics.push_back(std::move(im));
            continue;
        }

        im.deserialized = true;
        im.idValid = true;
        result.inputMetrics.push_back(std::move(im));

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
        // Same registration story as inputs above; use idata() for the key
        // so the executor can find the slot via NXFacility.idata(name).
        cmn::FacilityInl<cmn::Data>::Instance().push(oname);
        ID oid = NXFacility.idata(oname);
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

            OutputMetric om;
            om.name = od.name;
            om.timestampNs = od.timestamp_ns;
            om.nonEmpty = (od.data != nullptr && od.timestamp_ns != 0);
            // od.data is a raw uint8_t buffer, not a protobuf Message pointer.
            // We cannot call ByteSizeLong() on it. Use timestamp_ns as a proxy
            // for "executor wrote something meaningful to this output slot".
            om.dataSize = om.nonEmpty ? 1 : 0;
            result.outputMetrics.push_back(std::move(om));
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
    for (auto& entry : _entries) {
        unloadEntry(entry);
    }
    _entries.clear();
}

void ExecutorHarness::unloadEntry(ExecutorEntry& entry) {
    if (entry.executor) {
        auto* executor = static_cast<task::IExecutor*>(entry.executor);
        if (entry.initialized) {
            executor->release();
        }
        delete executor;
        entry.executor = nullptr;
    }
    entry.initialized = false;
    entry.outputDataNames.clear();
    if (entry.soHandle) {
        dlclose(entry.soHandle);
        entry.soHandle = nullptr;
    }
}

std::vector<ExecutorHarness::MultiLoadResult> ExecutorHarness::loadMultiple(
    const std::vector<HarnessConfig>& configs) {
    unload();
    std::vector<MultiLoadResult> results;

    static bool protoLibLoaded = false;
    if (!protoLibLoaded) {
        void* mh = dlopen("libcommon_message.so", RTLD_NOW | RTLD_GLOBAL);
        if (mh) {
            std::cerr << "[Harness] Loaded libcommon_message.so (multi)" << std::endl;
        }
        protoLibLoaded = true;
    }

    for (const auto& config : configs) {
        MultiLoadResult mlr;
        mlr.className = config.executorClass;

        void* handle = dlopen(config.soPath.c_str(), RTLD_LAZY | RTLD_GLOBAL);
        if (!handle) {
            mlr.error = std::string("dlopen failed: ") + dlerror();
            results.push_back(mlr);
            continue;
        }

        try {
            using CreateFnPtr = task::IExecutor*(*)(void);
            auto createFn = FeatureClassFactory.createcb<CreateFnPtr>(config.executorClass);
            if (!createFn) {
                mlr.error = "No factory for class: " + config.executorClass;
                dlclose(handle);
                results.push_back(mlr);
                continue;
            }
            auto* executor = createFn();
            if (!executor) {
                mlr.error = "Factory returned null for: " + config.executorClass;
                dlclose(handle);
                results.push_back(mlr);
                continue;
            }

            auto status = executor->initial(config.configPaths);
            if (status != task::ExecutorStatus::kReady) {
                mlr.error = "initial() returned " + statusToString(status);
                executor->release();
                delete executor;
                dlclose(handle);
                results.push_back(mlr);
                continue;
            }

            ExecutorEntry entry;
            entry.className = config.executorClass;
            entry.soHandle = handle;
            entry.executor = executor;
            entry.initialized = true;
            entry.outputDataNames = config.outputDataNames;
            _entries.push_back(std::move(entry));

            mlr.success = true;
        } catch (const std::exception& e) {
            mlr.error = std::string("Exception: ") + e.what();
            dlclose(handle);
        }

        results.push_back(mlr);
    }

    return results;
}

std::vector<FrameResult> ExecutorHarness::processFrameMulti(
    const std::vector<FrameInput>& inputs) {
    std::vector<FrameResult> results;

    if (_entries.empty()) {
        if (_executor && _initialized) {
            results.push_back(processFrame(inputs));
        }
        return results;
    }

    for (auto& entry : _entries) {
        FrameResult result;
        result.timestampNs = inputs.empty() ? 0 : inputs[0].timestampNs;

        if (!entry.executor || !entry.initialized) {
            result.statusCode = -1;
            result.statusName = "not_initialized";
            result.errorMsg = entry.className + " not loaded";
            result.processTimeMs = 0;
            results.push_back(result);
            continue;
        }

        auto* executor = static_cast<task::IExecutor*>(entry.executor);

        std::vector<std::unique_ptr<google::protobuf::Message>> deserializedMsgs;
        task::IExecutor::InputDataType inputMap;
        bool firstInput = true;

        for (const auto& fi : inputs) {
            if (fi.protoData.empty() || fi.protoType.empty()) continue;

            cmn::FacilityInl<cmn::Data>::Instance().push(fi.dataName);
            ID dataId = NXFacility.idata(fi.dataName);
            if (ID_IS_INVALID(dataId)) continue;

            auto* pool = google::protobuf::DescriptorPool::generated_pool();
            auto* desc = pool->FindMessageTypeByName(fi.protoType);
            if (!desc) continue;
            auto* factory = google::protobuf::MessageFactory::generated_factory();
            auto* prototype = factory->GetPrototype(desc);
            if (!prototype) continue;

            auto msg = std::unique_ptr<google::protobuf::Message>(prototype->New());
            if (!msg->ParseFromArray(fi.protoData.data(), static_cast<int>(fi.protoData.size()))) continue;

            task::IExecutor::InputData id;
            id.name = fi.dataName;
            id.timestamp_ns = fi.timestampNs;
            id.trigger = firstInput;
            id.data = msg.get();
            inputMap.emplace(dataId, std::move(id));
            deserializedMsgs.push_back(std::move(msg));
            firstInput = false;
        }

        if (inputMap.empty()) {
            result.statusCode = 0;
            result.statusName = "kSkipped";
            result.processTimeMs = 0;
            results.push_back(result);
            continue;
        }

        task::IExecutor::OutputDataType outputMap;
        std::vector<std::vector<uint8_t>> outputBuffers;
        auto& onames = entry.outputDataNames;
        if (onames.empty()) { onames.push_back("output"); }
        for (const auto& oname : onames) {
            outputBuffers.emplace_back(256 * 1024, 0);
            task::IExecutor::OutputData od;
            od.name = oname;
            od.data = outputBuffers.back().data();
            cmn::FacilityInl<cmn::Data>::Instance().push(oname);
            ID oid = NXFacility.idata(oname);
            outputMap.emplace(oid, std::move(od));
        }

        auto t0 = std::chrono::high_resolution_clock::now();
        try {
            auto status = executor->process(inputMap, outputMap);
            auto t1 = std::chrono::high_resolution_clock::now();
            result.statusCode = static_cast<int>(status);
            result.statusName = statusToString(status);
            result.processTimeMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
            if (status != task::ExecutorStatus::kProcessOk) {
                result.errorMsg = executor->error();
            }
        } catch (const std::exception& e) {
            auto t1 = std::chrono::high_resolution_clock::now();
            result.statusCode = -2;
            result.statusName = "exception";
            result.errorMsg = e.what();
            result.processTimeMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
        }

        result.outputJson = Json::Value(Json::objectValue);
        result.outputJson["executor"] = entry.className;
        for (auto& [key, od] : outputMap) {
            Json::Value outEntry;
            outEntry["name"] = od.name;
            outEntry["timestamp_ns"] = Json::Value::UInt64(od.timestamp_ns);
            outEntry["non_empty"] = (od.data != nullptr && od.timestamp_ns != 0);
            result.outputJson[od.name] = outEntry;
        }

        results.push_back(result);
    }

    return results;
}

} // namespace harness
