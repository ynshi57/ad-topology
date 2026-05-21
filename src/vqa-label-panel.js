import {
  datasetImageUrl,
  extractVqaFrames,
  loadVqaManifest,
  saveVqaLabels,
  trainVqaLocalModel,
  evaluateVqaLocalModel,
} from './vqa-runner.js';
import { loadVqaSidecar } from './vqa-overlay.js';

const STATES = ['clean', 'wet', 'blocked', 'blur', 'dark', 'saturate', 'frozen', 'unknown'];
const SEVERITIES = ['none', 'low', 'medium', 'high', 'unknown'];

function esc(s) {
  const d = document.createElement('span');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

export function renderLabelPanel({ mcapPath = '' }) {
  const wrap = document.createElement('div');
  wrap.className = 'vqa-label-tool';
  wrap.innerHTML = `
    <div class="vqa-label-toolbar">
      <label>dataset <input id="vqa-label-dataset" value="adhoc" /></label>
      <label>mcap <input id="vqa-label-mcap" value="${esc(mcapPath)}" /></label>
      <label>interval <input id="vqa-label-interval" type="number" value="10" min="0.5" step="0.5" /></label>
      <label>max <input id="vqa-label-max" type="number" value="20" min="1" step="1" /></label>
      <button id="vqa-extract-frames" class="vqa-run-btn">Extract Frames</button>
      <button id="vqa-load-dataset" class="vqa-run-btn">Load Dataset</button>
      <span id="vqa-label-status" class="vqa-panel-status">idle</span>
    </div>
    <div class="vqa-label-workspace">
      <aside class="vqa-label-left">
        <div class="vqa-label-progress" id="vqa-label-progress">0 / 0 labeled</div>
        <label>filter
          <select id="vqa-label-filter">
            <option value="all">all</option>
            <option value="unlabeled">unlabeled</option>
            <option value="labeled">labeled</option>
            ${STATES.map(s => `<option value="${s}">${s}</option>`).join('')}
          </select>
        </label>
        <div class="vqa-label-meta" id="vqa-label-meta">No dataset loaded.</div>
        <div class="vqa-teacher-suggestion" id="vqa-teacher-suggestion">Teacher: none</div>
        <div class="vqa-label-buttons">
          ${STATES.map((s, i) => `<button data-state="${s}" class="vqa-label-state-btn">${i + 1} ${s}</button>`).join('')}
        </div>
        <label>severity
          <select id="vqa-label-severity">
            ${SEVERITIES.map(s => `<option value="${s}">${s}</option>`).join('')}
          </select>
        </label>
        <div class="vqa-label-nav">
          <button id="vqa-prev-sample" class="vqa-analysis-action">Q Previous</button>
          <button id="vqa-next-sample" class="vqa-analysis-action">E Next</button>
          <button id="vqa-accept-teacher" class="vqa-run-btn">Enter Accept</button>
          <button id="vqa-reject-teacher" class="vqa-analysis-action">R Reject</button>
          <button id="vqa-save-label" class="vqa-run-btn">S Save</button>
          <button id="vqa-skip-label" class="vqa-analysis-action">Skip</button>
        </div>
      </aside>
      <main class="vqa-label-viewer">
        <div class="vqa-label-image-wrap">
          <img id="vqa-label-image" alt="dataset sample" />
        </div>
        <pre class="vqa-label-json" id="vqa-label-json"></pre>
      </main>
    </div>
    <details class="vqa-details">
      <summary>Dataset / Train / Evaluate</summary>
      <div class="vqa-label-grid">
        <label>labels path <input id="vqa-train-labels" /></label>
        <label>run id <input id="vqa-train-runid" value="exp001" /></label>
        <label>epochs <input id="vqa-train-epochs" type="number" value="5" min="1" /></label>
        <label>batch <input id="vqa-train-batch" type="number" value="16" min="1" /></label>
        <button id="vqa-train-model" class="vqa-run-btn">Train local_model</button>
        <label>model path <input id="vqa-eval-model" /></label>
        <label>repeat <input id="vqa-eval-repeat" type="number" value="5" min="1" /></label>
        <button id="vqa-eval-model-btn" class="vqa-run-btn">Evaluate</button>
      </div>
      <pre class="vqa-json" id="vqa-dataset-result"></pre>
    </div>
  `;
  const datasetEl = wrap.querySelector('#vqa-label-dataset');
  const mcapEl = wrap.querySelector('#vqa-label-mcap');
  const intervalEl = wrap.querySelector('#vqa-label-interval');
  const maxEl = wrap.querySelector('#vqa-label-max');
  const filterEl = wrap.querySelector('#vqa-label-filter');
  const sevEl = wrap.querySelector('#vqa-label-severity');
  const statusEl = wrap.querySelector('#vqa-label-status');
  const progressEl = wrap.querySelector('#vqa-label-progress');
  const metaEl = wrap.querySelector('#vqa-label-meta');
  const teacherEl = wrap.querySelector('#vqa-teacher-suggestion');
  const imageEl = wrap.querySelector('#vqa-label-image');
  const jsonEl = wrap.querySelector('#vqa-label-json');
  const resultEl = wrap.querySelector('#vqa-dataset-result');
  const trainLabelsEl = wrap.querySelector('#vqa-train-labels');
  const evalModelEl = wrap.querySelector('#vqa-eval-model');
  let manifest = [];
  let labels = [];
  let filtered = [];
  let idx = 0;
  let selectedState = 'unknown';
  let reviewStatus = 'corrected';

  function labelKey(row) {
    return `${row.image_path || ''}`;
  }

  function labelMap() {
    const m = new Map();
    for (const l of labels) {
      m.set(labelKey(l), l);
    }
    return m;
  }

  function teacherFor(row, label) {
    return label?.teacher || row?.teacher || null;
  }

  async function mergeTeacherFromSidecar(mcapPath) {
    if (!mcapPath) { return; }
    const sidecar = await loadVqaSidecar(mcapPath);
    if (!sidecar?.frames?.length) { return; }
    const runtime = sidecar.runtime || {};
    const latest = sidecar.frames[sidecar.frames.length - 1];
    const states = latest.answer?.parsed?.camera_states || {};
    manifest = manifest.map(row => {
      if (row.teacher) { return row; }
      const st = states[row.camera_id];
      if (!st || st.source !== 'prompt_fanout') { return row; }
      return {
        ...row,
        teacher: {
          runtime: 'prompt_fanout',
          model: runtime.model || runtime.name || 'unknown',
          task: runtime.task || sidecar.questions?.[0] || 'unknown',
          raw_answer: st.teacher_raw_answer || st.visibility_state,
          state: st.visibility_state || 'unknown',
          review_status: st.review_status || 'pending',
        },
      };
    });
  }

  function refreshFilter() {
    const map = labelMap();
    const f = filterEl.value;
    filtered = manifest.filter(row => {
      const l = map.get(labelKey(row));
      if (f === 'all') { return true; }
      if (f === 'unlabeled') { return !l; }
      if (f === 'labeled') { return !!l; }
      return l?.state === f;
    });
    if (idx >= filtered.length) { idx = Math.max(0, filtered.length - 1); }
    renderCurrent();
  }

  function renderCurrent() {
    const map = labelMap();
    const labeled = labels.length;
    progressEl.textContent = `${labeled} / ${manifest.length} labeled`;
    const row = filtered[idx];
    if (!row) {
      metaEl.textContent = 'No sample for current filter.';
      imageEl.removeAttribute('src');
      jsonEl.textContent = '';
      return;
    }
    const label = map.get(labelKey(row));
    const teacher = teacherFor(row, label);
    selectedState = label?.state || selectedState || 'unknown';
    if (!label && teacher?.state) {
      selectedState = teacher.state;
      reviewStatus = 'pending';
    } else {
      reviewStatus = label?.review_status || (teacher ? 'pending' : 'corrected');
    }
    sevEl.value = label?.severity || sevEl.value || 'unknown';
    wrap.querySelectorAll('.vqa-label-state-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.state === selectedState);
    });
    imageEl.src = datasetImageUrl(row.image_path);
    metaEl.innerHTML = `
      <b>${esc(row.camera_id)}</b><br/>
      t=${esc(Number(row.timestamp_sec || 0).toFixed(2))}s<br/>
      ${idx + 1} / ${filtered.length}<br/>
      ${label ? `label=${esc(label.state)} / ${esc(label.severity)}` : 'unlabeled'}
    `;
    teacherEl.innerHTML = teacher
      ? `Teacher: <b>${esc(teacher.model || teacher.runtime || 'prompt_fanout')}</b> ${esc(teacher.task || '')} -> <b>${esc(teacher.state || teacher.raw_answer || 'unknown')}</b> (${esc(reviewStatus)})`
      : 'Teacher: none';
    jsonEl.textContent = JSON.stringify({ sample: row, label: label || null }, null, 2);
  }

  async function loadDataset() {
    statusEl.textContent = 'loading...';
    const data = await loadVqaManifest(datasetEl.value || 'adhoc');
    manifest = data.manifest || [];
    labels = data.labels || [];
    await mergeTeacherFromSidecar(data.metadata?.mcap_path || mcapEl.value);
    mergeTeacherFromLabels();
    trainLabelsEl.value = data.labelsPath || '';
    idx = 0;
    refreshFilter();
    statusEl.textContent = `loaded ${manifest.length}`;
  }

  async function saveCurrent() {
    const row = filtered[idx];
    if (!row) { return; }
    const existing = labelMap().get(labelKey(row));
    const teacher = teacherFor(row, existing);
    const label = {
      ...row,
      state: selectedState,
      severity: sevEl.value,
      review_status: reviewStatus,
      teacher,
      source: 'ad-topology-label-ui',
    };
    statusEl.textContent = 'saving...';
    try {
      const json = await saveVqaLabels(datasetEl.value || 'adhoc', [label]);
      labels.push(label);
      statusEl.textContent = `saved ${json.count}`;
      idx = Math.min(idx + 1, Math.max(0, filtered.length - 1));
      refreshFilter();
    } catch (err) {
      statusEl.textContent = `failed: ${err.message}`;
    }
  }

  function mergeTeacherFromLabels() {
    const byPath = new Map(labels.map(l => [labelKey(l), l]));
    manifest = manifest.map(row => {
      const l = byPath.get(labelKey(row));
      if (l?.teacher && !row.teacher) {
        return { ...row, teacher: l.teacher };
      }
      return row;
    });
  }

  wrap.querySelector('#vqa-extract-frames').addEventListener('click', async () => {
    statusEl.textContent = 'extracting...';
    try {
      const result = await extractVqaFrames({
        mcapPath: mcapEl.value,
        datasetId: datasetEl.value || 'adhoc',
        sampleIntervalSec: parseFloat(intervalEl.value) || 10,
        maxSamples: parseInt(maxEl.value, 10) || 20,
      });
      resultEl.textContent = JSON.stringify(result, null, 2);
      await loadDataset();
    } catch (err) {
      statusEl.textContent = `extract failed: ${err.message}`;
    }
  });
  wrap.querySelector('#vqa-load-dataset').addEventListener('click', () => {
    loadDataset().catch(err => { statusEl.textContent = `load failed: ${err.message}`; });
  });
  filterEl.addEventListener('change', refreshFilter);
  wrap.querySelectorAll('.vqa-label-state-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedState = btn.dataset.state;
      reviewStatus = 'corrected';
      renderCurrent();
    });
  });
  wrap.querySelector('#vqa-prev-sample').addEventListener('click', () => {
    idx = Math.max(0, idx - 1);
    renderCurrent();
  });
  wrap.querySelector('#vqa-next-sample').addEventListener('click', () => {
    idx = Math.min(Math.max(0, filtered.length - 1), idx + 1);
    renderCurrent();
  });
  wrap.querySelector('#vqa-save-label').addEventListener('click', () => saveCurrent());
  wrap.querySelector('#vqa-accept-teacher').addEventListener('click', () => {
    const row = filtered[idx];
    const teacher = teacherFor(row, labelMap().get(labelKey(row)));
    if (teacher?.state) {
      selectedState = teacher.state;
      reviewStatus = 'accepted';
      renderCurrent();
      saveCurrent();
    }
  });
  wrap.querySelector('#vqa-reject-teacher').addEventListener('click', () => {
    reviewStatus = 'rejected';
    selectedState = 'unknown';
    renderCurrent();
  });
  wrap.querySelector('#vqa-skip-label').addEventListener('click', () => {
    idx = Math.min(Math.max(0, filtered.length - 1), idx + 1);
    renderCurrent();
  });
  wrap.querySelector('#vqa-train-model').addEventListener('click', async () => {
    statusEl.textContent = 'training...';
    try {
      const result = await trainVqaLocalModel({
        labelsPath: trainLabelsEl.value,
        runId: wrap.querySelector('#vqa-train-runid').value || 'exp001',
        epochs: parseInt(wrap.querySelector('#vqa-train-epochs').value, 10) || 5,
        batchSize: parseInt(wrap.querySelector('#vqa-train-batch').value, 10) || 16,
        device: 'cpu',
      });
      resultEl.textContent = JSON.stringify(result, null, 2);
      evalModelEl.value = `${result.output_dir}/model.pt`;
      statusEl.textContent = 'train done';
    } catch (err) {
      statusEl.textContent = `train failed: ${err.message}`;
    }
  });
  wrap.querySelector('#vqa-eval-model-btn').addEventListener('click', async () => {
    statusEl.textContent = 'evaluating...';
    try {
      const result = await evaluateVqaLocalModel({
        modelPath: evalModelEl.value,
        labelsPath: trainLabelsEl.value,
        repeat: parseInt(wrap.querySelector('#vqa-eval-repeat').value, 10) || 5,
        device: 'cpu',
      });
      resultEl.textContent = JSON.stringify(result, null, 2);
      statusEl.textContent = 'eval done';
    } catch (err) {
      statusEl.textContent = `eval failed: ${err.message}`;
    }
  });

  wrap.addEventListener('keydown', (ev) => {
    const idx = Number(ev.key);
    if (idx >= 1 && idx <= STATES.length) {
      selectedState = STATES[idx - 1];
      renderCurrent();
      ev.preventDefault();
    } else if (ev.key === 'q') {
      wrap.querySelector('#vqa-prev-sample').click();
    } else if (ev.key === 'e') {
      wrap.querySelector('#vqa-next-sample').click();
    } else if (ev.key === 's') {
      saveCurrent();
    } else if (ev.key === 'u') {
      selectedState = 'unknown';
      reviewStatus = 'corrected';
      renderCurrent();
    } else if (ev.key === 'Enter') {
      wrap.querySelector('#vqa-accept-teacher').click();
    } else if (ev.key === 'r') {
      wrap.querySelector('#vqa-reject-teacher').click();
    }
  });
  return wrap;
}
