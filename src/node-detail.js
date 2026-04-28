/**
 * Node Detail View — shows a single process node with upstream/downstream
 * and selectable topic message panels with decoded JSON content.
 */

import * as d3 from 'd3';
import { createSplitter } from './splitter.js';

const DC = {
  sensor: '#4db8c7', perception: '#c7943a', localization: '#3aaa7a',
  pnc: '#5b8fd9', system: '#8a73c7', recorder: '#777777',
  maprouter: '#d4884d', openapi: '#6b8f8f', unknown: '#555',
};

/**
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {string} opts.nodeId — the target node
 * @param {object} opts.topology — { nodes, links }
 * @param {object} opts.DOMAINS
 * @param {function} opts.onBack — callback to return to topology
 */
export function createNodeDetail(container, opts) {
  const { nodeId, topology, DOMAINS } = opts;
  const { nodes, links } = topology;
  const nodeData = nodes.find(n => n.id === nodeId);
  if (!nodeData) return null;

  // Find upstream and downstream
  const upstreamLinks = links.filter(l => l.target === nodeId);
  const downstreamLinks = links.filter(l => l.source === nodeId);
  const upstreamIds = [...new Set(upstreamLinks.map(l => l.source))];
  const downstreamIds = [...new Set(downstreamLinks.map(l => l.target))];

  // Collect all topics for this node (PUB + SUB)
  const pubTopics = (nodeData.topics || []).map(t => ({ ...t, direction: 'PUB' }));
  const subTopics = [];
  for (const link of upstreamLinks) {
    for (const t of (link.topics || [])) {
      if (!subTopics.find(s => s.topic === t.topic)) {
        subTopics.push({ ...t, direction: 'SUB', from: link.source });
      }
    }
  }
  const allTopics = [...pubTopics, ...subTopics];

  const el = document.createElement('div');
  el.className = 'nd-view';

  // --- Build HTML ---
  el.innerHTML = `
    <div class="nd-header">
      <button class="nd-back" id="nd-back">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7" fill="none" stroke="currentColor" stroke-width="2"/></svg>
        Back
      </button>
      <div class="nd-title">
        <span class="view-label">Node Detail</span>
        <span class="nd-dot" style="background:${DC[nodeData.domain] || '#555'}"></span>
        <span>${esc(nodeId)}</span>
        <span class="nd-badge">${DOMAINS[nodeData.domain]?.label || nodeData.domain}</span>
        <span class="nd-runtime-badge">${nodeData.runtime === 'nexis' ? 'Nexis' : nodeData.runtime === 'cyber' ? 'CyberRT' : ''}</span>
      </div>
      <div class="nd-stats">
        <span class="nd-stat">${pubTopics.length} PUB</span>
        <span class="nd-stat">${subTopics.length} SUB</span>
        <span class="nd-stat">${(nodeData.totalMessages || 0).toLocaleString()} msgs</span>
        <button class="nd-test-btn" id="nd-test-btn">Replay Test</button>
      </div>
    </div>
    <div class="nd-mini-topo" id="nd-mini-topo"></div>
    <div class="nd-selector" id="nd-selector">
      <div class="nd-sel-columns">
        <div class="nd-sel-col" id="nd-sel-col-sub">
          <div class="nd-sel-col-title sub">SUB <span class="nd-sel-col-count" id="nd-sub-count">0</span></div>
          <div class="nd-sel-col-body" id="nd-sel-sub-body"></div>
        </div>
        <div class="nd-sel-col" id="nd-sel-col-pub">
          <div class="nd-sel-col-title pub">PUB <span class="nd-sel-col-count" id="nd-pub-count">0</span></div>
          <div class="nd-sel-col-body" id="nd-sel-pub-body"></div>
        </div>
      </div>
    </div>
    <div class="nd-panels" id="nd-panels"></div>
  `;

  container.appendChild(el);

  // --- Back button ---
  el.querySelector('#nd-back').addEventListener('click', () => {
    if (opts.onBack) opts.onBack();
  });

  // --- Mini Topo ---
  renderMiniTopo(el.querySelector('#nd-mini-topo'), {
    nodeId, nodeData, upstreamIds, downstreamIds, upstreamLinks, downstreamLinks, nodes, DOMAINS,
  });

  // --- Resize Handle (mini-topo | selector) ---
  const miniTopo = el.querySelector('#nd-mini-topo');
  const ndSelector = el.querySelector('#nd-selector');
  const miniTopoSplitter = createSplitter(miniTopo, ndSelector, { direction: 'vertical', min: 60, max: 600 });

  // --- Topic Selector (two-column: SUB | PUB, grouped by node) ---
  const subBody = el.querySelector('#nd-sel-sub-body');
  const pubBody = el.querySelector('#nd-sel-pub-body');
  const selectedTopics = new Set();
  const panelContainer = el.querySelector('#nd-panels');

  el.querySelector('#nd-sub-count').textContent = subTopics.length;
  el.querySelector('#nd-pub-count').textContent = pubTopics.length;

  // Group SUB topics by upstream node
  const subByNode = {};
  for (const t of subTopics) {
    const fromNode = t.from || 'unknown';
    if (!subByNode[fromNode]) { subByNode[fromNode] = []; }
    subByNode[fromNode].push(t);
  }

  // Group PUB topics by downstream subscriber (from topicToSubscribers)
  // Use the full subscriber mapping instead of only downstreamLinks, which
  // may miss some subscribers not represented as topo edges.
  const topicToSubs = topology.topicToSubscribers || {};
  const pubByNode = {};
  for (const t of pubTopics) {
    const subs = topicToSubs[t.topic] || [];
    const key = subs.length > 0 ? '→ ' + [...subs].sort().join(', ') : '(no known subscriber)';
    if (!pubByNode[key]) { pubByNode[key] = []; }
    pubByNode[key].push(t);
  }

  function createChip(t) {
    const chip = document.createElement('button');
    chip.className = 'nd-chip';
    chip.dataset.topic = t.topic;
    chip.innerHTML = `${esc(shortTopic(t.topic))} <span class="nd-chip-hz">${t.hz}Hz</span>`;
    chip.addEventListener('click', () => {
      if (selectedTopics.has(t.topic)) {
        selectedTopics.delete(t.topic);
        chip.classList.remove('active');
        removePanel(t.topic);
      } else {
        selectedTopics.add(t.topic);
        chip.classList.add('active');
        addPanel(t);
      }
    });
    return chip;
  }

  function createNodeGroup(parentEl, label, domainColor, topics) {
    const group = document.createElement('div');
    group.className = 'nd-sel-node-group';
    const dotHtml = domainColor ? `<span class="nd-sel-group-dot" style="background:${domainColor}"></span>` : '';
    group.innerHTML = `<div class="nd-sel-node-header">${dotHtml}<span class="nd-sel-node-name">${esc(label)}</span><span class="nd-sel-group-count">${topics.length}</span></div>`;
    const chips = document.createElement('div');
    chips.className = 'nd-sel-node-chips';
    for (const t of topics) { chips.appendChild(createChip(t)); }
    group.appendChild(chips);
    parentEl.appendChild(group);
  }

  // Fill SUB column
  const sortedUpstreams = Object.keys(subByNode).sort();
  for (const fromNode of sortedUpstreams) {
    const upNode = nodes.find(n => n.id === fromNode);
    const domainColor = DC[upNode?.domain] || '#555';
    createNodeGroup(subBody, fromNode, domainColor, subByNode[fromNode]);
  }

  // Fill PUB column
  const sortedDownstreams = Object.keys(pubByNode).sort();
  for (const toKey of sortedDownstreams) {
    const isNoSub = toKey.startsWith('(no');
    const firstNodeName = isNoSub ? '' : toKey.replace(/^→ /, '').split(', ')[0];
    const downNode = firstNodeName ? nodes.find(n => n.id === firstNodeName) : null;
    const domainColor = downNode ? (DC[downNode.domain] || '#555') : null;
    createNodeGroup(pubBody, toKey, domainColor, pubByNode[toKey]);
  }

  // --- Message Panels ---
  const activePanels = new Map(); // topic -> { el, listEl, autoScroll }

  function addPanel(topicInfo) {
    const panel = document.createElement('div');
    panel.className = 'nd-panel';
    panel.dataset.topic = topicInfo.topic;
    const dirClass = topicInfo.direction === 'PUB' ? 'pub' : 'sub';
    let peerLabel = '';
    if (topicInfo.direction === 'PUB') {
      // Find specific downstream processes that subscribe to this topic
      const subs = downstreamLinks
        .filter(l => (l.topics || []).some(t => t.topic === topicInfo.topic))
        .map(l => l.target);
      peerLabel = subs.length > 0 ? `→ ${[...new Set(subs)].join(', ')}` : '';
    } else {
      peerLabel = topicInfo.from ? `← ${topicInfo.from}` : '';
    }

    panel.innerHTML = `
      <div class="nd-panel-header">
        <span class="nd-panel-dir ${dirClass}">${topicInfo.direction}</span>
        <span class="nd-panel-topic">${esc(topicInfo.topic)}</span>
        <span class="nd-panel-hz">${topicInfo.hz} Hz</span>
        <span class="nd-panel-peer">${esc(peerLabel)}</span>
        <button class="nd-panel-close" title="Close">x</button>
      </div>
      <div class="nd-panel-schema">${esc(topicInfo.schema || '')}</div>
      <div class="nd-panel-body"><div class="nd-panel-list"></div></div>
    `;

    panel.querySelector('.nd-panel-close').addEventListener('click', () => {
      selectedTopics.delete(topicInfo.topic);
      const chip = selList.querySelector(`[data-topic="${CSS.escape(topicInfo.topic)}"]`);
      if (chip) chip.classList.remove('active');
      removePanel(topicInfo.topic);
    });

    const listEl = panel.querySelector('.nd-panel-list');
    const bodyEl = panel.querySelector('.nd-panel-body');
    let autoScroll = true;

    bodyEl.addEventListener('scroll', () => {
      autoScroll = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 30;
    });

    panelContainer.appendChild(panel);
    activePanels.set(topicInfo.topic, { el: panel, listEl, bodyEl, autoScroll: () => autoScroll });
  }

  function removePanel(topic) {
    const p = activePanels.get(topic);
    if (p) { p.el.remove(); activePanels.delete(topic); }
  }

  /**
   * Push a decoded message to the appropriate panel.
   * @param {string} topic
   * @param {number} timeSec — relative seconds
   * @param {object|null} decoded — JSON object or null
   * @param {number} dataSize — raw bytes
   */
  function pushMessage(topic, timeSec, decoded, dataSize) {
    const p = activePanels.get(topic);
    if (!p) return;

    const entry = document.createElement('div');
    entry.className = 'nd-msg';

    let content;
    if (decoded) {
      content = JSON.stringify(decoded, null, 2);
    } else {
      content = `(binary ${dataSize} bytes)`;
    }

    entry.innerHTML = `<span class="nd-msg-time">[${timeSec.toFixed(3)}s]</span><pre class="nd-msg-json">${escHtml(content)}</pre>`;

    // Click to expand/collapse JSON
    const pre = entry.querySelector('.nd-msg-json');
    pre.addEventListener('click', () => pre.classList.toggle('expanded'));

    p.listEl.appendChild(entry);

    // Keep max 50 messages per panel to limit DOM size
    while (p.listEl.children.length > 50) {
      p.listEl.removeChild(p.listEl.firstChild);
    }

    if (p.autoScroll()) {
      p.bodyEl.scrollTop = p.bodyEl.scrollHeight;
    }
  }

  function clearMessages() {
    for (const [, p] of activePanels) {
      p.listEl.innerHTML = '';
    }
  }

  function getSelectedTopics() {
    return [...selectedTopics];
  }

  function destroy() {
    miniTopoSplitter.destroy();
    el.remove();
  }

  return { pushMessage, clearMessages, getSelectedTopics, destroy, allTopics };
}

