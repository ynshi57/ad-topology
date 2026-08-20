/**
 * Unit tests for the fault attribution engine.
 *
 * Scenario: a topic-health fault on /mapping/lidar_freespace (system_monitor's
 * topic_monitor, frame-rate degrade, raised first) precedes a downstream
 * data-starvation fault in pnc (kDataDelayTooMuch) on the same topic. The
 * engine should attribute the downstream fault to the earlier topic-health one.
 */
import { strict as assert } from 'assert';
import { buildAlarmTracks, buildFaultEvents } from '../src/fault-rca/fault-events.js';
import { attribute, computeEpisodeScope, Confidence } from '../src/fault-rca/attribution.js';

const CODE_TOPIC_MONITOR = '765633291309023232';   // module 40, reason 1200 (topic health)
const CODE_PNC_DATA_DELAY = '1693374814494982144';  // module 32 (PNC), reason 401 (data delay)
const TOPIC = '/mapping/lidar_freespace';

function alarm(code, app, sub, state) {
  return { code, app, sub_module: sub, category: TOPIC, state_flag: state, module: '', level: 0 };
}

const nexisConfig = {
  topicToPublisher: { [TOPIC]: 'model_infer' },
  topicToSubscribers: { [TOPIC]: ['pnc', 'model_infer'] },
  processes: {},
};

const alarmStream = [
  { sec: 1.0, decoded: { alarm_states: [alarm(CODE_TOPIC_MONITOR, 'system_monitor', 'topic_monitor', true)] } },
  { sec: 1.5, decoded: { alarm_states: [
    alarm(CODE_TOPIC_MONITOR, 'system_monitor', 'topic_monitor', true),
    alarm(CODE_PNC_DATA_DELAY, 'pnc', 'data_center', true),
  ] } },
  { sec: 2.0, decoded: { alarm_states: [
    alarm(CODE_TOPIC_MONITOR, 'system_monitor', 'topic_monitor', true),
    alarm(CODE_PNC_DATA_DELAY, 'pnc', 'data_center', true),
  ] } },
];

const faultStream = [
  { sec: 2.0, decoded: {
    flag: 'SYSTEM_ERROR',
    item: [{ alarm_data: alarm(CODE_PNC_DATA_DELAY, 'pnc', 'data_center', true), vehicle_action: 'SLOW_DOWN', sd_action: 'NONE' }],
    item_list: [
      alarm(CODE_TOPIC_MONITOR, 'system_monitor', 'topic_monitor', true),
      alarm(CODE_PNC_DATA_DELAY, 'pnc', 'data_center', true),
    ],
  } },
];

const alarmResult = buildAlarmTracks(alarmStream);
const events = buildFaultEvents(faultStream);
assert.equal(events.length, 1, 'one fault event');

const rca = attribute(events[0], alarmResult, nexisConfig, { windowSec: 3 });

// Cluster contains both faults
const clusterCodes = rca.cluster.map(n => n.code).sort();
assert.deepEqual(clusterCodes, [CODE_PNC_DATA_DELAY, CODE_TOPIC_MONITOR].sort(), 'cluster has both faults');

// Winner is the pnc data-delay fault
assert.equal(rca.winnerCode, CODE_PNC_DATA_DELAY, 'winner is pnc data delay');
assert.equal(rca.arbitration.winnerDomain, 'PNC', 'winner domain PNC');

// Causal edge: topic-health (upstream) -> data-starvation (downstream)
const edge = rca.edges.find(e => e.from === CODE_TOPIC_MONITOR && e.to === CODE_PNC_DATA_DELAY);
assert.ok(edge, 'edge topic_monitor -> pnc data delay exists');
assert.equal(edge.confidence, Confidence.CONFIGURED, 'same-topic edge is CONFIGURED');

// Root is the earliest, in-degree-0 topic-health fault
assert.deepEqual(rca.roots, [CODE_TOPIC_MONITOR], 'root is the topic-health fault');
const winnerNode = rca.cluster.find(n => n.code === CODE_PNC_DATA_DELAY);
assert.equal(winnerNode.inDegree, 1, 'downstream fault has one incoming edge');

