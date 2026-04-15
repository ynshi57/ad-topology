#include "executor_harness.h"

#include <chrono>
#include <csignal>
#include <dlfcn.h>
#include <iostream>
#include <sstream>

#include <google/protobuf/descriptor.h>
#include <google/protobuf/descriptor_database.h>
#include <google/protobuf/dynamic_message.h>
#include <google/protobuf/message.h>

#include "task/executor/executor.hpp"
#include "core/class_factory.hpp"

using namespace neolix::nexis;

namespace harness {

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

ExecutorHarness::ExecutorHarness() = default;

ExecutorHarness::~ExecutorHarness() {
    unload();
}

bool ExecutorHarness::loadModule(const HarnessConfig& config, std::string& errorOut) {
    unload();

    _soHandle = dlopen(config.soPath.c_str(), RTLD_LAZY | RTLD_GLOBAL);
    if (!_soHandle) {
        errorOut = std::string("dlopen failed: ") + dlerror();
        return false;
    }

    // Use FeatureClassFactory to create executor instance
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
    for (size_t i = 0; i < inputs.size(); ++i) {
        task::IExecutor::InputData id;
        id.name = inputs[i].dataName;
        id.timestamp_ns = inputs[i].timestampNs;
        id.trigger = (i == 0);

        if (!inputs[i].protoType.empty() && !inputs[i].protoData.empty()) {
            auto* pool = google::protobuf::DescriptorPool::generated_pool();
            auto* desc = pool->FindMessageTypeByName(inputs[i].protoType);
            if (desc) {
                auto* factory = google::protobuf::MessageFactory::generated_factory();
                auto* prototype = factory->GetPrototype(desc);
                if (prototype) {
                    auto msg = std::unique_ptr<google::protobuf::Message>(prototype->New());
                    if (msg->ParseFromArray(inputs[i].protoData.data(), static_cast<int>(inputs[i].protoData.size()))) {
                        id.data = msg.get();
                        deserializedMsgs.push_back(std::move(msg));
                    } else {
                        std::cerr << "[Harness] Failed to parse proto for " << inputs[i].dataName
                                  << " (type: " << inputs[i].protoType << ", size: " << inputs[i].protoData.size() << ")" << std::endl;
                        id.data = nullptr;
                    }
                } else {
                    id.data = nullptr;
                }
            } else {
                id.data = inputs[i].protoData.data();
            }
        } else {
            id.data = inputs[i].protoData.empty() ? nullptr : inputs[i].protoData.data();
        }

        inputMap.emplace(static_cast<ID>(i), std::move(id));
    }

    // Build OutputDataType with pre-allocated buffers
    task::IExecutor::OutputDataType outputMap;
    std::vector<std::vector<uint8_t>> outputBuffers(1, std::vector<uint8_t>(64 * 1024, 0));
    {
        task::IExecutor::OutputData od;
        od.name = "output";
        od.data = outputBuffers[0].data();
        outputMap.emplace(static_cast<ID>(0), std::move(od));
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

        // Capture output metadata
        result.outputJson = Json::Value(Json::objectValue);
        for (auto& [key, od] : outputMap) {
            Json::Value outEntry;
            outEntry["name"] = od.name;
            outEntry["timestamp_ns"] = Json::Value::UInt64(od.timestamp_ns);
            outEntry["has_data"] = (od.data != nullptr);
            result.outputJson[std::to_string(key)] = outEntry;
        }

    } catch (const std::exception& e) {
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
    if (_soHandle) {
        dlclose(_soHandle);
        _soHandle = nullptr;
    }
}

} // namespace harness
