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
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include <json/json.h>
#include "task/executor/executor.hpp"
#include "core/class_factory.hpp"
#include "executor_harness.h"
#include "cyber_harness.h"

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

            auto tryExecutor = [&](std::string& errOut) -> bool {
                harness::HarnessConfig cfg;
                cfg.soPath = soPath;
                cfg.executorClass = className;
                cfg.configPaths = configPaths;
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

            if (runtimeHint == "nexis") {
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
            resp["mode"] = "executor";
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

                auto result = execHarness.processFrame(inputs);
                Json::Value r;
                r["timestamp_ns"] = Json::Value::UInt64(result.timestampNs);
                r["status_code"] = result.statusCode;
                r["status"] = result.statusName;
                r["process_time_ms"] = result.processTimeMs;
                if (!result.errorMsg.empty()) { r["error"] = result.errorMsg; }
                r["output"] = result.outputJson;
                resp["results"].append(r);
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
