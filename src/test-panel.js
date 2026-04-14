/**
 * Test Panel — configure and run module replay tests via WebSocket to the backend harness.
 */

const WS_URL = 'ws://localhost:8765';

// Map node IDs to likely .so paths and class names based on nexis/cyber conventions
const MODULE_HINTS = {
  fault_manager:  { so: 'libsystem_monitor.so', cls: 'FaultManagerExecutor', config: '/home/caros/workspace/ad_dag/conf/fault_process_table.pbtxt', flag: '', src: 'system_monitor' },
  system_monitor: { so: 'libsystem_monitor.so', cls: 'SystemMonitorComponent', config: '', flag: '', src: 'system_monitor' },
  neo_canbus:     { so: 'libcanbus_executor.so', cls: 'CanbusExecutor', config: '', flag: '', src: 'canbus' },
  model_infer:    { so: 'libmodel_infer.so', cls: 'ModelInferExecutor', config: '', flag: '', src: 'model_infer' },
  map_router:     { so: 'libmaprouter_exector_map_router.so', cls: 'MapRouterExecutor', config: '', flag: '', src: 'maprouter' },
  planning:       { so: 'libplanning_new.so', cls: 'PlanningComponent', config: '', flag: 'conf/planning.flag', src: 'planning' },
  control:        { so: 'libcontrol.so', cls: 'ControlComponent', config: 'conf/control.pb.txt', flag: 'conf/control.flag', src: 'control' },
  aeb:            { so: 'libaeb.so', cls: 'AebComponent', config: '', flag: '', src: 'aeb' },
  location:       { so: 'libdead_reckoning_localization_component.so', cls: 'DeadReckoningLocalizationComponent', config: '', flag: 'conf/dead_reckoning_localization.flag', src: 'location' },
  perception:     { so: 'libperception_component.so', cls: 'TrackPredComponent', config: '', flag: '', src: 'perception' },
  state_machine:  { so: 'libstate_machine.so', cls: 'StateMachineComponent', config: '', flag: '', src: 'finite_state_machine' },
  dynamic_layer:  { so: 'libdynamic_layer.so', cls: 'DynamicLayerComponent', config: '', flag: '', src: 'dynamic_layer' },
};

function guessDefaults(nodeId) {
  const hint = MODULE_HINTS[nodeId];
  if (hint) {
    const configs = [];
    if (hint.config) configs.push(hint.config);
    if (hint.flag) configs.push(`flag:${hint.flag}`);
    return {
      soPath: `/home/caros/cyberrt/lib/${hint.so}`,
      className: hint.cls,
      configPaths: configs.join('\n'),
      buildCmd: hint.src ? `cd /home/caros/workspace/${hint.src} && rm -rf build_x86_64* && bash cross_build.sh x86_64` : '',
    };
  }
  return {
    soPath: `/home/caros/cyberrt/lib/lib${nodeId}.so`,
    className: '',
    configPaths: '',
    buildCmd: '',
  };
}

function guessTopics(nodeId, topology, direction) {
  if (!topology) return '';
  const { nodes, links } = topology;
  const topics = [];
  if (direction === 'sub') {
    for (const l of links) {
      if (l.target === nodeId) {
        for (const t of (l.topics || [])) topics.push(t.topic);
      }
    }
  } else {
    const node = nodes.find(n => n.id === nodeId);
    if (node) {
      for (const t of (node.topics || [])) topics.push(t.topic);
    }
  }
  return [...new Set(topics)].join('\n');
}

