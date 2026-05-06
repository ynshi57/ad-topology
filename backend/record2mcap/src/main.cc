#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "record_to_mcap.h"

namespace {

void PrintUsage(const char* argv0) {
    std::cerr
        << "Usage: " << argv0 << " <input.record> <output.mcap> [options]\n"
        << "\n"
        << "Options:\n"
        << "  --compression <none|zstd|lz4>   Chunk compression (default: zstd)\n"
        << "  --include topic1,topic2,...     Keep only these topics\n"
        << "  --exclude topic1,topic2,...     Drop these topics\n"
        << "  --verify                        Sample-check 100 messages byte-for-byte\n"
        << "  --verify-samples N              Override number of verify samples\n"
        << "  --report <path.json>            Output report path (default: <out>.report.json)\n"
        << "  --platform <name>               Inject camera calibration for this vehicle\n"
        << "                                  platform (e.g. X3PRO_25_L, X6, X6S, X2O...)\n"
        << "  --calib-param-root <dir>        Override DefaultParam root directory\n"
        << "  --vehicle-config-root <dir>     Override vehicle_config directory\n"
        << "  --lidar-imu-yaml <path>         Override velodyne16_back_novatel YAML\n"
        << "  --quiet                         Suppress progress output\n"
        << "  -h, --help                      Show this help\n";
}

std::vector<std::string> SplitCsv(const std::string& value) {
    std::vector<std::string> parts;
    std::string cur;
    for (char c : value) {
        if (c == ',') {
            if (!cur.empty()) {
                parts.push_back(cur);
                cur.clear();
            }
        } else {
            cur.push_back(c);
        }
    }
    if (!cur.empty()) {
        parts.push_back(cur);
    }
    return parts;
}

bool ParseCompression(const std::string& value, record2mcap::CompressionMode* out,
                      std::string* errorOut) {
    if (value == "none") {
        *out = record2mcap::CompressionMode::kNone;
        return true;
    }
    if (value == "zstd") {
        *out = record2mcap::CompressionMode::kZstd;
        return true;
    }
    if (value == "lz4") {
        *out = record2mcap::CompressionMode::kLz4;
        return true;
    }
    if (errorOut != nullptr) {
        *errorOut = "unknown --compression value: " + value;
    }
    return false;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        PrintUsage(argv[0]);
        return argc == 2 && (std::strcmp(argv[1], "-h") == 0 ||
                             std::strcmp(argv[1], "--help") == 0)
                   ? 0
                   : 2;
    }

    record2mcap::ConvertOptions options;
    options.inputPath = argv[1];
    options.outputPath = argv[2];

    bool quiet = false;

    for (int i = 3; i < argc; ++i) {
        const std::string arg = argv[i];
        auto next = [&](const std::string& name) -> std::string {
            if (i + 1 >= argc) {
                std::cerr << "error: " << name << " requires a value" << std::endl;
                std::exit(2);
            }
            return argv[++i];
        };

        if (arg == "-h" || arg == "--help") {
            PrintUsage(argv[0]);
            return 0;
        } else if (arg == "--compression") {
            std::string err;
            if (!ParseCompression(next(arg), &options.compression, &err)) {
                std::cerr << "error: " << err << std::endl;
                return 2;
            }
        } else if (arg == "--include") {
            for (auto& t : SplitCsv(next(arg))) {
                options.includeTopics.insert(t);
            }
        } else if (arg == "--exclude") {
            for (auto& t : SplitCsv(next(arg))) {
                options.excludeTopics.insert(t);
            }
        } else if (arg == "--verify") {
            options.verify = true;
        } else if (arg == "--verify-samples") {
            try {
                options.verifySampleCount = std::stoi(next(arg));
            } catch (const std::exception& e) {
                std::cerr << "error: --verify-samples requires integer: " << e.what()
                          << std::endl;
                return 2;
            }
        } else if (arg == "--report") {
            options.reportPath = next(arg);
        } else if (arg == "--platform") {
            options.platform = next(arg);
        } else if (arg == "--calib-param-root") {
            options.calibrationParamRoot = next(arg);
        } else if (arg == "--vehicle-config-root") {
            options.vehicleConfigRoot = next(arg);
        } else if (arg == "--lidar-imu-yaml") {
            options.lidarImuYamlPath = next(arg);
        } else if (arg == "--quiet") {
            quiet = true;
        } else {
            std::cerr << "error: unknown argument: " << arg << std::endl;
            PrintUsage(argv[0]);
            return 2;
        }
    }

    if (options.reportPath.empty()) {
        options.reportPath = options.outputPath + ".report.json";
    }

    if (!quiet) {
        std::cout << "record2mcap: " << options.inputPath << " -> "
                  << options.outputPath << std::endl;
        std::cout << "  compression = ";
        switch (options.compression) {
            case record2mcap::CompressionMode::kNone: std::cout << "none"; break;
            case record2mcap::CompressionMode::kLz4: std::cout << "lz4"; break;
            case record2mcap::CompressionMode::kZstd: std::cout << "zstd"; break;
        }
        std::cout << std::endl;
        if (!options.includeTopics.empty()) {
            std::cout << "  include topics: " << options.includeTopics.size() << std::endl;
        }
        if (!options.excludeTopics.empty()) {
            std::cout << "  exclude topics: " << options.excludeTopics.size() << std::endl;
        }
        if (options.verify) {
            std::cout << "  verify samples: " << options.verifySampleCount << std::endl;
        }
        if (!options.platform.empty()) {
            std::cout << "  platform = " << options.platform
                      << " (calibration injection enabled)" << std::endl;
        }
        std::cout << "  report = " << options.reportPath << std::endl;
    }

    record2mcap::ConvertReport report;
    std::string err;
    const bool ok = record2mcap::ConvertRecordToMcap(options, &report, &err);

    std::string writeErr;
    if (!record2mcap::WriteReport(options.reportPath, report, &writeErr)) {
        std::cerr << "warn: failed to write report: " << writeErr << std::endl;
    }

    if (!ok) {
        std::cerr << "error: " << (err.empty() ? "conversion failed" : err) << std::endl;
        return 1;
    }

    if (!quiet) {
        std::cout << "done: kept " << report.keptMessages << " / " << report.totalMessages
                  << " messages across " << report.channels.size() << " channels"
                  << std::endl;
        if (options.verify) {
            std::cout << "verify: " << report.verifySamples << " samples, "
                      << report.verifyMismatches << " mismatches" << std::endl;
        }
        if (report.calibrationInjectionRan) {
            std::cout << "calibration injection: "
                      << report.injectedCalibrationChannels << " camera_info + "
                      << report.injectedTransformChannels << " transform channels"
                      << std::endl;
            if (!report.calibrationError.empty()) {
                std::cout << "  error: " << report.calibrationError << std::endl;
            }
            for (const auto& w : report.calibrationWarnings) {
                std::cout << "  warn: " << w << std::endl;
            }
        }
    }

    return 0;
}
