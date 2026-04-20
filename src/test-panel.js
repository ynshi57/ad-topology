/**
 * Replay Test View — full-screen page for module replay testing with real mcap data.
 * Uses snapshot-based replay: maintains a latest-value buffer per input channel,
 * calls process() at configurable frame rate with accumulated snapshots.
 */

import nexisConfig from './nexis-config.json';

const WS_URL = 'ws://localhost:8765';
const DEFAULT_HZ = 20;
const LIB_DIR = '/home/caros/cyberrt/lib';
const WORKSPACE = '/home/caros/workspace';

let cachedSoList = null;

async function getSoList() {
  if (cachedSoList) return cachedSoList;
  try {
    const resp = await fetch(`http://localhost:8765/ls-lib`);
    if (resp.ok) {
      cachedSoList = await resp.json();
      return cachedSoList;
    }
  } catch { /* ignore */ }
  cachedSoList = [];
  return cachedSoList;
}

function guessDefaultsSync(nodeId, soList) {
  const proc = nexisConfig.processes[nodeId];
  const runtime = proc?.runtime || 'unknown';
  const parts = nodeId.split('_');
  const pascalCase = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');

  let soPath = `${LIB_DIR}/lib${nodeId}.so`;
  let className = runtime === 'nexis' ? pascalCase + 'Executor'
    : runtime === 'cyber' ? pascalCase + 'Component' : '';
  let configPaths = '';

  const tasks = nexisConfig.executorTasks || {};
  let taskEntry = tasks[className];

  if (!taskEntry) {
    const kw = nodeId.replace(/_/g, '').toLowerCase();
    for (const [cls, info] of Object.entries(tasks)) {
      const clsLower = cls.replace(/Executor$|Component$|NexisExecutor$/i, '').toLowerCase().replace(/_/g, '');
      const srcLower = (info.sourceFile || '').replace('.pbtxt', '').replace(/_/g, '').toLowerCase();
      const taskLower = (info.taskName || '').replace(/_/g, '').toLowerCase();
      if (clsLower.includes(kw) || kw.includes(clsLower)
          || srcLower.includes(kw) || taskLower.includes(kw)) {
        taskEntry = info;
        className = cls;
        break;
      }
    }
  }

  if (taskEntry) {
    soPath = `${LIB_DIR}/${taskEntry.libName}`;
    if (taskEntry.cfgFiles?.length > 0) {
      configPaths = taskEntry.cfgFiles.join('\n');
    }
  } else if (soList?.length > 0) {
    const kw = nodeId.replace(/_/g, '');
    const match = soList.find(f =>
      f.toLowerCase().includes(kw) && (f.includes('exector') || f.includes('executor'))
    ) || soList.find(f =>
      f.toLowerCase().includes(kw) && f.includes('component')
    ) || soList.find(f => f.toLowerCase().includes(kw));
    if (match) soPath = `${LIB_DIR}/${match}`;
  }

  return {
    soPath,
    className,
    configPaths,
    buildCmd: `cd ${WORKSPACE}/${nodeId} && rm -rf build_x86_64* && bash cross_build.sh x86_64`,
  };
}

function guessTopics(nodeId, topology, direction) {
  if (!topology) return '';
  const topics = [];
  if (direction === 'sub') {
    for (const l of topology.links) {
      if (l.target === nodeId) {
        for (const t of (l.topics || [])) topics.push(t.topic);
      }
    }
    const proc = nexisConfig.processes[nodeId];
    if (proc) {
      for (const s of proc.sub || []) {
        if (s.topic && !topics.includes(s.topic)) topics.push(s.topic);
      }
    }
  } else {
    const node = topology.nodes.find(n => n.id === nodeId);
    if (node) {
      for (const t of (node.topics || [])) topics.push(t.topic);
    }
    const proc = nexisConfig.processes[nodeId];
    if (proc) {
      for (const p of proc.pub || []) {
        if (p.topic && !topics.includes(p.topic)) topics.push(p.topic);
      }
    }
  }
  return [...new Set(topics)].join('\n');
}

function uint8ToBase64(u8) {
  let binary = '';
  for (let i = 0; i < u8.byteLength; i++) { binary += String.fromCharCode(u8[i]); }
  return btoa(binary);
}

