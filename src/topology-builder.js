/**
 * Build topology graph by fusing mcap channel data with nexis process config.
 *
 * - Nodes = processes (nexis + CyberRT) that have at least one matching mcap topic
 * - Edges = pub/sub relationships from config, filtered to mcap-present topics
 * - All data values (Hz, msgCount, schema) come from mcap
 */

import nexisConfig from './nexis-config.json';

export const DOMAINS = {
  sensor:       { label: 'Sensor',       color: '#4db8c7' },
  perception:   { label: 'Perception',   color: '#c7943a' },
  localization: { label: 'Localization', color: '#3aaa7a' },
  pnc:          { label: 'PNC',          color: '#5b8fd9' },
  system:       { label: 'System',       color: '#8a73c7' },
  recorder:     { label: 'Recorder',     color: '#777777' },
  maprouter:    { label: 'MapRouter',    color: '#d4884d' },
  openapi:      { label: 'OpenAPI',      color: '#6b8f8f' },
  unknown:      { label: 'Unknown',      color: '#555555' },
};

function filterDataChannels(channels) {
  return channels.filter(ch => {
    const t = ch.topic;
    if (t.startsWith('/sensor/camera/') && t.endsWith('/video')) return true;
    if (ch.schemaName.startsWith('foxglove.')) return false;
    if (t.endsWith('_3d') || t.endsWith('/grid') || t.endsWith('/fix/gcj02')) return false;
    if (t.endsWith('/trajectory') || t.endsWith('/poses_in_frame')) return false;
    if (t.includes('/target_line') || t.includes('/ego_line')) return false;
    if (t.includes('/ego_car') || t.includes('/perception_obstacle') || t.includes('/plane')) return false;
    return true;
  });
}

/**
 * @param {Array} mcapChannels — raw channels from mcap-loader
 * @returns {{ nodes, links, LAYER_MAP }}
 */
export function buildTopologyFromChannels(mcapChannels) {
  const dataChannels = filterDataChannels(mcapChannels);
  const mcapByTopic = {};
  dataChannels.forEach(ch => { mcapByTopic[ch.topic] = ch; });

  const { processes, topicToPublisher, topicToSubscribers } = nexisConfig;

  // Step 1: assign each mcap channel to its publisher process
  const processTopics = {}; // processName -> [mcapChannel, ...]

  for (const ch of dataChannels) {
    const publisher = topicToPublisher[ch.topic];
    if (publisher) {
      if (!processTopics[publisher]) processTopics[publisher] = [];
      processTopics[publisher].push(ch);
      ch.publisher = publisher;
    }
  }

  // Also activate subscriber-only processes that subscribe to mcap-present topics
  const activeSubscribers = new Set();
  for (const [procName, proc] of Object.entries(processes)) {
    for (const sub of proc.sub) {
      if (mcapByTopic[sub.topic]) {
        activeSubscribers.add(procName);
        break;
      }
    }
  }

  const allActiveProcs = new Set([...Object.keys(processTopics), ...activeSubscribers]);

  // Orphan channels (in mcap but no known publisher)
  const orphans = dataChannels.filter(ch => !ch.publisher);
  if (orphans.length > 0) {
    allActiveProcs.add('_unknown');
    processTopics['_unknown'] = orphans;
    orphans.forEach(ch => { ch.publisher = '_unknown'; });
  }

  // Step 2: build nodes
  const nodes = [];
  const layerMap = {};

  for (const procName of allActiveProcs) {
    const procConfig = processes[procName];
    const topics = processTopics[procName] || [];
    const domain = procName === '_unknown' ? 'unknown' : (procConfig?.domain || 'system');
    const layer = procName === '_unknown' ? 7 : (procConfig?.layer ?? 5);

    layerMap[procName] = layer;

    nodes.push({
      id: procName,
      domain,
      runtime: procConfig?.runtime || 'unknown',
      components: [...new Set(topics.map(t => t.schemaName))].filter(s => s && s !== 'unknown').slice(0, 4),
      pubCount: topics.length,
      subCount: 0,
      totalMessages: topics.reduce((a, t) => a + t.messageCount, 0),
      topics: topics.map(t => ({
        topic: t.topic,
        schema: t.schemaName,
        hz: t.hz,
        messageCount: t.messageCount,
      })),
    });
  }

  // Step 3: build edges from config sub lists, filtered to mcap-present topics
  const linkMap = {};

  for (const [procName, proc] of Object.entries(processes)) {
    if (!allActiveProcs.has(procName)) continue;

    for (const sub of proc.sub) {
      const mcapCh = mcapByTopic[sub.topic];
      if (!mcapCh) continue;

      const publisher = topicToPublisher[sub.topic];
      if (!publisher || !allActiveProcs.has(publisher) || publisher === procName) continue;

      const key = `${publisher}\x00${procName}`;
      if (!linkMap[key]) {
        linkMap[key] = { source: publisher, target: procName, topics: [] };
      }
      if (!linkMap[key].topics.find(t => t.topic === sub.topic)) {
        linkMap[key].topics.push({
          topic: sub.topic,
          schema: mcapCh.schemaName,
          hz: mcapCh.hz,
          messageCount: mcapCh.messageCount,
        });
      }
    }
  }

  const links = Object.values(linkMap);

  for (const link of links) {
    const tgt = nodes.find(n => n.id === link.target);
    if (tgt) tgt.subCount += link.topics.length;
  }

  return { nodes, links, LAYER_MAP: layerMap };
}
