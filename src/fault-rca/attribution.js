/**
 * Fault root-cause attribution engine (deterministic, explainable).
 *
 * There is NO explicit causality in the alarm/fault data, so every causal edge
 * is INFERRED from one of three grounded signals, each carrying an explicit
 * confidence label:
 *   - OBSERVED   : temporal precedence within the co-occurring cluster
 *   - CONFIGURED : two faults share a `category` topic, one is topic-health
 *                  (producer/source) and the other is consumer data-starvation
 *   - INFERRED   : producer→subscriber relation from the pub/sub topology graph
 *
 * The engine never claims certain causation; it ranks candidates and exposes
 * the evidence so a human can judge.
 */
import { classifyDomain } from './fault-code.js';
import { isDataStarvationReason, isTopicHealthReason } from './fault-code.js';
import { trackActiveAt } from './fault-events.js';

export const Confidence = {
  OBSERVED: 'OBSERVED',
  CONFIGURED: 'CONFIGURED',
  INFERRED: 'INFERRED',
};

export const EdgeKind = {
  TOPIC_HEALTH_TO_STARVATION: 'topic_health->data_starvation',
  PRODUCER_TO_SUBSCRIBER: 'producer->subscriber',
  TEMPORAL_LEAD: 'temporal_lead',
};

function isSourceHealth(alarm) {
  return isTopicHealthReason(alarm.reason) || alarm.subModule === 'topic_monitor';
}

/**
 * Build the co-occurring cluster of alarms around the fault event time.
 * A track qualifies if any RAISE interval overlaps [t - windowSec, t], plus we
 * always include the winner and the output's active snapshot codes.
 */
function buildCluster(event, alarmResult, windowSec, scope) {
  const t = event.sec;
  // Scope: either an explicit data-driven episode [start, end] (auto mode, no
  // user knob) or a fixed backward window [t - windowSec, t] (default / tests).
  const lo = scope ? scope.start : t - windowSec;
  const hi = scope ? scope.end : t;
  const nodesByCode = new Map();

  const addFromTrack = (track) => {
    if (nodesByCode.has(track.code)) return;
    nodesByCode.set(track.code, {
      code: track.code,
      alarm: track.alarm,
      firstRaiseSec: track.firstRaiseSec,
      // "active at decision" = active at the fault_manager output time t.
      activeAtEvent: trackActiveAt(track, t),
      // Raised strictly after the decision -> a consequence / chained fault.
      raisedAfterEvent: track.firstRaiseSec != null && track.firstRaiseSec > t + 1e-6,
      inDegree: 0,
      isWinner: false,
    });
  };

  for (const track of alarmResult.tracks) {
    const overlaps = track.intervals.some(([s, e]) => e >= lo && s <= hi);
    const openInWindow = track.firstRaiseSec != null && track.firstRaiseSec <= hi && track.active;
    if (overlaps || openInWindow) addFromTrack(track);
  }

  // Ensure the output's active snapshot alarms are represented even if their
  // track was not captured (e.g. partial stream).
  const trackByCode = new Map(alarmResult.tracks.map(tr => [tr.code, tr]));
  const injectAlarm = (alarm) => {
    if (!alarm || nodesByCode.has(alarm.code)) return;
    const tr = trackByCode.get(alarm.code);
    nodesByCode.set(alarm.code, {
      code: alarm.code,
      alarm,
      firstRaiseSec: tr ? tr.firstRaiseSec : t,
      activeAtEvent: true,
      raisedAfterEvent: false,
      inDegree: 0,
      isWinner: false,
    });
  };
  for (const snap of event.activeSnapshot || []) injectAlarm(snap);
  // The arbitration winner must always be present, even when item_list is empty
  // (some recordings don't populate it) and its track fell outside the window.
  injectAlarm(event.winner);

  return nodesByCode;
}

