import './style.css';
import { loadMcapFiles } from './mcap-loader.js';
import { buildTopologyFromChannels, DOMAINS } from './topology-builder.js';
import { createGraph } from './graph.js';
import { createTimeline } from './timeline.js';
import { createTopicPanel } from './topic-panel.js';
import { createNodeDetail } from './node-detail.js';
import { initDecoder, decodeMessage } from './proto-decoder.js';
import { createReplayTestView } from './test-panel.js';
import { create3DScene } from './scene-3d.js';
import { createSceneTopics } from './scene-topics.js';
import { createSplitter } from './splitter.js';
import { initCameraDecoders, isCameraSchema } from './camera-decoder.js';
import { createCameraPanel, buildCameraIndex } from './camera-panel.js';
import { isCameraVideoTopic, isVideoStreamSchema } from './videostream-decoder.js';
import { loadYoloSidecar } from './yolo-overlay.js';
import { listPlatforms, getActivePlatform, setActivePlatform } from './platform-config.js';
import { createLogPane } from './log-pane.js';
import { loadVqaSidecar } from './vqa-overlay.js';

const app = document.getElementById('app');

let currentView = 'dropzone';
let currentGraph = null;
let currentTimeline = null;
let currentPanel = null;
let currentDetail = null;
let current3DScene = null;
let current3DTopics = null;
let show3D = false;
let showCamera = false;
let currentCameraPanel = null;
let cameraIndex = null;
let activeSplitters = [];

let sharedSummary = null;
let sharedTopology = null;
let sharedStartNs = null;
let sharedDesignHz = {};
let sharedYoloIndex = null;
let sharedVqaIndex = null;
let sharedMcapPath = null;

// Optimized message index
let msgBucketIndex = null;   // bucketKey -> [topic, ...]
let msgTopicOffsets = null;   // topic -> Float64Array of relative-seconds timestamps (compact)
let msgTopicFirstSec = null;  // topic -> first message relative sec

// Pre-cached message data for detail view: topic -> [{logTime, data, schemaId, channelId}]
let msgDataCache = null;

// 3D foxglove data: topic -> [{sec, decoded}] (on-demand decoded)
let foxgloveChannels = null; // channels with foxglove.* schemas
let foxgloveDataCache = null; // topic -> [{sec, decoded}]
let foxgloveCursors = {}; // topic -> last rendered index

// Mount the global Debug Log pane once. It's body-fixed (not inside the
// `app` container) so that view re-renders never destroy/recreate it; the
// pane survives across Topology / Camera / 3D / DropZone switches and
// keeps its history & SSE connection.
let _globalLogPane = null;
function ensureLogPane() {
  if (_globalLogPane) { return _globalLogPane; }
  let host = document.getElementById('global-log-pane-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'global-log-pane-host';
    host.className = 'log-pane-host';
    document.body.appendChild(host);
  }
  _globalLogPane = createLogPane(host);
  return _globalLogPane;
}
ensureLogPane();

showDropZone();

// Also check URL params on page load for auto-load
checkUrlParams();

/**
 * Parse mcap URLs from a viz.data.neolix.cn URL or direct mcap URL(s).
 * Extracts ds.url parameters which contain S3-signed mcap file URLs.
 */
/**
 * Calls the backend /record2mcap endpoint with an absolute server path.
 * Streams NDJSON progress events and resolves with { outputPath, filename, sizeMB }
 * once the converter exits successfully.
 * @param {string} recordPath Absolute path on the server.
 * @param {{verify?: boolean, overwrite?: boolean, onLog?: (line: string) => void}} opts
 */
async function convertRecordOnServer(recordPath, opts = {}) {
  const { verify = false, overwrite = true, platform = 'auto', onLog = () => {} } = opts;
  const resp = await fetch('http://localhost:8765/record2mcap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputPath: recordPath,
      verify,
      verifySamples: verify ? 50 : 0,
      overwrite,
      platform,
    }),
  });

  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '');
    let msg = `/record2mcap responded ${resp.status}`;
    try {
      const parsed = JSON.parse(errText);
      if (parsed.error) msg = parsed.error;
      if (parsed.hint) msg += ` (${parsed.hint})`;
    } catch {
      if (errText) msg = errText;
    }
    throw new Error(msg);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let doneEvent = null;
  let lastError = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        onLog(line);
        continue;
      }
      if (evt.type === 'start') {
        onLog(`converter: ${evt.binary}`);
        onLog(`args: ${Array.isArray(evt.args) ? evt.args.join(' ') : ''}`);
        onLog(`output: ${evt.outputPath}`);
      } else if (evt.type === 'log') {
        onLog(`[${evt.stream}] ${evt.line}`);
      } else if (evt.type === 'done') {
        doneEvent = evt;
        if (!evt.ok) {
          lastError = evt.error || `record2mcap exited with code ${evt.exitCode}`;
        }
      }
    }
  }

  if (!doneEvent) {
    throw new Error('record2mcap stream ended before emitting a done event');
  }
  if (lastError) {
    throw new Error(lastError);
  }
  if (!doneEvent.outputExists) {
    throw new Error('record2mcap finished but output file is missing');
  }

  const outputPath = doneEvent.outputPath;
  const filename = outputPath.split('/').pop();
  const sizeMB = (Number(doneEvent.outputSizeBytes || 0) / (1024 * 1024)).toFixed(1);
  return { outputPath, filename, sizeMB, report: doneEvent.report };
}

/**
 * Ask the server to locate an mcap by basename across known directories.
 * Returns the absolute path if found, otherwise null.
 */
async function tryFindMcapPath(basename) {
  if (!basename) { return null; }
  try {
    const r = await fetch(
      `http://localhost:8765/find-mcap?name=${encodeURIComponent(basename)}`,
    );
    if (!r.ok) { return null; }
    const j = await r.json();
    return j.found ? j.path : null;
  } catch {
    return null;
  }
}

/**
 * Strip non-S3 query params from an S3 pre-signed URL. S3 sigv4 only
 * recognizes ``X-Amz-*`` query params; viz-platform leftovers like
 * ``layoutId=13`` will break the signature on Baidu OBS (and possibly AWS).
 */