function buildTopicToDataNameMap(nodeId) {
  const map = new Map();
  const proc = nexisConfig.processes[nodeId];
  if (proc) {
    for (const sub of proc.sub || []) {
      if (sub.topic && sub.dataName) {
        map.set(sub.topic, sub.dataName);
      }
    }
  }
  return map;
}

function buildTopicToProtoMap(nodeId) {
  const map = new Map();
  const proc = nexisConfig.processes[nodeId];
  if (proc) {
    for (const sub of proc.sub || []) {
      if (sub.topic && sub.proto) {
        map.set(sub.topic, sub.proto);
      }
    }
  }
  if (nexisConfig.dataTypes) {
    for (const [name, type] of Object.entries(nexisConfig.dataTypes)) {
      const proc2 = nexisConfig.processes[nodeId];
      if (proc2) {
        for (const sub of proc2.sub || []) {
          if (sub.dataName === name && type && !map.has(sub.topic)) {
            map.set(sub.topic, type);
          }
        }
      }
    }
  }
  return map;
}

function findExecutorFlow(nodeId) {
  const flows = nexisConfig.executorFlows || {};
  const kw = nodeId.replace(/_/g, '');
  for (const [name, flow] of Object.entries(flows)) {
    const nkw = name.replace(/_/g, '');
    if (nkw.includes(kw) || kw.includes(nkw.replace('executor', ''))) {
      return { executorName: name, ...flow };
    }
  }
  return null;
}

function detectFrameHz(nodeId) {
  const flow = findExecutorFlow(nodeId);
  if (flow) return flow.hz;
  return DEFAULT_HZ;
}

async function readRawMessages(readers, topics, startNs, endNs) {
  const msgs = [];
  const topicSet = new Set(topics);
  for (const { reader } of readers) {
    for await (const msg of reader.readMessages({ startTime: startNs, endTime: endNs })) {
      const ch = reader.channelsById.get(msg.channelId);
      if (!ch || !topicSet.has(ch.topic)) continue;
      const schema = reader.schemasById.get(ch.schemaId);
      msgs.push({
        topic: ch.topic,
        logTime: msg.logTime,
        data: new Uint8Array(msg.data),
        schemaName: schema?.name || '',
        schemaEncoding: schema?.encoding || '',
      });
    }
  }
  msgs.sort((a, b) => (a.logTime < b.logTime ? -1 : a.logTime > b.logTime ? 1 : 0));
  return msgs;
}

/**
 * @param {HTMLElement} container
 * @param {object} opts
 */