/**
 * @param {object} event           one entry from buildFaultEvents
 * @param {object} alarmResult      output of buildAlarmTracks
 * @param {object} nexisConfig      { topicToPublisher, topicToSubscribers }
 * @param {object} [opts]           { windowSec = 3 }
 */
export function attribute(event, alarmResult, nexisConfig = {}, opts = {}) {
  const windowSec = opts.windowSec ?? 3;
  const scope = opts.scope || null; // data-driven episode from the view; else window
  const topicToPublisher = nexisConfig.topicToPublisher || {};
  const topicToSubscribers = nexisConfig.topicToSubscribers || {};

  const nodesByCode = buildCluster(event, alarmResult, windowSec, scope);
  const winnerCode = event.summary?.code || event.winner?.code || null;
  if (winnerCode && nodesByCode.has(winnerCode)) {
    nodesByCode.get(winnerCode).isWinner = true;
  }

  const nodes = [...nodesByCode.values()];
  const edges = [];
  const edgeKey = new Set();
  const addEdge = (from, to, kind, confidence) => {
    if (from === to) return;
    const key = `${from}->${to}`;
    if (edgeKey.has(key)) return;
    edgeKey.add(key);
    edges.push({ from, to, kind, confidence });
    const target = nodesByCode.get(to);
    if (target) target.inDegree += 1;
  };

  // Pairwise causal inference.
  for (const a of nodes) {
    for (const b of nodes) {
      if (a.code === b.code) continue;
      const at = a.alarm.topic;
      const bt = b.alarm.topic;

      // R1 CONFIGURED: same topic, A source-health -> B data-starvation.
      if (at && bt && at === bt &&
          isSourceHealth(a.alarm) && isDataStarvationReason(b.alarm.reason)) {
        addEdge(a.code, b.code, EdgeKind.TOPIC_HEALTH_TO_STARVATION, Confidence.CONFIGURED);
        continue;
      }

      // R2 INFERRED: A is on topic T; B's process subscribes T and B is a
      // data-starvation consumer -> producer/source health leads B.
      if (at && isDataStarvationReason(b.alarm.reason)) {
        const subs = topicToSubscribers[at] || [];
        const aIsSource = a.alarm.app === topicToPublisher[at] || isSourceHealth(a.alarm);
        if (aIsSource && subs.includes(b.alarm.app)) {
          addEdge(a.code, b.code, EdgeKind.PRODUCER_TO_SUBSCRIBER, Confidence.INFERRED);
        }
      }
    }
  }

  // Roots = in-degree-0 nodes, earliest RAISE first.
  const byFirstRaise = (x, y) => (x.firstRaiseSec ?? Infinity) - (y.firstRaiseSec ?? Infinity);
  let rootNodes = nodes.filter(n => n.inDegree === 0).sort(byFirstRaise);

  // OBSERVED fallback: no causal edges at all -> earliest riser is the temporal
  // root candidate for the whole cluster.
  if (edges.length === 0 && nodes.length > 0) {
    rootNodes = [...nodes].sort(byFirstRaise).slice(0, 1);
  }

  const ranked = [...nodes].sort((x, y) => (x.inDegree - y.inDegree) || byFirstRaise(x, y));

  // Cross-domain upstream backtracking from the winner's input topic.
  const winnerNode = nodes.find(n => n.isWinner);
  const winnerAlarm = winnerNode?.alarm || event.winner || null;
  const upstreamChain = traceUpstreamChain(winnerAlarm, nodes.map(n => n.alarm).filter(Boolean), nexisConfig);

  // Arbitration context (why fault_manager chose this output, distinct from
  // root cause). Mirrors classifyDomain + the multi-domain-boost heuristic.
  const domainsActive = new Set(nodes.filter(n => n.activeAtEvent).map(n => n.alarm.domain));
  const arbitration = {
    winnerDomain: winnerCode ? classifyDomain(winnerCode) : null,
    domainsActive: [...domainsActive],
    multiDomainBoost: domainsActive.size >= 2,
    vehicleAction: event.summary?.vehicleAction ?? null,
    sdAction: event.summary?.sdAction ?? null,
  };

  return {
    event,
    windowSec,
    scope,
    cluster: nodes,
    edges,
    roots: rootNodes.map(n => n.code),
    ranked,
    winnerCode,
    winnerAlarm,
    upstreamChain,
    arbitration,
  };
}

