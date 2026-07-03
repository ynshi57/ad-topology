/**
 * Unit tests for createSplitter, focused on the behaviour the Node Detail
 * "View Message" panels rely on: a panel can own a resize handle inserted
 * directly after it (no explicit panelB), and dragging clamps the size.
 *
 * Uses a minimal DOM stub so it can run under plain Node (no jsdom).
 */
import { strict as assert } from 'assert';

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  contains(c) { return this.set.has(c); }
}

function makeEl() {
  const el = {
    className: '',
    classList: new FakeClassList(),
    style: {},
    parentNode: null,
    children: [],
    handlers: {},
    _w: 0,
    _h: 0,
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const arr = this.handlers[type];
      if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
    },
    remove() {
      if (this.parentNode) {
        const i = this.parentNode.children.indexOf(this);
        if (i >= 0) this.parentNode.children.splice(i, 1);
        this.parentNode = null;
      }
    },
    insertBefore(node, ref) {
      node.parentNode = this;
      if (ref == null) {
        this.children.push(node);
      } else {
        const i = this.children.indexOf(ref);
        if (i < 0) { this.children.push(node); } else { this.children.splice(i, 0, node); }
      }
      return node;
    },
    getBoundingClientRect() { return { width: this._w, height: this._h }; },
  };
  Object.defineProperty(el, 'nextSibling', {
    get() {
      if (!this.parentNode) { return null; }
      const i = this.parentNode.children.indexOf(this);
      return this.parentNode.children[i + 1] || null;
    },
  });
  return el;
}

function installDom() {
  const docHandlers = {};
  globalThis.document = {
    body: { style: {} },
    createElement: () => makeEl(),
    addEventListener(type, fn) { (docHandlers[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const arr = docHandlers[type];
      if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
    },
    _fire(type, evt) { (docHandlers[type] || []).slice().forEach(fn => fn(evt)); },
  };
  globalThis.window = { dispatchEvent() { return true; } };
  globalThis.Event = class { constructor(type) { this.type = type; } };
  return globalThis.document;
}

function makeParentWith(...kids) {
  const parent = makeEl();
  for (const k of kids) { parent.insertBefore(k, null); }
  return parent;
}

const doc = installDom();
const { createSplitter } = await import('../src/splitter.js');

const order = (parent) => parent.children;

// Case 1: explicit panelB -> handle inserted between A and B.
{
  const a = makeEl(); const b = makeEl();
  const parent = makeParentWith(a, b);
  const { el } = createSplitter(a, b, { direction: 'horizontal' });
  assert.equal(order(parent).indexOf(el), 1, 'handle should sit between panelA and panelB');
  assert.equal(order(parent).indexOf(el), order(parent).indexOf(a) + 1, 'handle should follow panelA');
}

// Case 2 (the regression target): no panelB, panelA has a following sibling.
// The handle MUST land directly after panelA, not at the end of the row.
{
  const a = makeEl(); const other = makeEl();
  const parent = makeParentWith(a, other);
  const { el } = createSplitter(a, null, { direction: 'horizontal' });
  assert.equal(order(parent).indexOf(el), order(parent).indexOf(a) + 1, 'handle should be right after panelA when panelB omitted');
  assert.ok(order(parent).indexOf(el) < order(parent).indexOf(other), 'handle should be before the following sibling');
}

// Case 3: no panelB, panelA is the last child -> handle appended at the end.
{
  const x = makeEl(); const a = makeEl();
  const parent = makeParentWith(x, a);
  const { el } = createSplitter(a, null, { direction: 'horizontal' });
  assert.equal(order(parent).indexOf(el), order(parent).length - 1, 'handle should append after a trailing panelA');
  assert.equal(order(parent).indexOf(el), order(parent).indexOf(a) + 1, 'handle should still follow panelA');
}

// Case 4: dragging clamps the resized width to [min, max].
{
  const a = makeEl(); const b = makeEl();
  a._w = 340;
  makeParentWith(a, b);
  const { el } = createSplitter(a, b, { direction: 'horizontal', min: 200, max: 600 });

  el.handlers.mousedown[0]({ preventDefault() {}, clientX: 100, clientY: 0 });
  doc._fire('mousemove', { clientX: 5000, clientY: 0 });
  assert.equal(a.style.width, '600px', 'width should clamp to max');
  doc._fire('mouseup', {});

  el.handlers.mousedown[0]({ preventDefault() {}, clientX: 100, clientY: 0 });
  doc._fire('mousemove', { clientX: -5000, clientY: 0 });
  assert.equal(a.style.width, '200px', 'width should clamp to min');
  doc._fire('mouseup', {});
}

console.log('splitter tests passed');