// --- Mini Topo renderer ---

function renderMiniTopo(container, opts) {
  const { nodeId, nodeData, upstreamIds, downstreamIds, upstreamLinks, downstreamLinks, nodes, DOMAINS } = opts;

  const W = container.clientWidth || 800;
  const maxSide = Math.max(upstreamIds.length, downstreamIds.length, 1);
  const SPREAD_Y = 45;
  const H = Math.max(120, maxSide * SPREAD_Y + 60);
  container.style.height = H + 'px';
  const svg = d3.select(container).append('svg').attr('width', W).attr('height', H);
  const g = svg.append('g');

  const CX = W / 2, CY = H / 2;
  const SPREAD_X = Math.min(W * 0.3, 250);

  const miniNodes = [];
  const miniLinks = [];

  // Target node
  miniNodes.push({ id: nodeId, x: CX, y: CY, isTarget: true, domain: nodeData.domain, label: nodeId });

  // Handle nodes that are both upstream AND downstream — give them unique IDs per side
  const bothSides = new Set(upstreamIds.filter(id => downstreamIds.includes(id)));

  // Upstream
  upstreamIds.forEach((id, i) => {
    const n = nodes.find(n => n.id === id);
    const y = CY + (i - (upstreamIds.length - 1) / 2) * SPREAD_Y;
    const miniId = bothSides.has(id) ? `${id}_up` : id;
    miniNodes.push({ id: miniId, x: CX - SPREAD_X, y, isTarget: false, domain: n?.domain || 'system', label: id });
  });

  // Downstream
  downstreamIds.forEach((id, i) => {
    const n = nodes.find(n => n.id === id);
    const y = CY + (i - (downstreamIds.length - 1) / 2) * SPREAD_Y;
    const miniId = bothSides.has(id) ? `${id}_down` : id;
    miniNodes.push({ id: miniId, x: CX + SPREAD_X, y, isTarget: false, domain: n?.domain || 'system', label: id });
  });

  // Links
  for (const l of upstreamLinks) {
    const count = (l.topics || []).length;
    const srcId = bothSides.has(l.source) ? `${l.source}_up` : l.source;
    miniLinks.push({ source: srcId, target: nodeId, label: `${count} topic` });
  }
  for (const l of downstreamLinks) {
    const count = (l.topics || []).length;
    const tgtId = bothSides.has(l.target) ? `${l.target}_down` : l.target;
    miniLinks.push({ source: nodeId, target: tgtId, label: `${count} topic` });
  }

  const byId = Object.fromEntries(miniNodes.map(n => [n.id, n]));

  // Arrow marker
  svg.append('defs').append('marker').attr('id', 'mini-arr')
    .attr('viewBox', '0 -3 6 6').attr('refX', 6).attr('refY', 0)
    .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
    .append('path').attr('d', 'M0,-2L6,0L0,2').attr('fill', '#4b4b4b');

  // Draw links
  g.selectAll('path.mini-link').data(miniLinks).join('path')
    .attr('fill', 'none').attr('stroke', '#333').attr('stroke-width', 1.2)
    .attr('marker-end', 'url(#mini-arr)')
    .attr('d', d => {
      const s = byId[d.source], t = byId[d.target];
      if (!s || !t) return '';
      return `M${s.x + 18},${s.y} C${(s.x + t.x) / 2},${s.y} ${(s.x + t.x) / 2},${t.y} ${t.x - 18},${t.y}`;
    });

  // Link labels
  g.selectAll('text.mini-label').data(miniLinks).join('text')
    .attr('x', d => { const s = byId[d.source], t = byId[d.target]; return s && t ? (s.x + t.x) / 2 : 0; })
    .attr('y', d => { const s = byId[d.source], t = byId[d.target]; return s && t ? (s.y + t.y) / 2 - 6 : 0; })
    .attr('text-anchor', 'middle').attr('fill', '#4b4b4b')
    .attr('font-family', 'Inter, system-ui').attr('font-size', '8px')
    .text(d => d.label.length > 40 ? d.label.slice(0, 40) + '...' : d.label);

  // Draw nodes
  const nodeSel = g.selectAll('g.mini-node').data(miniNodes).join('g')
    .attr('transform', d => `translate(${d.x},${d.y})`);

  nodeSel.append('circle').attr('r', d => d.isTarget ? 16 : 12)
    .attr('fill', '#000').attr('stroke', d => d.isTarget ? '#fff' : (DC[d.domain] || '#555'))
    .attr('stroke-width', d => d.isTarget ? 2.5 : 1.5);

  nodeSel.append('circle').attr('r', d => d.isTarget ? 5 : 3)
    .attr('fill', d => DC[d.domain] || '#555');

  nodeSel.append('text').text(d => d.label || d.id)
    .attr('dy', d => (d.isTarget ? 16 : 12) + 14).attr('text-anchor', 'middle')
    .attr('fill', d => d.isTarget ? '#fff' : '#6b6b6b')
    .attr('font-family', 'Inter, system-ui').attr('font-size', d => d.isTarget ? '11px' : '9px')
    .attr('font-weight', d => d.isTarget ? '700' : '500');
}

function esc(s) { const d = document.createElement('span'); d.textContent = s; return d.innerHTML; }
function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function shortTopic(t) {
  const parts = t.split('/').filter(Boolean);
  return parts.length > 2 ? '/' + parts.slice(-2).join('/') : t;
}
