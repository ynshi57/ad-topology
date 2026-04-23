import './style.css';
import { loadMcapFiles } from './mcap-loader.js';
import { buildTopologyFromChannels, DOMAINS } from './topology-builder.js';
import { createGraph } from './graph.js';
import { createTimeline } from './timeline.js';
import { createTopicPanel } from './topic-panel.js';
import { createOutputPanel } from './output-panel.js';
import { createNodeDetail } from './node-detail.js';
import { initDecoder, decodeMessage } from './proto-decoder.js';
import { createReplayTestView } from './test-panel.js';
import { create3DScene } from './scene-3d.js';
import { createSceneTopics } from './scene-topics.js';

const app = document.getElementById('app');

let currentView = 'dropzone';
let currentGraph = null;
let currentTimeline = null;
let currentPanel = null;
let currentOutput = null;
let currentDetail = null;
let current3DScene = null;
let current3DTopics = null;
let show3D = false;

let sharedSummary = null;
let sharedTopology = null;
let sharedStartNs = null;
let sharedDesignHz = {};

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
  const { verify = false, overwrite = true, onLog = () => {} } = opts;
  const resp = await fetch('http://localhost:8765/record2mcap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputPath: recordPath,
      verify,
      verifySamples: verify ? 50 : 0,
      overwrite,
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

function parseMcapUrls(input) {
  const urls = [];

  try {
    const parsed = new URL(input);
    const rawSearch = parsed.search || '';

    // Fully decode the query string (may be double-encoded)
    let decoded = rawSearch;
    try { decoded = decodeURIComponent(decoded); } catch {}
    try { decoded = decodeURIComponent(decoded); } catch {}

    // Split by 'ds.url=' to extract mcap URLs
    const parts = decoded.split('ds.url=');
    for (let i = 1; i < parts.length; i++) {
      let url = parts[i];

      // The URL ends at the next 'ds.url=' split or at known non-S3 params
      // Remove trailing '&' if present
      if (url.endsWith('&')) url = url.slice(0, -1);

      // Remove any trailing viz platform params that aren't part of the S3 URL
      const trailingParams = /&(id|recordName|time|carId|date)=/;
      const trailIdx = url.search(trailingParams);
      if (trailIdx > 0) url = url.slice(0, trailIdx);

      if (url.includes('.mcap')) {
        if (!urls.includes(url)) urls.push(url);
      }
    }

    // If no ds.url found but input itself is a mcap URL
    if (urls.length === 0 && input.includes('.mcap')) {
      urls.push(input);
    }
  } catch {
    if (input.startsWith('http') && input.includes('.mcap')) {
      urls.push(input);
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
            <input type="checkbox" id="dz-record-verify" />
            <span>verify (sample-check 50, record only)</span>
          </label>
          <label class="dz-record-opt">
            <input type="checkbox" id="dz-record-overwrite" checked />
            <span>overwrite existing mcap (record only)</span>
          </label>
        </div>
        <pre class="dz-record-log" id="dz-record-log" style="display:none"></pre>
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
      for (let i = 0; i < mcapUrls.length; i++) {
        const url = mcapUrls[i];
        const filename = url.split('/').pop().split('?')[0] || `remote_${i}.mcap`;
        showLoading(`Downloading ${filename} (${i + 1}/${mcapUrls.length})...`);
        // Use backend proxy to avoid CORS issues
        const proxyUrl = PROXY_BASE + encodeURIComponent(url);
        const res = await fetch(proxyUrl);
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`Download failed for ${filename}: ${res.status} ${errText}`);
        }
        const blob = await res.blob();
        files.push(new File([blob], filename, { type: 'application/octet-stream' }));
      }

      if (files.length) {
        await handleFiles(files);
      } else {
        showDropZone();
        alert('Failed to download mcap files.');
      }
    } catch (err) {
      console.error('URL load error:', err);
      app.innerHTML = `<div class="loading"><p style="color:#ef4444">URL load error: ${err.message}</p><button class="dz-btn" onclick="location.reload()">Retry</button></div>`;
    }
  });

  document.getElementById('dz-record-load').addEventListener('click', async () => {
    const inputPathRaw = document.getElementById('dz-record-path').value.trim();
    if (!inputPathRaw) {
      return;
    }
    const verify = document.getElementById('dz-record-verify').checked;
    const overwrite = document.getElementById('dz-record-overwrite').checked;
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
        const converted = await convertRecordOnServer(inputPathRaw, {
          verify,
          overwrite,
          onLog: appendLog,
        });
        appendLog(`downloading ${converted.filename} (${converted.sizeMB} MB)...`);
        mcapPath = converted.outputPath;
        filename = converted.filename;
      }

      const fileResp = await fetch(
        `http://localhost:8765/file?path=${encodeURIComponent(mcapPath)}`,
      );
      if (!fileResp.ok) {
        const errText = await fileResp.text().catch(() => '');
        throw new Error(`fetch mcap failed: ${fileResp.status} ${errText}`);
      }
      const blob = await fileResp.blob();
      appendLog(`downloaded ${blob.size.toLocaleString()} bytes, parsing mcap...`);
      const file = new File([blob], filename, { type: 'application/octet-stream' });
      await handleFiles([file]);
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
}