/**
 * Cross-domain upstream backtracking (the core "回溯").
 *
 * The arbitration winner is usually a CONSUMER fault: it complains that one of
 * its input topics is missing/stale (its `category` is that input topic). The
 * true root often lies upstream: the topic's publisher, or the publisher's own
 * upstream, may be the actual failing module (e.g. a localization fault that
 * propagates through maprouter and finally trips a PNC input check). We walk the
 * pub/sub graph from the winner's input topic toward the source, following hops
 * that carry an active alarm when possible.
 *
 * @param {object} winnerAlarm       normalized winner alarm
 * @param {Array}  activeAlarms      normalized alarms active in the episode
 * @param {object} nexisConfig       { topicToPublisher, processes }
 * @returns {{ hops: Array<{topic,producer,alarm,kind}>, root: object|null }}
 */
export function traceUpstreamChain(winnerAlarm, activeAlarms, nexisConfig = {}, opts = {}) {
  const maxHops = opts.maxHops ?? 6;
  const t2p = nexisConfig.topicToPublisher || {};
  const procs = nexisConfig.processes || {};
  const matches = (alarm, proc) => !!alarm && !!proc && (alarm.app === proc || alarm.moduleName === proc);
  const alarmAt = (proc) => activeAlarms.find(a => matches(a, proc));

  const hops = [];
  const visited = new Set();
  let topic = winnerAlarm && (winnerAlarm.topic || (winnerAlarm.category?.startsWith('/') ? winnerAlarm.category : null));
  let depth = 0;

  while (topic && depth < maxHops && !visited.has(topic)) {
    visited.add(topic);
    const producer = t2p[topic] || null;
    const alarm = producer ? alarmAt(producer) : null;
    hops.push({ topic, producer, alarm: alarm || null, kind: alarm ? 'observed' : 'inferred' });
    if (!producer) break;

    // Choose the next upstream topic: one of the producer's subscribed inputs
    // that itself carries an active alarm (observed) or whose own publisher has
    // an active alarm — that's the branch worth following toward the source.
    const subs = (procs[producer]?.sub || []).map(s => s.topic).filter(Boolean);
    let next = null;
    for (const st of subs) {
      if (visited.has(st)) continue;
      const p2 = t2p[st];
      if (activeAlarms.some(a => a.category === st || matches(a, p2))) { next = st; break; }
    }
    topic = next;
    depth++;
  }

  // Root = furthest-upstream hop that carries a real alarm (observed root); if
  // none upstream reported, the last reachable producer is the suspected root.
  let root = null;
  for (const h of hops) if (h.alarm) root = h;
  if (!root && hops.length) root = hops[hops.length - 1];
  return { hops, root };
}

/**
 * Data-driven analysis scope for a fault event, so the user never tunes a knob.
 * Cause candidates are the alarms active at the decision time t; the scope
 * reaches back to the earliest RAISE among them and forward to the end of the
 * error episode (episodeEndSec, supplied by the caller from the fault_process
 * event list). Falls back to a tight span when nothing is active.
 * @returns {{start:number, end:number}}
 */
export function computeEpisodeScope(event, alarmResult, episodeEndSec) {
  const t = event.sec;
  const activeAtDecision = alarmResult.tracks.filter(tr => trackActiveAt(tr, t));
  const raises = activeAtDecision.map(tr => tr.firstRaiseSec).filter(v => v != null);
  const start = raises.length ? Math.min(...raises) : t;
  const end = episodeEndSec != null && episodeEndSec > t ? episodeEndSec : (alarmResult.endSec || t);
  return { start, end };
}
