/**
 * S4 Output Diff — compare replay outputs with recorded outputs in mcap.
 * When precise byte-diff is not possible, falls back to size comparison.
 */

import { evaluateRules } from '../rules/index.js';
import { decodeMessage, decodeMessageByType } from '../../proto-decoder.js';

export default {
  id: 'S4',
  name: 'Output Diff',

  async run(ctx) {
    const allOutputMetrics = ctx.getEvidence('S2', 'allOutputMetrics') || [];
    const totalFrames = ctx.getEvidence('S2', 'totalFrames') || 0;

    if (totalFrames === 0) {
      return { status: 'skipped', warnings: ['No frames from S2'], findings: [] };
    }

    const outputSummary = {};
    for (const om of allOutputMetrics) {
      if (!outputSummary[om.name]) {
        outputSummary[om.name] = { name: om.name, totalSize: 0, nonEmptyCount: 0, frameCount: 0 };
      }
      outputSummary[om.name].totalSize += om.data_size || 0;
      outputSummary[om.name].frameCount++;
      if (om.non_empty) {
        outputSummary[om.name].nonEmptyCount++;
      }
    }

    // Determine which output channels belong to this executor vs other
    // executors in the same DAG process. Only flag zero-output on ours.
    const myOutputNames = new Set(ctx.outputDataNames || []);

    const zeroOutputChannels = [];
    const outputStats = [];
    for (const [name, s] of Object.entries(outputSummary)) {
      const avgSize = s.frameCount > 0 ? s.totalSize / s.frameCount : 0;
      const isMine = myOutputNames.size === 0 || myOutputNames.has(name);
      outputStats.push({
        name,
        avgSize: Math.round(avgSize),
        nonEmptyPct: s.frameCount > 0 ? Math.round(s.nonEmptyCount / s.frameCount * 100) : 0,
        frames: s.frameCount,
        ownedByThisExecutor: isMine,
      });
      if (s.nonEmptyCount === 0 && s.frameCount > 0 && isMine) {
        zeroOutputChannels.push(name);
      }
    }

    const trivialOutputChannels = outputStats
      .filter(o => {
        if (o.ownedByThisExecutor === false || o.nonEmptyPct <= 0 || o.avgSize >= 100) {
          return false;
        }
        // fault_manager 正常无故障时会持续输出很小的 FaultProcess
        // (SYSTEM_OK + timestamp，约 20B)，不能按通用“小输出”判失败。
        if (ctx.nodeId === 'fault_manager' && o.name === 'fault_process_data') {
          return false;
        }
        return true;
      })
      .map(o => ({ name: o.name, avgSize: o.avgSize }));

    const evidence = { zeroOutputChannels, trivialOutputChannels, outputStats, divergedOutputs: [] };
    let faultManagerDiff = null;
    if (ctx.nodeId === 'fault_manager') {
      faultManagerDiff = buildFaultManagerDiff(ctx);
      evidence.faultManagerDiff = faultManagerDiff;
    }
    ctx.setEvidence('S4', 'outputStats', outputStats);
    ctx.setEvidence('S4', 'zeroOutputChannels', zeroOutputChannels);
    ctx.setEvidence('S4', 'trivialOutputChannels', trivialOutputChannels);
    ctx.setEvidence('S4', 'faultManagerDiff', faultManagerDiff);

    const findings = evaluateRules('S4', evidence, ctx);
    if (faultManagerDiff?.status === 'failed') {
      findings.push({
        ruleId: 'FAULT_MANAGER_SEMANTIC_DIFF',
        stageId: 'S4',
        severity: 'error',
        finding: `FaultProcess semantic mismatch: ${faultManagerDiff.mismatchCount}/${faultManagerDiff.matchedCount} matched frames`,
        tags: ['fault_process_semantic_mismatch'],
        confidence: 0.95,
      });
    } else if (faultManagerDiff?.status === 'warn') {
      findings.push({
        ruleId: 'FAULT_MANAGER_SEMANTIC_DIFF',
        stageId: 'S4',
        severity: 'warn',
        finding: faultManagerDiff.reason || 'FaultProcess semantic diff unavailable',
        tags: ['fault_process_semantic_diff_unavailable'],
        confidence: 0.8,
      });
    }
    for (const f of findings) {
      ctx.addFinding(f);
    }

    const warnings = findings.filter(f => f.severity === 'warn').map(f => f.finding);
    const errors = findings.filter(f => f.severity === 'error');

    return {
      status: errors.length > 0 ? 'failed' : warnings.length > 0 ? 'warn' : 'passed',
      outputStats,
      zeroOutputChannels,
      faultManagerDiff,
      warnings,
      findings,
    };
  },

  render(el, result) {
    const mine = (result.outputStats || []).filter(o => o.ownedByThisExecutor !== false);
    const others = (result.outputStats || []).filter(o => o.ownedByThisExecutor === false);

    const renderRow = (o) => {
      const cls = o.nonEmptyPct > 0 ? 'at-health-ok' : 'at-health-bad';
      return `<div class="at-health-row ${cls}">
        <span class="at-health-indicator">${o.nonEmptyPct > 0 ? '\u25CF' : '\u26A0'}</span>
        <span class="at-health-topic">${esc(o.name)}</span>
        <span class="at-health-hz">${o.nonEmptyPct}% non-empty</span>
        <span class="at-health-count">avg ${o.avgSize}B</span>
      </div>`;
    };

    const rows = mine.map(renderRow).join('');
    const otherRows = others.length > 0
      ? `<details class="at-other-outputs"><summary class="at-note">Other executors in same process (${others.length})</summary>${others.map(renderRow).join('')}</details>`
      : '';

    el.innerHTML = `
      <div class="at-health-grid">${rows}</div>
      ${otherRows}
      ${renderFaultManagerDiff(result.faultManagerDiff)}
      ${(result.findings || []).map(f =>
        `<div class="at-finding at-finding-${f.severity}"><strong>[${f.ruleId}]</strong> ${esc(f.finding)}</div>`
      ).join('')}
      <div class="at-note">Byte-level diff requires output serialization hook (future work)</div>
    `;
  },
};

