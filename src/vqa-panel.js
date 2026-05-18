import { runVqaDetect, summarizeVqaLogLine } from './vqa-runner.js';
import { loadVqaSidecar } from './vqa-overlay.js';
import { renderImpactTable } from './vqa-impact.js';

function esc(s) {
  const d = document.createElement('span');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

function renderDiagBlock(name, block) {
  if (!block) {
    return `<div class="vqa-diag-card"><b>${esc(name)}</b><span>missing</span></div>`;
  }
  if (block.exposed === false) {
    return `
      <div class="vqa-diag-card muted">
        <b>${esc(name)}</b>
        <span>not exposed</span>
        <small>${esc(block.reason || 'runtime did not export diagnostics')}</small>
      </div>
    `;
  }
  return `
    <div class="vqa-diag-card">
      <b>${esc(name)}</b>
      <span>shape: ${esc(JSON.stringify(block.output_shape || []))}</span>
      <span>lat: ${esc(block.latency_ms ?? '?')} ms</span>
      <span>dtype: ${esc(block.dtype || '?')}</span>
      <span>mean/std: ${esc(block.mean ?? '?')} / ${esc(block.std ?? '?')}</span>
      <span>nan/inf: ${esc(block.nan_count ?? 0)} / ${esc(block.inf_count ?? 0)}</span>
      ${block.num_queries ? `<span>queries/layers: ${esc(block.num_queries)} / ${esc(block.layers ?? '?')}</span>` : ''}
      ${block.attention_entropy !== undefined ? `<span>attn entropy: ${esc(block.attention_entropy)}</span>` : ''}
      ${renderPerCameraAttention(block.per_camera_attention)}
    </div>
  `;
}

function renderPerCameraAttention(attn) {
  if (!attn || typeof attn !== 'object') { return ''; }
  const rows = Object.entries(attn)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 12)
    .map(([cam, weight]) => {
      const pct = Math.max(0, Math.min(100, Number(weight || 0) * 100));
      return `
        <div class="vqa-attn-row">
          <span>${esc(cam)}</span>
          <div class="vqa-attn-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
          <em>${pct.toFixed(1)}%</em>
        </div>
      `;
    }).join('');
  return `<div class="vqa-attn">${rows}</div>`;
}

function renderLatest(index) {
  if (!index || !index.frames || index.frames.length === 0) {
    return '<div class="vqa-empty">No VQA sidecar loaded.</div>';
  }
  const frame = index.frames[index.frames.length - 1];
  const parsed = frame.answer?.parsed || {};
  const states = parsed.camera_states || {};
  const stateRows = Object.entries(states).map(([cam, st]) => `
    <tr>
      <td>${esc(cam)}</td>
      <td><span class="vqa-state ${esc(st.visibility_state || 'unknown')}">${esc(st.visibility_state || 'unknown')}</span></td>
      <td>${esc(st.severity || 'unknown')}</td>
      <td>${esc(st.confidence ?? '')}</td>
    </tr>
  `).join('');
  return `
    <div class="vqa-summary-grid">
      <div><b>model</b><span>${esc(index.model || 'unknown')}</span></div>
      <div><b>runtime</b><span>${esc(index.runtime?.name || index.runtime?.mode || 'unknown')}</span></div>
      <div><b>frames</b><span>${esc(index.totalFrames || 0)}</span></div>
      <div><b>schema invalid</b><span>${esc(index.summary?.schema_invalid_frames || 0)}</span></div>
    </div>
    <div class="vqa-diag-grid">
      ${renderDiagBlock('backbone', frame.diagnostics?.backbone)}
      ${renderDiagBlock('perceiver', frame.diagnostics?.perceiver)}
      ${renderDiagBlock('vlm_adapter', frame.diagnostics?.vlm_adapter)}
      ${renderDiagBlock('decoder', frame.diagnostics?.decoder)}
    </div>
    <details class="vqa-details" open>
      <summary>Camera States</summary>
      <table class="vqa-state-table">
        <thead><tr><th>Camera</th><th>State</th><th>Severity</th><th>Conf</th></tr></thead>
        <tbody>${stateRows || '<tr><td colspan="4">No camera states</td></tr>'}</tbody>
      </table>
    </details>
    <details class="vqa-details">
      <summary>Predicted vs Actual Impact</summary>
      ${renderImpactTable(parsed.function_impact || {})}
    </details>
    <details class="vqa-details">
      <summary>Raw / Parsed Answer</summary>
      <pre class="vqa-json">${esc(JSON.stringify(frame.answer || {}, null, 2))}</pre>
    </details>
  `;
}

