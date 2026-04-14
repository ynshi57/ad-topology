/**
 * Output log panel — collapsible, bottom-docked.
 * Shows freq alerts, errors, and info during playback.
 */

export function createOutputPanel(container) {
  const el = document.createElement('div');
  el.className = 'output-panel collapsed';
  el.innerHTML = `
    <div class="op-header" id="op-header">
      <span class="op-title">Output</span>
      <span class="op-badge" id="op-badge">0</span>
      <span class="op-latest" id="op-latest"></span>
      <button class="op-clear" id="op-clear" title="Clear">Clear</button>
      <button class="op-toggle" id="op-toggle" title="Toggle">
        <svg viewBox="0 0 24 24" width="12" height="12"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2"/></svg>
      </button>
    </div>
    <div class="op-body" id="op-body">
      <div class="op-list" id="op-list"></div>
    </div>
  `;
  container.appendChild(el);

  const listEl = el.querySelector('#op-list');
  const badgeEl = el.querySelector('#op-badge');
  const latestEl = el.querySelector('#op-latest');
  const toggleBtn = el.querySelector('#op-toggle');
  const clearBtn = el.querySelector('#op-clear');
  const headerEl = el.querySelector('#op-header');

  let entries = [];
  let autoScroll = true;
  let expanded = false;

  // Deduplicate: don't repeat the same alert within 1s
  const recentAlerts = new Map();

  headerEl.addEventListener('click', (e) => {
    if (e.target === clearBtn) return;
    expanded = !expanded;
    el.classList.toggle('collapsed', !expanded);
    toggleBtn.querySelector('svg').style.transform = expanded ? 'rotate(180deg)' : '';
    if (expanded && autoScroll) listEl.scrollTop = listEl.scrollHeight;
  });

  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    entries = [];
    listEl.innerHTML = '';
    badgeEl.textContent = '0';
    latestEl.textContent = '';
    recentAlerts.clear();
  });

  listEl.addEventListener('scroll', () => {
    const atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 20;
    autoScroll = atBottom;
  });

  function log(timeSec, level, topic, message) {
    const key = `${level}:${topic}`;
    const now = performance.now();
    const last = recentAlerts.get(key);
    if (last && now - last < 1000) return;
    recentAlerts.set(key, now);

    const entry = { timeSec, level, topic, message };
    entries.push(entry);

    const levelClass = level === 'ERROR' ? 'op-error' : level === 'WARN' ? 'op-warn' : level === 'CRITICAL' ? 'op-critical' : 'op-info';
    const row = document.createElement('div');
    row.className = `op-entry ${levelClass}`;
    row.innerHTML = `<span class="op-time">[${timeSec.toFixed(2)}s]</span> <span class="op-level">${level}</span> <span class="op-topic">${esc(topic)}</span> ${esc(message)}`;
    listEl.appendChild(row);

    if (autoScroll) listEl.scrollTop = listEl.scrollHeight;

    const warnCount = entries.filter(e => e.level !== 'INFO').length;
    badgeEl.textContent = warnCount > 0 ? warnCount : entries.length;
    badgeEl.className = `op-badge ${warnCount > 0 ? 'has-warnings' : ''}`;

    latestEl.textContent = `${level} ${topic}: ${message}`;
    latestEl.className = `op-latest ${levelClass}`;
  }

  function esc(s) { const d = document.createElement('span'); d.textContent = s; return d.innerHTML; }

  return {
    log,
    clear() { clearBtn.click(); },
    destroy() { el.remove(); },
  };
}
