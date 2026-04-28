#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>
#include <json/json.h>

namespace harness {

struct GradingConfig {
    uint64_t l2MinOutputBytes = 100;
};

struct HarnessConfig {
    std::string soPath;
    std::string executorClass;
    std::vector<std::string> configPaths;
    std::vector<std::string> outputDataNames;
    GradingConfig grading;
};

struct FrameInput {
    uint64_t timestampNs;
    std::string dataName;
    std::string protoType;
    std::vector<uint8_t> protoData;
};

struct InputMetric {
    std::string name;
    std::string protoType;
    uint64_t timestampNs = 0;
    uint64_t dataSize = 0;
    bool idValid = false;
    bool deserialized = false;
    std::string skipReason;
};

struct OutputMetric {
    std::string name;
    uint64_t timestampNs = 0;
    uint64_t dataSize = 0;
    bool nonEmpty = false;
};

struct FrameResult {
    uint64_t timestampNs;
    int statusCode;
    std::string statusName;
    std::string errorMsg;
    Json::Value outputJson;
    double processTimeMs;
    std::vector<InputMetric> inputMetrics;
    std::vector<OutputMetric> outputMetrics;

    int gradeLevel = 0;
    std::string gradeReason;
    uint64_t totalOutputBytes = 0;
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

    // Multi-executor support: load multiple executors sequentially.
    // Each gets its own .so + class + config. Returns per-executor load results.
    struct MultiLoadResult {
        std::string className;
        bool success = false;
        std::string error;
    };
    std::vector<MultiLoadResult> loadMultiple(const std::vector<HarnessConfig>& configs);

    // Process a frame against all loaded executors independently.
    // Returns one FrameResult per executor, in load order.
    std::vector<FrameResult> processFrameMulti(const std::vector<FrameInput>& inputs);

    int executorCount() const { return static_cast<int>(_entries.size()); }

private:
    // Single-executor (legacy) state
    void* _soHandle = nullptr;
    void* _executor = nullptr;
    void* _destroyFn = nullptr;
    bool _initialized = false;
    std::vector<std::string> _outputDataNames;
    GradingConfig _gradingConfig;

    // Multi-executor state
    struct ExecutorEntry {
        std::string className;
        void* soHandle = nullptr;
        void* executor = nullptr;
        bool initialized = false;
        std::vector<std::string> outputDataNames;
    };
    std::vector<ExecutorEntry> _entries;
    void unloadEntry(ExecutorEntry& entry);
    void computeGrade(FrameResult& result);
};

} // namespace harness
