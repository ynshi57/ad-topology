const STATES = ['clean', 'wet', 'blocked', 'blur', 'dark', 'saturate', 'frozen', 'unknown'];
const SEVERITIES = ['none', 'low', 'medium', 'high', 'unknown'];

function esc(s) {
  const d = document.createElement('span');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

export function renderLabelPanel({ cameras = [], mcapPath = '', getCurrentFrame = () => null }) {
  const wrap = document.createElement('details');
  wrap.className = 'vqa-details vqa-label-panel';
  wrap.innerHTML = `
    <summary>Label Mode</summary>
    <div class="vqa-label-grid">
      <label>dataset <input id="vqa-label-dataset" value="adhoc" /></label>
      <label>camera
        <select id="vqa-label-camera">
          ${cameras.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('')}
        </select>
      </label>
      <label>state
        <select id="vqa-label-state">
          ${STATES.map(s => `<option value="${s}">${s}</option>`).join('')}
        </select>
      </label>
      <label>severity
        <select id="vqa-label-severity">
          ${SEVERITIES.map(s => `<option value="${s}">${s}</option>`).join('')}
        </select>
      </label>
      <button id="vqa-label-save" class="vqa-run-btn">Save Label</button>
      <span id="vqa-label-status" class="vqa-panel-status">idle</span>
    </div>
  `;
  const datasetEl = wrap.querySelector('#vqa-label-dataset');
  const camEl = wrap.querySelector('#vqa-label-camera');
  const stateEl = wrap.querySelector('#vqa-label-state');
  const sevEl = wrap.querySelector('#vqa-label-severity');
  const saveBtn = wrap.querySelector('#vqa-label-save');
  const statusEl = wrap.querySelector('#vqa-label-status');

  saveBtn?.addEventListener('click', async () => {
    const frame = getCurrentFrame?.() || {};
    const label = {
      mcap_path: mcapPath,
      timestamp_sec: frame.timestamp_sec ?? null,
      log_time_ns: frame.log_time_ns ?? null,
      camera_id: camEl.value,
      state: stateEl.value,
      severity: sevEl.value,
      source: 'ad-topology-label-ui',
    };
    statusEl.textContent = 'saving...';
    try {
      const resp = await fetch('http://localhost:8765/camera-vqa-label-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetId: datasetEl.value || 'adhoc', labels: [label] }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(json.error || `HTTP ${resp.status}`);
      }
      statusEl.textContent = `saved ${json.count}`;
    } catch (err) {
      statusEl.textContent = `failed: ${err.message}`;
    }
  });

  wrap.addEventListener('keydown', (ev) => {
    const idx = Number(ev.key);
    if (idx >= 1 && idx <= STATES.length) {
      stateEl.value = STATES[idx - 1];
      ev.preventDefault();
    }
  });
  return wrap;
}
