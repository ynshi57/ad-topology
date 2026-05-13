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

#include "localization_dead_reckoning.pb.h"
#include "localization_pose.pb.h"
#include "car_status.pb.h"

namespace nexis { namespace common { namespace vpm {
class VehiclePoseManager {
public:
    static VehiclePoseManager* getInstance();
    void init(double buf_seconds = 15.0);
    void AddDrData(const neodrive::global::localization_dr::LocalizationVehicleSpeed& dr_data);
    void AddGnssData(const neodrive::global::localization::LocalizationEstimate& gnss_data);
    void AddSteeringData(const neodrive::global::canbus::PbCarStatus& steering_data);
};
}}} // namespace nexis::common::vpm

using namespace neolix::nexis;

static const std::string kDrProtoType =
    "neodrive.global.localization_dr.LocalizationVehicleSpeed";
static const std::string kGnssProtoType =
    "neodrive.global.localization.LocalizationEstimate";
static const std::string kSteeringProtoType =
    "neodrive.global.canbus.PbCarStatus";

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

static std::string base64Encode(const std::string& bytes) {
    static const char* kChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    int val = 0;
    int valb = -6;
    for (uint8_t c : bytes) {
        val = (val << 8) + c;
        valb += 8;
        while (valb >= 0) {
            out.push_back(kChars[(val >> valb) & 0x3F]);
            valb -= 6;
        }
    }
    if (valb > -6) {
        out.push_back(kChars[((val << 8) >> (valb + 8)) & 0x3F]);
    }
    while (out.size() % 4) {
        out.push_back('=');
    }
    return out;
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
        _outputProtoTypes = config.outputProtoTypes;

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
        _gradingConfig = config.grading;

        auto* vpm = nexis::common::vpm::VehiclePoseManager::getInstance();
        vpm->init(300.0);
        std::cerr << "[Harness] VehiclePoseManager initialized (buf=300s)" << std::endl;

        return true;
    } catch (const std::exception& e) {
        errorOut = std::string("Exception during load: ") + e.what();
        if (_soHandle) { dlclose(_soHandle); _soHandle = nullptr; }
        return false;
    }
}

