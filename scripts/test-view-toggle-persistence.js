import { readFileSync } from 'fs';

const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function extractFunction(name) {
  const start = src.indexOf(`function ${name}(`);
  assert(start >= 0, `missing function ${name}`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') {
      depth++;
    } else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(start, i + 1);
      }
    }
  }
  throw new Error(`could not parse function ${name}`);
}

function extractListener(buttonId) {
  const marker = `getElementById('${buttonId}').addEventListener('click', () => {`;
  const start = src.indexOf(marker);
  assert(start >= 0, `missing listener for ${buttonId}`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') {
      depth++;
    } else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(start, i + 1);
      }
    }
  }
  throw new Error(`could not parse listener for ${buttonId}`);
}

const updateVisibility = extractFunction('updateMainAreaVisibility');
const btn3d = extractListener('btn-3d');
const btnCamera = extractListener('btn-camera');

for (const [name, block] of [
  ['updateMainAreaVisibility', updateVisibility],
  ['btn-3d listener', btn3d],
  ['btn-camera listener', btnCamera],
]) {
  assert(!/current3DScene\.destroy\(\)/.test(block), `${name} must not destroy the 3D scene`);
  assert(!/current3DTopics\.destroy\(\)/.test(block), `${name} must not destroy the 3D topics panel`);
  assert(!/currentCameraPanel\.destroy\(\)/.test(block), `${name} must not destroy the Camera panel`);
}

assert(/if \(show3D && !current3DScene\)/.test(btn3d), '3D listener should lazily create the 3D panel');
assert(/if \(showCamera && !currentCameraPanel\)/.test(btnCamera), 'Camera listener should lazily create the Camera panel');

console.log('view toggle persistence checks passed');
