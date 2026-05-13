/**
 * Dual-Mode Executor Harness — stdin/stdout JSON protocol.
 *
 * Auto-detects module type:
 *   1. Try Nexis IExecutor (FeatureClassFactory)
 *   2. Fallback to CyberRT Component (ClassLoader)
 *
 * Commands:
 *   {"cmd":"load", "so_path":"...", "class":"...", "config_paths":["..."],
 *    "input_topics":["..."], "output_topics":["..."]}
 *   {"cmd":"process", "frames":[...]}
 *   {"cmd":"inject", "topic":"...", "timestamp_ns":N, "data_base64":"..."}
 *   {"cmd":"reset"}
 *   {"cmd":"unload"}
 *   {"cmd":"quit"}
 */

#include <cstdlib>
#include <dlfcn.h>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

#include <json/json.h>
#include "task/executor/executor.hpp"
#include "core/class_factory.hpp"
#include "executor_harness.h"
#include "cyber_harness.h"

#include <google/protobuf/descriptor.h>
#include <google/protobuf/message.h>
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

static std::string base64Decode(const std::string& encoded) {
    static const std::string chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::vector<uint8_t> out;
    int val = 0, bits = -8;
    for (char c : encoded) {
        if (c == '=' || c == '\n' || c == '\r') { continue; }
        auto pos = chars.find(c);
        if (pos == std::string::npos) { continue; }
        val = (val << 6) + static_cast<int>(pos);
        bits += 6;
        if (bits >= 0) {
            out.push_back(static_cast<uint8_t>((val >> bits) & 0xFF));
            bits -= 8;
        }
    }
    return std::string(out.begin(), out.end());
}

static void writeResponse(const Json::Value& resp) {
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "";
    std::cout << Json::writeString(builder, resp) << "\n" << std::flush;
}

