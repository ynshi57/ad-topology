/**
 * Full-Canvas topology graph renderer.
 * All visible elements (nodes, labels, edges, arrows, particles) on one Canvas.
 * Hidden SVG paths for getPointAtLength() geometry only.
 * Zero sync issues. No particle pool limits.
 */

import * as d3 from 'd3';

const DC = {
  sensor: '#4db8c7', perception: '#c7943a', localization: '#3aaa7a',
  pnc: '#5b8fd9', system: '#8a73c7', recorder: '#777777',
  maprouter: '#d4884d', openapi: '#6b8f8f', unknown: '#555',
};

const STATUS_COLORS = {
  ok:    { particle: '#ffffff', edge: '#10b981' },
  warn:  { particle: '#f59e0b', edge: '#f59e0b' },
  error: { particle: '#ef4444', edge: '#ef4444' },
  dead:  { particle: null,      edge: '#ef4444' },
};

export function createGraph(container, topology, opts = {}) {
  const { nodes, links, LAYER_MAP } = topology;
  const DOMAINS = opts.DOMAINS || {};
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));

  const W = container.clientWidth || 1400;
  const H = container.clientHeight || 900;

  // ===== LAYOUT =====
  const layer = {};
  nodes.forEach(n => { layer[n.id] = LAYER_MAP?.[n.id] ?? 6; });
  const tL = Math.max(...nodes.map(n => layer[n.id])) + 1;
  const lG = Array.from({ length: tL }, () => []);
  nodes.forEach(n => { const l = layer[n.id]; if (l >= 0 && l < tL) lG[l].push(n); });

  const GAP_X = 420, GAP_Y = 160, PAD = 200;
  const dOrd = ['sensor','localization','perception','maprouter','pnc','system','openapi','recorder'];
  lG.forEach((grp, li) => {
    grp.sort((a, b) => dOrd.indexOf(a.domain) - dOrd.indexOf(b.domain));
    const th = (grp.length - 1) * GAP_Y;
    grp.forEach((n, i) => { n.x = PAD + li * GAP_X; n.y = -th / 2 + i * GAP_Y; });
  });
  const allY = nodes.map(n => n.y);
  const yOff = H / 2 - (Math.min(...allY) + Math.max(...allY)) / 2;
  nodes.forEach(n => n.y += yOff);

  const R = n => {
    const ch = (n.pubCount || 0) + (n.subCount || 0);
    return ch === 0 ? 20 : Math.min(20 + Math.sqrt(ch) * 2.5, 36);
  };

  // ===== HIDDEN SVG for path geometry =====
  const hiddenSvg = d3.select(container).append('svg')
    .attr('width', 0).attr('height', 0)
    .style('position', 'absolute').style('visibility', 'hidden');

  // Edge geometry
  const pK = l => [l.source, l.target].sort().join('\0');
  const pCnt = {}, pIdx = {}, pCur = {};
  links.forEach(l => { const k = pK(l); pCnt[k] = (pCnt[k] || 0) + 1; });
  links.forEach((l, i) => { const k = pK(l); pCur[k] = pCur[k] || 0; pIdx[i] = pCur[k]++; });

  const AVOID_MARGIN = 50;
  const linkVisualIdx = new Map();
  links.forEach((l, i) => { linkVisualIdx.set(i, i); });

  // Compute edge control points for bezier curves
  function edgeGeometry(d, i) {
    const s = byId[d.source], t = byId[d.target];
    if (!s || !t) return null;
    const dx = t.x - s.x, dy = t.y - s.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const gs = R(s) + 8, gt = R(t) + 12;
    const sx = s.x + (dx / dist) * gs, sy = s.y + (dy / dist) * gs;
    const tx = t.x - (dx / dist) * gt, ty = t.y - (dy / dist) * gt;

    const totalLinks = links.length;
    const visualSlot = linkVisualIdx.get(i) || 0;
    const globalOff = (visualSlot - (totalLinks - 1) / 2) * (300 / Math.max(totalLinks, 1));
    const k = pK(d), tot = pCnt[k], idx = pIdx[i];
    const pairOff = tot <= 1 ? 0 : (idx - (tot - 1) / 2) * 35;
    let off = pairOff + globalOff * 0.15;
    off = Math.max(-120, Math.min(120, off));

    for (const n of nodes) {
      if (n.id === d.source || n.id === d.target) continue;
      const px = n.x - sx, py = n.y - sy;
      const along = (px * (tx - sx) + py * (ty - sy)) / (dist * dist);
      if (along < 0.1 || along > 0.9) continue;
      const perpDist = py * (tx - sx) / dist - px * (ty - sy) / dist;
      const absDist = Math.abs(perpDist);
      const nodeR = R(n) + AVOID_MARGIN;
      if (absDist < nodeR) {
        const deflect = (nodeR - absDist + 25) * (perpDist >= 0 ? -1 : 1);
        if (Math.abs(deflect) > Math.abs(off)) off = deflect;
      }
    }

    const cx1 = sx + (tx - sx) * 0.35, cy1 = sy + off;
    const cx2 = sx + (tx - sx) * 0.65, cy2 = ty + off;
    return { sx, sy, tx, ty, cx1, cy1, cx2, cy2 };
  }

  // Build hidden SVG paths for getPointAtLength
  const edgeGeos = links.map((l, i) => edgeGeometry(l, i));
  const pathElements = [];
  edgeGeos.forEach((eg, i) => {
    const p = hiddenSvg.append('path')
      .attr('d', eg ? `M${eg.sx},${eg.sy} C${eg.cx1},${eg.cy1} ${eg.cx2},${eg.cy2} ${eg.tx},${eg.ty}` : '')
      .attr('fill', 'none');
    pathElements.push(p.node());
  });

  const pathLenCache = new Map();
  function getPathLen(i) {
    if (!pathLenCache.has(i)) pathLenCache.set(i, pathElements[i]?.getTotalLength() || 0);
    return pathLenCache.get(i);
  }

  // ===== CANVAS =====
  const canvas = document.createElement('canvas');
  canvas.width = W * devicePixelRatio;
  canvas.height = H * devicePixelRatio;
  canvas.style.cssText = `width:${W}px;height:${H}px;display:block;`;
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  ctx.scale(devicePixelRatio, devicePixelRatio);

  // Transform state
  let tf = { x: 0, y: 0, k: 1 };

  // ===== ZOOM & PAN =====
  const zoomBehavior = d3.zoom().scaleExtent([0.1, 5]).on('zoom', (e) => {
    tf = { x: e.transform.x, y: e.transform.y, k: e.transform.k };
    drawFrame();
  });
  d3.select(canvas).call(zoomBehavior).on('dblclick.zoom', null);

  // ===== TOOLTIP =====
  const tooltip = d3.select(container).append('div').attr('class', 'graph-tooltip').style('display', 'none');
  container.style.position = 'relative';

  // ===== EDGE / PARTICLE STATE =====
  let playbackActive = false;
  const edgeParticles = new Map();
  const edgeColors = {};    // linkIndex -> { stroke, opacity, width }
  const edgeStatus = {};
  const PARTICLE_SPACING = 40;
  const PARTICLE_RADIUS = 3;
  const nodeHighlight = {};  // nodeId -> bool

  const topicDesignHz = {};
  links.forEach(l => { (l.topics || []).forEach(t => { if (t.hz && !topicDesignHz[t.topic]) topicDesignHz[t.topic] = t.hz; }); });

  // Init edge colors to default
  links.forEach((l, i) => { edgeColors[i] = { stroke: '#333333', opacity: 0.6, width: Math.min(0.8 + (l.topics?.length || 1) * 0.35, 2.5) }; });

  // ===== DRAWING =====
  function tx(x) { return x * tf.k + tf.x; }
  function ty(y) { return y * tf.k + tf.y; }
  function ts(s) { return s * tf.k; }

  // Layer labels
  const layerLabels = [];
  const lLabels = ['INPUT', 'STATE', 'PRE-PROCESS', 'PERCEPTION', 'PLANNING', 'CONTROL', 'AUX'];
  lG.forEach((grp, li) => {
    if (!grp.length) return;
    const x = PAD + li * GAP_X;
    const yMin = Math.min(...grp.map(n => n.y));
    const yMax = Math.max(...grp.map(n => n.y));
    layerLabels.push({ x, yMin, yMax, text: lLabels[li] || `L${li}` });
  });

  function drawFrame() {
    const cw = W, ch = H;
    ctx.clearRect(0, 0, cw, ch);

    // Layer guides
    ctx.save();
    ctx.font = `600 ${ts(10)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    for (const ll of layerLabels) {
      ctx.fillStyle = '#282828';
      ctx.fillText(ll.text, tx(ll.x), ty(ll.yMin - 40));
      ctx.strokeStyle = '#1a1a1a';
      ctx.lineWidth = ts(1);
      ctx.setLineDash([ts(2), ts(6)]);
      ctx.beginPath();
      ctx.moveTo(tx(ll.x), ty(ll.yMin - 30));
      ctx.lineTo(tx(ll.x), ty(ll.yMax + 50));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    // Edges (bezier curves)
    for (let i = 0; i < links.length; i++) {
      const eg = edgeGeos[i];
      if (!eg) continue;
      const ec = edgeColors[i];
      ctx.strokeStyle = ec.stroke;
      ctx.globalAlpha = ec.opacity;
      ctx.lineWidth = ts(ec.width);
      ctx.beginPath();
      ctx.moveTo(tx(eg.sx), ty(eg.sy));
      ctx.bezierCurveTo(tx(eg.cx1), ty(eg.cy1), tx(eg.cx2), ty(eg.cy2), tx(eg.tx), ty(eg.ty));
      ctx.stroke();

      // Arrow at end
      const arrSize = ts(6);
      const angle = Math.atan2(eg.ty - eg.cy2, eg.tx - eg.cx2);
      const ax = tx(eg.tx), ay = ty(eg.ty);
      ctx.fillStyle = ec.stroke;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - arrSize * Math.cos(angle - 0.4), ay - arrSize * Math.sin(angle - 0.4));
      ctx.lineTo(ax - arrSize * Math.cos(angle + 0.4), ay - arrSize * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Particles
    for (const [linkIdx, state] of edgeParticles) {
      const pathEl = pathElements[linkIdx];
      if (!pathEl || !state.particles) continue;
      const totalLen = getPathLen(linkIdx);
      if (totalLen === 0) continue;

      for (const p of state.particles) {
        const pt = pathEl.getPointAtLength(p.dist);
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(tx(pt.x), ty(pt.y), ts(PARTICLE_RADIUS), 0, Math.PI * 2);
        ctx.fill();

        const tailDist = p.dist - 12;
        if (tailDist > 0) {
          const tpt = pathEl.getPointAtLength(tailDist);
          ctx.globalAlpha = 0.35;
          ctx.beginPath();
          ctx.arc(tx(tpt.x), ty(tpt.y), ts(PARTICLE_RADIUS * 0.6), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;

    // Nodes
    for (const n of nodes) {
      const r = R(n);
      const cx = tx(n.x), cy = ty(n.y);
      const color = DC[n.domain] || '#555';
      const highlighted = nodeHighlight[n.id];

      // Background circle (blocks edges visually)
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.arc(cx, cy, ts(r + 4), 0, Math.PI * 2);
      ctx.fill();

      // Outer ring
      ctx.strokeStyle = highlighted ? '#ffffff' : color;
      ctx.lineWidth = ts(highlighted ? 2.5 : 2);
      ctx.fillStyle = color + '15';
      ctx.beginPath();
      ctx.arc(cx, cy, ts(r), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Inner dot
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, ts(Math.max(4, r * 0.25)), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Label
      ctx.fillStyle = '#afafaf';
      ctx.font = `600 ${ts(12)}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(n.id, cx, cy + ts(r + 18));

      // Channel count badge
      const ch = (n.pubCount || 0) + (n.subCount || 0);
      if (ch > 0) {
        ctx.fillStyle = '#6b6b6b';
        ctx.font = `600 ${ts(10)}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText(ch, cx + ts(r + 8), cy + ts(-r + 4));
      }
    }
  }

  // Initial draw
  function fitView() {
    const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
    const pd = 100;
    const x0 = Math.min(...xs) - pd, x1 = Math.max(...xs) + pd;
    const y0 = Math.min(...ys) - pd, y1 = Math.max(...ys) + pd;
    const bw = x1 - x0, bh = y1 - y0;
    const sc = Math.min(W / bw, H / bh, 1.2) * 0.92;
    const tvx = W / 2 - (x0 + bw / 2) * sc, tvy = H / 2 - (y0 + bh / 2) * sc;
    const t = d3.zoomIdentity.translate(tvx, tvy).scale(sc);
    d3.select(canvas).call(zoomBehavior.transform, t);
  }
  fitView();

  // ===== HIT TESTING =====
  let hoveredNode = null;
  let dragNode = null;
  let dragStartX = 0, dragStartY = 0;

  function nodeAtPoint(mx, my) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = mx - tx(n.x), dy = my - ty(n.y);
      if (dx * dx + dy * dy < ts(R(n) + 4) ** 2) return n;
    }
    return null;
  }

  function linkAtPoint(mx, my) {
    for (let i = 0; i < links.length; i++) {
      const eg = edgeGeos[i];
      if (!eg) continue;
      const pathEl = pathElements[i];
      const totalLen = getPathLen(i);
      for (let d = 0; d < totalLen; d += 8) {
        const pt = pathEl.getPointAtLength(d);
        const dx = mx - tx(pt.x), dy = my - ty(pt.y);
        if (dx * dx + dy * dy < (ts(6)) ** 2) return { link: links[i], index: i };
      }
    }
    return null;
  }

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;

    if (dragNode) {
      dragNode.x += (e.clientX - dragStartX) / tf.k;
      dragNode.y += (e.clientY - dragStartY) / tf.k;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      rebuildEdgeGeometry();
      drawFrame();
      return;
    }

    const n = nodeAtPoint(mx, my);
    canvas.style.cursor = n ? 'pointer' : 'default';

    if (n !== hoveredNode) {
      hoveredNode = n;
      if (!playbackActive) {
        if (n) {
          links.forEach((l, i) => {
            const connected = lid(l, 'source') === n.id || lid(l, 'target') === n.id;
            edgeColors[i] = connected
              ? { stroke: DC[n.domain] || '#888', opacity: 0.9, width: Math.min(1.5 + (l.topics?.length || 1) * 0.4, 3.5) }
              : { stroke: '#1a1a1a', opacity: 0.15, width: 0.3 };
          });
        } else {
          links.forEach((l, i) => {
            edgeColors[i] = { stroke: '#333333', opacity: 0.6, width: Math.min(0.8 + (l.topics?.length || 1) * 0.35, 2.5) };
          });
        }
        drawFrame();
      }
    }

    if (n) {
      showNodeTT(e, n);
    } else {
      const lh = linkAtPoint(mx, my);
      if (lh) { showLinkTT(e, lh.link, lh.index); }
      else { tooltip.style('display', 'none'); }
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const n = nodeAtPoint(e.clientX - rect.left, e.clientY - rect.top);
    if (n) {
      dragNode = n;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      canvas.style.cursor = 'grabbing';
      e.stopPropagation();
    }
  });

  canvas.addEventListener('mouseup', () => {
    if (dragNode) {
      dragNode = null;
      canvas.style.cursor = 'pointer';
    }
  });

  canvas.addEventListener('mouseleave', () => {
    tooltip.style('display', 'none');
    hoveredNode = null;
    if (!playbackActive) {
      links.forEach((l, i) => {
        edgeColors[i] = { stroke: '#333333', opacity: 0.6, width: Math.min(0.8 + (l.topics?.length || 1) * 0.35, 2.5) };
      });
      drawFrame();
    }
  });

  canvas.addEventListener('dblclick', (e) => {
    const rect = canvas.getBoundingClientRect();
    const n = nodeAtPoint(e.clientX - rect.left, e.clientY - rect.top);
    if (n && opts.onNodeDetail) {
      e.stopPropagation();
      opts.onNodeDetail(n.id);
    }
  });

  function rebuildEdgeGeometry() {
    links.forEach((l, i) => {
      const eg = edgeGeometry(l, i);
      edgeGeos[i] = eg;
      if (eg && pathElements[i]) {
        pathElements[i].setAttribute('d', `M${eg.sx},${eg.sy} C${eg.cx1},${eg.cy1} ${eg.cx2},${eg.cy2} ${eg.tx},${eg.ty}`);
      }
    });
    pathLenCache.clear();
  }

  // ===== TOOLTIPS =====
  const lid = (l, f) => { const v = l[f]; return typeof v === 'string' ? v : v?.id; };

  function posTT(ev) {
    tooltip.style('left', Math.min(ev.clientX + 14, window.innerWidth - 440) + 'px')
      .style('top', Math.min(ev.clientY - 6, window.innerHeight - 300) + 'px');
  }

  function showNodeTT(ev, d) {
    const out = links.filter(l => lid(l, 'source') === d.id);
    const inp = links.filter(l => lid(l, 'target') === d.id);
    const dc = DC[d.domain] || '#888';
    let h = `<div class="tt-header" style="border-left-color:${dc}"><span class="tt-name">${d.id}</span><span class="tt-badge">${d.runtime}</span></div>`;
    h += `<div class="tt-domain" style="color:${dc}">${DOMAINS[d.domain]?.label || d.domain}</div>`;
    h += `<div class="tt-components">${(d.components || []).join(' · ')}</div>`;
    const ownTopics = d.topics || [];
    if (ownTopics.length > 0) {
      const totalMsgs = ownTopics.reduce((a, t) => a + (t.messageCount || 0), 0);
      h += `<div class="tt-section" style="color:#afafaf">MCAP: ${ownTopics.length} topics · ${totalMsgs.toLocaleString()} msgs</div>`;
      ownTopics.forEach(t => {
        h += `<div class="tt-row"><span class="tt-topic">${t.topic}</span></div>`;
        h += `<div class="tt-proto">${t.schema || ''}${t.hz ? ' <b>' + t.hz + ' Hz</b>' : ''}</div>`;
      });
    }
    if (out.length) { h += `<div class="tt-section tt-pub">→ ${out.length} downstream</div>`; out.forEach(l => { h += `<div class="tt-row"><span class="tt-target">${lid(l, 'target')}</span> (${(l.topics || []).length} topic)</div>`; }); }
    if (inp.length) { h += `<div class="tt-section tt-sub">← ${inp.length} upstream</div>`; inp.forEach(l => { h += `<div class="tt-row"><span class="tt-target">${lid(l, 'source')}</span> (${(l.topics || []).length} topic)</div>`; }); }
    tooltip.html(h).style('display', 'block'); posTT(ev);
  }

  function showLinkTT(ev, d, idx) {
    let h = `<div class="tt-header"><span class="tt-name">${lid(d, 'source')} → ${lid(d, 'target')}</span><span class="tt-badge">${(d.topics?.length || 0)} topic</span></div>`;
    (d.topics || []).forEach(t => {
      const status = edgeStatus[idx];
      const freqStr = status ? `<b style="color:${STATUS_COLORS[status.level]?.edge || '#fff'}">${status.actualHz.toFixed(1)} / ${t.hz} Hz</b>` : `<b>${t.hz} Hz</b>`;
      h += `<div class="tt-row"><span class="tt-topic">${t.topic}</span></div>`;
      h += `<div class="tt-proto">${t.schema || ''} ${freqStr}</div>`;
    });
    tooltip.html(h).style('display', 'block'); posTT(ev);
  }

  // ===== PLAYBACK =====
  function updatePlayback(frameData) {
    const { topicFreqs, warmup } = frameData;
    playbackActive = true;

    const activeNodes = new Set();

    links.forEach((l, i) => {
      const linkTopics = l.topics || [];
      let totalActualHz = 0, worstLevel = 'ok', maxHz = 0, maxDesign = 0;

      for (const t of linkTopics) {
        const actualHz = topicFreqs[t.topic] ?? -1;
        const designHz = t.hz || topicDesignHz[t.topic] || 1;
        if (actualHz < 0) continue;
        totalActualHz += actualHz;
        maxHz = Math.max(maxHz, actualHz);
        maxDesign = Math.max(maxDesign, designHz);

        if (!warmup) {
          const ratio = designHz > 0 ? actualHz / designHz : 1;
          let level = 'ok';
          if (actualHz === 0) level = 'dead';
          else if (ratio < 0.5) level = 'error';
          else if (ratio < 0.8) level = 'warn';
          if (level === 'dead' || (level === 'error' && worstLevel !== 'dead') ||
            (level === 'warn' && worstLevel === 'ok')) worstLevel = level;
        }
      }

      const hasData = totalActualHz > 0;
      edgeStatus[i] = hasData ? { level: worstLevel, actualHz: maxHz, designHz: maxDesign } : null;
      const colors = hasData ? STATUS_COLORS[worstLevel] : null;

      edgeColors[i] = {
        stroke: hasData ? colors.edge : '#282828',
        opacity: hasData ? 0.8 : 0.35,
        width: hasData ? Math.min(1.2 + linkTopics.length * 0.3, 3) : 0.8,
      };

      if (hasData) { activeNodes.add(lid(l, 'source')); activeNodes.add(lid(l, 'target')); }

      const edgeHz = warmup ? (maxDesign || maxHz || 5) : maxHz;
      if (hasData && colors?.particle && edgeHz > 0) {
        if (!edgeParticles.has(i)) edgeParticles.set(i, { particles: [], spawnDist: 0 });
        const state = edgeParticles.get(i);
        const pxPerFrame = Math.max(1, (edgeHz * PARTICLE_SPACING) / 60);
        state.pxPerFrame = pxPerFrame;
        state.spawnDist += pxPerFrame;
        while (state.spawnDist >= PARTICLE_SPACING) {
          state.spawnDist -= PARTICLE_SPACING;
          state.particles.push({ dist: 0, color: colors.particle });
        }
      } else if (!hasData) {
        edgeParticles.delete(i);
      }
    });

    // Move particles
    for (const [linkIdx, state] of edgeParticles) {
      const totalLen = getPathLen(linkIdx);
      const pxPerFrame = state.pxPerFrame || 4;
      for (let j = state.particles.length - 1; j >= 0; j--) {
        state.particles[j].dist += pxPerFrame;
        if (state.particles[j].dist >= totalLen) { state.particles.splice(j, 1); }
      }
      const maxP = Math.ceil(totalLen / PARTICLE_SPACING) + 2;
      while (state.particles.length > maxP) state.particles.shift();
    }

    // Update node highlights
    for (const n of nodes) nodeHighlight[n.id] = activeNodes.has(n.id);

    drawFrame();
  }

  function stopPlayback() {
    playbackActive = false;
    edgeParticles.clear();
    links.forEach((l, i) => {
      edgeColors[i] = { stroke: '#333333', opacity: 0.6, width: Math.min(0.8 + (l.topics?.length || 1) * 0.35, 2.5) };
    });
    for (const n of nodes) nodeHighlight[n.id] = false;
    drawFrame();
  }

  function setActiveTopics(topics) {
    updatePlayback({ activeTopics: topics, topicFreqs: {} });
  }

  return {
    resetView() { fitView(); },
    toggleLabels() { /* labels always drawn in canvas */ },
    setActiveTopics,
    updatePlayback,
    stopPlayback,
    clearActive: stopPlayback,
    getTopicDesignHz: () => topicDesignHz,
    destroy() { stopPlayback(); canvas.remove(); hiddenSvg.remove(); tooltip.remove(); },
  };
}