export function createVqaPanel(opts) {
  const {
    mcapPath,
    vqaIndex = null,
    onVqaIndexChange = () => {},
  } = opts;
  let currentIndex = vqaIndex;
  let abortController = null;

  const wrap = document.createElement('div');
  wrap.className = 'vqa-panel';
  wrap.innerHTML = `
    <div class="vqa-panel-header">
      <span class="vqa-panel-title">Camera VQA / Atlas</span>
      <span class="vqa-panel-status" id="vqa-status">${currentIndex ? 'Loaded' : 'No data'}</span>
    </div>
    <div class="vqa-panel-controls">
      <select id="vqa-runtime" class="vqa-control">
        <option value="fixture">runtime: fixture (non-production)</option>
        <option value="external">runtime: external</option>
        <option value="http">runtime: http</option>
        <option value="precomputed">runtime: precomputed</option>
      </select>
      <input id="vqa-sample-interval" class="vqa-control" type="number" min="0.5" max="3600" step="0.5" value="10" title="sample interval seconds" />
      <input id="vqa-max-samples" class="vqa-control" type="number" min="1" max="1000" step="1" value="8" title="max samples" />
      <button id="vqa-run" class="vqa-run-btn">Run VQA</button>
      <button id="vqa-cancel" class="vqa-cancel-btn" style="display:none">Cancel</button>
    </div>
    <div class="vqa-progress" id="vqa-progress" style="display:none">
      <div class="vqa-progress-text" id="vqa-progress-text">starting...</div>
    </div>
    <div class="vqa-body" id="vqa-body">${renderLatest(currentIndex)}</div>
    <pre class="vqa-log" id="vqa-log" style="display:none"></pre>
  `;

  const statusEl = wrap.querySelector('#vqa-status');
  const bodyEl = wrap.querySelector('#vqa-body');
  const runBtn = wrap.querySelector('#vqa-run');
  const cancelBtn = wrap.querySelector('#vqa-cancel');
  const progressEl = wrap.querySelector('#vqa-progress');
  const progressText = wrap.querySelector('#vqa-progress-text');
  const logEl = wrap.querySelector('#vqa-log');
  const runtimeSel = wrap.querySelector('#vqa-runtime');
  const sampleInput = wrap.querySelector('#vqa-sample-interval');
  const maxInput = wrap.querySelector('#vqa-max-samples');

  function setIndex(index) {
    currentIndex = index;
    statusEl.textContent = index ? `${index.model || 'VQA'} | ${index.totalFrames || 0} frames` : 'No data';
    bodyEl.innerHTML = renderLatest(index);
    onVqaIndexChange(index);
  }

  runBtn.addEventListener('click', async () => {
    if (!mcapPath) {
      progressEl.style.display = 'block';
      progressText.textContent = 'No mcap server path. Load a cached/server file first.';
      return;
    }
    runBtn.style.display = 'none';
    cancelBtn.style.display = 'inline-block';
    progressEl.style.display = 'block';
    logEl.style.display = 'block';
    logEl.textContent = '';
    progressText.textContent = 'starting...';
    statusEl.textContent = 'running...';
    abortController = new AbortController();

    try {
      const final = await runVqaDetect({
        mcapPath,
        runtime: runtimeSel.value,
        sampleIntervalSec: parseFloat(sampleInput.value) || 10,
        maxSamples: parseInt(maxInput.value, 10) || 8,
        signal: abortController.signal,
        onLog(evt) {
          if (evt.type === 'log') {
            const summary = summarizeVqaLogLine(evt.line);
            if (summary) { progressText.textContent = summary; }
            logEl.textContent += evt.line + '\n';
            logEl.scrollTop = logEl.scrollHeight;
          } else if (evt.type === 'start') {
            progressText.textContent = `running ${evt.runtime}...`;
          }
        },
      });
      progressText.textContent = `done. ${final.summary?.frames || 0} frames.`;
      const reloaded = await loadVqaSidecar(mcapPath);
      setIndex(reloaded);
    } catch (err) {
      progressText.textContent = err.name === 'AbortError'
        ? 'cancelled'
        : `failed: ${err.message}`;
      console.error('Camera VQA failed:', err);
      statusEl.textContent = 'failed';
    } finally {
      runBtn.style.display = 'inline-block';
      cancelBtn.style.display = 'none';
      abortController = null;
    }
  });

  cancelBtn.addEventListener('click', () => {
    abortController?.abort();
  });

  return {
    el: wrap,
    setIndex,
    getIndex() { return currentIndex; },
  };
}