function cleanS3Url(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const params = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (k.startsWith('X-Amz-')) {
        params.set(k, v);
      }
    }
    u.search = params.toString();
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function parseMcapUrls(input) {
  const urls = [];

  try {
    const parsed = new URL(input);
    const rawSearch = parsed.search || '';

    // Fully decode the query string (may be double-encoded)
    let decoded = rawSearch;
    try { decoded = decodeURIComponent(decoded); } catch {}
    try { decoded = decodeURIComponent(decoded); } catch {}

    // Split by 'ds.url=' to extract mcap URLs (the viz platform may pack
    // multiple mcap URLs into one query string by chaining ``&ds.url=`` after
    // a previous URL's signature).
    const parts = decoded.split('ds.url=');
    for (let i = 1; i < parts.length; i++) {
      let url = parts[i];
      if (url.endsWith('&')) { url = url.slice(0, -1); }

      // Defensive: drop legacy viz platform tail params before structured
      // cleanup. (URL parsing below handles any survivors.)
      const trailingParams = /&(id|recordName|time|carId|date|layoutId)=/;
      const trailIdx = url.search(trailingParams);
      if (trailIdx > 0) { url = url.slice(0, trailIdx); }

      if (!url.includes('.mcap')) { continue; }

      // Definitively remove all non-S3 query params.
      const cleaned = cleanS3Url(url);
      if (!urls.includes(cleaned)) { urls.push(cleaned); }
    }

    // If no ds.url found but input itself is a mcap URL
    if (urls.length === 0 && input.includes('.mcap')) {
      urls.push(cleanS3Url(input));
    }
  } catch {
    if (input.startsWith('http') && input.includes('.mcap')) {
      urls.push(cleanS3Url(input));
    }
  }

  return urls;
}

/**
 * Check if the page URL has mcap parameters for auto-loading.
 * Supports: ?url=<mcap_url> or ?viz=<viz_platform_url>
 */
function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const vizUrl = params.get('viz');
  const mcapUrl = params.get('url');

  if (vizUrl) {
    setTimeout(() => {
      document.getElementById('dz-url').value = vizUrl;
      document.getElementById('dz-url-load').click();
    }, 500);
  } else if (mcapUrl) {
    setTimeout(() => {
      document.getElementById('dz-url').value = mcapUrl;
      document.getElementById('dz-url-load').click();
    }, 500);
  }
}

// =====================================================================
//  DROP ZONE
// =====================================================================

