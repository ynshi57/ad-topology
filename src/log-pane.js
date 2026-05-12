/**
 * In-app Debug Log pane.
 *
 * A collapsible, fixed-height panel that shows:
 *   1. Frontend `console.log/warn/error/info` output (intercepted globally).
 *   2. Backend Express log output streamed over Server-Sent Events from
 *      ``/server-log/stream`` (which mirrors the Express console.* ring
 *      buffer; up to 500 most-recent lines are replayed on connect).
 *
 * Goal: the user never has to open browser DevTools to debug the app.
 *
 * Usage:
 *   import { createLogPane } from './log-pane.js';
 *   const pane = createLogPane(document.getElementById('cam-log-pane-host'));
 *   ...
 *   pane.destroy();
 */

const LOG_BUF_MAX = 1000;
const SSE_RECONNECT_MS = 2000;

let installed = null; // singleton wrapper to avoid double-installing console hooks

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function fmtTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${String(
    date.getMilliseconds(),
  ).padStart(3, '0')}`;
}

function formatArg(a) {
  if (typeof a === 'string') { return a; }
  if (a instanceof Error) { return a.stack || a.message; }
  if (a === undefined) { return 'undefined'; }
  if (a === null) { return 'null'; }
  if (typeof a === 'object') {
    try { return JSON.stringify(a); }
    catch { return String(a); }
  }
  return String(a);
}

/**
 * Install console.log/warn/error/info patches that ALSO push entries to a
 * shared sink. Idempotent (returns same wrapper on repeat calls).
 */
function installConsoleHook() {
  if (installed) { return installed; }
  const subs = new Set();
  const wrap = {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    push(level, args) {
      for (const fn of subs) {
        try { fn(level, args); } catch { /* never let a subscriber kill the hook */ }
      }
    },
  };
  const orig = {
    log:   console.log.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
    info:  console.info.bind(console),
  };
  console.log   = (...a) => { orig.log(...a);   wrap.push('log', a); };
  console.warn  = (...a) => { orig.warn(...a);  wrap.push('warn', a); };
  console.error = (...a) => { orig.error(...a); wrap.push('error', a); };
  console.info  = (...a) => { orig.info(...a);  wrap.push('info', a); };

  // Also capture uncaught errors and unhandled rejections so they
  // surface in the in-app log even if dev-tools isn't open.
  window.addEventListener('error', (ev) => {
    wrap.push('error', [`[uncaught] ${ev.message} @ ${ev.filename}:${ev.lineno}:${ev.colno}`]);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason;
    const msg = reason && (reason.stack || reason.message)
      ? (reason.stack || reason.message)
      : formatArg(reason);
    wrap.push('error', [`[unhandledrejection] ${msg}`]);
  });

  installed = wrap;
  return installed;
}

/**
 * Create a Debug Log panel inside ``host``.
 *
 * Returns { destroy, clear, setExpanded, isExpanded }.
 */
export function createLogPane(host) {
  if (!host) { throw new Error('createLogPane: host is required'); }

  const root = document.createElement('div');
  root.className = 'log-pane collapsed';
  root.innerHTML = `
    <div class="log-pane-header">
      <span class="log-pane-toggle" title="Toggle expand/collapse">▶</span>
      <span class="log-pane-title">Debug Log</span>
      <span class="log-pane-count" id="log-pane-count">0</span>
      <span class="log-pane-spacer"></span>
      <span class="log-pane-summary" id="log-pane-summary"></span>
      <span class="log-pane-spacer-flex"></span>
      <label class="log-filter" title="Show frontend console messages">
        <input type="checkbox" data-src="fe" checked /> FE
      </label>
      <label class="log-filter" title="Show backend Express messages">
        <input type="checkbox" data-src="be" checked /> BE
      </label>
      <select class="log-pane-level" id="log-pane-level" title="Minimum level">
        <option value="log">all</option>
        <option value="info">info+</option>
        <option value="warn">warn+</option>
        <option value="error">error</option>
      </select>
      <button class="log-pane-btn" id="log-pane-pause" title="Pause incoming entries">Pause</button>
      <button class="log-pane-btn" id="log-pane-clear" title="Clear pane">Clear</button>
    </div>
    <div class="log-pane-body" id="log-pane-body"></div>
  `;
  host.appendChild(root);

  const elHeader = root.querySelector('.log-pane-header');
  const elBody = root.querySelector('#log-pane-body');
  const elToggle = root.querySelector('.log-pane-toggle');
  const elCount = root.querySelector('#log-pane-count');
  const elSummary = root.querySelector('#log-pane-summary');
  const elPause = root.querySelector('#log-pane-pause');
  const elClear = root.querySelector('#log-pane-clear');
  const elLevel = root.querySelector('#log-pane-level');
  const filterFe = root.querySelector('.log-filter input[data-src="fe"]');
  const filterBe = root.querySelector('.log-filter input[data-src="be"]');

  const LEVEL_ORDER = { log: 0, info: 1, warn: 2, error: 3 };

  let entries = [];   // ring buffer of all received entries
  let expanded = false;
  let paused = false;
  let warnCount = 0;
  let errCount = 0;
  let autoScroll = true;
  let dropped = 0;
  let pendingLatest = null;

  function shouldShow(entry) {
    if (entry.src === 'fe' && !filterFe.checked) { return false; }
    if (entry.src === 'be' && !filterBe.checked) { return false; }
    const min = LEVEL_ORDER[elLevel.value] || 0;
    const lvl = LEVEL_ORDER[entry.level] ?? 0;
    return lvl >= min;
  }

  function appendRow(entry) {
    if (!shouldShow(entry)) { return; }
    const row = document.createElement('div');
    row.className = `log-row log-${entry.level} log-src-${entry.src}`;
    const ts = document.createElement('span');
    ts.className = 'log-ts';
    ts.textContent = fmtTime(new Date(entry.ts));
    const tag = document.createElement('span');
    tag.className = 'log-tag';
    tag.textContent = entry.src === 'be' ? 'svr' : 'fe';
    const lvl = document.createElement('span');
    lvl.className = 'log-lvl';
    lvl.textContent = entry.level.toUpperCase();
    const msg = document.createElement('span');
    msg.className = 'log-msg';
    msg.textContent = entry.line;
    row.appendChild(ts);
    row.appendChild(tag);
    row.appendChild(lvl);
    row.appendChild(msg);
    elBody.appendChild(row);
    if (autoScroll) {
      elBody.scrollTop = elBody.scrollHeight;
    }
  }

  function renderAll() {
    elBody.innerHTML = '';
    for (const e of entries) { appendRow(e); }
  }

  function updateHeaderCount() {
    elCount.textContent = String(entries.length);
    elCount.classList.toggle('has-error', errCount > 0);
    elCount.classList.toggle('has-warn', warnCount > 0 && errCount === 0);
    if (pendingLatest) {
      elSummary.textContent =
        `${pendingLatest.src === 'be' ? 'svr' : 'fe'}/${pendingLatest.level}: `
        + (pendingLatest.line.length > 80
            ? pendingLatest.line.slice(0, 80) + '...'
            : pendingLatest.line);
    }
  }

  function ingest(entry) {
    if (paused) {
      dropped += 1;
      elSummary.textContent = `(paused; ${dropped} dropped)`;
      return;
    }
    pendingLatest = entry;
    entries.push(entry);
    if (entries.length > LOG_BUF_MAX) { entries.shift(); }
    if (entry.level === 'error') { errCount += 1; }
    else if (entry.level === 'warn') { warnCount += 1; }
    appendRow(entry);
    updateHeaderCount();
  }

  // ---- Hook frontend console -----------------------------------------
  const consoleHook = installConsoleHook();
  const unsubConsole = consoleHook.subscribe((level, args) => {
    ingest({
      ts: Date.now(),
      level,
      src: 'fe',
      line: args.map(formatArg).join(' '),
    });
  });

  // ---- Subscribe to backend SSE --------------------------------------
  let es = null;
  let esRetryTimer = null;
  let stopped = false;
  function connectSse() {
    if (stopped) { return; }
    try {
      es = new EventSource('/server-log/stream');
    } catch (err) {
      ingest({ ts: Date.now(), level: 'warn', src: 'fe',
               line: `[log-pane] SSE connect failed: ${err.message}` });
      return;
    }
    es.onopen = () => {
      ingest({ ts: Date.now(), level: 'info', src: 'fe',
               line: '[log-pane] connected to /server-log/stream' });
    };
    es.onmessage = (ev) => {
      try {
        const obj = JSON.parse(ev.data);
        ingest({
          ts: obj.ts || Date.now(),
          level: obj.level || 'log',
          src: 'be',
          line: obj.line || '',
        });
      } catch { /* ignore malformed line */ }
    };
    es.onerror = () => {
      // EventSource auto-reconnects on transient errors but we add a
      // manual retry too so it survives Express restarts cleanly.
      try { es?.close(); } catch {}
      es = null;
      if (!stopped) {
        clearTimeout(esRetryTimer);
        esRetryTimer = setTimeout(connectSse, SSE_RECONNECT_MS);
      }
    };
  }
  connectSse();

  // ---- UI behaviour --------------------------------------------------
  elBody.addEventListener('scroll', () => {
    const atBottom =
      elBody.scrollHeight - elBody.scrollTop - elBody.clientHeight < 4;
    autoScroll = atBottom;
  });

  elHeader.addEventListener('click', (ev) => {
    // Don't toggle when clicking on a control inside the header.
    const t = ev.target;
    if (t === elHeader || t === elToggle || t === elCount
        || t === root.querySelector('.log-pane-title')
        || t === elSummary
        || t.classList.contains('log-pane-spacer')
        || t.classList.contains('log-pane-spacer-flex')) {
      setExpanded(!expanded);
    }
  });

  filterFe.addEventListener('change', renderAll);
  filterBe.addEventListener('change', renderAll);
  elLevel.addEventListener('change', renderAll);

  elClear.addEventListener('click', (ev) => {
    ev.stopPropagation();
    entries = [];
    warnCount = 0;
    errCount = 0;
    dropped = 0;
    pendingLatest = null;
    elBody.innerHTML = '';
    elSummary.textContent = '';
    updateHeaderCount();
  });

  elPause.addEventListener('click', (ev) => {
    ev.stopPropagation();
    paused = !paused;
    elPause.classList.toggle('paused', paused);
    elPause.textContent = paused ? 'Resume' : 'Pause';
    if (!paused) {
      dropped = 0;
      elSummary.textContent = pendingLatest
        ? `${pendingLatest.src === 'be' ? 'svr' : 'fe'}/${pendingLatest.level}: ` + pendingLatest.line
        : '';
    }
  });

  function setExpanded(v) {
    expanded = !!v;
    root.classList.toggle('collapsed', !expanded);
    root.classList.toggle('expanded', expanded);
    elToggle.textContent = expanded ? '▼' : '▶';
    if (expanded) {
      autoScroll = true;
      elBody.scrollTop = elBody.scrollHeight;
    }
  }

  // Start collapsed.
  setExpanded(false);
  updateHeaderCount();

  return {
    destroy() {
      stopped = true;
      try { es?.close(); } catch {}
      clearTimeout(esRetryTimer);
      if (typeof unsubConsole === 'function') { unsubConsole(); }
      try { root.remove(); } catch {}
    },
    clear() { elClear.click(); },
    setExpanded,
    isExpanded() { return expanded; },
  };
}
