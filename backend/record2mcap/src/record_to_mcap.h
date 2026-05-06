#ifndef AD_TOPOLOGY_RECORD2MCAP_RECORD_TO_MCAP_H_
#define AD_TOPOLOGY_RECORD2MCAP_RECORD_TO_MCAP_H_

#include <cstdint>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace record2mcap {

enum class CompressionMode {
    kNone,
    kZstd,
    kLz4,
};

struct ConvertOptions {
    std::string inputPath;
    std::string outputPath;
    CompressionMode compression = CompressionMode::kZstd;
    // If non-empty, only channels whose topic exactly matches are kept.
    std::unordered_set<std::string> includeTopics;
    // Channels listed here are dropped entirely.
    std::unordered_set<std::string> excludeTopics;
    // When true, re-open the output mcap after writing and sample-check
    // 100 messages byte-for-byte against the original record.
    bool verify = false;
    // Number of random samples used when verify is true.
    int verifySampleCount = 100;
    // Optional report path; defaults to outputPath + ".report.json".
    std::string reportPath;
    // Optional platform (e.g. "X3PRO_25_L"). When set, the converter loads
    // calibration YAML/JSON files for that platform and injects
    // foxglove.CameraCalibration + foxglove.FrameTransform channels for each
    // camera present in the record.
    std::string platform;
    // Optional path overrides for calibration injection. Empty -> defaults.
    std::string calibrationParamRoot;     // perception/.../DefaultParam
    std::string vehicleConfigRoot;        // common_neolix/conf/vehicle_config
    std::string lidarImuYamlPath;         // velodyne16_back_novatel_extrinsics.yaml
};

struct ChannelReport {
    std::string topic;
    std::string protoType;
    std::string schemaSha256;
    uint64_t messageCount = 0;
    uint64_t firstNs = 0;
    uint64_t lastNs = 0;
};

struct ConvertReport {
    std::string inputPath;
    std::string outputPath;
    std::string compression;
    uint64_t totalMessages = 0;
    uint64_t keptMessages = 0;
    uint64_t skippedMessages = 0;
    uint64_t firstNs = 0;
    uint64_t lastNs = 0;
    std::vector<ChannelReport> channels;
    // Lossless assertions that remained true during conversion.
    bool timestampsPreserved = true;
    bool protoDescPreserved = true;
    bool messageBytesPreserved = true;
    // --verify results.
    bool verifyRan = false;
    uint64_t verifySamples = 0;
    uint64_t verifyMismatches = 0;
    std::string verifyNotes;
    // Calibration injection results.
    bool calibrationInjectionRan = false;
    int injectedCalibrationChannels = 0;
    int injectedTransformChannels = 0;
    std::vector<std::string> calibrationWarnings;
    std::string calibrationError;
};

// Runs the conversion. Returns true on full success. Fills outReport with
// per-channel statistics and verification results.
bool ConvertRecordToMcap(const ConvertOptions& options, ConvertReport* outReport,
                         std::string* errorOut);

// Serializes a ConvertReport to JSON text.
std::string ReportToJson(const ConvertReport& report);

// Writes the JSON representation of a ConvertReport to the given path. Creates
// the file if it does not exist. Returns false on IO error.
bool WriteReport(const std::string& path, const ConvertReport& report,
                 std::string* errorOut);

}  // namespace record2mcap

#endif  // AD_TOPOLOGY_RECORD2MCAP_RECORD_TO_MCAP_H_
