/**
 * S5 Perf Snapshot — sample the harness process with perf, produce a flame graph.
 * Calls POST /perf-sample on the backend, receives folded stacks, stores for rendering.
 */

import { evaluateRules } from '../rules/index.js';

const BACKEND_BASE = 'http://localhost:8765';
const DEFAULT_DURATION_SEC = 5;

export default {
  id: 'S5',
  name: 'Perf',

  async run(ctx) {
    // Prefer perf data collected during S2 replay (much more meaningful than
    // post-replay idle sampling). Falls back to on-demand /perf-sample if S2
    // data is not available.
    let data = ctx.getEvidence('S5', 'perfFromS2');

    if (!data) {
      const checkResp = await fetch(`${BACKEND_BASE}/perf-check`);
      const checkData = await checkResp.json();

      if (!checkData.perfAvailable) {
        return {
          status: 'warn',
          warnings: [checkData.hint || 'perf not available'],
          foldedStacks: null,
          hotspots: [],
          findings: [],
        };
      }

      const pid = ctx.harnessPid;
      if (!pid) {
        return {
          status: 'warn',
          warnings: ['Harness PID unknown — run S2 first to collect perf during replay.'],
          foldedStacks: null,
          hotspots: [],
          findings: [],
        };
      }

      const resp = await fetch(`${BACKEND_BASE}/perf-sample`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid, duration_sec: DEFAULT_DURATION_SEC }),
      });

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        return {
          status: 'warn',
          warnings: [`perf failed: ${errData.error || resp.status}`],
          foldedStacks: null,
          hotspots: [],
          findings: [],
        };
      }

      data = await resp.json();
    }
    const stacks = data.stacks || [];
    const totalSamples = data.totalSamples || 0;

    const funcCounts = {};
    let unknownCount = 0;
    for (const s of stacks) {
      const frames = s.stack.split(';');
      const leaf = frames[frames.length - 1] || '[unknown]';
      funcCounts[leaf] = (funcCounts[leaf] || 0) + s.count;
      if (leaf === '[unknown]' || leaf.startsWith('0x')) {
        unknownCount += s.count;
      }
    }

    const hotspots = Object.entries(funcCounts)
      .map(([func, count]) => ({ func, count, pct: totalSamples > 0 ? count / totalSamples * 100 : 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const unknownSymbolPct = totalSamples > 0 ? unknownCount / totalSamples * 100 : 0;

    const evidence = { hotspots, unknownSymbolPct };
    ctx.setEvidence('S5', 'foldedStacks', data.foldedStacks);
    ctx.setEvidence('S5', 'hotspots', hotspots);
    ctx.setEvidence('S5', 'totalSamples', totalSamples);

    const findings = evaluateRules('S5', evidence, ctx);
    for (const f of findings) {
      ctx.addFinding(f);
    }

    return {
      status: findings.some(f => f.severity === 'error') ? 'failed'
           : findings.some(f => f.severity === 'warn') ? 'warn'
           : 'passed',
      totalSamples,
      hotspots,
      foldedStacks: data.foldedStacks,
      unknownSymbolPct,
      findings,
    };
  },

  render(el, result, ctx) {
    if (!result.foldedStacks) {
      el.innerHTML = `<div class="at-note">${(result.warnings || []).join('; ') || 'No perf data'}</div>`;
      return;
    }

    const hotspotsHtml = (result.hotspots || []).slice(0, 10).map(h => {
      const barWidth = Math.min(Math.max(h.pct, 1), 100);
      return `<div class="at-hotspot-row">
        <span class="at-hotspot-bar" style="width:${barWidth}%"></span>
        <span class="at-hotspot-pct">${h.pct.toFixed(1)}%</span>
        <span class="at-hotspot-func">${esc(h.func)}</span>
      </div>`;
    }).join('');

    el.innerHTML = `
      <div class="at-kv"><span>Total Samples:</span> <strong>${result.totalSamples}</strong></div>
      <div class="at-kv"><span>Unknown Symbols:</span> <strong>${result.unknownSymbolPct?.toFixed(1) || 0}%</strong></div>
      <div class="at-hotspot-list">
        <div class="at-section-title">Top Functions</div>
        ${hotspotsHtml}
      </div>
      <div id="at-flamegraph-container" class="at-flamegraph-container"></div>
      ${(result.findings || []).map(f =>
        `<div class="at-finding at-finding-${f.severity}"><strong>[${f.ruleId}]</strong> ${esc(f.finding)}</div>`
      ).join('')}
    `;

    if (typeof window.__renderFlamegraph === 'function' && result.foldedStacks) {
      try {
        window.__renderFlamegraph(
          el.querySelector('#at-flamegraph-container'),
          result.foldedStacks,
        );
      } catch (err) {
        el.querySelector('#at-flamegraph-container').textContent = `Flamegraph render error: ${err.message}`;
      }
    }
  },
};

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
