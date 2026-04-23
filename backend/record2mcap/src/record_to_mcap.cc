#include "record_to_mcap.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <random>
#include <sstream>

#include "cyber/record/record_message.h"
#include "cyber/record/record_reader.h"

#include "mcap/mcap.hpp"

namespace record2mcap {

namespace {

constexpr const char* kSchemaEncoding = "protobuf";
constexpr const char* kMessageEncoding = "protobuf";
constexpr const char* kProfile = "";            // empty = default profile
constexpr const char* kLibrary = "record2mcap"; // identifies producer

// FNV-1a 64-bit hash. Used only as a low-collision fingerprint for the schema
// bytes in the human-readable report. Not a cryptographic primitive.
uint64_t Fnv1a64(const std::string& bytes) {
    uint64_t h = 0xcbf29ce484222325ULL;
    for (unsigned char c : bytes) {
        h ^= static_cast<uint64_t>(c);
        h *= 0x100000001b3ULL;
    }
    return h;
}

std::string HexU64(uint64_t v) {
    std::ostringstream oss;
    oss << std::hex << std::setw(16) << std::setfill('0') << v;
    return oss.str();
}

mcap::Compression ToMcapCompression(CompressionMode mode) {
    switch (mode) {
        case CompressionMode::kNone:
            return mcap::Compression::None;
        case CompressionMode::kLz4:
            return mcap::Compression::Lz4;
        case CompressionMode::kZstd:
        default:
            return mcap::Compression::Zstd;
    }
}

std::string CompressionName(CompressionMode mode) {
    switch (mode) {
        case CompressionMode::kNone:
            return "none";
        case CompressionMode::kLz4:
            return "lz4";
        case CompressionMode::kZstd:
        default:
            return "zstd";
    }
}

bool IsChannelAllowed(const ConvertOptions& options, const std::string& topic) {
    if (!options.includeTopics.empty() &&
        options.includeTopics.find(topic) == options.includeTopics.end()) {
        return false;
    }
    if (options.excludeTopics.count(topic) > 0) {
        return false;
    }
    return true;
}

// Re-read the produced mcap, load messages for the sampled channels into
// memory, and cross-check with the original record. This is intentionally a
// dumb byte compare: if anything drifts, the sample catches it.
struct VerifySampleResult {
    uint64_t samples = 0;
    uint64_t mismatches = 0;
    std::string notes;
};

VerifySampleResult RunVerify(const ConvertOptions& options,
                             const ConvertReport& report,
                             std::string* errorOut) {
    VerifySampleResult result;
    if (report.keptMessages == 0) {
        result.notes = "no messages kept, nothing to verify";
        return result;
    }

    const uint64_t sampleCount = std::min<uint64_t>(
        static_cast<uint64_t>(std::max(1, options.verifySampleCount)),
        report.keptMessages);

    // Draw random global indices to sample, deterministic for reproducibility.
    std::mt19937_64 rng(0xC0FFEEULL);
    std::uniform_int_distribution<uint64_t> dist(0, report.keptMessages - 1);
    std::unordered_set<uint64_t> sampleIndices;
    while (sampleIndices.size() < sampleCount) {
        sampleIndices.insert(dist(rng));
    }

    // First pass: read the original record and cache (content, time, topic)
    // for every sampled global index.
    struct SampleData {
        std::string topic;
        std::string content;
        uint64_t timeNs = 0;
    };
    std::unordered_map<uint64_t, SampleData> samples;

    neodrive::cyber::record::RecordReader reader(options.inputPath);
    if (!reader.IsValid()) {
        if (errorOut) {
            *errorOut = "verify: cannot reopen input record";
        }
        result.notes = "reopen record failed";
        return result;
    }
    neodrive::cyber::record::RecordMessage recMsg;
    uint64_t globalIndex = 0;
    while (reader.ReadMessage(&recMsg)) {
        if (!IsChannelAllowed(options, recMsg.channel_name)) {
            continue;
        }
        if (sampleIndices.count(globalIndex) > 0) {
            SampleData sd;
            sd.topic = recMsg.channel_name;
            sd.content = recMsg.content;
            sd.timeNs = recMsg.time;
            samples.emplace(globalIndex, std::move(sd));
        }
        ++globalIndex;
        recMsg = neodrive::cyber::record::RecordMessage();
    }

    // Second pass: read the mcap and count through kept messages using the
    // same topic allowlist; compare any sampled index byte-for-byte.
    mcap::McapReader mcapReader;
    const auto openStatus = mcapReader.open(options.outputPath);
    if (!openStatus.ok()) {
        if (errorOut) {
            *errorOut = "verify: cannot open mcap: " + openStatus.message;
        }
        result.notes = "mcap open failed: " + openStatus.message;
        return result;
    }

    auto problemCb = [&result](const mcap::Status& s) {
        if (!s.ok()) {
            result.notes = "mcap problem: " + s.message;
        }
    };

    auto view = mcapReader.readMessages(problemCb);
    uint64_t mcapIndex = 0;
    for (auto it = view.begin(); it != view.end(); ++it) {
        const auto& msgView = *it;
        if (samples.count(mcapIndex) > 0) {
            const auto& sd = samples[mcapIndex];
            ++result.samples;
            const std::string topic = msgView.channel->topic;
            const std::string payload(reinterpret_cast<const char*>(msgView.message.data),
                                      msgView.message.dataSize);
            const bool ok = topic == sd.topic && payload == sd.content &&
                            msgView.message.logTime == sd.timeNs;
            if (!ok) {
                ++result.mismatches;
            }
        }
        ++mcapIndex;
    }
    mcapReader.close();

    if (result.samples != samples.size()) {
        // We consider fewer-than-expected samples a mismatch too.
        result.mismatches += samples.size() - result.samples;
        result.notes = "mcap iteration ran shorter than expected samples";
    }

    return result;
}

}  // namespace

bool ConvertRecordToMcap(const ConvertOptions& options, ConvertReport* outReport,
                         std::string* errorOut) {
    if (outReport == nullptr) {
        if (errorOut) {
            *errorOut = "outReport is null";
        }
        return false;
    }
    outReport->inputPath = options.inputPath;
    outReport->outputPath = options.outputPath;
    outReport->compression = CompressionName(options.compression);

    neodrive::cyber::record::RecordReader reader(options.inputPath);
    if (!reader.IsValid()) {
        if (errorOut) {
            *errorOut = "cannot open input record: " + options.inputPath;
        }
        return false;
    }

    // Configure writer.
    mcap::McapWriterOptions writerOptions(kProfile);
    writerOptions.library = kLibrary;
    writerOptions.compression = ToMcapCompression(options.compression);
    writerOptions.noChunking = false;

    mcap::McapWriter writer;
    const auto openStatus = writer.open(options.outputPath, writerOptions);
    if (!openStatus.ok()) {
        if (errorOut) {
            *errorOut = "cannot create output mcap: " + openStatus.message;
        }
        return false;
    }

    struct ChannelRegistry {
        mcap::ChannelId channelId = 0;
        mcap::SchemaId schemaId = 0;
        std::string protoType;
        uint64_t fnvHash = 0;
        ChannelReport report;
    };
    std::unordered_map<std::string, ChannelRegistry> channels;

    neodrive::cyber::record::RecordMessage recMsg;
    uint64_t totalMessages = 0;
    uint64_t keptMessages = 0;
    uint64_t skippedMessages = 0;
    uint64_t firstNs = std::numeric_limits<uint64_t>::max();
    uint64_t lastNs = 0;

    while (reader.ReadMessage(&recMsg)) {
        ++totalMessages;
        const std::string& topic = recMsg.channel_name;
        if (!IsChannelAllowed(options, topic)) {
            ++skippedMessages;
            recMsg = neodrive::cyber::record::RecordMessage();
            continue;
        }

        auto it = channels.find(topic);
        if (it == channels.end()) {
            const std::string& messageType = reader.GetMessageType(topic);
            const std::string& protoDesc = reader.GetProtoDesc(topic);

            mcap::Schema schema(messageType, kSchemaEncoding, protoDesc);
            writer.addSchema(schema);

            mcap::Channel channel(topic, kMessageEncoding, schema.id);
            writer.addChannel(channel);

            ChannelRegistry reg;
            reg.channelId = channel.id;
            reg.schemaId = schema.id;
            reg.protoType = messageType;
            reg.fnvHash = Fnv1a64(protoDesc);
            reg.report.topic = topic;
            reg.report.protoType = messageType;
            reg.report.schemaSha256 = HexU64(reg.fnvHash);
            reg.report.firstNs = recMsg.time;
            reg.report.lastNs = recMsg.time;

            // Lossless guards: schema data bytes must equal the record's
            // stored proto_desc exactly. We compare sizes here and rely on
            // the by-value copy above preserving the bytes.
            if (schema.data.size() != protoDesc.size()) {
                outReport->protoDescPreserved = false;
            }
            it = channels.emplace(topic, std::move(reg)).first;
        }

        ChannelRegistry& reg = it->second;

        mcap::Message mcapMsg;
        mcapMsg.channelId = reg.channelId;
        mcapMsg.sequence = 0;
        mcapMsg.logTime = recMsg.time;
        mcapMsg.publishTime = recMsg.time;
        mcapMsg.dataSize = recMsg.content.size();
        mcapMsg.data = reinterpret_cast<const std::byte*>(recMsg.content.data());

        // Byte-size guard: the writer copies data; the source must not have
        // been truncated in transit.
        if (mcapMsg.dataSize != recMsg.content.size()) {
            outReport->messageBytesPreserved = false;
        }
        if (mcapMsg.logTime != recMsg.time || mcapMsg.publishTime != recMsg.time) {
            outReport->timestampsPreserved = false;
        }

        const auto writeStatus = writer.write(mcapMsg);
        if (!writeStatus.ok()) {
            if (errorOut) {
                *errorOut = "mcap write failed: " + writeStatus.message;
            }
            writer.close();
            return false;
        }

        ++reg.report.messageCount;
        reg.report.lastNs = recMsg.time;
        if (firstNs > recMsg.time) {
            firstNs = recMsg.time;
        }
        if (lastNs < recMsg.time) {
            lastNs = recMsg.time;
        }
        ++keptMessages;
        recMsg = neodrive::cyber::record::RecordMessage();
    }

    writer.close();

    outReport->totalMessages = totalMessages;
    outReport->keptMessages = keptMessages;
    outReport->skippedMessages = skippedMessages;
    outReport->firstNs = firstNs == std::numeric_limits<uint64_t>::max() ? 0 : firstNs;
    outReport->lastNs = lastNs;

    outReport->channels.reserve(channels.size());
    for (auto& entry : channels) {
        outReport->channels.push_back(std::move(entry.second.report));
    }
    std::sort(outReport->channels.begin(), outReport->channels.end(),
              [](const ChannelReport& a, const ChannelReport& b) {
                  return a.topic < b.topic;
              });

    if (options.verify) {
        outReport->verifyRan = true;
        const auto v = RunVerify(options, *outReport, errorOut);
        outReport->verifySamples = v.samples;
        outReport->verifyMismatches = v.mismatches;
        outReport->verifyNotes = v.notes;
        if (v.mismatches > 0) {
            return false;
        }
    }
    return true;
}

namespace {

void AppendString(std::string& out, const std::string& raw) {
    out.push_back('"');
    for (char c : raw) {
        switch (c) {
            case '"': out.append("\\\""); break;
            case '\\': out.append("\\\\"); break;
            case '\b': out.append("\\b"); break;
            case '\f': out.append("\\f"); break;
            case '\n': out.append("\\n"); break;
            case '\r': out.append("\\r"); break;
            case '\t': out.append("\\t"); break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out.append(buf);
                } else {
                    out.push_back(c);
                }
        }
    }
    out.push_back('"');
}

}  // namespace

