/**
 * Extract time-ordered fault data from decoded mcap messages:
 *  - alarm tracks (per-code RAISE/CLEAR intervals) from AlarmStateDataList
 *  - discrete fault_manager output events from FaultProcess
 *
 * The pure builders take arrays of { sec, decoded } so they can be unit-tested
 * without a browser / proto decoder. buildStreamsFromCache() adapts the runtime
 * msgDataCache via an injected decode function.
 */
import { decodeFaultCode, classifyDomain, reasonName, MODULE_NAMES } from './fault-code.js';

export const ALARM_TOPIC = '/nexis/security/alarm/alarm_state_data';
export const FAULT_TOPIC = '/nexis/security/alarm/fault_process';

// Normalize a protobuf uint64 code (String longs, Number, bigint, or Long
// object) to an exact decimal string.
export function normalizeCodeRaw(code) {
  if (code == null) return '0';
  if (typeof code === 'string') return code;
  if (typeof code === 'bigint') return code.toString();
  if (typeof code === 'number') return String(Math.trunc(code));
  if (typeof code === 'object' && 'low' in code && 'high' in code) {
    const hi = BigInt(code.high >>> 0);
    const lo = BigInt(code.low >>> 0);
    return ((hi << 32n) | lo).toString();
  }
  return String(code);
}

function pick(obj, camel, snake) {
  return obj[camel] !== undefined ? obj[camel] : obj[snake];
}

/**
 * Normalize a single AlarmStateData proto object into a display + attribution
 * friendly record, merging proto string fields with bitfield-derived values.
 */
export function normalizeAlarm(a) {
  const codeRaw = normalizeCodeRaw(a.code);
  const f = decodeFaultCode(codeRaw);
  const category = a.category || '';
  return {
    code: codeRaw,
    domain: classifyDomain(codeRaw),
    moduleId: f.module,
    moduleName: a.module || MODULE_NAMES[f.module] || String(f.module),
    subModule: pick(a, 'subModule', 'sub_module') || '',
    app: a.app || '',
    category,
    topic: category.startsWith('/') ? category : null,
    level: a.level != null ? Number(a.level) : f.level,
    reason: f.reason,
    reasonName: reasonName(f.reason),
    message: a.message || '',
    stateFlag: !!pick(a, 'stateFlag', 'state_flag'),
  };
}

function alarmListOf(decoded) {
  return pick(decoded, 'alarmStates', 'alarm_states') || [];
}

/**
 * Build per-code alarm tracks with RAISE/CLEAR intervals.
 * @param {Array<{sec:number, decoded:object}>} alarmStream time-sorted
 * @returns {{ tracks: Array, events: Array, endSec: number }}
 */
export function buildAlarmTracks(alarmStream) {
  const byCode = new Map();
  const events = [];
  const endSec = alarmStream.length ? alarmStream[alarmStream.length - 1].sec : 0;

  for (const { sec, decoded } of alarmStream) {
    if (!decoded) continue;
    for (const raw of alarmListOf(decoded)) {
      const alarm = normalizeAlarm(raw);
      events.push({ sec, code: alarm.code, active: alarm.stateFlag, alarm });

      let t = byCode.get(alarm.code);
      if (!t) {
        t = { code: alarm.code, alarm, intervals: [], firstRaiseSec: null, lastSec: sec, active: false, _open: null };
        byCode.set(alarm.code, t);
      }
      t.alarm = alarm;
      t.lastSec = sec;
      if (alarm.stateFlag) {
        if (t.firstRaiseSec == null) t.firstRaiseSec = sec;
        if (t._open == null) t._open = sec;
        t.active = true;
      } else {
        if (t._open != null) { t.intervals.push([t._open, sec]); t._open = null; }
        t.active = false;
      }
    }
  }

  for (const t of byCode.values()) {
    if (t._open != null) { t.intervals.push([t._open, endSec]); }
    delete t._open;
  }
  return { tracks: [...byCode.values()], events, endSec };
}

/**
 * Whether a track is active at time sec (in one of its RAISE intervals, or
 * opened before sec with no later CLEAR).
 */
export function trackActiveAt(track, sec) {
  for (const [s, e] of track.intervals) {
    if (sec >= s && sec <= e) return true;
  }
  return false;
}

// Ported from attribution/stages/s4-output-diff.js summarizeFaultProcess, with
// exact string codes.
export function summarizeFaultProcess(fp) {
  if (!fp) return null;
  const items = fp.item || [];
  const first = items[0] || {};
  const alarm = pick(first, 'alarmData', 'alarm_data') || {};
  return {
    flag: fp.flag ?? 'UNKNOWN',
    itemSize: items.length,
    code: alarm.code != null ? normalizeCodeRaw(alarm.code) : null,
    vehicleAction: pick(first, 'vehicleAction', 'vehicle_action') ?? null,
    sdAction: pick(first, 'sdAction', 'sd_action') ?? null,
    recoredAction: pick(first, 'recoredAction', 'recored_action') ?? null,
  };
}

function itemListOf(fp) {
  return pick(fp, 'itemList', 'item_list') || [];
}

/**
 * Collapse the FaultProcess stream into discrete events: one per significant
 * output change (flag / winner code / vehicle_action / sd_action).
 * @param {Array<{sec:number, decoded:object}>} faultStream time-sorted
 */
export function buildFaultEvents(faultStream) {
  const events = [];
  let prevKey = null;
  for (const { sec, decoded } of faultStream) {
    if (!decoded) continue;
    const summary = summarizeFaultProcess(decoded);
    if (!summary) continue;
    const key = `${summary.flag}|${summary.code}|${summary.vehicleAction}|${summary.sdAction}`;
    if (key === prevKey) continue;
    prevKey = key;

    const items = decoded.item || [];
    const first = items[0] || {};
    const winnerAlarm = pick(first, 'alarmData', 'alarm_data');
    events.push({
      sec,
      summary,
      winner: winnerAlarm ? normalizeAlarm(winnerAlarm) : null,
      activeSnapshot: itemListOf(decoded).map(normalizeAlarm),
    });
  }
  return events;
}

/**
 * Runtime adapter: turn msgDataCache entries into { sec, decoded } streams.
 * @param {object} msgDataCache topic -> [{sec, schemaId, data, ...}]
 * @param {(entry)=>object|null} decodeFn returns a decoded object (string longs)
 */
export function buildStreamsFromCache(msgDataCache, decodeFn) {
  const toStream = (topic) => (msgDataCache?.[topic] || [])
    .map((entry) => ({ sec: entry.sec, decoded: decodeFn(entry) }))
    .filter((e) => e.decoded);
  return {
    alarmStream: toStream(ALARM_TOPIC),
    faultStream: toStream(FAULT_TOPIC),
  };
}