function buildFaultManagerDiff(ctx) {
  const replayOutputs = (ctx.getEvidence('S2', 'replayOutputs') || [])
    .filter(o => o.dataName === 'fault_process_data' && o.serializedBase64);
  const recordedEntries = ctx.msgDataCache?.['/nexis/security/alarm/fault_process'] || [];

  if (replayOutputs.length === 0) {
    return { status: 'warn', reason: 'No replay fault_process_data outputs captured', replayCount: 0, recordedCount: recordedEntries.length };
  }
  if (recordedEntries.length === 0) {
    return { status: 'warn', reason: 'Recorded /nexis/security/alarm/fault_process not found in mcap', replayCount: replayOutputs.length, recordedCount: 0 };
  }

  const recorded = recordedEntries.map(e => ({
    timestamp_ns: Number(e.logTime ?? e.receiveTime ?? ((ctx.startTimeNs || 0n) + BigInt(Math.round((e.sec || 0) * 1e9)))),
    summary: summarizeFaultProcess(e.decoded || decodeMessage(e.schemaId, e.data)),
  })).filter(e => e.summary);

  const replay = replayOutputs.map(e => ({
    timestamp_ns: Number(e.timestamp_ns || 0),
    summary: summarizeFaultProcess(decodeMessageByType(e.protoType, base64ToUint8(e.serializedBase64))),
  })).filter(e => e.summary);

  const toleranceNs = 100_000_000; // 100ms
  let matchedCount = 0;
  let mismatchCount = 0;
  const mismatches = [];
  let recIdx = 0;

  for (const r of replay) {
    while (recIdx + 1 < recorded.length &&
           Math.abs(recorded[recIdx + 1].timestamp_ns - r.timestamp_ns) <=
           Math.abs(recorded[recIdx].timestamp_ns - r.timestamp_ns)) {
      recIdx++;
    }
    const nearest = recorded[recIdx];
    if (!nearest || Math.abs(nearest.timestamp_ns - r.timestamp_ns) > toleranceNs) {
      continue;
    }
    matchedCount++;
    if (!sameSummary(r.summary, nearest.summary)) {
      mismatchCount++;
      if (mismatches.length < 20) {
        mismatches.push({
          timestamp_ns: r.timestamp_ns,
          delta_ms: Math.round((nearest.timestamp_ns - r.timestamp_ns) / 1e6),
          replay: r.summary,
          recorded: nearest.summary,
        });
      }
    }
  }

  const status = matchedCount === 0 ? 'warn' : (mismatchCount === 0 ? 'passed' : 'failed');
  return {
    status,
    replayCount: replay.length,
    recordedCount: recorded.length,
    matchedCount,
    mismatchCount,
    mismatches,
  };
}

function summarizeFaultProcess(fp) {
  if (!fp) return null;
  const items = fp.item || [];
  const first = items[0] || {};
  const alarm = first.alarmData || first.alarm_data || {};
  return {
    flag: fp.flag ?? 'UNKNOWN',
    itemSize: items.length,
    code: normalizeCode(alarm.code),
    vehicleAction: first.vehicleAction ?? first.vehicle_action ?? null,
    sdAction: first.sdAction ?? first.sd_action ?? null,
    recoredAction: first.recoredAction ?? first.recored_action ?? null,
  };
}

function sameSummary(a, b) {
  return a.flag === b.flag &&
    a.itemSize === b.itemSize &&
    a.code === b.code &&
    a.vehicleAction === b.vehicleAction &&
    a.sdAction === b.sdAction &&
    a.recoredAction === b.recoredAction;
}

function normalizeCode(v) {
  if (v == null) return null;
  if (typeof v === 'number') return '0x' + Math.trunc(v).toString(16);
  return String(v).startsWith('0x') ? String(v).toLowerCase() : '0x' + String(v);
}

function base64ToUint8(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function renderFaultManagerDiff(diff) {
  if (!diff) return '';
  const cls = diff.status === 'passed' ? 'at-health-ok' : diff.status === 'warn' ? 'at-health-warn' : 'at-health-bad';
  const mismatchRows = (diff.mismatches || []).slice(0, 5).map(m => `
    <div class="at-kv"><span>t=${esc(m.timestamp_ns)} delta=${esc(m.delta_ms)}ms</span>
      <strong>replay=${esc(JSON.stringify(m.replay))}</strong>
      <span>recorded=${esc(JSON.stringify(m.recorded))}</span>
    </div>
  `).join('');
  return `
    <div class="at-section">
      <div class="at-health-row ${cls}">
        <span class="at-health-indicator">${diff.status === 'passed' ? '●' : '⚠'}</span>
        <span class="at-health-topic">fault_manager semantic diff</span>
        <span class="at-health-hz">matched ${diff.matchedCount || 0}/${diff.replayCount || 0}</span>
        <span class="at-health-count">mismatch ${diff.mismatchCount || 0}</span>
      </div>
      ${diff.reason ? `<div class="at-note">${esc(diff.reason)}</div>` : ''}
      ${mismatchRows}
    </div>
  `;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
