/**
 * S6 Report — aggregate all findings, run causal inference, produce structured report.
 */

import { inferRootCauses } from '../rules/index.js';

const BACKEND_BASE = 'http://localhost:8765';

export default {
  id: 'S6',
  name: 'Report',

  async run(ctx) {
    const { causes, findings: enrichedFindings } = inferRootCauses(ctx.findings);

    const hotspots = ctx.getEvidence('S5', 'hotspots') || [];
    const topHotspots = hotspots.slice(0, 5).map(h => `${h.func} (${h.pct.toFixed(1)}%)`);

    const report = {
      version: '1.0',
      moduleId: ctx.nodeId,
      runtime: ctx.runtime,
      timestamp: new Date().toISOString(),
      stages: {},
      findings: enrichedFindings,
      rootCauses: causes,
      summary: {
        replayOkRate: computeRate(ctx.getEvidence('S2', 'okFrames'), ctx.getEvidence('S2', 'totalFrames')),
        missingRequired: ctx.getEvidence('S3', 'missingRequired') || [],
        zeroOutputChannels: ctx.getEvidence('S4', 'zeroOutputChannels') || [],
        topPerfHotspots: topHotspots,
        totalFindings: enrichedFindings.length,
        errorFindings: enrichedFindings.filter(f => f.severity === 'error').length,
        warnFindings: enrichedFindings.filter(f => f.severity === 'warn').length,
      },
    };

    for (const [stageId, stageResult] of Object.entries(ctx.stageResults)) {
      report.stages[stageId] = {
        status: stageResult.status,
        error: stageResult.error || null,
      };
    }

    ctx.setEvidence('S6', 'report', report);
    ctx.setEvidence('S6', 'enrichedFindings', enrichedFindings);
    ctx.setEvidence('S6', 'rootCauses', causes);

    return {
      status: causes.some(c => c.shortCircuit) ? 'warn' : 'passed',
      report,
      causes,
      enrichedFindings,
    };
  },

  render(el, result, ctx) {
    const report = result.report;
    const causes = result.causes || [];
    const findings = result.enrichedFindings || [];

    const causeHtml = causes.length > 0
      ? causes.map(c => `<div class="at-root-cause ${c.shortCircuit ? 'at-root-cause-short' : ''}">
          <strong>[Root Cause]</strong> ${esc(c.primary)}: ${esc(c.message)}
        </div>`).join('')
      : '<div class="at-note">No root causes inferred</div>';

    const findingsHtml = findings.map(f => {
      const reduced = f.weightReduced ? ' at-finding-reduced' : '';
      return `<div class="at-finding at-finding-${f.severity}${reduced}">
        <strong>[${f.ruleId}]</strong> ${esc(f.finding)}
        ${f.rootCauseHint ? `<div class="at-hint">Hint: ${esc(f.rootCauseHint)}</div>` : ''}
        <span class="at-confidence">${(f.confidence * 100).toFixed(0)}%</span>
      </div>`;
    }).join('');

    const summary = report.summary;

    el.innerHTML = `
      <div class="at-report-summary">
        <div class="at-stats-row">
          <div class="at-stat"><span class="at-stat-val">${summary.replayOkRate}</span><span class="at-stat-label">Replay OK</span></div>
          <div class="at-stat"><span class="at-stat-val">${summary.totalFindings}</span><span class="at-stat-label">Findings</span></div>
          <div class="at-stat"><span class="at-stat-val">${summary.errorFindings}</span><span class="at-stat-label">Errors</span></div>
          <div class="at-stat"><span class="at-stat-val">${summary.warnFindings}</span><span class="at-stat-label">Warnings</span></div>
        </div>
        ${summary.missingRequired.length > 0 ? `<div class="at-note">Missing required: ${summary.missingRequired.join(', ')}</div>` : ''}
        ${summary.zeroOutputChannels.length > 0 ? `<div class="at-note">Zero outputs: ${summary.zeroOutputChannels.join(', ')}</div>` : ''}
        ${summary.topPerfHotspots.length > 0 ? `<div class="at-note">Top hotspots: ${summary.topPerfHotspots.join(', ')}</div>` : ''}
      </div>

      <div class="at-section-title">Root Cause Analysis</div>
      ${causeHtml}

      <div class="at-section-title">All Findings</div>
      ${findingsHtml}

      <div class="at-export-area">
        <button class="at-btn at-btn-export" id="at-export-btn">Export to Analysis Workflow</button>
        <span class="at-export-status" id="at-export-status"></span>
      </div>

      <details>
        <summary>Raw Report JSON</summary>
        <pre class="at-pre">${esc(JSON.stringify(report, null, 2))}</pre>
      </details>
    `;

    el.querySelector('#at-export-btn')?.addEventListener('click', async () => {
      const statusEl = el.querySelector('#at-export-status');
      statusEl.textContent = 'Exporting...';
      try {
        const slug = ctx.getSlug();
        const resp = await fetch(`${BACKEND_BASE}/agent-output-write`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug,
            stage_id: 'S6',
            content: report,
          }),
        });
        const data = await resp.json();
        if (data.ok) {
          statusEl.textContent = `Exported to ${data.path}`;
        } else {
          statusEl.textContent = `Error: ${data.error}`;
        }
      } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
      }
    });
  },
};

function computeRate(ok, total) {
  if (!total || total === 0) {
    return 'N/A';
  }
  return `${((ok / total) * 100).toFixed(1)}%`;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