function showDropZone() {
  currentView = 'dropzone';
  app.innerHTML = `
    <div class="drop-zone" id="drop-zone" data-view-name="Load View">
      <span class="view-label">Load View</span>
      <div class="dz-content">
        <div class="dz-icon">
          <svg viewBox="0 0 48 48" width="48" height="48">
            <path d="M24 4L14 14h7v14h6V14h7L24 4z" fill="#ffffff" opacity="0.6"/>
            <path d="M8 32v8a4 4 0 004 4h24a4 4 0 004-4v-8" fill="none" stroke="#ffffff" stroke-width="2.5" opacity="0.4"/>
          </svg>
        </div>
        <h1 class="dz-title">Drop .mcap files here</h1>
        <p class="dz-sub">or click to browse. Double-click a node to see message details.</p>
        <input type="file" id="file-input" multiple accept=".mcap" style="display:none" />
        <button class="dz-btn" id="dz-browse">Select Files</button>
        <a class="dz-btn" href="fault-explorer.html" target="_blank" style="text-decoration:none;display:inline-block;margin-left:8px">Fault Explorer</a>
        <div class="dz-url-wrap">
          <input class="dz-url-input" id="dz-url" placeholder="Paste viz.data.neolix.cn URL or mcap URL..." />
          <button class="dz-url-btn" id="dz-url-load">Load URL</button>
        </div>
        <div class="dz-url-wrap dz-record-wrap">
          <input class="dz-url-input" id="dz-record-path" placeholder="Server path: .record (convert + load) or .mcap (load directly)" />
          <button class="dz-url-btn" id="dz-record-load">Load</button>
        </div>
        <div class="dz-record-opts">
          <label class="dz-record-opt">
            <span class="dz-record-opt-label">Platform:</span>
            <select id="dz-platform" class="dz-platform-select">
              <option value="auto">Auto-detect</option>
              <option value="X3PRO_25_L">X3PRO_25_L</option>
              <option value="X3PRO_25">X3PRO_25</option>
              <option value="X6">X6</option>
              <option value="X6S">X6S</option>
              <option value="X2O">X2O</option>
              <option value="LONG_V2">LONG_V2</option>
              <option value="LONG">LONG</option>
              <option value="ORIN">ORIN</option>
              <option value="PRO">PRO</option>
            </select>
          </label>
          <label class="dz-record-opt">
            <input type="checkbox" id="dz-record-verify" />
            <span>verify (sample-check 50, record only)</span>
          </label>
          <label class="dz-record-opt">
            <input type="checkbox" id="dz-record-overwrite" checked />
            <span>overwrite existing mcap (record only)</span>
          </label>
        </div>
        <div class="dz-progress-wrap" id="dz-progress-wrap" style="display:none">
          <div class="dz-progress-bar"><div class="dz-progress-fill" id="dz-progress-fill"></div></div>
          <div class="dz-progress-text" id="dz-progress-text"></div>
        </div>
        <pre class="dz-record-log" id="dz-record-log" style="display:none"></pre>

        <div class="dz-recents" id="dz-recents">
          <div class="dz-recents-header">
            <span class="dz-recents-title">Recent files in mcap_file/</span>
            <button class="dz-recents-refresh" id="dz-recents-refresh" title="Refresh">refresh</button>
          </div>
          <div class="dz-recents-list" id="dz-recents-list">
            <div class="dz-recents-empty">loading...</div>
          </div>
        </div>

        <div class="dz-hint"><span class="dz-sample" id="dz-sample">Load sample from workspace</span></div>
      </div>
    </div>
  `;
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  document.getElementById('dz-browse').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files.length) handleFiles(Array.from(fileInput.files)); });
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.mcap'));
    if (files.length) handleFiles(files);
  });
  document.getElementById('dz-url-load').addEventListener('click', async () => {
    const urlInput = document.getElementById('dz-url').value.trim();
    if (!urlInput) return;

    showLoading('Parsing URL and downloading mcap files...');
    try {
      const mcapUrls = parseMcapUrls(urlInput);
      if (mcapUrls.length === 0) {
        showDropZone();
        alert('No mcap URLs found in the input.');
        return;
      }

      const PROXY_BASE = 'http://localhost:8765/proxy?url=';

      const files = [];
      const savedPaths = [];
      for (let i = 0; i < mcapUrls.length; i++) {
        const url = mcapUrls[i];
        const filename = url.split('/').pop().split('?')[0] || `remote_${i}.mcap`;
        showLoading(`Downloading ${filename} (${i + 1}/${mcapUrls.length})...`);
        // Use backend proxy to avoid CORS issues. Also ask the server to cache
        // the bytes to /tmp/ad-topology-cache/<filename> so server-side tools
        // (YOLO, etc.) can operate on the same data without a second upload.
        const proxyUrl = PROXY_BASE + encodeURIComponent(url)
          + '&save=' + encodeURIComponent(filename);
        const res = await fetch(proxyUrl);
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`Download failed for ${filename}: ${res.status} ${errText}`);
        }
        const savedPath = res.headers.get('X-Saved-Path');
        const blob = await res.blob();
        files.push(new File([blob], filename, { type: 'application/octet-stream' }));
        if (savedPath) {
          savedPaths.push({ filename, path: savedPath });
        }
      }

      if (files.length) {
        // Prefer the camera mcap as the YOLO source (it is the one with
        // /sensor/camera/* video streams). Fall back to the first saved path.
        const cameraEntry = savedPaths.find(s => /camera\.mcap$/i.test(s.filename));
        const mcapServerPath = (cameraEntry || savedPaths[0])?.path || null;
        await handleFiles(files, mcapServerPath);
      } else {
        showDropZone();
        alert('Failed to download mcap files.');
      }
    } catch (err) {
      console.error('URL load error:', err);
      app.innerHTML = `<div class="loading"><p style="color:#ef4444">URL load error: ${err.message}</p><button class="dz-btn" onclick="location.reload()">Retry</button></div>`;
    }
  });

  // Restore last-used platform from localStorage
  try {
    const savedPlatform = localStorage.getItem('ad-topology-platform');
    const platformSel = document.getElementById('dz-platform');
    if (savedPlatform && platformSel) { platformSel.value = savedPlatform; }
  } catch {}

  document.getElementById('dz-record-load').addEventListener('click', async () => {
    const inputPathRaw = document.getElementById('dz-record-path').value.trim();
    if (!inputPathRaw) {
      return;
    }
    const verify = document.getElementById('dz-record-verify').checked;
    const overwrite = document.getElementById('dz-record-overwrite').checked;
    const platform = document.getElementById('dz-platform').value;
    try { localStorage.setItem('ad-topology-platform', platform); } catch {}
    const logEl = document.getElementById('dz-record-log');
    const btn = document.getElementById('dz-record-load');
    logEl.style.display = 'block';
    logEl.textContent = '';
    btn.disabled = true;

    const appendLog = (line) => {
      logEl.textContent += line + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    };

    const isAlreadyMcap = inputPathRaw.toLowerCase().endsWith('.mcap');

    try {
      let mcapPath;
      let filename;
      if (isAlreadyMcap) {
        appendLog(`loading existing mcap: ${inputPathRaw}`);
        mcapPath = inputPathRaw;
        filename = inputPathRaw.split('/').pop() || 'remote.mcap';
      } else {
        if (platform && platform !== 'auto') {
          appendLog(`platform: ${platform}`);
        } else {
          appendLog('platform: auto-detect');
        }
        const converted = await convertRecordOnServer(inputPathRaw, {
          verify,
          overwrite,
          platform,
          onLog: appendLog,
        });
        appendLog(`downloading ${converted.filename} (${converted.sizeMB} MB)...`);
        mcapPath = converted.outputPath;
        filename = converted.filename;
      }

      appendLog('fetching mcap from server...');
      const fileResp = await fetch(
        `http://localhost:8765/file?path=${encodeURIComponent(mcapPath)}`,
      );
      if (!fileResp.ok) {
        const errText = await fileResp.text().catch(() => '');
        throw new Error(`fetch mcap failed: ${fileResp.status} ${errText}`);
      }

      const contentLength = parseInt(fileResp.headers.get('Content-Length') || '0', 10);
      const progressWrap = document.getElementById('dz-progress-wrap');
      const progressFill = document.getElementById('dz-progress-fill');
      const progressText = document.getElementById('dz-progress-text');
      if (progressWrap) { progressWrap.style.display = 'block'; }

      let receivedBytes = 0;
      const chunks = [];
      const reader = fileResp.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }
        chunks.push(value);
        receivedBytes += value.length;
        if (contentLength > 0 && progressFill) {
          const pct = Math.round(receivedBytes / contentLength * 100);
          progressFill.style.width = `${pct}%`;
          if (progressText) {
            progressText.textContent = `${(receivedBytes / 1024 / 1024).toFixed(1)} / ${(contentLength / 1024 / 1024).toFixed(1)} MB`;
          }
        }
      }

      const blob = new Blob(chunks);
      appendLog(`downloaded ${blob.size.toLocaleString()} bytes, parsing mcap...`);
      if (progressFill) { progressFill.style.width = '100%'; }
      if (progressText) { progressText.textContent = 'parsing...'; }
      const file = new File([blob], filename, { type: 'application/octet-stream' });
      await handleFiles([file], mcapPath);
    } catch (err) {
      console.error('Load error:', err);
      appendLog(`\nERROR: ${err.message}`);
      btn.disabled = false;
    }
  });

  document.getElementById('dz-sample').addEventListener('click', async () => {
    showLoading('Loading sample files...');
    try {
      const urls = ['/X610034_20260406113014644.lite.mcap', '/X610034_20260406113014644.camera.mcap'];
      const files = [];
      for (const url of urls) {
        try { const r = await fetch(url); if (r.ok) { const b = await r.blob(); files.push(new File([b], url.split('/').pop())); } } catch {}
      }
      if (files.length) await handleFiles(files);
      else { showDropZone(); alert('Sample files not found.'); }
    } catch { showDropZone(); }
  });

  document.getElementById('dz-recents-refresh').addEventListener('click', refreshRecents);
  refreshRecents();
}

