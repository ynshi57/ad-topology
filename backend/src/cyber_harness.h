#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include <json/json.h>

namespace harness {

struct CyberConfig {
    std::string soPath;
    std::string className;
    std::string configFilePath;
    std::string flagFilePath;
    std::vector<std::string> inputTopics;
    std::vector<std::string> outputTopics;
};

struct CyberFrameResult {
    uint64_t timestampNs;
    std::string status;
    std::string errorMsg;
    Json::Value capturedOutputs; // topic -> { size, timestamp }
    double elapsedMs;
};

class CyberComponentHarness {
public:
    CyberComponentHarness();
    ~CyberComponentHarness();

    bool load(const CyberConfig& config, std::string& errorOut);
    CyberFrameResult injectMessage(const std::string& topic, uint64_t timestampNs,
                                    const void* data, size_t dataSize);
    void unload();
    bool isLoaded() const { return _loaded; }

private:
    bool _cyberInitialized = false;
    bool _loaded = false;
    void* _classLoader = nullptr;
    void* _component = nullptr;
    void* _harnessNode = nullptr;

    struct WriterEntry { std::string topic; void* writer; };
    struct ReaderEntry {
        std::string topic;
        void* reader;
        std::mutex mtx;
        std::vector<std::pair<uint64_t, size_t>> captured; // timestamp, size
    };

    std::vector<WriterEntry> _writers;
    std::vector<std::shared_ptr<ReaderEntry>> _readers;
};

} // namespace harness
