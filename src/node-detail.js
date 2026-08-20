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

  // --- Resize Handle (selector | message panels) ---
  // Lets the SUB/PUB selector region grow/shrink against the message area.
  const ndPanels = el.querySelector('#nd-panels');
  const selectorSplitter = createSplitter(ndSelector, ndPanels, { direction: 'vertical', min: 80, max: 700 });

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

    // Combo layout: a single-frame full-detail pane on top (prominent timestamp
    // + Δ from previous frame + frame #) and a compact, clickable timestamp log
    // below. High-frequency streams stay scannable; clicking a row pins that
    // frame in the detail pane, and "跟随最新" resumes tailing the latest frame.
    panel.innerHTML = `
      <div class="nd-panel-header">
        <span class="nd-panel-dir ${dirClass}">${topicInfo.direction}</span>
        <span class="nd-panel-topic">${esc(topicInfo.topic)}</span>
        <span class="nd-panel-hz">${topicInfo.hz} Hz</span>
        <span class="nd-panel-peer">${esc(peerLabel)}</span>
        <button class="nd-panel-close" title="Close">x</button>
      </div>
      <div class="nd-panel-schema">${esc(topicInfo.schema || '')}</div>
      <div class="nd-panel-body">
        <div class="nd-detail">
          <div class="nd-detail-head">
            <span class="nd-detail-time">—</span>
            <span class="nd-detail-delta"></span>
            <span class="nd-detail-seq"></span>
            <span class="nd-detail-size"></span>
            <button class="nd-follow active" title="跟随最新帧">跟随最新</button>
          </div>
          <pre class="nd-detail-json"><span class="nd-detail-empty">等待数据…</span></pre>
        </div>
        <div class="nd-rows"></div>
      </div>
    `;

    panel.querySelector('.nd-panel-close').addEventListener('click', () => {
      selectedTopics.delete(topicInfo.topic);
      const chip = selList.querySelector(`[data-topic="${CSS.escape(topicInfo.topic)}"]`);
      if (chip) chip.classList.remove('active');
      removePanel(topicInfo.topic);
    });

    const rowsEl = panel.querySelector('.nd-rows');
    const timeEl = panel.querySelector('.nd-detail-time');
    const deltaEl = panel.querySelector('.nd-detail-delta');
    const seqEl = panel.querySelector('.nd-detail-seq');
    const sizeEl = panel.querySelector('.nd-detail-size');
    const jsonEl = panel.querySelector('.nd-detail-json');
    const followBtn = panel.querySelector('.nd-follow');

    const ctl = { frames: [], followLatest: true, seq: 0, selectedRow: null };

    function renderDetail(frame, rowEl) {
      timeEl.textContent = `[${frame.sec.toFixed(3)}s]`;
      deltaEl.textContent = frame.deltaMs != null ? `Δ${frame.deltaMs.toFixed(1)}ms` : '';
      seqEl.textContent = `#${frame.seq}`;
      sizeEl.textContent = `${frame.dataSize}B`;
      jsonEl.textContent = frame.decoded
        ? JSON.stringify(frame.decoded, null, 2)
        : `(binary ${frame.dataSize} bytes)`;
      if (ctl.selectedRow) { ctl.selectedRow.classList.remove('active'); }
      if (rowEl) { rowEl.classList.add('active'); ctl.selectedRow = rowEl; }
    }
    function updateFollowBtn() { followBtn.classList.toggle('active', ctl.followLatest); }
    followBtn.addEventListener('click', () => {
      ctl.followLatest = true;
      updateFollowBtn();
      const last = ctl.frames[ctl.frames.length - 1];
      if (last) { renderDetail(last, rowsEl.lastElementChild); }
      rowsEl.scrollTop = rowsEl.scrollHeight;
    });
    function clear() {
      ctl.frames = []; ctl.seq = 0; ctl.followLatest = true; ctl.selectedRow = null;
      rowsEl.innerHTML = '';
      timeEl.textContent = '—'; deltaEl.textContent = ''; seqEl.textContent = ''; sizeEl.textContent = '';
      jsonEl.innerHTML = '<span class="nd-detail-empty">等待数据…</span>';
      updateFollowBtn();
    }

    panelContainer.appendChild(panel);

    // Give each message panel its own drag-to-resize handle on its right edge.
    const panelSplitter = createSplitter(panel, null, {
      direction: 'horizontal', min: 220, max: 1100,
    });

    activePanels.set(topicInfo.topic, {
      el: panel, splitter: panelSplitter, ctl, rowsEl, renderDetail, updateFollowBtn, clear,
    });
  }

  function removePanel(topic) {
    const p = activePanels.get(topic);
    if (p) {
      if (p.splitter) { p.splitter.destroy(); }
      p.el.remove();
      activePanels.delete(topic);
    }
  }

  const MAX_FRAMES = 300;

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
    const { ctl, rowsEl } = p;

    const prev = ctl.frames[ctl.frames.length - 1];
    const frame = {
      sec: timeSec, decoded, dataSize,
      seq: ++ctl.seq,
      deltaMs: prev ? (timeSec - prev.sec) * 1000 : null,
    };
    ctl.frames.push(frame);

    const row = document.createElement('div');
    row.className = 'nd-row';
    const preview = decoded ? clipLine(JSON.stringify(decoded), 240) : `(binary ${dataSize} bytes)`;
    row.innerHTML = `<span class="nd-row-time">${timeSec.toFixed(3)}s</span><span class="nd-row-preview">${escHtml(preview)}</span>`;
    row.addEventListener('click', () => {
      ctl.followLatest = false;
      p.updateFollowBtn();
      p.renderDetail(frame, row);
    });
    rowsEl.appendChild(row);

    // Cap DOM + memory; drop oldest frame and its row together.
    while (ctl.frames.length > MAX_FRAMES) {
      ctl.frames.shift();
      if (rowsEl.firstElementChild) { rowsEl.removeChild(rowsEl.firstElementChild); }
    }

    if (ctl.followLatest) {
      p.renderDetail(frame, row);
      rowsEl.scrollTop = rowsEl.scrollHeight;
    }
  }

  function clearMessages() {
    for (const [, p] of activePanels) {
      if (p.clear) { p.clear(); }
    }
  }

  function getSelectedTopics() {
    return [...selectedTopics];
  }

  function destroy() {
    for (const [, p] of activePanels) {
      if (p.splitter) { p.splitter.destroy(); }
    }
    activePanels.clear();
    selectorSplitter.destroy();
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
function clipLine(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function shortTopic(t) {
  const parts = t.split('/').filter(Boolean);
  return parts.length > 2 ? '/' + parts.slice(-2).join('/') : t;
}
