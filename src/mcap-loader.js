import { McapIndexedReader } from '@mcap/core';
import { BlobReadable } from '@mcap/browser';
import { decompress as zstdDecompress } from 'fzstd';

function getDecompressHandlers() {
  return {
    zstd: (buffer, _decompressedSize) => {
      const input = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      const result = zstdDecompress(input);
      return result;
    },
  };
}

/**
 * Parse one or more mcap File objects and return a unified summary.
 * @param {File[]} files
 * @returns {Promise<McapSummary>}
 */
export async function loadMcapFiles(files) {
  const allChannels = [];
  let globalStartNs = BigInt("9999999999999999999");
  let globalEndNs = BigInt(0);
  let totalMessages = 0;

  const decompressHandlers = getDecompressHandlers();
  const readers = [];

  for (const file of files) {
    const readable = new BlobReadable(file);
    const reader = await McapIndexedReader.Initialize({ readable, decompressHandlers });
    readers.push({ reader, filename: file.name });

    const stats = reader.statistics;
    if (!stats) continue;

    const startNs = stats.messageStartTime;
    const endNs = stats.messageEndTime;
    if (startNs < globalStartNs) globalStartNs = startNs;
    if (endNs > globalEndNs) globalEndNs = endNs;
    totalMessages += Number(stats.messageCount);

    for (const [channelId, channel] of reader.channelsById) {
      const schema = reader.schemasById.get(channel.schemaId);
      const msgCount = Number(stats.channelMessageCounts?.get(channelId) ?? 0);
      const durationSec = Number(endNs - startNs) / 1e9;
      const hz = durationSec > 0 ? msgCount / durationSec : 0;

      allChannels.push({
        id: channelId,
        topic: channel.topic,
        schemaName: schema?.name ?? 'unknown',
        schemaEncoding: schema?.encoding ?? '',
        messageCount: msgCount,
        hz: Math.round(hz * 10) / 10,
        sourceFile: file.name,
      });
    }
  }

  const durationNs = globalEndNs - globalStartNs;
  const durationSec = Number(durationNs) / 1e9;

  return {
    channels: allChannels,
    startTimeNs: globalStartNs,
    endTimeNs: globalEndNs,
    durationSec: Math.round(durationSec * 100) / 100,
    totalMessages,
    readers,
  };
}

/**
 * Read messages in a time window for playback.
 * Returns array sorted by logTime.
 */
export async function readMessagesInRange(readers, startNs, endNs, topics) {
  const messages = [];
  for (const { reader } of readers) {
    const opts = { startTime: startNs, endTime: endNs };
    if (topics) opts.topics = topics;
    for await (const msg of reader.readMessages(opts)) {
      messages.push({
        topic: reader.channelsById.get(msg.channelId)?.topic ?? '',
        logTime: msg.logTime,
        channelId: msg.channelId,
        dataSize: msg.data.byteLength,
      });
    }
  }
  messages.sort((a, b) => (a.logTime < b.logTime ? -1 : a.logTime > b.logTime ? 1 : 0));
  return messages;
}
