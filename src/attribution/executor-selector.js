/**
 * Executor Selector with DAG Visualization.
 *
 * For multi-executor processes: renders an SVG directed graph showing
 * executor nodes and their data dependencies. Each node has a checkbox.
 * For single-executor processes: degrades to a compact text display.
 *
 * Uses d3 for SVG rendering (already a project dependency).
 */

import * as d3 from 'd3';
import nexisConfig from '../nexis-config.json';

const LIB_DIR = '/home/caros/cyberrt/lib';

const NODE_W = 180;
const NODE_H = 64;
const LAYER_GAP_X = 80;
const NODE_GAP_Y = 30;
const PAD = 24;

export function getProcessExecutors(nodeId) {
  return nexisConfig.processExecutors?.[nodeId] || [];
}

export function getExecutorDependencies(nodeId) {
  return nexisConfig.executorDependencies?.[nodeId] || [];
}

function shortClassName(cls) {
  return cls
    .replace(/NexisExecutor$/, '')
    .replace(/Executor$/, '')
    .replace(/^Neo/, '');
}

function shortTopic(t) {
  if (!t) { return ''; }
  const parts = t.split('/').filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : t;
}

function truncateSvgText(textEl, maxWidth) {
  if (!textEl || !textEl.getComputedTextLength) { return; }
  const original = textEl.textContent;
  if (textEl.getComputedTextLength() <= maxWidth) { return; }
  for (let len = original.length - 1; len > 0; len--) {
    textEl.textContent = original.slice(0, len) + '..';
    if (textEl.getComputedTextLength() <= maxWidth) { return; }
  }
}

function topoSort(executors, deps) {
  const inDeg = {};
  const adj = {};
  for (const ex of executors) {
    inDeg[ex.className] = 0;
    adj[ex.className] = [];
  }
  for (const d of deps) {
    if (inDeg[d.to] !== undefined && adj[d.from] !== undefined) {
      adj[d.from].push(d.to);
      inDeg[d.to]++;
    }
  }
  const queue = Object.keys(inDeg).filter(k => inDeg[k] === 0);
  const order = [];
  const visited = new Set();
  while (queue.length > 0) {
    const n = queue.shift();
    if (visited.has(n)) { continue; }
    visited.add(n);
    order.push(n);
    for (const next of (adj[n] || [])) {
      inDeg[next]--;
      if (inDeg[next] <= 0 && !visited.has(next)) {
        queue.push(next);
      }
    }
  }
  for (const ex of executors) {
    if (!visited.has(ex.className)) {
      order.push(ex.className);
    }
  }
  return order;
}

function assignLayers(executors, deps) {
  const order = topoSort(executors, deps);
  const depSet = new Set(deps.map(d => `${d.from}->${d.to}`));
  const layer = {};
  for (const cls of order) {
    let maxParentLayer = -1;
    for (const d of deps) {
      if (d.to === cls && layer[d.from] !== undefined) {
        maxParentLayer = Math.max(maxParentLayer, layer[d.from]);
      }
    }
    layer[cls] = maxParentLayer + 1;
  }
  return layer;
}