void ExecutorHarness::computeGrade(FrameResult& result) {
    if (result.statusCode < 0) {
        result.gradeLevel = 0;
        result.gradeReason = result.statusName;
        return;
    }

    result.gradeLevel = 1;

    uint64_t totalOut = 0;
    for (const auto& om : result.outputMetrics) {
        totalOut += om.dataSize;
    }
    result.totalOutputBytes = totalOut;

    if (totalOut >= _gradingConfig.l2MinOutputBytes) {
        result.gradeLevel = 2;
    } else {
        result.gradeReason = "output_too_small(" + std::to_string(totalOut) + "B)";
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

        if (fi.protoType == kDrProtoType) {
            auto* drMsg = dynamic_cast<const neodrive::global::localization_dr::LocalizationVehicleSpeed*>(msgPtr);
            if (drMsg) {
                auto* vpmInst = nexis::common::vpm::VehiclePoseManager::getInstance();
                static bool loggedOnce = false;
                if (!loggedOnce) {
                    std::cerr << "[VPM] processFrame instance=" << (void*)vpmInst << std::endl;
                    loggedOnce = true;
                }
                vpmInst->AddDrData(*drMsg);
            }
        } else if (fi.protoType == kGnssProtoType) {
            auto* gnssMsg = dynamic_cast<const neodrive::global::localization::LocalizationEstimate*>(msgPtr);
            if (gnssMsg) {
                nexis::common::vpm::VehiclePoseManager::getInstance()->AddGnssData(*gnssMsg);
            }
        } else if (fi.protoType == kSteeringProtoType) {
            auto* canMsg = dynamic_cast<const neodrive::global::canbus::PbCarStatus*>(msgPtr);
            if (canMsg) {
                nexis::common::vpm::VehiclePoseManager::getInstance()->AddSteeringData(*canMsg);
            }
        }

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
    std::vector<std::unique_ptr<google::protobuf::Message>> outputMessages;
    std::unordered_map<std::string, google::protobuf::Message*> outputMessageByName;

    if (_outputDataNames.empty()) {
        _outputDataNames.push_back("output");
    }
    for (const auto& oname : _outputDataNames) {
        task::IExecutor::OutputData od;
        od.name = oname;
        const auto protoIt = _outputProtoTypes.find(oname);
        if (protoIt != _outputProtoTypes.end() && !protoIt->second.empty()) {
            auto* pool = google::protobuf::DescriptorPool::generated_pool();
            auto* desc = pool->FindMessageTypeByName(protoIt->second);
            auto* factory = google::protobuf::MessageFactory::generated_factory();
            auto* prototype = desc ? factory->GetPrototype(desc) : nullptr;
            if (prototype) {
                auto msg = std::unique_ptr<google::protobuf::Message>(prototype->New());
                od.data = msg.get();
                outputMessageByName[oname] = msg.get();
                outputMessages.push_back(std::move(msg));
            } else {
                std::cerr << "[Harness] output proto not found for " << oname
                          << ": " << protoIt->second << ", fallback to raw buffer" << std::endl;
                outputBuffers.emplace_back(256 * 1024, 0);
                od.data = outputBuffers.back().data();
            }
        } else {
            outputBuffers.emplace_back(256 * 1024, 0);
            od.data = outputBuffers.back().data();
        }
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

            OutputMetric om;
            om.name = od.name;
            om.timestampNs = od.timestamp_ns;
            om.dataSize = 0;
            auto outMsgIt = outputMessageByName.find(od.name);
            if (outMsgIt != outputMessageByName.end()) {
                auto* msgPtr = outMsgIt->second;
                om.dataSize = msgPtr ? msgPtr->ByteSizeLong() : 0;
                om.nonEmpty = (om.dataSize > 0);
                outEntry["proto_type"] = _outputProtoTypes[od.name];
                outEntry["byte_size"] = Json::Value::UInt64(om.dataSize);
                if (msgPtr && om.dataSize > 0) {
                    std::string serialized;
                    if (msgPtr->SerializeToString(&serialized)) {
                        outEntry["serialized_base64"] = base64Encode(serialized);
                    }
                }
            } else {
                om.nonEmpty = (od.data != nullptr && od.timestamp_ns != 0);
                try {
                    auto* msgPtr = reinterpret_cast<const google::protobuf::MessageLite*>(od.data);
                    om.dataSize = msgPtr->ByteSizeLong();
                } catch (...) {
                    om.dataSize = 1;
                }
            }
            result.outputJson[od.name] = outEntry;
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

    computeGrade(result);
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
            entry.outputProtoTypes = config.outputProtoTypes;
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

            const auto* rawPtr = msg.get();
            if (fi.protoType == kDrProtoType) {
                auto* drMsg = dynamic_cast<const neodrive::global::localization_dr::LocalizationVehicleSpeed*>(rawPtr);
                if (drMsg) {
                    nexis::common::vpm::VehiclePoseManager::getInstance()->AddDrData(*drMsg);
                }
            } else if (fi.protoType == kGnssProtoType) {
                auto* gnssMsg = dynamic_cast<const neodrive::global::localization::LocalizationEstimate*>(rawPtr);
                if (gnssMsg) {
                    nexis::common::vpm::VehiclePoseManager::getInstance()->AddGnssData(*gnssMsg);
                }
            } else if (fi.protoType == kSteeringProtoType) {
                auto* canMsg = dynamic_cast<const neodrive::global::canbus::PbCarStatus*>(rawPtr);
                if (canMsg) {
                    nexis::common::vpm::VehiclePoseManager::getInstance()->AddSteeringData(*canMsg);
                }
            }

            task::IExecutor::InputData id;
            id.name = fi.dataName;
            id.timestamp_ns = fi.timestampNs;
            id.trigger = firstInput;
            id.data = rawPtr;
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
        std::vector<std::unique_ptr<google::protobuf::Message>> outputMessages;
        std::unordered_map<std::string, google::protobuf::Message*> outputMessageByName;
        auto& onames = entry.outputDataNames;
        if (onames.empty()) { onames.push_back("output"); }
        for (const auto& oname : onames) {
            task::IExecutor::OutputData od;
            od.name = oname;
            const auto protoIt = entry.outputProtoTypes.find(oname);
            if (protoIt != entry.outputProtoTypes.end() && !protoIt->second.empty()) {
                auto* pool = google::protobuf::DescriptorPool::generated_pool();
                auto* desc = pool->FindMessageTypeByName(protoIt->second);
                auto* factory = google::protobuf::MessageFactory::generated_factory();
                auto* prototype = desc ? factory->GetPrototype(desc) : nullptr;
                if (prototype) {
                    auto msg = std::unique_ptr<google::protobuf::Message>(prototype->New());
                    od.data = msg.get();
                    outputMessageByName[oname] = msg.get();
                    outputMessages.push_back(std::move(msg));
                } else {
                    outputBuffers.emplace_back(256 * 1024, 0);
                    od.data = outputBuffers.back().data();
                }
            } else {
                outputBuffers.emplace_back(256 * 1024, 0);
                od.data = outputBuffers.back().data();
            }
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
            bool nonEmpty = false;
            auto outMsgIt = outputMessageByName.find(od.name);
            uint64_t protoSize = 0;
            if (outMsgIt != outputMessageByName.end()) {
                auto* msgPtr = outMsgIt->second;
                protoSize = msgPtr ? msgPtr->ByteSizeLong() : 0;
                nonEmpty = protoSize > 0;
                outEntry["proto_type"] = entry.outputProtoTypes[od.name];
                outEntry["byte_size"] = Json::Value::UInt64(protoSize);
                if (msgPtr && protoSize > 0) {
                    std::string serialized;
                    if (msgPtr->SerializeToString(&serialized)) {
                        outEntry["serialized_base64"] = base64Encode(serialized);
                    }
                }
            } else {
                nonEmpty = (od.data != nullptr && od.timestamp_ns != 0);
            }
            outEntry["non_empty"] = nonEmpty;
            result.outputJson[od.name] = outEntry;

            OutputMetric om;
            om.name = od.name;
            om.timestampNs = od.timestamp_ns;
            om.nonEmpty = nonEmpty;
            om.dataSize = protoSize;
            if (om.nonEmpty && outMsgIt == outputMessageByName.end()) {
                try {
                    auto* msgPtr = reinterpret_cast<const google::protobuf::MessageLite*>(od.data);
                    om.dataSize = msgPtr->ByteSizeLong();
                } catch (...) {
                    om.dataSize = 1;
                }
            }
            result.outputMetrics.push_back(std::move(om));
        }

        computeGrade(result);
        results.push_back(result);
    }

    return results;
}

} // namespace harness