export async function createReplayTestView(container, opts) {
  const { nodeId, topology, summary, onBack } = opts;
  const nodeData = topology.nodes.find(n => n.id === nodeId);
  const runtime = nodeData?.runtime || 'unknown';
  const runtimeLabel = runtime === 'nexis' ? 'Nexis IExecutor' : runtime === 'cyber' ? 'CyberRT Component' : 'Unknown';
  const runtimeClass = runtime === 'nexis' ? 'rt-nexis' : runtime === 'cyber' ? 'rt-cyber' : 'rt-unknown';
  const soList = await getSoList();
  const defaults = guessDefaultsSync(nodeId, soList);

  const el = document.createElement('div');
  el.className = 'rt-view';
  el.setAttribute('data-view-name', 'Replay Test');
  el.innerHTML = `
    <div class="rt-header">
      <button class="rt-back" id="rt-back">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7" fill="none" stroke="currentColor" stroke-width="2"/></svg>
        Back
      </button>
      <div class="rt-title">
        <span class="view-label">Replay Test</span>
        <span class="rt-node-name">${esc(nodeId)}</span>
        <span class="tp-runtime-badge ${runtimeClass}">${runtimeLabel}</span>
      </div>
      <div class="rt-meta">
        <span class="rt-meta-item">${summary.durationSec}s mcap</span>
        <span class="rt-meta-item">${summary.totalMessages.toLocaleString()} msgs</span>
      </div>
    </div>
    <div class="rt-body">
      <div class="rt-left">
        <div class="rt-section">
          <div class="rt-section-title">Module Configuration</div>
          <label class="rt-label">.so Path</label>
          <input class="rt-input" id="rt-so" value="${esc(defaults.soPath)}" />
          <label class="rt-label">Executor Class Name</label>
          <input class="rt-input" id="rt-class" value="${esc(defaults.className)}" />
          <label class="rt-label">Config Paths (one per line)</label>
          <textarea class="rt-textarea" id="rt-config">${esc(defaults.configPaths)}</textarea>
          <label class="rt-label">Build Command</label>
          <input class="rt-input" id="rt-build-cmd" value="${esc(defaults.buildCmd)}" />
        </div>
        <div class="rt-section">
          <div class="rt-section-title">Topics</div>
          <label class="rt-label">Input Topics</label>
          <textarea class="rt-textarea rt-topics" id="rt-input-topics">${esc(guessTopics(nodeId, topology, 'sub'))}</textarea>
          <label class="rt-label">Output Topics</label>
          <textarea class="rt-textarea rt-topics" id="rt-output-topics">${esc(guessTopics(nodeId, topology, 'pub'))}</textarea>
        </div>
        <div class="rt-section">
          <div class="rt-section-title">Replay Settings</div>
          <label class="rt-label">Frame Rate (Hz)</label>
          <select class="rt-select" id="rt-hz">
            <option value="auto">Auto (${detectFrameHz(nodeId)} Hz)</option>
            <option value="10">10 Hz</option>
            <option value="20">20 Hz</option>
            <option value="50">50 Hz</option>
            <option value="100">100 Hz</option>
          </select>
        </div>
        <div class="rt-actions">
          <button class="rt-btn rt-btn-primary" id="rt-run">Run Test</button>
          <button class="rt-btn rt-btn-rebuild" id="rt-rebuild">Rebuild & Test</button>
        </div>
        <div class="rt-progress-area" id="rt-progress-area" style="display:none">
          <div class="rt-progress-bar"><div class="rt-progress-fill" id="rt-progress-fill"></div></div>
          <div class="rt-progress-text" id="rt-progress-text">Preparing...</div>
        </div>
        <div class="rt-status" id="rt-status"></div>
      </div>
      <div class="rt-right">
        <div class="rt-summary" id="rt-summary" style="display:none">
          <div class="rt-stat"><span class="rt-stat-val" id="rt-stat-frames">0</span><span class="rt-stat-label">Frames</span></div>
          <div class="rt-stat"><span class="rt-stat-val" id="rt-stat-pass">0</span><span class="rt-stat-label">Pass</span></div>
          <div class="rt-stat"><span class="rt-stat-val" id="rt-stat-fail">0</span><span class="rt-stat-label">Fail</span></div>
          <div class="rt-stat"><span class="rt-stat-val" id="rt-stat-avg">-</span><span class="rt-stat-label">Avg ms</span></div>
          <div class="rt-stat"><span class="rt-stat-val" id="rt-stat-max">-</span><span class="rt-stat-label">Max ms</span></div>
          <div class="rt-stat"><span class="rt-stat-val" id="rt-stat-total">-</span><span class="rt-stat-label">Total</span></div>
        </div>
        <div class="rt-flamegraph-area" id="rt-flamegraph-area" style="display:none">
          <div class="rt-section-title">Process Timing
            <span class="rt-fg-hint">(each bar = one process() call, color = duration)</span>
          </div>
          <canvas id="rt-flame-canvas" width="800" height="120"></canvas>
        </div>
        <div class="rt-log-area">
          <div class="rt-section-title">Frame Log</div>
          <div class="rt-log" id="rt-log"></div>
        </div>
      </div>
    </div>
  `;
  container.appendChild(el);

  const soInput = el.querySelector('#rt-so');
  const classInput = el.querySelector('#rt-class');
  const configInput = el.querySelector('#rt-config');
  const buildCmdInput = el.querySelector('#rt-build-cmd');
  const inputTopicsEl = el.querySelector('#rt-input-topics');
  const outputTopicsEl = el.querySelector('#rt-output-topics');
  const statusEl = el.querySelector('#rt-status');
  const logEl = el.querySelector('#rt-log');
  const progressArea = el.querySelector('#rt-progress-area');
  const progressFill = el.querySelector('#rt-progress-fill');
  const progressText = el.querySelector('#rt-progress-text');
  const summaryEl = el.querySelector('#rt-summary');
  const flameArea = el.querySelector('#rt-flamegraph-area');
  const flameCanvas = el.querySelector('#rt-flame-canvas');

  const hzSelect = el.querySelector('#rt-hz');

  el.querySelector('#rt-back').addEventListener('click', () => { destroy(); if (onBack) onBack(); });
  el.querySelector('#rt-run').addEventListener('click', () => startTest(false));
  el.querySelector('#rt-rebuild').addEventListener('click', () => startTest(true));

  let ws = null;
  let allFrameTimes = [];

  function getSelectedHz() {
    const val = hzSelect.value;
    return val === 'auto' ? detectFrameHz(nodeId) : parseInt(val, 10);
  }

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'rt-status' + (cls ? ' ' + cls : '');
  }

  function appendLog(level, text) {
    const row = document.createElement('div');
    row.className = `rt-log-row ${level}`;
    row.textContent = text;
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setProgress(current, total, label) {
    progressArea.style.display = 'block';
    const pct = total > 0 ? (current / total * 100) : 0;
    progressFill.style.width = pct + '%';
    progressText.textContent = label || `${current} / ${total}`;
  }

  function updateSummary() {
    summaryEl.style.display = 'flex';
    const pass = allFrameTimes.filter(t => t.ok).length;
    const fail = allFrameTimes.length - pass;
    const times = allFrameTimes.map(t => t.ms);
    const avg = times.length ? (times.reduce((a, b) => a + b, 0) / times.length) : 0;
    const max = times.length ? Math.max(...times) : 0;
    const total = times.reduce((a, b) => a + b, 0);

    el.querySelector('#rt-stat-frames').textContent = allFrameTimes.length;
    el.querySelector('#rt-stat-pass').textContent = pass;
    el.querySelector('#rt-stat-pass').parentElement.className = 'rt-stat' + (pass > 0 ? ' ok' : '');
    el.querySelector('#rt-stat-fail').textContent = fail;
    el.querySelector('#rt-stat-fail').parentElement.className = 'rt-stat' + (fail > 0 ? ' fail' : '');
    el.querySelector('#rt-stat-avg').textContent = avg.toFixed(2);
    el.querySelector('#rt-stat-max').textContent = max.toFixed(2);
    el.querySelector('#rt-stat-total').textContent = (total / 1000).toFixed(2) + 's';
  }

  function renderFlameGraph() {
    if (allFrameTimes.length === 0) return;
    flameArea.style.display = 'block';
    const canvas = flameCanvas;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.parentElement.clientWidth - 16;
    const h = 100;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const maxMs = Math.max(...allFrameTimes.map(t => t.ms), 1);
    const barW = Math.max(1, (w - 2) / allFrameTimes.length);

    for (let i = 0; i < allFrameTimes.length; i++) {
      const t = allFrameTimes[i];
      const barH = Math.max(2, (t.ms / maxMs) * (h - 20));
      const x = i * barW;
      const y = h - 10 - barH;

      const ratio = Math.min(t.ms / maxMs, 1);
      if (!t.ok) {
        ctx.fillStyle = '#ef4444';
      } else if (ratio < 0.3) {
        ctx.fillStyle = '#10b981';
      } else if (ratio < 0.7) {
        ctx.fillStyle = '#f59e0b';
      } else {
        ctx.fillStyle = '#ef4444';
      }
      ctx.fillRect(x + 0.5, y, Math.max(1, barW - 1), barH);
    }

    ctx.fillStyle = '#666';
    ctx.font = '9px Inter, sans-serif';
    ctx.fillText(`0ms`, 2, h - 1);
    ctx.fillText(`${maxMs.toFixed(1)}ms`, 2, 12);
    ctx.fillText(`${allFrameTimes.length} frames`, w - 60, h - 1);
  }

  async function startTest(buildFirst) {
    setStatus('Connecting...', '');
    logEl.innerHTML = '';
    allFrameTimes = [];
    summaryEl.style.display = 'none';
    flameArea.style.display = 'none';
    progressArea.style.display = 'none';

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      if (buildFirst) {
        const buildCmd = buildCmdInput.value.trim();
        if (!buildCmd) {
          setStatus('No build command configured', 'error');
          appendLog('error', 'Set a build command first');
          ws.close();
          return;
        }
        setStatus('Building...', '');
        appendLog('info', `Building: ${buildCmd}`);
        ws.send(JSON.stringify({ cmd: 'build', command: buildCmd }));
      } else {
        sendLoadCommand();
      }
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.status === 'ready') {
        appendLog('info', 'Harness ready');
        return;
      }

      if (msg.type === 'build_output') return;

      if (msg.cmd === 'build_result') {
        if (msg.success) {
          setStatus('Build succeeded. Loading module...', '');
          appendLog('ok', `Build succeeded (${(msg.duration_ms / 1000).toFixed(1)}s)`);
          sendLoadCommand();
        } else {
          setStatus('Build failed', 'error');
          appendLog('error', `Build failed: ${msg.error}`);
          if (msg.stderr) appendLog('error', msg.stderr.slice(0, 1000));
        }
        return;
      }

      if (msg.cmd === 'load_result') {
        if (msg.success) {
          const modeLabel = msg.mode === 'executor' ? 'Nexis IExecutor' : msg.mode === 'cyber' ? 'CyberRT Component' : msg.mode;
          setStatus(`Loaded (${modeLabel}). Reading mcap data...`, 'ok');
          appendLog('ok', `Loaded as ${modeLabel}`);
          beginReplay(msg.mode);
        } else {
          setStatus('Load failed', 'error');
          appendLog('error', `Load failed: ${msg.error}`);
        }
        return;
      }

      if (msg.cmd === 'process_result') {
        handleProcessResults(msg);
        return;
      }

      if (msg.cmd === 'inject_result') {
        handleInjectResult(msg);
        return;
      }

      if (msg.type === 'harness_exit') {
        setStatus('Test complete', 'ok');
        appendLog('info', `Harness exited (code=${msg.code})`);
        progressArea.style.display = 'none';
        updateSummary();
        renderFlameGraph();
        return;
      }

      if (msg.type === 'stderr') {
        const text = msg.message || '';
        if (text.includes('] I') || text.includes('] W')) {
          appendLog('info', `[module] ${text}`);
        } else {
          appendLog('warn', `[stderr] ${text}`);
        }
        return;
      }

      if (msg.error) {
        appendLog('error', msg.error);
      }
    };

    ws.onerror = () => {
      setStatus('WebSocket error — is the server running?', 'error');
    };
    ws.onclose = () => { ws = null; };
  }

  function sendLoadCommand() {
    const lines = configInput.value.trim().split('\n').filter(l => l.trim());
    const configPaths = [];
    let flagPath = '';
    for (const line of lines) {
      if (line.startsWith('flag:')) { flagPath = line.slice(5).trim(); }
      else { configPaths.push(line.trim()); }
    }
    const inputTopics = inputTopicsEl.value.trim().split('\n').filter(l => l.trim());
    const outputTopics = outputTopicsEl.value.trim().split('\n').filter(l => l.trim());
    const proc = nexisConfig.processes[nodeId];
    const outputDataNames = (proc?.pub || []).map(p => p.dataName || p.topic.split('/').pop()).filter(Boolean);
    setStatus('Loading module...', '');
    ws.send(JSON.stringify({
      cmd: 'load',
      so_path: soInput.value.trim(),
      class: classInput.value.trim(),
      config_paths: configPaths,
      flag_path: flagPath,
      input_topics: inputTopics,
      output_topics: outputTopics,
      output_data_names: outputDataNames,
      runtime,
    }));
  }

  let pendingResolve = null;
  let replayMode = 'executor';

  function handleProcessResults(msg) {
    for (const r of msg.results || []) {
      const ok = (r.status_code === 1 || r.status === 'kProcessOk');
      const ms = r.process_time_ms || 0;
      allFrameTimes.push({ ok, ms, ts: r.timestamp_ns });
      const level = ok ? 'ok' : (r.status === 'kSkipped' ? 'warn' : 'error');
      const tsLabel = r.timestamp_ns ? `[${(r.timestamp_ns / 1e9).toFixed(3)}s]` : '';
      const deser = r.output?._deser;
      const deserInfo = deser ? ` [${deser.ok}/${deser.total} deserialized]` : '';
      appendLog(level, `${tsLabel} ${r.status} (${ms.toFixed(2)}ms)${deserInfo}${r.error ? ' — ' + r.error : ''}`);
    }
    updateSummary();
    if (pendingResolve) { pendingResolve(); pendingResolve = null; }
  }

  function handleInjectResult(msg) {
    const ok = msg.status === 'ok';
    const ms = msg.elapsed_ms || 0;
    allFrameTimes.push({ ok, ms, ts: msg.timestamp_ns });
    const level = ok ? 'ok' : 'error';
    appendLog(level, `[inject] ${msg.topic || ''} ${msg.status} (${ms.toFixed(2)}ms)`);
    updateSummary();
    if (pendingResolve) { pendingResolve(); pendingResolve = null; }
  }

  function waitForResponse() {
    return new Promise(resolve => { pendingResolve = resolve; });
  }

  async function beginReplay(mode) {
    replayMode = mode;
    const inputTopics = inputTopicsEl.value.trim().split('\n').filter(l => l.trim());
    if (inputTopics.length === 0) {
      appendLog('warn', 'No input topics — sending empty test frame');
      ws.send(JSON.stringify({ cmd: 'process', frames: [{ timestamp_ns: 1000000000, inputs: [{ name: 'test', timestamp_ns: 1000000000, data_base64: '' }] }] }));
      return;
    }

    setStatus('Reading mcap messages...', '');
    setProgress(0, 1, 'Reading mcap...');

    const rawMsgs = await readRawMessages(summary.readers, inputTopics, summary.startTimeNs, summary.endTimeNs);
    if (rawMsgs.length === 0) {
      appendLog('warn', 'No messages found for input topics in mcap');
      ws.send(JSON.stringify({ cmd: 'unload' }));
      ws.send(JSON.stringify({ cmd: 'quit' }));
      return;
    }

    appendLog('info', `Found ${rawMsgs.length} messages across ${inputTopics.length} input topics`);
    setStatus(`Replaying ${rawMsgs.length} messages...`, '');

    if (mode === 'executor') {
      await replayExecutorMode(rawMsgs);
    } else {
      await replayCyberMode(rawMsgs);
    }

    ws.send(JSON.stringify({ cmd: 'unload' }));
    ws.send(JSON.stringify({ cmd: 'quit' }));
  }

  async function replayExecutorMode(rawMsgs) {
    const topicToDataName = buildTopicToDataNameMap(nodeId);
    const topicToProto = buildTopicToProtoMap(nodeId);
    const flow = findExecutorFlow(nodeId);
    const hz = getSelectedHz();
    const intervalNs = BigInt(Math.floor(1e9 / hz));
    const allRequiredFromFlow = flow?.requiredInputs || [];
    const availableDataNames = new Set();
    for (const msg of rawMsgs) {
      const dn = topicToDataName.get(msg.topic);
      if (dn) availableDataNames.add(dn);
    }
    const requiredSet = new Set(allRequiredFromFlow.filter(r => availableDataNames.has(r)));
    const missingRequired = allRequiredFromFlow.filter(r => !availableDataNames.has(r));

    const startTime = rawMsgs[0].logTime;
    const endTime = rawMsgs[rawMsgs.length - 1].logTime;
    const totalTicks = Number((endTime - startTime) / intervalNs) + 1;

    const scheduleMode = requiredSet.size > 0 ? 'event-triggered' : 'periodic';
    appendLog('info', `Schedule: ${scheduleMode}, ${hz}Hz interval`);
    appendLog('info', `Time range: ${(Number(endTime - startTime) / 1e9).toFixed(2)}s, ~${totalTicks} ticks max`);
    appendLog('info', `Required (in mcap): ${requiredSet.size > 0 ? [...requiredSet].join(', ') : 'none'}`);
    if (missingRequired.length > 0) {
      appendLog('warn', `Required but NOT in mcap (skipped): ${missingRequired.join(', ')}`);
    }
    appendLog('info', `Available data channels: ${availableDataNames.size}`);
    const nonProtoTopics = rawMsgs.filter(m => m.schemaEncoding && m.schemaEncoding !== 'protobuf')
      .map(m => topicToDataName.get(m.topic) || m.topic);
    const uniqueNonProto = [...new Set(nonProtoTopics)];
    if (uniqueNonProto.length > 0) {
      appendLog('warn', `Non-protobuf encoding (skipped): ${uniqueNonProto.join(', ')}`);
    }

    const latestValues = new Map();
    const arrivedSinceLastTick = new Set();
    let msgCursor = 0;
    let tickTime = startTime;
    let frameIdx = 0;
    let skipped = 0;

    while (tickTime <= endTime) {
      if (!ws || ws.readyState !== WebSocket.OPEN) break;

      arrivedSinceLastTick.clear();
      while (msgCursor < rawMsgs.length && rawMsgs[msgCursor].logTime <= tickTime) {
        const msg = rawMsgs[msgCursor];
        const dataName = topicToDataName.get(msg.topic) || msg.topic.split('/').pop() || msg.topic;
        const encoding = msg.schemaEncoding || 'protobuf';
        const protoType = encoding === 'protobuf'
          ? (topicToProto.get(msg.topic) || msg.schemaName || '')
          : (topicToProto.get(msg.topic) || '');
        latestValues.set(dataName, { data: msg.data, ts: msg.logTime, protoType, encoding });
        arrivedSinceLastTick.add(dataName);
        msgCursor++;
      }

      let shouldProcess = latestValues.size > 0;
      if (requiredSet.size > 0) {
        let allRequired = true;
        for (const req of requiredSet) {
          if (!latestValues.has(req)) { allRequired = false; break; }
        }
        shouldProcess = allRequired;
      }

      if (shouldProcess) {
        const inputs = [];
        for (const [name, val] of latestValues) {
          if (val.encoding && val.encoding !== 'protobuf') { continue; }
          if (!val.protoType) { continue; }
          inputs.push({
            name,
            timestamp_ns: Number(val.ts),
            data_base64: uint8ToBase64(val.data),
            proto_type: val.protoType,
          });
        }

        ws.send(JSON.stringify({
          cmd: 'process',
          frames: [{ timestamp_ns: Number(tickTime), inputs }],
        }));
        await waitForResponse();
        frameIdx++;
        const elapsed = (Number(tickTime - startTime) / 1e9).toFixed(2);
        setProgress(frameIdx, totalTicks, `Frame ${frameIdx} (${elapsed}s) | ${inputs.length} inputs | ${skipped} skipped`);
        if (frameIdx % 10 === 0) renderFlameGraph();
      } else {
        skipped++;
      }

      tickTime = tickTime + intervalNs;
    }

    setProgress(totalTicks, totalTicks, `Done: ${frameIdx} processed, ${skipped} skipped`);
    appendLog('info', `Replay complete: ${frameIdx} frames processed, ${skipped} ticks skipped (required triggers not met)`);
    renderFlameGraph();
  }

  async function replayCyberMode(rawMsgs) {
    for (let i = 0; i < rawMsgs.length; i++) {
      if (!ws || ws.readyState !== WebSocket.OPEN) break;
      const msg = rawMsgs[i];
      setProgress(i + 1, rawMsgs.length, `Injecting ${i + 1} / ${rawMsgs.length}`);
      ws.send(JSON.stringify({
        cmd: 'inject',
        topic: msg.topic,
        timestamp_ns: Number(msg.logTime),
        data_base64: uint8ToBase64(msg.data),
      }));
      await waitForResponse();
      if ((i + 1) % 50 === 0) renderFlameGraph();
    }
    setProgress(rawMsgs.length, rawMsgs.length, 'Complete');
  }

  function destroy() {
    if (ws) { ws.close(); ws = null; }
    el.remove();
  }

  return { destroy };
}

function esc(s) { const d = document.createElement('span'); d.textContent = s; return d.innerHTML; }