export function createExecutorSelector(container, nodeId, onChange) {
  const executors = getProcessExecutors(nodeId);
  const deps = getExecutorDependencies(nodeId);
  // Single-select: only one executor can be active at a time (radio behavior)
  let selectedClass = executors.length > 0 ? executors[executors.length - 1].className : null;

  const el = document.createElement('div');
  el.className = 'exec-selector';
  container.appendChild(el);

  if (executors.length <= 1) {
    const ex = executors[0];
    if (ex) {
      el.innerHTML = `<div class="exec-single">
        <span class="exec-single-name">${ex.className}</span>
        <span class="exec-single-lib">${ex.libName}</span>
        <span class="exec-single-io">${ex.inputs.length} in → ${ex.outputs.length} out</span>
      </div>`;
    }
    return {
      getSelected: () => executors,
      getSelectedClassNames: () => new Set(executors.map(e => e.className)),
      isSingleExecutor: () => true,
      destroy: () => { el.remove(); },
    };
  }

  function render() {
    el.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'exec-header';
    const selLabel = selectedClass ? '1' : '0';
    header.innerHTML = `
      <span class="exec-title">Executors</span>
      <span class="exec-count">${selLabel} / ${executors.length} selected</span>
      <button class="exec-btn" id="exec-none">Deselect</button>
    `;
    el.appendChild(header);

    header.querySelector('#exec-none').addEventListener('click', () => {
      selectedClass = null;
      render();
      if (onChange) { onChange([]); }
    });

    const layers = assignLayers(executors, deps);
    const maxLayer = Math.max(0, ...Object.values(layers));

    const layerBuckets = [];
    for (let i = 0; i <= maxLayer; i++) {
      layerBuckets.push(executors.filter(e => layers[e.className] === i));
    }

    const maxBucketSize = Math.max(1, ...layerBuckets.map(b => b.length));
    const svgW = (maxLayer + 1) * (NODE_W + LAYER_GAP_X) + PAD * 2;
    const svgH = maxBucketSize * (NODE_H + NODE_GAP_Y) + PAD * 2;

    const positions = {};
    for (let li = 0; li <= maxLayer; li++) {
      const bucket = layerBuckets[li];
      const totalH = bucket.length * NODE_H + (bucket.length - 1) * NODE_GAP_Y;
      const startY = (svgH - totalH) / 2;
      bucket.forEach((ex, idx) => {
        positions[ex.className] = {
          x: PAD + li * (NODE_W + LAYER_GAP_X),
          y: startY + idx * (NODE_H + NODE_GAP_Y),
        };
      });
    }

    const svgContainer = document.createElement('div');
    svgContainer.className = 'exec-dag-container';
    el.appendChild(svgContainer);

    const svg = d3.select(svgContainer).append('svg')
      .attr('width', svgW)
      .attr('height', svgH)
      .attr('class', 'exec-dag-svg');

    svg.append('defs').append('marker')
      .attr('id', 'exec-arrow')
      .attr('viewBox', '0 -4 8 8')
      .attr('refX', 8)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-3L8,0L0,3')
      .attr('class', 'exec-arrow-path');

    for (const dep of deps) {
      const from = positions[dep.from];
      const to = positions[dep.to];
      if (!from || !to) { continue; }

      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_H / 2;

      const isBackEdge = from.x >= to.x;
      const midX = (x1 + x2) / 2;

      let pathD;
      if (isBackEdge) {
        const curveY = Math.min(from.y, to.y) - 30;
        pathD = `M${x1},${y1} C${x1 + 40},${curveY} ${x2 - 40},${curveY} ${x2},${y2}`;
      } else {
        pathD = `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`;
      }

      svg.append('path')
        .attr('d', pathD)
        .attr('class', `exec-edge${isBackEdge ? ' exec-edge-back' : ''}`)
        .attr('marker-end', 'url(#exec-arrow)');

      const labelX = (x1 + x2) / 2;
      const labelY = isBackEdge ? Math.min(from.y, to.y) - 16 : (y1 + y2) / 2 - 8;
      svg.append('text')
        .attr('x', labelX)
        .attr('y', labelY)
        .attr('text-anchor', 'middle')
        .attr('class', 'exec-edge-label')
        .text(shortTopic(dep.topic));
    }

    for (const ex of executors) {
      const pos = positions[ex.className];
      if (!pos) { continue; }
      const isSelected = selectedClass === ex.className;

      const g = svg.append('g')
        .attr('transform', `translate(${pos.x},${pos.y})`)
        .attr('class', `exec-node${isSelected ? ' exec-node-selected' : ' exec-node-dim'}`)
        .style('cursor', 'pointer');

      g.append('rect')
        .attr('width', NODE_W)
        .attr('height', NODE_H)
        .attr('rx', 6)
        .attr('ry', 6)
        .attr('class', 'exec-node-bg');

      const cbSize = 12;
      const cbX = 8;
      const cbY = (NODE_H - cbSize) / 2;
      g.append('rect')
        .attr('x', cbX)
        .attr('y', cbY)
        .attr('width', cbSize)
        .attr('height', cbSize)
        .attr('rx', 2)
        .attr('class', `exec-node-cb${isSelected ? ' exec-node-cb-checked' : ''}`);

      if (isSelected) {
        g.append('path')
          .attr('d', `M${cbX + 2},${cbY + 6}L${cbX + 5},${cbY + 9}L${cbX + 10},${cbY + 3}`)
          .attr('class', 'exec-node-check');
      }

      const textX = cbX + cbSize + 8;
      const maxTextW = NODE_W - textX - 6;

      g.append('text')
        .attr('x', textX)
        .attr('y', 22)
        .attr('class', 'exec-node-name')
        .text(shortClassName(ex.className))
        .each(function() { truncateSvgText(this, maxTextW); });

      g.append('text')
        .attr('x', textX)
        .attr('y', 38)
        .attr('class', 'exec-node-lib')
        .text(`${ex.inputs.length} in → ${ex.outputs.length} out`);

      g.append('text')
        .attr('x', textX)
        .attr('y', 52)
        .attr('class', 'exec-node-lib')
        .text(ex.libName.replace('lib', '').replace('.so', ''))
        .each(function() { truncateSvgText(this, maxTextW); });

      g.on('click', () => {
        selectedClass = selectedClass === ex.className ? null : ex.className;
        render();
        const sel = selectedClass ? executors.filter(e => e.className === selectedClass) : [];
        if (onChange) { onChange(sel); }
      });
    }
  }

  render();

  return {
    getSelected: () => selectedClass ? executors.filter(e => e.className === selectedClass) : [],
    getSelectedClassNames: () => selectedClass ? new Set([selectedClass]) : new Set(),
    isSingleExecutor: () => false,
    destroy: () => { el.remove(); },
  };
}
