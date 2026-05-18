/**
 * Camera VQA sidecar loader and time-indexed lookup helpers.
 */

function vqaSidecarPathForMcap(mcapPath) {
  let base = mcapPath || '';
  if (base.toLowerCase().endsWith('.mcap')) {
    base = base.slice(0, -5);
  }
  return base.endsWith('.camera')
    ? `${base}.vqa.json`
    : `${base}.camera.vqa.json`;
}

export async function loadVqaSidecar(mcapPath) {
  if (!mcapPath) { return null; }
  const sidecarPath = vqaSidecarPathForMcap(mcapPath);
  try {
    const url = `http://localhost:8765/file?path=${encodeURIComponent(sidecarPath)}`;
    const resp = await fetch(url);
    if (resp.status === 404) { return null; }
    if (!resp.ok) {
      console.warn(`VQA sidecar fetch failed: ${resp.status}`);
      return null;
    }
    const sidecar = await resp.json();
    return buildVqaIndex(sidecar);
  } catch (err) {
    console.warn('VQA sidecar load error:', err.message);
    return null;
  }
}

export function buildVqaIndex(sidecar) {
  const frames = [...(sidecar.frames || [])].sort(
    (a, b) => Number(a.log_time_ns || 0) - Number(b.log_time_ns || 0),
  );
  const stateCounts = sidecar.summary?.camera_state_counts || {};
  console.log(
    `Loaded VQA sidecar: model=${sidecar.model} frames=${frames.length}`
  );
  return {
    model: sidecar.model,
    runtime: sidecar.runtime,
    version: sidecar.version,
    questions: sidecar.questions || [],
    summary: sidecar.summary || {},
    frames,
    totalFrames: frames.length,
    stateCounts,
  };
}

export function findVqaFrameAt(index, secOffset, startTimeNs) {
  if (!index || !index.frames || index.frames.length === 0) { return null; }
  const targetNs = Number(startTimeNs || 0) + secOffset * 1e9;
  const arr = index.frames;
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Number(arr[mid].log_time_ns || 0) <= targetNs) { lo = mid + 1; }
    else { hi = mid; }
  }
  const idx = lo - 1;
  return idx >= 0 ? arr[idx] : arr[0];
}

export function getCameraState(frame, cameraName) {
  if (!frame || !cameraName) { return null; }
  return frame.answer?.parsed?.camera_states?.[cameraName] || null;
}

export function getFunctionImpact(frame) {
  return frame?.answer?.parsed?.function_impact || {};
}