// No causal metadata case: reversed-only cluster still yields a temporal root.
const rca2 = attribute(events[0], buildAlarmTracks([
  { sec: 5.0, decoded: { alarm_states: [alarm(CODE_PNC_DATA_DELAY, 'pnc', 'data_center', true)] } },
]), { topicToPublisher: {}, topicToSubscribers: {}, processes: {} }, { windowSec: 10 });
assert.ok(rca2.roots.length >= 1, 'temporal fallback still produces a root');

// Auto episode scope: a consequence raised AFTER the decision must be classified
// as a chained fault, not a cause candidate; cause candidates stay pre-decision.
{
  const CODE_LATER = '540451849599254500'; // module 32, kDataTimestampInTheFuture
  const later = (state) => ({ code: CODE_LATER, app: 'pnc', sub_module: 'data_center', category: '/perception/occ_fusion_map', state_flag: state, module: '', level: 0 });
  const stream = [
    { sec: 1.0, decoded: { alarm_states: [alarm(CODE_TOPIC_MONITOR, 'system_monitor', 'topic_monitor', true)] } },
    { sec: 2.0, decoded: { alarm_states: [alarm(CODE_TOPIC_MONITOR, 'system_monitor', 'topic_monitor', true)] } },
    { sec: 2.5, decoded: { alarm_states: [alarm(CODE_TOPIC_MONITOR, 'system_monitor', 'topic_monitor', true), later(true)] } },
  ];
  const res = buildAlarmTracks(stream);
  const scope = computeEpisodeScope(events[0], res, 3.0);
  // Earliest active-at-decision RAISE is 1.0; episode end passed as 3.0.
  assert.equal(scope.start, 1.0, 'scope starts at earliest active RAISE');
  assert.equal(scope.end, 3.0, 'scope ends at episode end');
  const rca = attribute(events[0], res, nexisConfig, { scope });
  const cand = rca.cluster.find(n => n.code === CODE_TOPIC_MONITOR);
  const cons = rca.cluster.find(n => n.code === CODE_LATER);
  assert.ok(cand && !cand.raisedAfterEvent, 'pre-decision alarm is a candidate');
  assert.ok(cons && cons.raisedAfterEvent, 'post-decision alarm is a consequence');
}

// Cross-domain upstream backtracking: PNC winner complains about its input
// /neo_map_router/router_output; that topic is published by maprouter, whose
// input /localization/pose carries a localization alarm -> root is localization,
// NOT the PNC winner.
{
  const { traceUpstreamChain } = await import('../src/fault-rca/attribution.js');
  const winner = { code: 'w', app: 'pnc', moduleName: 'pnc', domain: 'PNC', category: '/neo_map_router/router_output', topic: '/neo_map_router/router_output', reason: 1703 };
  const locAlarm = { code: 'l', app: 'location', moduleName: 'location', domain: 'LOCALIZATION', category: '/localization/pose', topic: '/localization/pose', reason: 410, message: 'loc lost' };
  const cfg = {
    topicToPublisher: { '/neo_map_router/router_output': 'maprouter', '/localization/pose': 'location' },
    processes: { maprouter: { sub: [{ topic: '/localization/pose' }] }, location: { sub: [] } },
  };
  const chain = traceUpstreamChain(winner, [winner, locAlarm], cfg);
  const producers = chain.hops.map(h => h.producer);
  assert.ok(producers.includes('maprouter'), 'chain hops through maprouter');
  assert.ok(producers.includes('location'), 'chain reaches localization');
  assert.equal(chain.root.producer, 'location', 'root producer is localization');
  assert.equal(chain.root.kind, 'observed', 'localization root is observed (has alarm)');

  // When the upstream producer has no alarm, root is the suspected direct producer.
  const chain2 = traceUpstreamChain(winner, [winner], cfg);
  assert.equal(chain2.root.producer, 'maprouter', 'suspected root is the direct input publisher');
  assert.equal(chain2.root.kind, 'inferred', 'suspected root is inferred (no alarm)');
}

console.log('fault-attribution tests passed');
