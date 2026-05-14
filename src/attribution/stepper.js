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

  const el = document.createElement('div');
  el.className = 'at-stepper';
  container.appendChild(el);

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
      el.remove();
    },
  };
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
