#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>
#include <json/json.h>

namespace harness {

struct HarnessConfig {
    std::string soPath;
    std::string executorClass;
    std::vector<std::string> configPaths;
};

struct FrameInput {
    uint64_t timestampNs;
    std::string dataName;
    std::vector<uint8_t> protoData;
};

struct FrameResult {
    uint64_t timestampNs;
    int statusCode;
    std::string statusName;
    std::string errorMsg;
    Json::Value outputJson;
    double processTimeMs;
};

/**
 * Load a .so, create executor, run process loop.
 * Communicates results via callback.
 */
class ExecutorHarness {
public:
    using ResultCallback = std::function<void(const FrameResult&)>;

    ExecutorHarness();
    ~ExecutorHarness();

    bool loadModule(const HarnessConfig& config, std::string& errorOut);
    FrameResult processFrame(const std::vector<FrameInput>& inputs);
    void reset();
    void unload();

private:
    void* _soHandle = nullptr;
    void* _executor = nullptr;
    void* _destroyFn = nullptr;
    bool _initialized = false;
};

} // namespace harness
