/**
 * Frontend driver for the /camera-vqa-detect endpoint.
 *
 * Mirrors yolo-runner.js: the server streams NDJSON progress and finishes with
 * a `done` payload. The caller reloads the VQA sidecar afterwards.
 */

export async function runVqaDetect(opts) {
  const {
    mcapPath,
    runtime = 'fixture',
    runtimeCommand = '',
    runtimeUrl = '',
    precomputedPath = '',
    modelPath = '',
    device = 'cpu',
    sampleIntervalSec = 10,
    maxSamples = 8,
    stabilityRuns = 3,
    questions = ['camera_state', 'exposure_fault', 'function_impact'],
    onLog,
    signal,
  } = opts;

  const resp = await fetch('http://localhost:8765/camera-vqa-detect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mcapPath,
      runtime,
      runtimeCommand,
      runtimeUrl,
      precomputedPath,
      modelPath,
      device,
      sampleIntervalSec,
      maxSamples,
      stabilityRuns,
      questions,
    }),
    signal,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`camera-vqa-detect HTTP ${resp.status}: ${text}`);
  }
  if (!resp.body) {
    throw new Error('camera-vqa-detect: no response stream');
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let final = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) { break; }
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() || '';
    for (const line of parts) {
      if (!line.trim()) { continue; }
      let evt;
      try { evt = JSON.parse(line); }
      catch { continue; }
      if (onLog) { onLog(evt); }
      if (evt.type === 'done') { final = evt; }
    }
  }
  if (buf.trim()) {
    try {
      const evt = JSON.parse(buf);
      if (onLog) { onLog(evt); }
      if (evt.type === 'done') { final = evt; }
    } catch { /* ignore */ }
  }
  if (!final) {
    throw new Error('camera-vqa-detect: stream closed without done event');
  }
  if (!final.ok) {
    throw new Error(final.error || `camera-vqa-detect failed (exit=${final.exitCode})`);
  }
  return final;
}

export function summarizeVqaLogLine(line) {
  if (!line) { return null; }
  const t = line.trim();
  if (t.startsWith('Camera VQA')) { return 'Starting Camera VQA...'; }
  if (t.startsWith('input:')) { return t; }
  if (t.startsWith('runtime:')) { return t; }
  if (t.startsWith('cameras:')) { return t; }
  if (t.startsWith('missing:')) { return t; }
  if (/^sample \d+\/\d+/.test(t)) { return t; }
  if (t.startsWith('Done.')) { return t; }
  if (t.startsWith('error:')) { return t; }
  return null;
}

async function postJson(path, payload) {
  const resp = await fetch(`http://localhost:8765${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(json.error || `${path} HTTP ${resp.status}`);
  }
  return json;
}

export function datasetImageUrl(path) {
  return `http://localhost:8765/camera-vqa-image?path=${encodeURIComponent(path)}`;
}

export async function extractVqaFrames(opts) {
  return postJson('/camera-vqa-extract-frames', opts);
}

export async function loadVqaManifest(datasetId) {
  return postJson('/camera-vqa-manifest-load', { datasetId });
}

export async function loadVqaLabels(datasetId) {
  return postJson('/camera-vqa-labels-load', { datasetId });
}

export async function saveVqaLabels(datasetId, labels) {
  return postJson('/camera-vqa-label-save', { datasetId, labels });
}

export async function trainVqaLocalModel(opts) {
  return postJson('/camera-vqa-train', opts);
}

export async function evaluateVqaLocalModel(opts) {
  return postJson('/camera-vqa-evaluate', opts);
}

export async function runPromptFanout(opts) {
  return postJson('/camera-vqa-prompt-fanout', opts);
}
