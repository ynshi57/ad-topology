/**
 * 64-bit alarm code decoding + domain classification.
 *
 * Mirrors the C++ layout in nexis_kernel/include/security/alarm_code_define.h:
 *   SOC(2) | APP(6) | Module(6) | SubModule(6) | Category(10) | Level(4) | Reason(14) | Duration(16)
 *
 * Codes routinely exceed 2^53, so the shared proto decoder's `longs: Number`
 * corrupts the low bits (reason/duration). Everything here works in BigInt and
 * accepts a code as bigint | decimal string | 0x-hex string | number.
 */

const SHIFT = {
  soc: 62n, app: 56n, module: 50n, subModule: 44n,
  category: 34n, level: 30n, reason: 16n, duration: 0n,
};
const WIDTH = {
  soc: 2n, app: 6n, module: 6n, subModule: 6n,
  category: 10n, level: 4n, reason: 14n, duration: 16n,
};

export function toBigIntCode(code) {
  if (typeof code === 'bigint') return code;
  if (typeof code === 'number') return BigInt(Math.trunc(code));
  if (typeof code === 'string') {
    const s = code.trim();
    if (s === '') return 0n;
    return BigInt(s); // handles both decimal and 0x-hex
  }
  return 0n;
}

function field(code, name) {
  return Number((code >> SHIFT[name]) & ((1n << WIDTH[name]) - 1n));
}

/**
 * @param {bigint|string|number} code
 * @returns {{soc,app,module,subModule,category,level,reason,duration,raw:string}}
 */
export function decodeFaultCode(code) {
  const c = toBigIntCode(code);
  return {
    soc: field(c, 'soc'),
    app: field(c, 'app'),
    module: field(c, 'module'),
    subModule: field(c, 'subModule'),
    category: field(c, 'category'),
    level: field(c, 'level'),
    reason: field(c, 'reason'),
    duration: field(c, 'duration'),
    raw: c.toString(),
  };
}

export const FaultDomain = {
  PERCEPTION: 'PERCEPTION',
  LOCALIZATION: 'LOCALIZATION',
  PNC: 'PNC',
  SYSTEM: 'SYSTEM',
  OTHER: 'OTHER',
};

// Module ids from AlarmModule (alarm_code_define.h).
export const MODULE_NAMES = {
  0: 'nexis', 1: 'data_source', 2: 'bus', 3: 'middleware',
  31: 'perception', 32: 'pnc', 33: 'parking', 34: 'localization',
  35: 'map_route', 36: 'calibration', 37: 'control', 38: 'canbus',
  39: 'state_machine', 40: 'system_monitor', 110: 'local_simulation',
};

/**
 * Mirrors FaultManagerExecutor::classifyDomain (fault_manager_executor.cpp).
 */
export function classifyDomain(code) {
  const mod = decodeFaultCode(code).module;
  switch (mod) {
    case 31: case 36: return FaultDomain.PERCEPTION;
    case 34: return FaultDomain.LOCALIZATION;
    case 32: case 33: case 35: case 37: return FaultDomain.PNC;
    case 0: case 1: case 2: case 3:
    case 38: case 39: case 40: return FaultDomain.SYSTEM;
    default: return FaultDomain.OTHER;
  }
}

// Reason enum names from AlarmReason (alarm_code_define.h) plus the local
// topic_monitor reasons defined in system_monitor/error_reporter.cpp.
export const REASON_NAMES = {
  0: 'kNoError',
  3: 'kDeviceLostCommunication', 4: 'kDeviceConnectTimeout',
  204: 'kModelProcessTimeout',
  400: 'kDataTimestampInTheFuture', 401: 'kDataDelayTooMuch', 402: 'kDataTimeOutOfSync',
  403: 'kDataTimeBack', 404: 'kDataNonUniform', 405: 'kDataTimestampConfusion',
  406: 'kDataRateDecreases', 407: 'kDataCrcCheckFailed', 408: 'kDataNonContinuous',
  409: 'kDataInvalid', 410: 'kDataLost', 411: 'kDataTimeout', 412: 'kPpsTimeError',
  413: 'kDataTimestampFrozen', 414: 'kDataTimeSpanTooShort', 415: 'kDataTimestampUnchanged',
  701: 'kProcessTimeout', 703: 'kProcessCannotRecover',
  904: 'kExecutorProcessingTimeout', 906: 'kExecutorDropProcess', 907: 'kExecutorDoProcessFailed',
  1200: 'kTopicFrameRateDegradeError', 1201: 'kTopicFrameRateDegradeFatal',
};

export function reasonName(reason) {
  return REASON_NAMES[reason] || `reason_${reason}`;
}

// Consumer-side data-starvation reasons: a downstream module observing that an
// input topic stopped / slowed / went stale. These are effects, so a matching
// producer/topic-health fault on the same topic is a stronger root candidate.
const DATA_STARVATION_REASONS = new Set([
  401, 403, 405, 408, 409, 410, 411, 413, 415,
]);

export function isDataStarvationReason(reason) {
  return DATA_STARVATION_REASONS.has(Number(reason));
}

// Producer / topic-health reasons: the source topic degraded at publication.
const TOPIC_HEALTH_REASONS = new Set([406, 1200, 1201]);

export function isTopicHealthReason(reason) {
  return TOPIC_HEALTH_REASONS.has(Number(reason));
}