async function refreshRecents() {
  const listEl = document.getElementById('dz-recents-list');
  if (!listEl) { return; }
  listEl.innerHTML = '<div class="dz-recents-empty">loading...</div>';
  try {
    const r = await fetch('http://localhost:8765/list-mcaps');
    if (!r.ok) {
      listEl.innerHTML = '<div class="dz-recents-empty">cannot reach server</div>';
      return;
    }
    const j = await r.json();
    renderRecents(listEl, j.entries || []);
  } catch (err) {
    listEl.innerHTML = `<div class="dz-recents-empty">load error: ${err.message}</div>`;
  }
}

function renderRecents(listEl, entries) {
  if (!entries.length) {
    listEl.innerHTML = '<div class="dz-recents-empty">no cached mcaps yet — try Load URL or Server path</div>';
    return;
  }
  listEl.innerHTML = entries.map((e, i) => {
    const totalSize = e.parts.reduce((s, p) => s + p.size, 0);
    const variantChips = e.parts.map(p =>
      `<span class="dz-recent-chip" title="${p.basename} - ${formatBytes(p.size)}">${p.variant}</span>`,
    ).join(' ');
    const sidecarBadge = e.hasSidecar
      ? `<span class="dz-recent-yolo" title="${e.sidecarSummary?.frames || 0} frames">YOLO ${e.sidecarSummary?.model || ''} · ${e.sidecarSummary?.totalDetections || 0} dets</span>`
      : '';
    const date = new Date(e.maxMtime);
    const ago = formatTimeAgo(date);
    return `
      <div class="dz-recent" data-idx="${i}">
        <div class="dz-recent-line1">
          <span class="dz-recent-stem">${escapeHtml(e.stem)}</span>
          <span class="dz-recent-meta">${formatBytes(totalSize)} · ${ago}</span>
        </div>
        <div class="dz-recent-line2">
          ${variantChips}
          ${sidecarBadge}
        </div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('.dz-recent').forEach(el => {
    const idx = parseInt(el.dataset.idx, 10);
    el.addEventListener('click', () => loadCachedEntry(entries[idx]));
  });
}

async function loadCachedEntry(entry) {
  showLoading(`Loading ${entry.stem} (${entry.parts.length} part(s))...`);
  try {
    const files = [];
    let cameraPath = null;
    for (let i = 0; i < entry.parts.length; i++) {
      const part = entry.parts[i];
      updateLoadingProgress(20 + 60 * i / entry.parts.length,
        `Fetching ${part.basename}...`);
      const fileResp = await fetch(
        `http://localhost:8765/file?path=${encodeURIComponent(part.path)}`,
      );
      if (!fileResp.ok) {
        throw new Error(`Failed to fetch ${part.basename}: HTTP ${fileResp.status}`);
      }
      const blob = await fileResp.blob();
      files.push(new File([blob], part.basename, { type: 'application/octet-stream' }));
      if (part.variant === 'camera' || part.variant === 'single') {
        cameraPath = part.path;
      }
    }
    if (!cameraPath && entry.parts.length > 0) {
      cameraPath = entry.parts[0].path;
    }
    await handleFiles(files, cameraPath);
  } catch (err) {
    console.error('Load cached entry failed:', err);
    app.innerHTML = `<div class="loading"><p style="color:#ef4444">Error: ${err.message}</p><button class="dz-btn" onclick="location.reload()">Retry</button></div>`;
  }
}

