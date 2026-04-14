/**
 * Right-side topic panel.
 * Shows ONLY mcap-actual topics, grouped by nexis deploy name (publisher).
 */

export function createTopicPanel(container, { channels, onTopicClick }) {
  const el = document.createElement('div');
  el.className = 'topic-panel';
  el.innerHTML = `
    <div class="tp-header">
      <span class="tp-title">Topics</span>
      <span class="tp-count">${channels.length}</span>
      <button class="tp-toggle" id="tp-toggle" title="Toggle panel">
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M15 19l-7-7 7-7" fill="none" stroke="currentColor" stroke-width="2"/></svg>
      </button>
    </div>
    <div class="tp-search-wrap">
      <input class="tp-search" id="tp-search" placeholder="Filter topics..." />
    </div>
    <div class="tp-list" id="tp-list"></div>
  `;
  container.appendChild(el);

  const listEl = el.querySelector('#tp-list');
  const searchEl = el.querySelector('#tp-search');
  const toggleBtn = el.querySelector('#tp-toggle');

  let collapsed = false;
  toggleBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    el.classList.toggle('collapsed', collapsed);
    toggleBtn.querySelector('svg').style.transform = collapsed ? 'rotate(180deg)' : '';
  });

  // Group by publisher deploy name (set by topology-builder)
  const grouped = {};
  channels.forEach(ch => {
    const deploy = ch.publisher || '_ungrouped';
    if (!grouped[deploy]) grouped[deploy] = [];
    grouped[deploy].push(ch);
  });

  function render(filter = '') {
    const filt = filter.toLowerCase();
    let html = '';

    const sortedGroups = Object.entries(grouped).sort((a, b) => {
      if (a[0] === '_unknown' || a[0] === '_ungrouped') return 1;
      if (b[0] === '_unknown' || b[0] === '_ungrouped') return -1;
      return a[0].localeCompare(b[0]);
    });

    for (const [deploy, topics] of sortedGroups) {
      const filtered = filt
        ? topics.filter(t => t.topic.toLowerCase().includes(filt) || t.schemaName.toLowerCase().includes(filt))
        : topics;
      if (filtered.length === 0) continue;

      const totalMsgs = filtered.reduce((a, t) => a + t.messageCount, 0);
      const displayName = deploy === '_unknown' ? 'UNMATCHED' : deploy;

      html += `<div class="tp-group">`;
      html += `<div class="tp-group-header">`;
      html += `<span class="tp-group-name">${esc(displayName)}</span>`;
      html += `<span class="tp-group-count">${filtered.length} topics &middot; ${totalMsgs.toLocaleString()} msgs</span>`;
      html += `</div>`;

      for (const ch of filtered) {
        html += `<div class="tp-item" data-topic="${escAttr(ch.topic)}">`;
        html += `<div class="tp-item-topic">${esc(ch.topic)}</div>`;
        html += `<div class="tp-item-meta">`;
        html += `<span class="tp-hz">${ch.hz} Hz</span>`;
        html += `<span class="tp-msgs">${ch.messageCount.toLocaleString()} msgs</span>`;
        html += `<span class="tp-schema">${esc(shortSchema(ch.schemaName))}</span>`;
        html += `</div></div>`;
      }
      html += `</div>`;
    }

    if (!html) html = '<div class="tp-empty">No matching topics</div>';
    listEl.innerHTML = html;

    listEl.querySelectorAll('.tp-item').forEach(item => {
      item.addEventListener('click', () => {
        listEl.querySelectorAll('.tp-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        if (onTopicClick) onTopicClick(item.dataset.topic);
      });
    });
  }

  searchEl.addEventListener('input', () => render(searchEl.value));
  render();

  return {
    setActiveTopics(topics) {
      const set = new Set(topics);
      listEl.querySelectorAll('.tp-item').forEach(item => {
        item.classList.toggle('live', set.has(item.dataset.topic));
      });
    },
    destroy() { el.remove(); },
  };
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function escAttr(s) { return s.replace(/"/g, '&quot;'); }
function shortSchema(s) {
  if (!s || s === 'unknown') return '';
  const p = s.split('.');
  return p.length > 2 ? p.slice(-2).join('.') : s;
}