function showLoading(msg) {
  app.innerHTML = `<div class="loading"><div class="loading-spinner"></div><p>${msg}</p></div>`;
}

async function handleFiles(files) {
  showLoading(`Parsing ${files.length} file(s)...`);
  try {
    sharedSummary = await loadMcapFiles(files);
    sharedTopology = buildTopologyFromChannels(sharedSummary.channels);
    sharedStartNs = sharedSummary.startTimeNs;
    await initDecoder(sharedSummary.readers);
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

  // Identify foxglove channels for 3D panel
  foxgloveChannels = summary.channels.filter(ch => ch.schemaName.startsWith('foxglove.'));

  app.innerHTML = `
    <div class="topbar" data-view-name="Topology View">
      <span class="view-label">Topology View</span>
      <h1>Process Topology</h1>
      <div class="sep"></div>
      <div class="topbar-info">
        <span class="tb-file">${fileNames}</span>
        <span class="tb-stat">${summary.durationSec}s</span>
        <span class="tb-stat">${summary.totalMessages.toLocaleString()} msgs</span>
        <span class="tb-stat">${summary.channels.length} ch</span>
      </div>
      <div class="controls">
        <button class="btn ${show3D ? 'active' : ''}" id="btn-3d">3D</button>
        <button class="btn" id="btn-refresh-config">Refresh Config</button>
        <button class="btn" id="btn-reset">Reset</button>
        <button class="btn" id="btn-new">New File</button>
      </div>
    </div>
    <div class="main-area">
      <div class="scene-topics-area" id="scene-topics-area" style="display:${show3D ? 'flex' : 'none'}"></div>
      <div class="graph-area" id="graph-area" style="display:${show3D ? 'none' : 'block'}"></div>
      <div class="scene-3d-area" id="scene-3d-area" style="display:${show3D ? 'block' : 'none'}"></div>
      <div class="panel-area" id="panel-area" style="display:${show3D ? 'none' : 'flex'}"></div>
    </div>
    <div class="timeline-area" id="timeline-area"></div>
    <div class="output-area" id="output-area"></div>
  `;

  currentGraph = createGraph(document.getElementById('graph-area'), topology, {
    DOMAINS,
    onNodeDetail(nodeId) { showDetailView(nodeId); },
  });
  sharedDesignHz = currentGraph.getTopicDesignHz();
  currentOutput = createOutputPanel(document.getElementById('output-area'));
  currentPanel = createTopicPanel(document.getElementById('panel-area'), {
    channels: summary.channels.filter(ch => ch.publisher),
    onTopicClick(topic) { currentGraph.setActiveTopics([topic]); },
  });

  // 3D Scene
  if (show3D && foxgloveChannels.length > 0) {
    setup3DPanel();
  }

  // 3D toggle button
  document.getElementById('btn-3d').addEventListener('click', () => {
    show3D = !show3D;
    document.getElementById('btn-3d').classList.toggle('active', show3D);
    document.getElementById('scene-topics-area').style.display = show3D ? 'flex' : 'none';
    document.getElementById('graph-area').style.display = show3D ? 'none' : 'block';
    document.getElementById('scene-3d-area').style.display = show3D ? 'block' : 'none';
    document.getElementById('panel-area').style.display = show3D ? 'none' : 'flex';
    if (show3D && !current3DScene) setup3DPanel();
    if (!show3D && current3DScene) { current3DScene.destroy(); current3DScene = null; }
    if (!show3D && current3DTopics) { current3DTopics.destroy(); current3DTopics = null; }
  });

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
  document.getElementById('btn-reset').addEventListener('click', () => {
    currentGraph.resetView();
    if (current3DScene) current3DScene.resetCamera();
  });
  document.getElementById('btn-new').addEventListener('click', () => { cleanupAll(); showDropZone(); });
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

      // Detail view: push pre-cached messages
      if (currentView === 'detail' && currentDetail) {
        pushCachedMessages(currentSec);
      }

      // Freq alerts
      if (currentOutput) {
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
            currentOutput.log(currentSec, levelStr, topic, msg);
          }
          if (level === 'ok' && lastAlertLevel[topic]) delete lastAlertLevel[topic];
        }
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
    <div class="output-area" id="output-area"></div>
  `;

  currentOutput = createOutputPanel(document.getElementById('output-area'));
  currentDetail = createNodeDetail(document.getElementById('detail-container'), {
    nodeId, topology: sharedTopology, DOMAINS,
    onBack() { backToTopology(); },
  });

  detailLastSec = -1;
  detailCursors = {};

  if (msgBucketIndex) {
    setupTimeline(document.getElementById('timeline-area'));
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
  if (currentOutput) { currentOutput.destroy(); currentOutput = null; }
  showTopologyView();
}

let currentReplayTest = null;

async function showReplayTestView(nodeId) {
  currentView = 'replay-test';
  if (currentTimeline) { currentTimeline.pause(); currentTimeline.destroy(); currentTimeline = null; }
  if (currentDetail) { currentDetail.destroy(); currentDetail = null; }
  if (currentOutput) { currentOutput.destroy(); currentOutput = null; }

  app.innerHTML = '';
  currentReplayTest = await createReplayTestView(app, {
    nodeId,
    topology: sharedTopology,
    summary: sharedSummary,
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
  // front. Record-converted mcaps typically contain no foxglove topics, in
  // which case this loop is a no-op.
  foxgloveDataCache = {};
  for (const [topic, msgs] of Object.entries(topicMsgData)) {
    const ch = sharedSummary.channels.find(c => c.topic === topic);
    if (!ch || !ch.schemaName?.startsWith('foxglove.')) continue;
    foxgloveDataCache[topic] = msgs.map(m => {
      if (m.decoded === undefined) {
        m.decoded = m.schemaId ? decodeMessage(m.schemaId, m.data) : null;
      }
      return { sec: m.sec, decoded: m.decoded, schema: ch.schemaName };
    });
  }

  console.log(`Index: ${count} msgs, ${Object.keys(buckets).length} buckets, ${Object.keys(msgTopicOffsets).length} topics`);
  console.log(`3D cache: ${Object.keys(foxgloveDataCache).length} foxglove topics`);
}

// =====================================================================
//  CLEANUP
// =====================================================================

function cleanupAll() {
  if (currentGraph) { currentGraph.destroy(); currentGraph = null; }
  if (currentTimeline) { currentTimeline.destroy(); currentTimeline = null; }
  if (currentPanel) { currentPanel.destroy(); currentPanel = null; }
  if (currentOutput) { currentOutput.destroy(); currentOutput = null; }
  if (currentDetail) { currentDetail.destroy(); currentDetail = null; }
  if (current3DScene) { current3DScene.destroy(); current3DScene = null; }
  if (current3DTopics) { current3DTopics.destroy(); current3DTopics = null; }
  if (currentReplayTest) { currentReplayTest.destroy(); currentReplayTest = null; }
  sharedSummary = null; sharedTopology = null; sharedStartNs = null; sharedDesignHz = {};
  msgBucketIndex = null; msgTopicOffsets = null; msgTopicFirstSec = null; msgDataCache = null;
  foxgloveChannels = null; foxgloveDataCache = null; foxgloveCursors = {};
  show3D = false;
}
