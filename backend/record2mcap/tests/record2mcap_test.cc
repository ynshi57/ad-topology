// End-to-end lossless test for record2mcap.
// Builds a tiny record on disk, runs the converter, then re-reads the
// produced mcap and asserts byte-for-byte equality of channel / schema /
// message bytes against the original record.

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <string>
#include <unordered_map>
#include <vector>

#include <gtest/gtest.h>

#include "cyber/record/record_reader.h"
#include "cyber/record/record_writer.h"

#include "mcap/mcap.hpp"

#include "record_to_mcap.h"

namespace {

struct ExpectedMessage {
    std::string topic;
    std::string payload;
    uint64_t timeNs = 0;
};

std::filesystem::path MakeTempDir() {
    auto base = std::filesystem::temp_directory_path() /
                ("record2mcap_test_" + std::to_string(getpid()));
    std::filesystem::create_directories(base);
    return base;
}

void BuildMiniRecord(const std::string& path,
                     std::vector<ExpectedMessage>* outMessages,
                     std::unordered_map<std::string, std::string>* outProtoDescs,
                     std::unordered_map<std::string, std::string>* outMessageTypes) {
    using neodrive::cyber::record::RecordWriter;
    RecordWriter writer(false /* use_zero_copy */);
    writer.SetSizeOfFileSegmentation(0);
    writer.SetIntervalOfFileSegmentation(0);
    ASSERT_TRUE(writer.Open(path));

    struct Plan {
        std::string topic;
        std::string messageType;
        std::string protoDesc;
    };
    const std::vector<Plan> plans = {
        {"/topic/alpha", "example.Alpha",
         std::string({'\x0a', '\x05', 'a', 'l', 'p', 'h', 'a'})},
        {"/topic/beta", "example.Beta",
         std::string({'\x0a', '\x04', 'b', 'e', 't', 'a'})},
    };

    for (const auto& p : plans) {
        ASSERT_TRUE(writer.WriteChannel(p.topic, p.messageType, p.protoDesc));
        (*outProtoDescs)[p.topic] = p.protoDesc;
        (*outMessageTypes)[p.topic] = p.messageType;
    }

    const std::vector<ExpectedMessage> plan = {
        {"/topic/alpha", std::string("hello"), 1000},
        {"/topic/beta", std::string("\x00\x01\x02\x03\x04", 5), 1200},
        {"/topic/alpha", std::string("world"), 1400},
        {"/topic/beta", std::string("\xff\xfe\xfd", 3), 1600},
        {"/topic/alpha", std::string("third"), 1800},
    };

    for (const auto& msg : plan) {
        ASSERT_TRUE(writer.WriteMessage(msg.topic, msg.payload, msg.timeNs));
        outMessages->push_back(msg);
    }

    writer.Close();
}

}  // namespace

TEST(Record2Mcap, LosslessEndToEnd) {
    const auto dir = MakeTempDir();
    const auto recordPath = (dir / "mini.record").string();
    const auto mcapPath = (dir / "mini.mcap").string();
    const auto reportPath = (dir / "mini.report.json").string();

    std::vector<ExpectedMessage> expected;
    std::unordered_map<std::string, std::string> expectedProtoDescs;
    std::unordered_map<std::string, std::string> expectedMessageTypes;
    BuildMiniRecord(recordPath, &expected, &expectedProtoDescs,
                    &expectedMessageTypes);

    record2mcap::ConvertOptions options;
    options.inputPath = recordPath;
    options.outputPath = mcapPath;
    options.reportPath = reportPath;
    options.verify = true;
    options.verifySampleCount = 5;
    options.compression = record2mcap::CompressionMode::kNone;

    record2mcap::ConvertReport report;
    std::string err;
    ASSERT_TRUE(record2mcap::ConvertRecordToMcap(options, &report, &err)) << err;
    ASSERT_EQ(report.keptMessages, expected.size());
    ASSERT_EQ(report.totalMessages, expected.size());
    ASSERT_EQ(report.skippedMessages, 0u);
    ASSERT_TRUE(report.timestampsPreserved);
    ASSERT_TRUE(report.protoDescPreserved);
    ASSERT_TRUE(report.messageBytesPreserved);
    ASSERT_TRUE(report.verifyRan);
    ASSERT_EQ(report.verifyMismatches, 0u);

    // Re-open mcap and compare every single message/channel/schema against the
    // original record plan. This is stronger than --verify (which samples).
    mcap::McapReader reader;
    ASSERT_TRUE(reader.open(mcapPath).ok());

    // Force summary to be populated so schemas_/channels_ are ready.
    const auto summaryStatus = reader.readSummary(mcap::ReadSummaryMethod::AllowFallbackScan);
    ASSERT_TRUE(summaryStatus.ok()) << summaryStatus.message;

    std::unordered_map<uint16_t, mcap::SchemaPtr> schemas;
    std::unordered_map<uint16_t, mcap::ChannelPtr> channels;
    for (const auto& entry : reader.schemas()) {
        schemas.emplace(entry.first, entry.second);
    }
    for (const auto& entry : reader.channels()) {
        channels.emplace(entry.first, entry.second);
    }
    ASSERT_EQ(channels.size(), 2u);

    for (const auto& [id, channel] : channels) {
        ASSERT_EQ(channel->messageEncoding, "protobuf");
        const auto schemaIt = schemas.find(channel->schemaId);
        ASSERT_NE(schemaIt, schemas.end());
        const auto& schema = schemaIt->second;
        ASSERT_EQ(schema->encoding, "protobuf");
        const auto msgTypeIt = expectedMessageTypes.find(channel->topic);
        ASSERT_NE(msgTypeIt, expectedMessageTypes.end());
        EXPECT_EQ(schema->name, msgTypeIt->second);
        const auto descIt = expectedProtoDescs.find(channel->topic);
        ASSERT_NE(descIt, expectedProtoDescs.end());
        const std::string expectedDesc = descIt->second;
        const std::string actualDesc(
            reinterpret_cast<const char*>(schema->data.data()), schema->data.size());
        EXPECT_EQ(actualDesc, expectedDesc);
    }

    size_t index = 0;
    auto view = reader.readMessages();
    for (auto it = view.begin(); it != view.end(); ++it) {
        ASSERT_LT(index, expected.size());
        const auto& view_msg = *it;
        const auto& expectedMsg = expected[index];
        EXPECT_EQ(view_msg.channel->topic, expectedMsg.topic);
        EXPECT_EQ(view_msg.message.logTime, expectedMsg.timeNs);
        EXPECT_EQ(view_msg.message.publishTime, expectedMsg.timeNs);
        const std::string payload(
            reinterpret_cast<const char*>(view_msg.message.data),
            view_msg.message.dataSize);
        EXPECT_EQ(payload, expectedMsg.payload);
        ++index;
    }
    EXPECT_EQ(index, expected.size());
    reader.close();

    // cleanup to keep /tmp tidy
    std::filesystem::remove_all(dir);
}