export function createTestPanel(container, opts) {
  const { nodeId, topology, summary, onClose } = opts;
  const nodeData = topology.nodes.find(n => n.id === nodeId);
  const runtime = nodeData?.runtime || 'unknown';
  const runtimeLabel = runtime === 'nexis' ? 'Nexis IExecutor' : runtime === 'cyber' ? 'CyberRT Component' : 'Unknown';
  const runtimeClass = runtime === 'nexis' ? 'rt-nexis' : runtime === 'cyber' ? 'rt-cyber' : 'rt-unknown';

  const el = document.createElement('div');
  el.className = 'tp-overlay';
  el.innerHTML = `
    <div class="tp-modal" data-view-name="Replay Test">
      <div class="tp-modal-header">
        <span class="tp-modal-title">Replay Test: ${esc(nodeId)}</span>
        <span class="tp-runtime-badge ${runtimeClass}">${runtimeLabel}</span>
        <button class="tp-modal-close" id="tp-close">x</button>
      </div>
      <div class="tp-modal-body">
        <div class="tp-form">
          <label class="tp-label">.so Path</label>
          <input class="tp-input" id="tp-so" value="${esc(guessDefaults(nodeId).soPath)}" />
          <label class="tp-label">Executor Class Name</label>
          <input class="tp-input" id="tp-class" value="${esc(guessDefaults(nodeId).className)}" />
          <label class="tp-label">Config Paths (one per line)</label>
          <textarea class="tp-textarea" id="tp-config">${esc(guessDefaults(nodeId).configPaths)}</textarea>
          <label class="tp-label">Build Command (optional — for Rebuild & Test)</label>
          <input class="tp-input" id="tp-build-cmd" value="${esc(guessDefaults(nodeId).buildCmd)}" />
          <label class="tp-label">Input Topics (for CyberRT mode, one per line)</label>
          <textarea class="tp-textarea tp-topics" id="tp-input-topics">${esc(guessTopics(nodeId, topology, 'sub'))}</textarea>
          <label class="tp-label">Output Topics (for CyberRT mode, one per line)</label>
          <textarea class="tp-textarea tp-topics" id="tp-output-topics">${esc(guessTopics(nodeId, topology, 'pub'))}</textarea>
        </div>
        <div class="tp-actions">
          <button class="tp-run-btn" id="tp-run">Run Test</button>
          <button class="tp-rebuild-btn" id="tp-rebuild">Rebuild & Test</button>
          <span class="tp-status" id="tp-status"></span>
        </div>
        <div class="tp-results" id="tp-results">
          <div class="tp-results-header">Results</div>
          <div class="tp-results-list" id="tp-results-list"></div>
        </div>
      </div>
    </div>
  `;
  container.appendChild(el);

  const soInput = el.querySelector('#tp-so');
  const classInput = el.querySelector('#tp-class');
  const configInput = el.querySelector('#tp-config');
  const runBtn = el.querySelector('#tp-run');
  const statusEl = el.querySelector('#tp-status');
  const resultsList = el.querySelector('#tp-results-list');

  el.querySelector('#tp-close').addEventListener('click', () => {
    destroy();
    if (onClose) onClose();
  });

  let ws = null;
  const buildCmdInput = el.querySelector('#tp-build-cmd');
  const rebuildBtn = el.querySelector('#tp-rebuild');
  let pendingBuildThenLoad = false;

  function startTest(buildFirst) {
    statusEl.textContent = 'Connecting...';
    statusEl.className = 'tp-status';
    resultsList.innerHTML = '';
    pendingBuildThenLoad = buildFirst;

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      if (buildFirst) {
        const buildCmd = buildCmdInput.value.trim();
        if (!buildCmd) {
          statusEl.textContent = 'No build command configured';
          statusEl.className = 'tp-status error';
          appendResult('error', 'Set a build command first');
          ws.close();
          return;
        }
        statusEl.textContent = 'Building...';
        appendResult('info', `Building: ${buildCmd}`);
        ws.send(JSON.stringify({ cmd: 'build', command: buildCmd }));
      } else {
        sendLoadCommand();
      }
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.status === 'ready') {
        appendResult('info', 'Harness ready');
        return;
      }

      if (msg.cmd === 'build_result') {
        if (msg.success) {
          statusEl.textContent = 'Build succeeded. Loading module...';
          appendResult('ok', `Build succeeded (${(msg.duration_ms / 1000).toFixed(1)}s)`);
          if (msg.stdout) appendResult('info', msg.stdout.slice(0, 500));
          sendLoadCommand();
        } else {
          statusEl.textContent = 'Build failed';
          statusEl.className = 'tp-status error';
          appendResult('error', `Build failed: ${msg.error}`);
          if (msg.stderr) appendResult('error', msg.stderr.slice(0, 1000));
        }
        return;
      }

      if (msg.cmd === 'load_result') {
        if (msg.success) {
          const modeLabel = msg.mode === 'executor' ? 'Nexis IExecutor' : msg.mode === 'cyber' ? 'CyberRT Component' : msg.mode;
          statusEl.textContent = `Loaded (${modeLabel}). Running test...`;
          statusEl.className = 'tp-status ok';
          appendResult('ok', `Module loaded as ${modeLabel}`);
          if (msg.message) appendResult('info', msg.message);
          sendTestFrames();
        } else {
          statusEl.textContent = 'Load failed';
          statusEl.className = 'tp-status error';
          appendResult('error', `Load failed: ${msg.error}`);
        }
        return;
      }

      if (msg.cmd === 'process_result') {
        const mode = msg.mode || 'executor';
        for (const r of msg.results || []) {
          if (mode === 'cyber') {
            const captured = r.captured ? Object.keys(r.captured).map(k => `${k}:${r.captured[k]?.captured_count || 0}`).join(', ') : '';
            appendResult(r.status === 'ok' ? 'ok' : 'error',
              `[${(r.timestamp_ns / 1e9).toFixed(3)}s] ${r.topic || ''} ${r.status} (${r.elapsed_ms?.toFixed(2) || 0}ms)${captured ? ' | captured: ' + captured : ''}${r.error ? ' — ' + r.error : ''}`);
          } else {
            const level = (r.status_code === 1 || r.status === 'kProcessOk') ? 'ok' : 'error';
            appendResult(level, `[${(r.timestamp_ns / 1e9).toFixed(3)}s] ${r.status} (${r.process_time_ms?.toFixed(2) || 0}ms)${r.error ? ' — ' + r.error : ''}`);
          }
        }
        statusEl.textContent = `Processed ${(msg.results || []).length} frames (${msg.mode || 'unknown'} mode)`;

        ws.send(JSON.stringify({ cmd: 'unload' }));
        ws.send(JSON.stringify({ cmd: 'quit' }));
        return;
      }

      if (msg.cmd === 'inject_result') {
        const captured = msg.captured ? Object.keys(msg.captured).map(k => `${k}:${msg.captured[k]?.captured_count || 0}`).join(', ') : '';
        appendResult(msg.status === 'ok' ? 'ok' : 'error',
          `[inject] ${msg.status} (${msg.elapsed_ms?.toFixed(2) || 0}ms)${captured ? ' | captured: ' + captured : ''}${msg.error ? ' — ' + msg.error : ''}`);
        return;
      }

      if (msg.type === 'harness_exit') {
        statusEl.textContent = 'Test complete';
        statusEl.className = 'tp-status ok';
        appendResult('info', `Harness exited (code=${msg.code})`);
        return;
      }

      if (msg.type === 'stderr') {
        appendResult('warn', `[stderr] ${msg.message}`);
        return;
      }

      if (msg.error) {
        appendResult('error', msg.error);
      }
    };

    ws.onerror = () => {
      statusEl.textContent = 'WebSocket error — is the server running? (npm run server)';
      statusEl.className = 'tp-status error';
    };

    ws.onclose = () => {
      ws = null;
    };
  }

  const inputTopicsEl = el.querySelector('#tp-input-topics');
  const outputTopicsEl = el.querySelector('#tp-output-topics');

  function sendLoadCommand() {
    const lines = configInput.value.trim().split('\n').filter(l => l.trim());
    const configPaths = [];
    let flagPath = '';
    for (const line of lines) {
      if (line.startsWith('flag:')) {
        flagPath = line.slice(5).trim();
      } else {
        configPaths.push(line.trim());
      }
    }
    const inputTopics = inputTopicsEl.value.trim().split('\n').filter(l => l.trim());
    const outputTopics = outputTopicsEl.value.trim().split('\n').filter(l => l.trim());
    ws.send(JSON.stringify({
      cmd: 'load',
      so_path: soInput.value.trim(),
      class: classInput.value.trim(),
      config_paths: configPaths,
      flag_path: flagPath,
      input_topics: inputTopics,
      output_topics: outputTopics,
      runtime,
    }));
  }

  runBtn.addEventListener('click', () => startTest(false));
  rebuildBtn.addEventListener('click', () => startTest(true));

  function sendTestFrames() {
    // Build minimal test frames from mcap data for this node's input topics
    const frames = [];
    // For now, send empty frames to test the pipeline
    frames.push({
      timestamp_ns: 1000000000,
      inputs: [{
        name: 'test_input',
        timestamp_ns: 1000000000,
        data_base64: '',
      }],
    });

    ws.send(JSON.stringify({
      cmd: 'process',
      frames: frames,
    }));
  }

  function appendResult(level, text) {
    const row = document.createElement('div');
    row.className = `tp-result-row ${level}`;
    row.textContent = text;
    resultsList.appendChild(row);
    resultsList.scrollTop = resultsList.scrollHeight;
  }

  function destroy() {
    if (ws) { ws.close(); ws = null; }
    el.remove();
  }

  return { destroy };
}

function esc(s) { const d = document.createElement('span'); d.textContent = s; return d.innerHTML; }
