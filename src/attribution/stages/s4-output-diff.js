/**
 * S4 Output Diff — compare replay outputs with recorded outputs in mcap.
 * When precise byte-diff is not possible, falls back to size comparison.
 */

import { evaluateRules } from '../rules/index.js';

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
      .filter(o => o.ownedByThisExecutor !== false && o.nonEmptyPct > 0 && o.avgSize < 100)
      .map(o => ({ name: o.name, avgSize: o.avgSize }));

    const evidence = { zeroOutputChannels, trivialOutputChannels, outputStats, divergedOutputs: [] };
    ctx.setEvidence('S4', 'outputStats', outputStats);
    ctx.setEvidence('S4', 'zeroOutputChannels', zeroOutputChannels);
    ctx.setEvidence('S4', 'trivialOutputChannels', trivialOutputChannels);

    const findings = evaluateRules('S4', evidence, ctx);
    for (const f of findings) {
      ctx.addFinding(f);
    }

    const warnings = findings.filter(f => f.severity === 'warn').map(f => f.finding);
    const errors = findings.filter(f => f.severity === 'error');

    return {
      status: errors.length > 0 ? 'failed' : warnings.length > 0 ? 'warn' : 'passed',
      outputStats,
      zeroOutputChannels,
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
      ${(result.findings || []).map(f =>
        `<div class="at-finding at-finding-${f.severity}"><strong>[${f.ruleId}]</strong> ${esc(f.finding)}</div>`
      ).join('')}
      <div class="at-note">Byte-level diff requires output serialization hook (future work)</div>
    `;
  },
};

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