function formatBytes(n) {
  if (n < 1024) { return `${n} B`; }
  if (n < 1024 * 1024) { return `${(n / 1024).toFixed(1)} KB`; }
  if (n < 1024 * 1024 * 1024) { return `${(n / 1024 / 1024).toFixed(1)} MB`; }
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatTimeAgo(date) {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60) { return 'just now'; }
  if (sec < 3600) { return `${Math.floor(sec / 60)}m ago`; }
  if (sec < 86400) { return `${Math.floor(sec / 3600)}h ago`; }
  return `${Math.floor(sec / 86400)}d ago`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function showLoading(msg) {
  app.innerHTML = `<div class="loading"><div class="loading-spinner"></div><p id="loading-msg">${msg}</p><div class="dz-progress-wrap" id="loading-progress" style="display:none;margin-top:12px;width:400px"><div class="dz-progress-bar"><div class="dz-progress-fill" id="loading-fill"></div></div><div class="dz-progress-text" id="loading-text"></div></div></div>`;
}

function updateLoadingProgress(pct, text) {
  const fill = document.getElementById('loading-fill');
  const txt = document.getElementById('loading-text');
  const wrap = document.getElementById('loading-progress');
  const msg = document.getElementById('loading-msg');
  if (wrap) { wrap.style.display = 'block'; }
  if (fill) { fill.style.width = `${Math.min(pct, 100)}%`; }
  if (txt) { txt.textContent = text || ''; }
  if (msg && text) { msg.textContent = text; }
}

async function handleFiles(files, mcapServerPath) {
  showLoading(`Preparing ${files.length} file(s)...`);
  sharedMcapPath = mcapServerPath || null;

  // If the caller didn't know an absolute server path (e.g. Select Files /
  // drag&drop), try to find a matching file on the server by basename. This
  // lets local-loaded mcaps reuse server-side artifacts like .yolo.json.
  if (!sharedMcapPath && files.length > 0) {
    const cameraGuess = files.find(f => /camera\.mcap$/i.test(f.name)) || files[0];
    sharedMcapPath = await tryFindMcapPath(cameraGuess.name);
    if (sharedMcapPath) {
      console.log(`Resolved server-side mcap path: ${sharedMcapPath}`);
    }
  }
  try {
    updateLoadingProgress(10, 'Opening mcap files...');
    sharedSummary = await loadMcapFiles(files);

    updateLoadingProgress(30, 'Building topology...');
    sharedTopology = buildTopologyFromChannels(sharedSummary.channels);
    sharedStartNs = sharedSummary.startTimeNs;

    updateLoadingProgress(45, 'Initializing proto decoder...');
    await initDecoder(sharedSummary.readers);

    updateLoadingProgress(55, 'Initializing camera decoder...');
    await initCameraDecoders(sharedSummary.readers);

    updateLoadingProgress(60, 'Checking for YOLO/VQA sidecars...');
    sharedYoloIndex = null;
    sharedVqaIndex = null;
    if (mcapServerPath) {
      try {
        sharedYoloIndex = await loadYoloSidecar(mcapServerPath);
      } catch (err) {
        console.warn('YOLO sidecar load failed (non-fatal):', err);
      }
      try {
        sharedVqaIndex = await loadVqaSidecar(mcapServerPath);
      } catch (err) {
        console.warn('VQA sidecar load failed (non-fatal):', err);
      }
    }

    updateLoadingProgress(70, 'Topology ready, building message index...');
    showTopologyView();
  } catch (err) {
    console.error('MCAP parse error:', err);
    app.innerHTML = `<div class="loading"><p style="color:#ef4444">Error: ${err.message}</p><button class="dz-btn" onclick="location.reload()">Retry</button></div>`;
  }
}

// =====================================================================
//  TOPOLOGY VIEW
// =====================================================================

function showTopologyView() {
  currentView = 'topology';
  const summary = sharedSummary;
  const topology = sharedTopology;
  const fileNames = [...new Set(summary.channels.map(c => c.sourceFile))].join(', ');

  // Identify foxglove channels for 3D panel (exclude camera schemas)
  foxgloveChannels = summary.channels.filter(ch =>
    ch.schemaName.startsWith('foxglove.') && !isCameraSchema(ch.schemaName)
  );

  const hasCameras = (cameraIndex && cameraIndex.cameras.length > 0)
    || summary.channels.some(ch =>
      ch.schemaName === 'foxglove.CompressedImage'
      || (isVideoStreamSchema(ch.schemaName) && isCameraVideoTopic(ch.topic))
    );

  app.innerHTML = `
    <div class="topbar" data-view-name="Topology View">
      <span class="view-label">Topology View</span>
      <h1>Process Topology</h1>
      <div class="sep"></div>
      <div class="topbar-info">
        <span class="tb-file">${fileNames}</span>
        <span class="tb-stat">${summary.durationSec}s</span>
        <span class="tb-stat">${summary.totalMessages.toLocaleString()} msgs</span>
        <span class="tb-stat">${summary.channels.length} topics</span>
      </div>
      <div class="controls">
        <select class="btn" id="cfg-platform" title="ad_dag platform profile">
          ${listPlatforms().map(p => `<option value="${p}" ${p === getActivePlatform() ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
        <button class="btn ${show3D ? 'active' : ''}" id="btn-3d">3D</button>
        ${hasCameras ? `<button class="btn ${showCamera ? 'active' : ''}" id="btn-camera">Camera</button>` : ''}
        <button class="btn" id="btn-faults">Faults</button>
        <button class="btn" id="btn-refresh-config">Refresh Config</button>
        <button class="btn" id="btn-reset">Reset</button>
        <button class="btn" id="btn-new">New File</button>
      </div>
    </div>
    <div id="cam-avif-warn-slot"></div>
    <div class="main-area">
      <div class="scene-topics-area" id="scene-topics-area" style="display:${show3D ? 'flex' : 'none'}"></div>
      <div class="graph-area" id="graph-area" style="display:${show3D || showCamera ? 'none' : 'block'}"></div>
      <div class="scene-3d-area" id="scene-3d-area" style="display:${show3D ? 'block' : 'none'}"></div>
      <div class="camera-area" id="camera-area" style="display:${showCamera ? 'flex' : 'none'}" data-view-name="Camera View"></div>
      <div class="panel-area" id="panel-area" style="display:${show3D || showCamera ? 'none' : 'flex'}"></div>
    </div>
    <div class="timeline-area" id="timeline-area"></div>
  `;

  activeSplitters.forEach(s => s.destroy());
  activeSplitters = [];

  currentGraph = createGraph(document.getElementById('graph-area'), topology, {
    DOMAINS,
    onNodeDetail(nodeId) { showDetailView(nodeId); },
  });
  sharedDesignHz = currentGraph.getTopicDesignHz();
  currentPanel = createTopicPanel(document.getElementById('panel-area'), {
    channels: summary.channels.filter(ch => ch.publisher),
    onTopicClick(topic) { currentGraph.setActiveTopics([topic]); },
  });

  const graphArea = document.getElementById('graph-area');
  const panelArea = document.getElementById('panel-area');
  activeSplitters.push(createSplitter(panelArea, graphArea, { direction: 'horizontal', min: 200, max: 600, reverse: true }));

  const sceneTopics = document.getElementById('scene-topics-area');
  const scene3D = document.getElementById('scene-3d-area');
  activeSplitters.push(createSplitter(sceneTopics, scene3D, { direction: 'horizontal', min: 150, max: 500 }));

  const mainArea = document.querySelector('.main-area');
  const timelineEl = document.getElementById('timeline-area');

  // 3D Scene
  if (show3D && foxgloveChannels.length > 0) {
    setup3DPanel();
  }

  // 3D toggle button
  document.getElementById('btn-3d').addEventListener('click', () => {
    show3D = !show3D;
    if (show3D) { showCamera = false; }
    updateMainAreaVisibility();
    if (show3D && !current3DScene) { setup3DPanel(); }
    refreshVisiblePlaybackFrame();
  });

  // Camera toggle button
  if (hasCameras) {
    document.getElementById('btn-camera').addEventListener('click', () => {
      showCamera = !showCamera;
      if (showCamera) { show3D = false; }
      updateMainAreaVisibility();
      if (showCamera && !currentCameraPanel) { setupCameraPanel(); }
      refreshVisiblePlaybackFrame();
    });
    if (showCamera) { setupCameraPanel(); }
    showAvifWarning();
  }

  const timelineArea = document.getElementById('timeline-area');

  if (msgBucketIndex) {
    setupTimeline(timelineArea);
  } else {
    timelineArea.innerHTML = '<div style="padding:12px 24px;color:#6b6b6b;font-size:12px">Building message index...</div>';
    buildMessageIndex(summary, (count, total) => {
      timelineArea.innerHTML = `<div style="padding:12px 24px;color:#6b6b6b;font-size:12px">Indexing: ${count.toLocaleString()} / ${total.toLocaleString()}</div>`;
    }).then(() => {
      timelineArea.innerHTML = '';
      setupTimeline(timelineArea);
      // Camera index is now ready; if user already switched to Camera tab,
      // re-init the panel with the real data.
      if (showCamera && cameraIndex && cameraIndex.cameras.length > 0) {
        if (currentCameraPanel) { currentCameraPanel.destroy(); currentCameraPanel = null; }
        setupCameraPanel();
      }
      showAvifWarning();
    }).catch(err => {
      console.error('Index failed:', err);
      timelineArea.innerHTML = `<div style="padding:12px 24px;color:#ef4444;font-size:12px">Index failed: ${err.message}</div>`;
    });
  }

  document.getElementById('btn-refresh-config').addEventListener('click', async () => {
    const btn = document.getElementById('btn-refresh-config');
    btn.textContent = 'Refreshing...';
    btn.disabled = true;
    try {
      const resp = await fetch('http://localhost:8765/rebuild-config');
      const result = await resp.json();
      if (result.ok) {
        btn.textContent = 'Done! Reload page';
        setTimeout(() => location.reload(), 1000);
      } else {
        btn.textContent = 'Failed';
        console.error(result.error);
        setTimeout(() => { btn.textContent = 'Refresh Config'; btn.disabled = false; }, 2000);
      }
    } catch (e) {
      btn.textContent = 'Error';
      console.error(e);
      setTimeout(() => { btn.textContent = 'Refresh Config'; btn.disabled = false; }, 2000);
    }
  });
  document.getElementById('cfg-platform').addEventListener('change', (e) => {
    setActivePlatform(e.target.value);
    // Rebuild the topology from the same mcap channels under the new platform's
    // pub/sub config, then re-render the topology view.
    sharedTopology = buildTopologyFromChannels(sharedSummary.channels);
    showTopologyView();
  });
  document.getElementById('btn-reset').addEventListener('click', () => {
    currentGraph.resetView();
    if (current3DScene) current3DScene.resetCamera();
  });
  document.getElementById('btn-new').addEventListener('click', () => { cleanupAll(); showDropZone(); });
  const btnFaults = document.getElementById('btn-faults');
  if (btnFaults) btnFaults.addEventListener('click', () => { window.open('fault-explorer.html', '_blank'); });
}

function setup3DPanel() {
  const sceneContainer = document.getElementById('scene-3d-area');
  const topicsContainer = document.getElementById('scene-topics-area');
  sceneContainer.setAttribute('data-view-name', '3D View');
  if (!sceneContainer.querySelector('.view-label')) {
    const lbl = document.createElement('span');
    lbl.className = 'view-label';
    lbl.textContent = '3D View';
    sceneContainer.appendChild(lbl);
  }

  current3DScene = create3DScene(sceneContainer);
  current3DTopics = createSceneTopics(topicsContainer, foxgloveChannels, (topic, enabled) => {
    if (enabled) current3DScene.enableTopic(topic);
    else current3DScene.disableTopic(topic);
  });

  foxgloveCursors = {};
}

function updateMainAreaVisibility() {
  const btn3d = document.getElementById('btn-3d');
  const btnCam = document.getElementById('btn-camera');
  if (btn3d) { btn3d.classList.toggle('active', show3D); }
  if (btnCam) { btnCam.classList.toggle('active', showCamera); }

  const sceneTopics = document.getElementById('scene-topics-area');
  const graphArea = document.getElementById('graph-area');
  const scene3d = document.getElementById('scene-3d-area');
  const cameraArea = document.getElementById('camera-area');
  const panelArea = document.getElementById('panel-area');

  const showGraph = !show3D && !showCamera;
  if (sceneTopics) { sceneTopics.style.display = show3D ? 'flex' : 'none'; }
  if (graphArea) { graphArea.style.display = showGraph ? 'block' : 'none'; }
  if (scene3d) { scene3d.style.display = show3D ? 'block' : 'none'; }
  if (cameraArea) { cameraArea.style.display = showCamera ? 'flex' : 'none'; }
  if (panelArea) { panelArea.style.display = showGraph ? 'flex' : 'none'; }
}

function refreshVisiblePlaybackFrame() {
  if (!currentTimeline) { return; }
  const state = currentTimeline.getState?.();
  if (!state?.currentNs) { return; }
  currentTimeline.seek(state.currentNs);
}

function setupCameraPanel() {
  const cameraArea = document.getElementById('camera-area');
  if (!cameraArea) { return; }
  cameraArea.innerHTML = '';

  if (!cameraIndex || cameraIndex.cameras.length === 0) {
    cameraArea.innerHTML = '<div class="cam-empty">Building camera index... please wait</div>';
    return;
  }

  currentCameraPanel = createCameraPanel(cameraArea, {
    cameraIndex,
    yoloIndex: sharedYoloIndex,
    vqaIndex: sharedVqaIndex,
    startTimeNs: sharedStartNs,
    mcapPath: sharedMcapPath,
    onYoloIndexChange: (idx) => {
      sharedYoloIndex = idx;
    },
    onVqaIndexChange: (idx) => {
      sharedVqaIndex = idx;
    },
  });
}

function showAvifWarning() {
  // No-op: warning is now shown dynamically by camera-panel when WASM fallback triggers
}

function updateCameraScene(currentSec, topicFreqs) {
  if (!currentCameraPanel || !showCamera) { return; }
  currentCameraPanel.update(currentSec, topicFreqs);
}

function update3DScene(currentSec) {
  if (!current3DScene || !foxgloveDataCache) return;

  const enabled = current3DScene.enabledTopics;
  for (const topic of enabled) {
    const cache = foxgloveDataCache[topic];
    if (!cache || cache.length === 0) continue;

    // Binary search: find latest frame at or before currentSec
    let lo = 0, hi = cache.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cache[mid].sec <= currentSec) lo = mid + 1;
      else hi = mid;
    }
    const frameIdx = lo - 1;
    if (frameIdx < 0) continue;

    // Only re-render if frame changed
    if (foxgloveCursors[topic] === frameIdx) continue;
    foxgloveCursors[topic] = frameIdx;

    const frame = cache[frameIdx];
    if (!frame?.decoded) continue;

    if (frame.schema === 'foxglove.SceneUpdate') {
      current3DScene.renderSceneUpdate(topic, frame.decoded);
    } else if (frame.schema === 'foxglove.Grid') {
      current3DScene.renderGrid(topic, frame.decoded);
    }
  }
}

// =====================================================================
//  TIMELINE (shared between topology and detail views)
// =====================================================================

function setupTimeline(timelineArea) {
  if (currentTimeline) { currentTimeline.destroy(); currentTimeline = null; }

  const designHz = sharedDesignHz;
  const lastAlertLevel = {};

  currentTimeline = createTimeline(timelineArea, {
    startTimeNs: sharedSummary.startTimeNs,
    endTimeNs: sharedSummary.endTimeNs,
    durationSec: sharedSummary.durationSec,
    onTick(currentNs) {
      const currentSec = Number(currentNs - sharedStartNs) / 1e9;

      // Compute Hz using compact Float64 arrays (no BigInt per-frame)
      const topicFreqs = {};
      const allActiveTopics = [];

      for (const [topic, offsets] of Object.entries(msgTopicOffsets)) {
        const firstSec = msgTopicFirstSec[topic];
        if (firstSec === undefined || currentSec < firstSec) { topicFreqs[topic] = -1; continue; }

        const windowSec = Math.min(currentSec - firstSec, 1.0);
        if (windowSec <= 0) { topicFreqs[topic] = -1; continue; }

        const windowStart = currentSec - windowSec;

        // Binary search on Float64Array (much faster than BigInt comparison)
        let lo = 0, hi = offsets.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid] < windowStart) lo = mid + 1; else hi = mid; }
        let end2 = lo;
        while (end2 < offsets.length && offsets[end2] <= currentSec) end2++;

        const count = end2 - lo;
        const hz = count / windowSec;
        topicFreqs[topic] = Math.round(hz * 10) / 10;
        if (count > 0) allActiveTopics.push(topic);
      }

      // Topology view
      if (currentView === 'topology' && currentGraph) {
        currentGraph.updatePlayback({ activeTopics: allActiveTopics, topicFreqs });
        if (currentPanel) currentPanel.setActiveTopics(allActiveTopics);
      }

      // 3D scene update
      if (show3D && current3DScene) {
        update3DScene(currentSec);
      }

      // Camera panel update
      if (showCamera && currentCameraPanel) {
        updateCameraScene(currentSec, topicFreqs);
      }

      // Detail view: push pre-cached messages
      if (currentView === 'detail' && currentDetail) {
        pushCachedMessages(currentSec);
      }

      // Freq alerts -> Debug Log (single logging surface).
      for (const topic of allActiveTopics) {
        const firstSec = msgTopicFirstSec[topic];
        if (firstSec === undefined || currentSec - firstSec < 1.0) continue;
        const actual = topicFreqs[topic] || 0;
        const design = designHz[topic] || 0;
        if (design <= 0) continue;
        const ratio = actual / design;
        let level = 'ok';
        if (actual === 0) level = 'dead';
        else if (ratio < 0.5) level = 'error';
        else if (ratio < 0.8) level = 'warn';

        if (level !== 'ok' && level !== lastAlertLevel[topic]) {
          lastAlertLevel[topic] = level;
          const levelStr = level === 'dead' ? 'CRITICAL' : level === 'error' ? 'ERROR' : 'WARN';
          const msg = level === 'dead' ? 'no messages in 1s window'
            : `freq ${actual.toFixed(1)}Hz / ${design.toFixed(1)}Hz (${(ratio * 100).toFixed(0)}%)`;
          const line = `[freq-alert ${levelStr}] t=${currentSec.toFixed(2)}s ${topic}: ${msg}`;
          if (level === 'warn') { console.warn(line); }
          else { console.error(line); }
        }
        if (level === 'ok' && lastAlertLevel[topic]) delete lastAlertLevel[topic];
      }
    },
  });
}

// =====================================================================
//  DETAIL VIEW
// =====================================================================

let detailLastSec = -1;
let detailCursors = {}; // topic -> index into msgDataCache[topic]

function showDetailView(nodeId) {
  currentView = 'detail';
  if (currentTimeline) currentTimeline.pause();
  if (currentGraph) { currentGraph.destroy(); currentGraph = null; }
  if (currentPanel) { currentPanel.destroy(); currentPanel = null; }

  app.innerHTML = `
    <div class="detail-container" id="detail-container"></div>
    <div class="timeline-area" id="timeline-area"></div>
  `;

  activeSplitters.forEach(s => s.destroy());
  activeSplitters = [];

  currentDetail = createNodeDetail(document.getElementById('detail-container'), {
    nodeId, topology: sharedTopology, DOMAINS,
    onBack() { backToTopology(); },
  });

  const detailContainer = document.getElementById('detail-container');
  const dtTimelineEl = document.getElementById('timeline-area');

  detailLastSec = -1;
  detailCursors = {};

  if (msgBucketIndex) {
    setupTimeline(dtTimelineEl);
  }

  setTimeout(() => {
    const testBtn = document.getElementById('nd-test-btn');
    if (testBtn) {
      testBtn.addEventListener('click', () => {
        showReplayTestView(nodeId);
      });
    }
  }, 100);
}

function backToTopology() {
  currentView = 'topology';
  if (currentTimeline) { currentTimeline.pause(); currentTimeline.destroy(); currentTimeline = null; }
  if (currentDetail) { currentDetail.destroy(); currentDetail = null; }
  activeSplitters.forEach(s => s.destroy());
  activeSplitters = [];
  showTopologyView();
}

let currentReplayTest = null;

async function showReplayTestView(nodeId) {
  currentView = 'replay-test';
  if (currentTimeline) { currentTimeline.pause(); currentTimeline.destroy(); currentTimeline = null; }
  if (currentDetail) { currentDetail.destroy(); currentDetail = null; }

  app.innerHTML = '';
  currentReplayTest = await createReplayTestView(app, {
    nodeId,
    topology: sharedTopology,
    summary: sharedSummary,
    msgDataCache,
    startTimeNs: sharedStartNs,
    onBack() {
      if (currentReplayTest) { currentReplayTest = null; }
      showDetailView(nodeId);
    },
  });
}

/**
 * Push pre-cached decoded messages to detail panels.
 * Uses cursor per topic to avoid re-scanning from start every frame.
 */
function pushCachedMessages(currentSec) {
  if (!currentDetail || !msgDataCache) return;

  const selectedTopics = currentDetail.getSelectedTopics();
  if (selectedTopics.length === 0) return;

  const fromSec = detailLastSec;
  detailLastSec = currentSec;
  if (currentSec <= fromSec) return;

  for (const topic of selectedTopics) {
    const cache = msgDataCache[topic];
    if (!cache || cache.length === 0) continue;

    // Initialize cursor for this topic
    if (detailCursors[topic] === undefined) {
      // Binary search to find starting position
      let lo = 0, hi = cache.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cache[mid].sec <= fromSec) lo = mid + 1; else hi = mid; }
      detailCursors[topic] = lo;
    }

    let cursor = detailCursors[topic];
    let pushed = 0;
    while (cursor < cache.length && cache[cursor].sec <= currentSec && pushed < 5) {
      const entry = cache[cursor];
      if (entry.sec > fromSec) {
        if (entry.decoded === undefined) {
          entry.decoded = entry.schemaId
            ? decodeMessage(entry.schemaId, entry.data)
            : null;
        }
        currentDetail.pushMessage(topic, entry.sec, entry.decoded, entry.size);
        pushed++;
      }
      cursor++;
    }
    detailCursors[topic] = cursor;
  }
}

// =====================================================================
//  MESSAGE INDEX (optimized)
// =====================================================================

async function buildMessageIndex(summary, onProgress) {
  const BUCKET_MS = 50;
  const total = summary.totalMessages;
  const buckets = {};
  const topicTsArrays = {};  // topic -> number[] (relative seconds)
  const topicMsgData = {};   // topic -> [{sec, schemaId, data, size, decoded}]
  let count = 0;
  let lastYield = performance.now();

  for (const { reader, filename } of summary.readers) {
    console.log(`Indexing ${filename}...`);
    for await (const msg of reader.readMessages()) {
      const channel = reader.channelsById.get(msg.channelId);
      const topic = channel?.topic;
      if (!topic) continue;

      const relSec = Number(msg.logTime - sharedStartNs) / 1e9;
      const bucketKey = Math.floor(relSec * 1000 / BUCKET_MS);

      if (!buckets[bucketKey]) buckets[bucketKey] = [];
      buckets[bucketKey].push(topic);

      if (!topicTsArrays[topic]) topicTsArrays[topic] = [];
      topicTsArrays[topic].push(relSec);

      // Cache raw bytes. Decoding is deferred to first access from the detail
      // view (see `pushCachedMessages`) so that heavy payloads such as H264
      // VideoStream frames do not pay protobuf-decode cost for topics the
      // user never inspects. Shaves tens of seconds off index build for
      // record-converted mcaps that contain many camera streams.
      if (!topicMsgData[topic]) topicMsgData[topic] = [];
      topicMsgData[topic].push({
        sec: relSec,
        schemaId: channel.schemaId,
        data: msg.data,
        size: msg.data.byteLength,
        decoded: undefined,
      });

      count++;
      const now = performance.now();
      if (now - lastYield > 80) {
        if (onProgress) onProgress(count, total);
        await new Promise(r => setTimeout(r, 0));
        lastYield = performance.now();
      }
    }
    console.log(`  ${filename}: ${count} messages indexed`);
  }

  // Convert to compact typed arrays and sort
  msgTopicOffsets = {};
  msgTopicFirstSec = {};
  for (const [topic, arr] of Object.entries(topicTsArrays)) {
    arr.sort((a, b) => a - b);
    msgTopicOffsets[topic] = new Float64Array(arr);
    msgTopicFirstSec[topic] = arr[0];
  }

  // Sort message data cache
  for (const topic of Object.keys(topicMsgData)) {
    topicMsgData[topic].sort((a, b) => a.sec - b.sec);
  }

  msgBucketIndex = buckets;
  msgDataCache = topicMsgData;

  // Foxglove topics drive the 3D scene every tick, so decode eagerly up
  // front. Skip CompressedImage / CameraCalibration / FrameTransform /
  // VideoStream camera topics — those are handled by the camera panel.
  foxgloveDataCache = {};
  for (const [topic, msgs] of Object.entries(topicMsgData)) {
    const ch = sharedSummary.channels.find(c => c.topic === topic);
    if (!ch || !ch.schemaName?.startsWith('foxglove.')) continue;
    if (isCameraSchema(ch.schemaName)) continue;
    if (isVideoStreamSchema(ch.schemaName) && isCameraVideoTopic(topic)) continue;
    foxgloveDataCache[topic] = msgs.map(m => {
      if (m.decoded === undefined) {
        m.decoded = m.schemaId ? decodeMessage(m.schemaId, m.data) : null;
      }
      return { sec: m.sec, decoded: m.decoded, schema: ch.schemaName };
    });
  }

  // Build camera index from CompressedImage channels (raw bytes, no decode)
  cameraIndex = buildCameraIndex(sharedSummary, topicMsgData);

  console.log(`Index: ${count} msgs, ${Object.keys(buckets).length} buckets, ${Object.keys(msgTopicOffsets).length} topics`);
  console.log(`3D cache: ${Object.keys(foxgloveDataCache).length} foxglove topics`);
  console.log(`Camera index: ${cameraIndex.cameras.length} cameras, ${Object.keys(cameraIndex.frameIndex).length} video topics`);
  if (cameraIndex.bevIndex) {
    console.log(`BEV index: ${cameraIndex.bevIndex.bevTopics.length} BevMap topics, ${cameraIndex.bevIndex.occTopics.length} OccResult topics`);
  }
}

// =====================================================================
//  CLEANUP
// =====================================================================

function cleanupAll() {
  if (currentGraph) { currentGraph.destroy(); currentGraph = null; }
  if (currentTimeline) { currentTimeline.destroy(); currentTimeline = null; }
  if (currentPanel) { currentPanel.destroy(); currentPanel = null; }
  if (currentDetail) { currentDetail.destroy(); currentDetail = null; }
  if (current3DScene) { current3DScene.destroy(); current3DScene = null; }
  if (current3DTopics) { current3DTopics.destroy(); current3DTopics = null; }
  if (currentReplayTest) { currentReplayTest.destroy(); currentReplayTest = null; }
  if (currentCameraPanel) { currentCameraPanel.destroy(); currentCameraPanel = null; }
  sharedSummary = null; sharedTopology = null; sharedStartNs = null; sharedDesignHz = {};
  msgBucketIndex = null; msgTopicOffsets = null; msgTopicFirstSec = null; msgDataCache = null;
  foxgloveChannels = null; foxgloveDataCache = null; foxgloveCursors = {};
  cameraIndex = null;
  sharedYoloIndex = null;
  sharedVqaIndex = null;
  sharedMcapPath = null;
  show3D = false;
  showCamera = false;
}