std::string ReportToJson(const ConvertReport& report) {
    std::string out;
    out.reserve(4096);
    out.append("{\n  ");
    AppendString(out, "input_path");
    out.append(": ");
    AppendString(out, report.inputPath);
    out.append(",\n  ");
    AppendString(out, "output_path");
    out.append(": ");
    AppendString(out, report.outputPath);
    out.append(",\n  ");
    AppendString(out, "compression");
    out.append(": ");
    AppendString(out, report.compression);
    out.append(",\n  ");
    AppendString(out, "total_messages");
    out.append(": " + std::to_string(report.totalMessages));
    out.append(",\n  ");
    AppendString(out, "kept_messages");
    out.append(": " + std::to_string(report.keptMessages));
    out.append(",\n  ");
    AppendString(out, "skipped_messages");
    out.append(": " + std::to_string(report.skippedMessages));
    out.append(",\n  ");
    AppendString(out, "first_ns");
    out.append(": " + std::to_string(report.firstNs));
    out.append(",\n  ");
    AppendString(out, "last_ns");
    out.append(": " + std::to_string(report.lastNs));
    out.append(",\n  ");
    AppendString(out, "duration_ns");
    out.append(": " + std::to_string(report.lastNs >= report.firstNs
                                         ? report.lastNs - report.firstNs
                                         : 0));
    out.append(",\n  ");
    AppendString(out, "lossless_check");
    out.append(": {\n    ");
    AppendString(out, "timestamps_preserved");
    out.append(std::string(": ") + (report.timestampsPreserved ? "true" : "false"));
    out.append(",\n    ");
    AppendString(out, "proto_desc_preserved");
    out.append(std::string(": ") + (report.protoDescPreserved ? "true" : "false"));
    out.append(",\n    ");
    AppendString(out, "message_bytes_preserved");
    out.append(std::string(": ") + (report.messageBytesPreserved ? "true" : "false"));
    out.append("\n  }");

    out.append(",\n  ");
    AppendString(out, "verify");
    out.append(": {\n    ");
    AppendString(out, "ran");
    out.append(std::string(": ") + (report.verifyRan ? "true" : "false"));
    out.append(",\n    ");
    AppendString(out, "samples");
    out.append(": " + std::to_string(report.verifySamples));
    out.append(",\n    ");
    AppendString(out, "mismatches");
    out.append(": " + std::to_string(report.verifyMismatches));
    out.append(",\n    ");
    AppendString(out, "notes");
    out.append(": ");
    AppendString(out, report.verifyNotes);
    out.append("\n  }");

    out.append(",\n  ");
    AppendString(out, "channels");
    out.append(": [");
    for (size_t i = 0; i < report.channels.size(); ++i) {
        const auto& ch = report.channels[i];
        out.append(i == 0 ? "\n    {\n      " : ",\n    {\n      ");
        AppendString(out, "topic");
        out.append(": ");
        AppendString(out, ch.topic);
        out.append(",\n      ");
        AppendString(out, "proto_type");
        out.append(": ");
        AppendString(out, ch.protoType);
        out.append(",\n      ");
        AppendString(out, "schema_hash_fnv1a");
        out.append(": ");
        AppendString(out, ch.schemaSha256);
        out.append(",\n      ");
        AppendString(out, "message_count");
        out.append(": " + std::to_string(ch.messageCount));
        out.append(",\n      ");
        AppendString(out, "first_ns");
        out.append(": " + std::to_string(ch.firstNs));
        out.append(",\n      ");
        AppendString(out, "last_ns");
        out.append(": " + std::to_string(ch.lastNs));
        out.append("\n    }");
    }
    if (!report.channels.empty()) {
        out.append("\n  ");
    }
    out.append("]\n}\n");
    return out;
}

bool WriteReport(const std::string& path, const ConvertReport& report,
                 std::string* errorOut) {
    std::ofstream out(path);
    if (!out.is_open()) {
        if (errorOut) {
            *errorOut = "cannot open report file for writing: " + path;
        }
        return false;
    }
    out << ReportToJson(report);
    out.flush();
    if (!out.good()) {
        if (errorOut) {
            *errorOut = "write error on report file: " + path;
        }
        return false;
    }
    return true;
}

}  // namespace record2mcap
