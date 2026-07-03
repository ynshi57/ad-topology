/**
 * Generic drag-to-resize splitter between two sibling panels.
 *
 * @param {HTMLElement} panelA  — the panel whose size is controlled
 * @param {HTMLElement} panelB  — the panel that fills remaining space (flex:1)
 * @param {Object} opts
 * @param {'horizontal'|'vertical'} opts.direction — horizontal = left/right, vertical = top/bottom
 * @param {number} opts.min  — minimum px for panelA (default 60)
 * @param {number} opts.max  — maximum px for panelA (default 800)
 * @param {boolean} opts.reverse — if true, drag direction is inverted (panelA is on the right/bottom side)
 * @returns {{ el: HTMLElement, destroy: Function }}
 */
export function createSplitter(panelA, panelB, opts = {}) {
  const dir = opts.direction || 'horizontal';
  const isH = dir === 'horizontal';
  const min = opts.min ?? 60;
  const max = opts.max ?? 800;
  const sign = opts.reverse ? -1 : 1;

  const el = document.createElement('div');
  el.className = `splitter ${isH ? 'splitter-h' : 'splitter-v'}`;

  // Insertion reference:
  // - reverse: panelA sits after the handle, so insert the handle before panelA.
  // - panelB given: insert the handle before panelB (between A and B).
  // - panelB omitted: the handle belongs to panelA alone, so insert it directly
  //   after panelA (panelA.nextSibling), or append when panelA is last. This
  //   lets each panel own a resize handle even with no flex sibling.
  const insertRef = opts.reverse ? panelA : (panelB || panelA.nextSibling);
  panelA.parentNode.insertBefore(el, insertRef);

  let startPos = 0;
  let startSize = 0;
  let dragging = false;

  function onMouseDown(e) {
    e.preventDefault();
    dragging = true;
    startPos = isH ? e.clientX : e.clientY;
    startSize = isH ? panelA.getBoundingClientRect().width : panelA.getBoundingClientRect().height;
    el.classList.add('dragging');
    document.body.style.cursor = isH ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e) {
    if (!dragging) {
      return;
    }
    const currentPos = isH ? e.clientX : e.clientY;
    const delta = (currentPos - startPos) * sign;
    let newSize = startSize + delta;
    if (newSize < min) {
      newSize = min;
    }
    if (newSize > max) {
      newSize = max;
    }
    if (isH) {
      panelA.style.width = newSize + 'px';
    } else {
      panelA.style.height = newSize + 'px';
    }
  }

  function onMouseUp() {
    dragging = false;
    el.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    window.dispatchEvent(new Event('resize'));
  }

  el.addEventListener('mousedown', onMouseDown);

  function destroy() {
    el.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    el.remove();
  }

  return { el, destroy };
}
