/**
 * Flamegraph renderer using d3-flame-graph.
 * Parses folded stacks text and renders an interactive flame graph into a DOM container.
 *
 * Registers itself as window.__renderFlamegraph so stages can call it without
 * circular import issues (S5 stage -> renderer -> d3 dependency).
 */

import d3Flamegraph from 'd3-flame-graph';

function parseFoldedStacks(text) {
  const lines = text.trim().split('\n');
  const root = { name: 'root', value: 0, children: [] };

  for (const line of lines) {
    if (!line) {
      continue;
    }
    const lastSpace = line.lastIndexOf(' ');
    if (lastSpace < 0) {
      continue;
    }
    const stack = line.slice(0, lastSpace);
    const count = parseInt(line.slice(lastSpace + 1), 10) || 0;
    const frames = stack.split(';');

    let node = root;
    for (const frame of frames) {
      let child = node.children.find(c => c.name === frame);
      if (!child) {
        child = { name: frame, value: 0, children: [] };
        node.children.push(child);
      }
      child.value += count;
      node = child;
    }
    root.value += count;
  }

  return root;
}

export function renderFlamegraph(container, foldedStacks) {
  if (!container || !foldedStacks) {
    return;
  }

  container.innerHTML = '';
  const data = parseFoldedStacks(foldedStacks);

  if (data.value === 0) {
    container.textContent = 'No samples collected';
    return;
  }

  const width = container.clientWidth || 800;
  const flamegraphFn = d3Flamegraph.flamegraph || d3Flamegraph;
  const chart = flamegraphFn()
    .width(width)
    .cellHeight(18)
    .transitionDuration(300)
    .minFrameSize(2)
    .selfValue(false);

  const sel = document.createElement('div');
  container.appendChild(sel);

  try {
    const d3 = { select: null };
    import('d3-selection').then(mod => {
      d3.select = mod.select;
      d3.select(sel).datum(data).call(chart);
    }).catch(() => {
      sel.innerHTML = `<pre style="font-size:11px;max-height:400px;overflow:auto">${foldedStacks.slice(0, 5000)}</pre>`;
    });
  } catch {
    sel.innerHTML = `<pre style="font-size:11px;max-height:400px;overflow:auto">${foldedStacks.slice(0, 5000)}</pre>`;
  }
}

window.__renderFlamegraph = renderFlamegraph;