int main(int argc, char** argv) {
    // Dual-mode harnesses
    harness::ExecutorHarness execHarness;
    harness::CyberComponentHarness cyberHarness;
    std::string activeMode = "none"; // "executor" | "cyber" | "none"

    Json::CharReaderBuilder readerBuilder;

    writeResponse([]() {
        Json::Value r;
        r["status"] = "ready";
        r["version"] = "2.0";
        r["modes"] = "executor,cyber";
        return r;
    }());

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) { continue; }

        Json::Value cmd;
        std::string parseErrors;
        std::istringstream iss(line);
        if (!Json::parseFromStream(readerBuilder, iss, &cmd, &parseErrors)) {
            Json::Value err;
            err["error"] = "invalid JSON: " + parseErrors;
            writeResponse(err);
            continue;
        }

        std::string cmdType = cmd.get("cmd", "").asString();

        if (cmdType == "load") {
            execHarness.unload();
            cyberHarness.unload();
            activeMode = "none";

            std::string soPath = cmd["so_path"].asString();
            std::string className = cmd["class"].asString();
            std::string runtimeHint = cmd.get("runtime", "").asString();

            std::vector<std::string> configPaths;
            for (const auto& p : cmd["config_paths"]) {
                configPaths.push_back(p.asString());
            }
            std::string flagPath;
            if (cmd.isMember("flag_path") && !cmd["flag_path"].asString().empty()) {
                flagPath = cmd["flag_path"].asString();
            }
            std::vector<std::string> inputTopics, outputTopics;
            for (const auto& t : cmd["input_topics"]) {
                inputTopics.push_back(t.asString());
            }
            for (const auto& t : cmd["output_topics"]) {
                outputTopics.push_back(t.asString());
            }

            std::vector<std::string> outputDataNames;
            for (const auto& n : cmd["output_data_names"]) {
                outputDataNames.push_back(n.asString());
            }
            std::unordered_map<std::string, std::string> outputProtoTypes;
            if (cmd.isMember("output_proto_types") && cmd["output_proto_types"].isObject()) {
                const auto names = cmd["output_proto_types"].getMemberNames();
                for (const auto& name : names) {
                    outputProtoTypes[name] = cmd["output_proto_types"][name].asString();
                }
            }

            harness::GradingConfig gradingCfg;
            if (cmd.isMember("grading")) {
                const auto& g = cmd["grading"];
                if (g.isMember("l2_min_output_bytes")) {
                    gradingCfg.l2MinOutputBytes = g["l2_min_output_bytes"].asUInt64();
                }
            }

            auto tryExecutor = [&](std::string& errOut) -> bool {
                harness::HarnessConfig cfg;
                cfg.soPath = soPath;
                cfg.executorClass = className;
                cfg.configPaths = configPaths;
                cfg.outputDataNames = outputDataNames;
                cfg.outputProtoTypes = outputProtoTypes;
                cfg.grading = gradingCfg;
                return execHarness.loadModule(cfg, errOut);
            };

            auto tryCyber = [&](std::string& errOut) -> bool {
                harness::CyberConfig cfg;
                cfg.soPath = soPath;
                cfg.className = className;
                if (!configPaths.empty()) {
                    cfg.configFilePath = configPaths[0];
                }
                cfg.flagFilePath = flagPath;
                cfg.inputTopics = inputTopics;
                cfg.outputTopics = outputTopics;
                return cyberHarness.load(cfg, errOut);
            };

            auto sendLoadOk = [&](const std::string& mode, const std::string& label) {
                activeMode = mode;
                Json::Value resp;
                resp["cmd"] = "load_result";
                resp["success"] = true;
                resp["mode"] = mode;
                resp["message"] = "Loaded as " + label;
                resp["pid"] = static_cast<int>(getpid());
                writeResponse(resp);
            };

            auto sendLoadFail = [&](const std::string& error) {
                Json::Value resp;
                resp["cmd"] = "load_result";
                resp["success"] = false;
                resp["mode"] = "none";
                resp["error"] = error;
                writeResponse(resp);
            };

            // Multi-executor load: if cmd["executors"] is an array, load them all
            if (cmd.isMember("executors") && cmd["executors"].isArray() && cmd["executors"].size() > 0) {
                std::vector<harness::HarnessConfig> configs;
                for (const auto& ex : cmd["executors"]) {
                    harness::HarnessConfig cfg;
                    cfg.soPath = ex.get("so_path", soPath).asString();
                    cfg.executorClass = ex.get("class", className).asString();
                    for (const auto& p : ex["config_paths"]) {
                        cfg.configPaths.push_back(p.asString());
                    }
                    for (const auto& n : ex["output_data_names"]) {
                        cfg.outputDataNames.push_back(n.asString());
                    }
                    if (ex.isMember("output_proto_types") && ex["output_proto_types"].isObject()) {
                        const auto names = ex["output_proto_types"].getMemberNames();
                        for (const auto& name : names) {
                            cfg.outputProtoTypes[name] = ex["output_proto_types"][name].asString();
                        }
                    }
                    configs.push_back(std::move(cfg));
                }
                auto results = execHarness.loadMultiple(configs);
                bool allOk = true;
                Json::Value resp;
                resp["cmd"] = "load_result";
                resp["mode"] = "multi_executor";
                resp["pid"] = static_cast<int>(getpid());
                Json::Value execResults(Json::arrayValue);
                for (const auto& r : results) {
                    Json::Value er;
                    er["class"] = r.className;
                    er["success"] = r.success;
                    if (!r.error.empty()) er["error"] = r.error;
                    execResults.append(er);
                    if (!r.success) allOk = false;
                }
                resp["success"] = allOk;
                resp["executors"] = execResults;
                resp["message"] = allOk
                    ? "Loaded " + std::to_string(results.size()) + " executors"
                    : "Some executors failed to load";
                if (allOk) activeMode = "executor";
                writeResponse(resp);
            } else if (runtimeHint == "nexis") {
                std::string err;
                if (tryExecutor(err)) {
                    sendLoadOk("executor", "Nexis IExecutor");
                } else {
                    std::cerr << "[Harness] Nexis Executor failed, trying CyberRT fallback..." << std::endl;
                    std::string cyberErr;
                    if (tryCyber(cyberErr)) {
                        sendLoadOk("cyber", "CyberRT Component (fallback)");
                    } else {
                        sendLoadFail("Executor: " + err + " | CyberRT fallback: " + cyberErr);
                    }
                }
            } else if (runtimeHint == "cyber") {
                std::string err;
                if (tryCyber(err)) {
                    sendLoadOk("cyber", "CyberRT Component");
                } else {
                    std::cerr << "[Harness] CyberRT failed, trying Nexis Executor fallback..." << std::endl;
                    std::string execErr;
                    if (tryExecutor(execErr)) {
                        sendLoadOk("executor", "Nexis IExecutor (fallback)");
                    } else {
                        sendLoadFail("CyberRT: " + err + " | Executor fallback: " + execErr);
                    }
                }
            } else {
                std::cerr << "[Harness] No runtime hint, auto-detecting..." << std::endl;
                std::string cyberErr;
                if (tryCyber(cyberErr)) {
                    sendLoadOk("cyber", "CyberRT Component");
                } else if (cyberErr.find("CreateClassObj returned null") != std::string::npos) {
                    std::cerr << "[Harness] Not a CyberRT component, trying Executor..." << std::endl;
                    std::string execErr;
                    if (tryExecutor(execErr)) {
                        sendLoadOk("executor", "Nexis IExecutor");
                    } else {
                        sendLoadFail("CyberRT: " + cyberErr + " | Executor: " + execErr);
                    }
                } else {
                    sendLoadFail("CyberRT Component: " + cyberErr);
                }
            }

        } else if (cmdType == "process" && activeMode == "executor") {
            // Nexis Executor: process frames
            const auto& frames = cmd["frames"];
            Json::Value resp;
            resp["cmd"] = "process_result";
            resp["mode"] = execHarness.executorCount() > 0 ? "multi_executor" : "executor";
            resp["results"] = Json::Value(Json::arrayValue);

            for (const auto& frame : frames) {
                std::vector<harness::FrameInput> inputs;
                for (const auto& inp : frame["inputs"]) {
                    harness::FrameInput fi;
                    fi.timestampNs = inp["timestamp_ns"].asUInt64();
                    fi.dataName = inp["name"].asString();
                    fi.protoType = inp.get("proto_type", "").asString();
                    std::string decoded = base64Decode(inp["data_base64"].asString());
                    fi.protoData.assign(decoded.begin(), decoded.end());
                    inputs.push_back(std::move(fi));
                }

                // Multi-executor: run all loaded executors
                if (execHarness.executorCount() > 0) {
                    auto multiResults = execHarness.processFrameMulti(inputs);
                    for (auto& result : multiResults) {
                        Json::Value r;
                        r["timestamp_ns"] = Json::Value::UInt64(result.timestampNs);
                        r["status_code"] = result.statusCode;
                        r["status"] = result.statusName;
                        r["process_time_ms"] = result.processTimeMs;
                        if (!result.errorMsg.empty()) { r["error"] = result.errorMsg; }
                        r["output"] = result.outputJson;
                        r["grade_level"] = result.gradeLevel;
                        if (!result.gradeReason.empty()) { r["grade_reason"] = result.gradeReason; }
                        r["total_output_bytes"] = Json::Value::UInt64(result.totalOutputBytes);
                        resp["results"].append(r);
                    }
                    continue;
                }

                auto result = execHarness.processFrame(inputs);
                Json::Value r;
                r["timestamp_ns"] = Json::Value::UInt64(result.timestampNs);
                r["status_code"] = result.statusCode;
                r["status"] = result.statusName;
                r["process_time_ms"] = result.processTimeMs;
                if (!result.errorMsg.empty()) { r["error"] = result.errorMsg; }
                r["output"] = result.outputJson;

                Json::Value inputMetrics(Json::arrayValue);
                for (const auto& im : result.inputMetrics) {
                    Json::Value entry;
                    entry["name"] = im.name;
                    entry["proto_type"] = im.protoType;
                    entry["timestamp_ns"] = Json::Value::UInt64(im.timestampNs);
                    entry["data_size"] = Json::Value::UInt64(im.dataSize);
                    entry["id_valid"] = im.idValid;
                    entry["deserialized"] = im.deserialized;
                    if (!im.skipReason.empty()) { entry["skip_reason"] = im.skipReason; }
                    inputMetrics.append(entry);
                }
                r["input_metrics"] = inputMetrics;

                Json::Value outputMetrics(Json::arrayValue);
                for (const auto& om : result.outputMetrics) {
                    Json::Value entry;
                    entry["name"] = om.name;
                    entry["timestamp_ns"] = Json::Value::UInt64(om.timestampNs);
                    entry["data_size"] = Json::Value::UInt64(om.dataSize);
                    entry["non_empty"] = om.nonEmpty;
                    outputMetrics.append(entry);
                }
                r["output_metrics"] = outputMetrics;
                r["grade_level"] = result.gradeLevel;
                if (!result.gradeReason.empty()) { r["grade_reason"] = result.gradeReason; }
                r["total_output_bytes"] = Json::Value::UInt64(result.totalOutputBytes);

                resp["results"].append(r);
            }
            writeResponse(resp);

        } else if (cmdType == "perf_replay" && activeMode == "executor") {
            // Tight-loop replay for perf sampling: process all frames back-to-back
            // with minimal overhead so perf can capture process() internals.
            const auto& frames = cmd["frames"];
            const int repeatCount = cmd.get("repeat", 1).asInt();
            int totalFrames = 0;
            int okFrames = 0;
            int l1Frames = 0, l2Frames = 0;
            double totalMs = 0;

            std::cerr << "[Harness] perf_replay: " << frames.size()
                      << " frames x" << repeatCount << " repeats" << std::endl;

            // Pre-parse all frame inputs to avoid JSON overhead during tight loop
            struct PreParsedFrame {
                std::vector<harness::FrameInput> inputs;
            };
            std::vector<PreParsedFrame> parsedFrames;
            for (const auto& frame : frames) {
                PreParsedFrame pf;
                for (const auto& inp : frame["inputs"]) {
                    harness::FrameInput fi;
                    fi.timestampNs = inp["timestamp_ns"].asUInt64();
                    fi.dataName = inp["name"].asString();
                    fi.protoType = inp.get("proto_type", "").asString();
                    std::string decoded = base64Decode(inp["data_base64"].asString());
                    fi.protoData.assign(decoded.begin(), decoded.end());
                    pf.inputs.push_back(std::move(fi));
                }
                parsedFrames.push_back(std::move(pf));
            }

            // Tight loop — this is where perf should see process() stacks
            for (int rep = 0; rep < repeatCount; rep++) {
                for (const auto& pf : parsedFrames) {
                    auto result = execHarness.processFrame(pf.inputs);
                    totalFrames++;
                    if (result.statusCode == 1) { okFrames++; }
                    if (result.gradeLevel >= 1) { l1Frames++; }
                    if (result.gradeLevel >= 2) { l2Frames++; }
                    totalMs += result.processTimeMs;
                }
            }

            Json::Value resp;
            resp["cmd"] = "perf_replay_result";
            resp["total_frames"] = totalFrames;
            resp["ok_frames"] = okFrames;
            resp["l1_frames"] = l1Frames;
            resp["l2_frames"] = l2Frames;
            resp["total_ms"] = totalMs;
            resp["avg_ms"] = totalFrames > 0 ? totalMs / totalFrames : 0;
            writeResponse(resp);

        } else if (cmdType == "vpm_preload") {
            const auto& messages = cmd["messages"];
            int drCount = 0, gnssCount = 0, canCount = 0, failCount = 0;
            auto* vpm = nexis::common::vpm::VehiclePoseManager::getInstance();

            std::vector<neodrive::global::localization_dr::LocalizationVehicleSpeed> drMsgs;
            std::vector<neodrive::global::localization::LocalizationEstimate> gnssMsgs;
            std::vector<neodrive::global::canbus::PbCarStatus> canMsgs;

            for (Json::ArrayIndex i = 0; i < messages.size(); i++) {
                const auto& m = messages[i];
                std::string protoType = m.get("proto_type", "").asString();
                std::string decoded = base64Decode(m.get("data_base64", "").asString());
                if (decoded.empty() || protoType.empty()) { failCount++; continue; }

                if (protoType == "neodrive.global.localization_dr.LocalizationVehicleSpeed") {
                    neodrive::global::localization_dr::LocalizationVehicleSpeed msg;
                    if (msg.ParseFromArray(decoded.data(), static_cast<int>(decoded.size()))) {
                        drMsgs.push_back(std::move(msg));
                    } else { failCount++; }
                } else if (protoType == "neodrive.global.localization.LocalizationEstimate") {
                    neodrive::global::localization::LocalizationEstimate msg;
                    if (msg.ParseFromArray(decoded.data(), static_cast<int>(decoded.size()))) {
                        gnssMsgs.push_back(std::move(msg));
                    } else { failCount++; }
                } else if (protoType == "neodrive.global.canbus.PbCarStatus") {
                    neodrive::global::canbus::PbCarStatus msg;
                    if (msg.ParseFromArray(decoded.data(), static_cast<int>(decoded.size()))) {
                        canMsgs.push_back(std::move(msg));
                    } else { failCount++; }
                }
            }

            std::sort(drMsgs.begin(), drMsgs.end(),
                [](const auto& a, const auto& b) { return a.measurement_time() < b.measurement_time(); });
            std::sort(gnssMsgs.begin(), gnssMsgs.end(),
                [](const auto& a, const auto& b) { return a.measurement_time() < b.measurement_time(); });
            std::sort(canMsgs.begin(), canMsgs.end(),
                [](const auto& a, const auto& b) { return a.header().timestamp_sec() < b.header().timestamp_sec(); });

            for (auto& msg : drMsgs) { vpm->AddDrData(msg); drCount++; }
            for (auto& msg : gnssMsgs) { vpm->AddGnssData(msg); gnssCount++; }
            for (auto& msg : canMsgs) { vpm->AddSteeringData(msg); canCount++; }

            if (!drMsgs.empty()) {
                std::cerr << "[VPM-preload] DR range: " << std::fixed << std::setprecision(3)
                          << drMsgs.front().measurement_time() << " → " << drMsgs.back().measurement_time()
                          << " (" << drMsgs.size() << " msgs)" << std::endl;
            }
            if (!gnssMsgs.empty()) {
                std::cerr << "[VPM-preload] GNSS range: " << std::fixed << std::setprecision(3)
                          << gnssMsgs.front().measurement_time() << " → " << gnssMsgs.back().measurement_time()
                          << " (" << gnssMsgs.size() << " msgs)" << std::endl;
            }
            if (!canMsgs.empty()) {
                std::cerr << "[VPM-preload] CAN range: " << std::fixed << std::setprecision(3)
                          << canMsgs.front().header().timestamp_sec() << " → " << canMsgs.back().header().timestamp_sec()
                          << " (" << canMsgs.size() << " msgs)" << std::endl;
            }

            std::cerr << "[Harness] VPM preloaded: DR=" << drCount
                      << " GNSS=" << gnssCount << " CAN=" << canCount
                      << " fail=" << failCount
                      << " instance=" << (void*)vpm << std::endl;

            // Verify VPM data by trying a query at the first DR message's timestamp
            bool vpmVerified = false;
            std::string vpmVerifyErr;
            {
                using GetLocDataFn = bool(*)(void*, int64_t, void*);
                void* sym = dlsym(RTLD_DEFAULT, "_ZN5nexis6common3vpm18VehiclePoseManager17GetVehicleLocDataElPNS1_14VehicleLocDataE");
                if (sym) {
                    auto fn = reinterpret_cast<GetLocDataFn>(sym);
                    // Find a timestamp from the middle of preloaded DR data
                    int64_t testTs = 0;
                    for (Json::ArrayIndex i = messages.size() / 2; i < messages.size(); i++) {
                        if (messages[i].get("proto_type", "").asString() == "neodrive.global.localization_dr.LocalizationVehicleSpeed") {
                            std::string dec = base64Decode(messages[i].get("data_base64", "").asString());
                            neodrive::global::localization_dr::LocalizationVehicleSpeed tm;
                            if (tm.ParseFromArray(dec.data(), static_cast<int>(dec.size()))) {
                                testTs = static_cast<int64_t>(tm.measurement_time() * 1e9);
                            }
                            break;
                        }
                    }
                    if (testTs > 0) {
                        uint8_t locBuf[4096] = {};
                        vpmVerified = fn(vpm, testTs, locBuf);
                        if (!vpmVerified) {
                            vpmVerifyErr = "GetVehicleLocData returned false at ts=" + std::to_string(testTs);
                        }
                    } else {
                        vpmVerifyErr = "no test timestamp";
                    }
                } else {
                    vpmVerifyErr = "dlsym failed";
                }
                std::cerr << "[Harness] VPM verify: " << (vpmVerified ? "OK" : ("FAIL: " + vpmVerifyErr)) << std::endl;
            }

            std::ostringstream addrStr;
            addrStr << (void*)vpm;

            Json::Value resp;
            resp["cmd"] = "vpm_preload_result";
            resp["dr"] = drCount;
            resp["gnss"] = gnssCount;
            resp["can"] = canCount;
            resp["fail"] = failCount;
            resp["instance"] = addrStr.str();
            resp["verify"] = vpmVerified ? "OK" : ("FAIL: " + vpmVerifyErr);
            // Capture first-CAN diagnostic into response for visibility
            {
                // Re-parse first CAN message to check fields
                for (Json::ArrayIndex i = 0; i < messages.size(); i++) {
                    std::string pt = messages[i].get("proto_type", "").asString();
                    if (pt != "neodrive.global.canbus.PbCarStatus") continue;
                    std::string dec = base64Decode(messages[i].get("data_base64", "").asString());
                    neodrive::global::canbus::PbCarStatus cm;
                    if (cm.ParseFromArray(dec.data(), static_cast<int>(dec.size()))) {
                        resp["can_diag"] = std::string("header=") + (cm.has_header() ? "1" : "0")
                            + " ts_sec=" + (cm.has_header() && cm.header().has_timestamp_sec() ? "1" : "0")
                            + " wheelspeed=" + (cm.has_wheelspeed() ? "1" : "0")
                            + " steer_angle=" + (cm.has_wheelspeed() && cm.wheelspeed().has_steering_angle() ? "1" : "0");
                    }
                    break;
                }
            }
            writeResponse(resp);

        } else if (cmdType == "inject" && activeMode == "cyber") {
            // CyberRT Component: inject single message
            std::string topic = cmd["topic"].asString();
            uint64_t tsNs = cmd["timestamp_ns"].asUInt64();
            std::string decoded = base64Decode(cmd.get("data_base64", "").asString());

            auto result = cyberHarness.injectMessage(topic, tsNs, decoded.data(), decoded.size());

            Json::Value resp;
            resp["cmd"] = "inject_result";
            resp["mode"] = "cyber";
            resp["timestamp_ns"] = Json::Value::UInt64(result.timestampNs);
            resp["status"] = result.status;
            resp["elapsed_ms"] = result.elapsedMs;
            if (!result.errorMsg.empty()) { resp["error"] = result.errorMsg; }
            resp["captured"] = result.capturedOutputs;
            writeResponse(resp);

        } else if (cmdType == "process" && activeMode == "cyber") {
            // CyberRT: process multiple frames by injecting sequentially
            const auto& frames = cmd["frames"];
            Json::Value resp;
            resp["cmd"] = "process_result";
            resp["mode"] = "cyber";
            resp["results"] = Json::Value(Json::arrayValue);

            for (const auto& frame : frames) {
                for (const auto& inp : frame["inputs"]) {
                    std::string topic = inp["topic"].asString();
                    uint64_t tsNs = inp["timestamp_ns"].asUInt64();
                    std::string decoded = base64Decode(inp.get("data_base64", "").asString());

                    auto result = cyberHarness.injectMessage(topic, tsNs, decoded.data(), decoded.size());
                    Json::Value r;
                    r["topic"] = topic;
                    r["timestamp_ns"] = Json::Value::UInt64(result.timestampNs);
                    r["status"] = result.status;
                    r["elapsed_ms"] = result.elapsedMs;
                    r["captured"] = result.capturedOutputs;
                    if (!result.errorMsg.empty()) { r["error"] = result.errorMsg; }
                    resp["results"].append(r);
                }
            }
            writeResponse(resp);

        } else if (cmdType == "reset") {
            if (activeMode == "executor") { execHarness.reset(); }
            Json::Value resp;
            resp["cmd"] = "reset_result";
            resp["success"] = true;
            writeResponse(resp);

        } else if (cmdType == "unload") {
            execHarness.unload();
            cyberHarness.unload();
            activeMode = "none";
            Json::Value resp;
            resp["cmd"] = "unload_result";
            resp["success"] = true;
            writeResponse(resp);

        } else if (cmdType == "quit") {
            break;

        } else {
            Json::Value err;
            err["error"] = "unknown command or wrong mode: " + cmdType + " (mode=" + activeMode + ")";
            writeResponse(err);
        }
    }

    execHarness.unload();
    cyberHarness.unload();
    return 0;
}
