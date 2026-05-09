/**
 * Frontend driver for the /yolo-detect server endpoint.
 *
 * Streams NDJSON progress lines from the backend and exposes hooks to update
 * progress UI. After successful completion, the caller can re-fetch the
 * sidecar via loadYoloSidecar and refresh the camera panel state.
 */

/**
 * Run YOLO detection on the server side.
 *
 * @param {Object} opts
 * @param {string} opts.mcapPath  absolute path to source mcap on the server
 * @param {string} [opts.model]   yolo11n/s/m/l/x (default yolo11n)
 * @param {string} [opts.device]  cpu / cuda:0 / auto (default auto)
 * @param {number} [opts.conf]    0.01..0.99 (default 0.25)
 * @param {boolean} [opts.skipFisheye]
 * @param {number} [opts.maxFramesPerCam]
 * @param {function} [opts.onLog] called with each NDJSON event
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Object>} resolved with the final 'done' payload
 */
export async function runYoloDetect(opts) {
  const {
    mcapPath, model = 'yolo11n', device = 'auto', conf = 0.25,
    skipFisheye = false, maxFramesPerCam = 0,
    onLog, signal,
  } = opts;

  const resp = await fetch('http://localhost:8765/yolo-detect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mcapPath, model, device, conf,
      skipFisheye, maxFramesPerCam,
    }),
    signal,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`yolo-detect HTTP ${resp.status}: ${text}`);
  }
  if (!resp.body) {
    throw new Error('yolo-detect: no response stream');
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
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (onLog) { onLog(evt); }
      if (evt.type === 'done') { final = evt; }
    }
  }
  if (buf.trim()) {
    try {
      const evt = JSON.parse(buf);
      if (onLog) { onLog(evt); }
      if (evt.type === 'done') { final = evt; }
    } catch { /* ignore tail */ }
  }
  if (!final) {
    throw new Error('yolo-detect: stream closed without done event');
  }
  if (!final.ok) {
    throw new Error(
      final.error
        || `yolo-detect failed (exit=${final.exitCode}, signal=${final.signal})`,
    );
  }
  return final;
}

/**
 * Heuristically extract a short progress message from a CLI log line.
 * Returns null if the line is not interesting.
 */
export function summarizeLogLine(line) {
  if (!line) { return null; }
  const trimmed = line.trim();
  if (trimmed.startsWith('Loading model')) { return 'Loading model...'; }
  if (trimmed.startsWith('Found ')) { return trimmed; }
  if (trimmed.startsWith('Decoding camera frames')) { return 'Decoding frames...'; }
  if (trimmed.startsWith('Running YOLO inference')) { return 'Running inference...'; }
  if (trimmed.startsWith('Writing sidecar')) { return 'Writing sidecar...'; }
  if (trimmed.startsWith('Done.')) { return 'Done.'; }
  // mid-progress messages: "  decoded N frames..."
  if (/^\s*decoded \d+ frames/.test(trimmed)) { return trimmed.trim(); }
  if (/^\s*\/sensor\/camera\/.+:.+detections/.test(trimmed)) { return trimmed.trim(); }
  if (/^\s*inferred \d+ detections/.test(trimmed)) { return trimmed.trim(); }
  return null;
}
