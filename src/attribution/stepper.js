/**
 * Stepper — a generic multi-stage UI component for attribution workflows.
 *
 * Each stage is { id, name, icon, run(ctx), render(el, result) }.
 * The stepper manages state transitions, renders a step bar, and delegates
 * stage execution and result display.
 *
 * State per stage: pending | running | passed | warn | failed | skipped
 */

const STATUS_ICONS = {
  pending: '\u25CB',   // ○
  running: '\u25CE',   // ◎
  passed: '\u25CF',    // ●
  warn: '\u26A0',      // ⚠
  failed: '\u2716',    // ✖
  skipped: '\u25CC',   // ◌
};

const STATUS_CLASSES = {
  pending: 'at-step-pending',
  running: 'at-step-running',
  passed: 'at-step-passed',
  warn: 'at-step-warn',
  failed: 'at-step-failed',
  skipped: 'at-step-skipped',
};

export function createStepper(container, stages, ctx) {
  const state = {};
  for (const s of stages) {
    state[s.id] = { status: 'pending', result: null, error: null };
  }

  let currentStageIdx = -1;
  let running = false;

  const logLines = [];
  let logPanelOpen = true;

  const origConsoleLog = console.log;
  const origConsoleWarn = console.warn;
  const origConsoleError = console.error;

  function captureLog(level, args) {
    const text = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    if (!text.startsWith('[S')) {
      return;
    }
    logLines.push({ level, text, ts: Date.now() });
    if (logLines.length > 2000) {
      logLines.splice(0, 500);
    }
    const logBody = document.getElementById('at-log-body');
    if (logBody) {
      const line = document.createElement('div');
      line.className = `at-log-line at-log-${level}`;
      line.textContent = text;
      logBody.appendChild(line);
      if (logBody.children.length > 2000) {
        for (let i = 0; i < 500; i++) {
          logBody.removeChild(logBody.firstChild);
        }
      }
      logBody.scrollTop = logBody.scrollHeight;
    }
  }

  console.log = (...args) => { origConsoleLog.apply(console, args); captureLog('info', args); };
  console.warn = (...args) => { origConsoleWarn.apply(console, args); captureLog('warn', args); };
  console.error = (...args) => { origConsoleError.apply(console, args); captureLog('error', args); };

  const el = document.createElement('div');
  el.className = 'at-stepper';
  container.appendChild(el);

  function renderLogPanel() {
    const panel = el.querySelector('#at-log-panel');
    if (!panel) {
      return;
    }
    const body = panel.querySelector('#at-log-body');
    if (!body) {
      return;
    }
    body.innerHTML = '';
    for (const entry of logLines) {
      const line = document.createElement('div');
      line.className = `at-log-line at-log-${entry.level}`;
      line.textContent = entry.text;
      body.appendChild(line);
    }
    body.scrollTop = body.scrollHeight;
  }

  function render() {
    el.innerHTML = `
      <div class="at-step-bar">
        ${stages.map((s, i) => {
          const st = state[s.id];
          const cls = STATUS_CLASSES[st.status] || '';
          const active = i === currentStageIdx ? ' at-step-active' : '';
          return `<div class="at-step-dot ${cls}${active}" data-idx="${i}" title="${s.name}: ${st.status}">
            <span class="at-step-icon">${STATUS_ICONS[st.status]}</span>
            <span class="at-step-label">${s.name}</span>
          </div>`;
        }).join('<div class="at-step-line"></div>')}
      </div>
      <div class="at-controls">
        <button class="at-btn at-btn-primary" id="at-run-all" ${running || !ctx.className ? 'disabled' : ''}>Run All</button>
        <button class="at-btn" id="at-rerun-failed" ${running || !ctx.className ? 'disabled' : ''}>Rerun Failed</button>
      </div>
      <div class="at-stages-area" id="at-stages-area"></div>
      <div class="at-log-panel ${logPanelOpen ? 'at-log-open' : ''}" id="at-log-panel">
        <div class="at-log-header" id="at-log-toggle">
          <span class="at-log-title">Console</span>
          <span class="at-log-badge">${logLines.length}</span>
          <span class="at-log-arrow">${logPanelOpen ? '\u25BC' : '\u25B2'}</span>
          <button class="at-log-clear" id="at-log-clear">Clear</button>
        </div>
        <div class="at-log-body" id="at-log-body"></div>
      </div>
    `;

    const stagesArea = el.querySelector('#at-stages-area');
    for (const s of stages) {
      const st = state[s.id];
      const card = document.createElement('div');
      card.className = `at-stage-card ${st.status !== 'pending' ? 'at-stage-expanded' : ''}`;
      card.id = `at-stage-${s.id}`;

      const headerCls = STATUS_CLASSES[st.status] || '';
      card.innerHTML = `
        <div class="at-stage-header ${headerCls}">
          <span class="at-stage-icon">${STATUS_ICONS[st.status]}</span>
          <span class="at-stage-title">${s.id} ${s.name}</span>
          <span class="at-stage-status">${st.status}</span>
          ${st.status !== 'pending' && st.status !== 'running' ? `<button class="at-stage-rerun" data-stage="${s.id}">Rerun</button>` : ''}
        </div>
        <div class="at-stage-body" id="at-stage-body-${s.id}"></div>
      `;
      stagesArea.appendChild(card);

      if (st.result !== null && s.render) {
        const body = card.querySelector(`#at-stage-body-${s.id}`);
        try {
          s.render(body, st.result, ctx);
        } catch (e) {
          body.textContent = `Render error: ${e.message}`;
        }
      }
      if (st.error) {
        const body = card.querySelector(`#at-stage-body-${s.id}`);
        body.innerHTML += `<pre class="at-stage-error">${escHtml(st.error)}</pre>`;
      }
    }

    el.querySelector('#at-run-all')?.addEventListener('click', () => runAll());
    el.querySelector('#at-rerun-failed')?.addEventListener('click', () => rerunFailed());

    el.querySelectorAll('.at-stage-rerun').forEach(btn => {
      btn.addEventListener('click', () => {
        const stageId = btn.dataset.stage;
        runSingleStage(stageId);
      });
    });

    el.querySelectorAll('.at-step-dot').forEach(dot => {
      dot.addEventListener('click', () => {
        const idx = parseInt(dot.dataset.idx, 10);
        const stageId = stages[idx].id;
        const card = el.querySelector(`#at-stage-${stageId}`);
        if (card) {
          card.classList.toggle('at-stage-expanded');
        }
      });
    });

    el.querySelector('#at-log-toggle')?.addEventListener('click', (e) => {
      if (e.target.id === 'at-log-clear') {
        return;
      }
      logPanelOpen = !logPanelOpen;
      const panel = el.querySelector('#at-log-panel');
      if (panel) {
        panel.classList.toggle('at-log-open', logPanelOpen);
      }
      const arrow = el.querySelector('.at-log-arrow');
      if (arrow) {
        arrow.textContent = logPanelOpen ? '\u25BC' : '\u25B2';
      }
    });

    el.querySelector('#at-log-clear')?.addEventListener('click', () => {
      logLines.length = 0;
      const body = el.querySelector('#at-log-body');
      if (body) {
        body.innerHTML = '';
      }
      const badge = el.querySelector('.at-log-badge');
      if (badge) {
        badge.textContent = '0';
      }
    });

    renderLogPanel();
  }

  async function runStage(stage) {
    const st = state[stage.id];
    st.status = 'running';
    st.result = null;
    st.error = null;
    currentStageIdx = stages.indexOf(stage);
    render();

    try {
      const result = await stage.run(ctx);
      st.result = result;
      st.status = result?.status || 'passed';
      if (st.status === 'passed' && result?.warnings?.length > 0) {
        st.status = 'warn';
      }
    } catch (err) {
      st.status = 'failed';
      st.error = err.message || String(err);
    }

    ctx.setStageResult(stage.id, { status: st.status, result: st.result, error: st.error });
    render();
    return st.status;
  }

  async function runAll() {
    if (running) {
      return;
    }
    running = true;
    render();

    for (let i = 0; i < stages.length; i++) {
      const status = await runStage(stages[i]);
      // Only S1 (Load) failure should short-circuit the entire pipeline.
      // Other stages (S2-S5) may fail but subsequent stages should still run
      // to collect as much diagnostic information as possible.
      if (status === 'failed' && stages[i].id === 'S1') {
        for (let j = i + 1; j < stages.length; j++) {
          state[stages[j].id].status = 'skipped';
        }
        break;
      }
    }

    running = false;
    currentStageIdx = -1;
    render();
  }

  async function rerunFailed() {
    if (running) {
      return;
    }
    running = true;
    render();

    for (const stage of stages) {
      if (state[stage.id].status === 'failed' || state[stage.id].status === 'warn') {
        await runStage(stage);
      }
    }

    running = false;
    render();
  }

  async function runSingleStage(stageId) {
    if (running) {
      return;
    }
    const stage = stages.find(s => s.id === stageId);
    if (!stage) {
      return;
    }
    running = true;
    render();
    await runStage(stage);
    running = false;
    render();
  }

  render();

  return {
    runAll,
    rerunFailed,
    runSingleStage,
    getState: () => ({ ...state }),
    destroy: () => {
      console.log = origConsoleLog;
      console.warn = origConsoleWarn;
      console.error = origConsoleError;
      el.remove();
    },
  };
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
