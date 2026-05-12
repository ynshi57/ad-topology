import { spawn } from 'child_process';

const PORT = 18765;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer(proc) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (proc.exitCode !== null) {
      throw new Error(`server exited early with code ${proc.exitCode}`);
    }
    try {
      const res = await fetch(BASE);
      if (res.ok) {
        return;
      }
    } catch {
      // Server not listening yet.
    }
    await sleep(200);
  }
  throw new Error('server did not become ready within 10s');
}

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertAnalysisShape(json) {
  assert(json.model === 'yolo11x', 'expected model=yolo11x');
  assert(json.files?.pt?.bytes > 1024, 'expected pt file size');
  assert(json.files?.onnx?.bytes > 1024, 'expected onnx file size');
  assert(json.netronUrl === '/netron/yolo11x/', 'expected netronUrl');
  assert(json.onnx?.irVersion, 'expected ONNX irVersion');
  assert(Array.isArray(json.onnx?.opsets) && json.onnx.opsets.length > 0, 'expected ONNX opsets');
  assert(Array.isArray(json.graph?.inputs), 'expected graph inputs');
  assert(Array.isArray(json.graph?.outputs), 'expected graph outputs');
  assert(Array.isArray(json.operators?.top) && json.operators.top.length > 0, 'expected top operators');
  assert(typeof json.health?.load?.ok === 'boolean', 'expected load health');
  assert(typeof json.health?.checker?.ok === 'boolean', 'expected checker health');
  assert(typeof json.health?.shapeInference?.ok === 'boolean', 'expected shape inference health');
}

async function main() {
  const proc = spawn('node', ['server/index.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, WS_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', chunk => { output += chunk.toString(); });
  proc.stderr.on('data', chunk => { output += chunk.toString(); });

  try {
    await waitForServer(proc);

    const bad = await postJson('/model-analyze', { model: 'bad-model' });
    assert(bad.res.status === 400, `invalid model should return 400, got ${bad.res.status}`);
    assert(Array.isArray(bad.json.allowed), 'invalid model response should include allowed models');

    const good = await postJson('/model-analyze', { model: 'yolo11x' });
    assert(good.res.status === 200, `analysis should return 200, got ${good.res.status}: ${JSON.stringify(good.json)}`);
    assertAnalysisShape(good.json);

    console.log('model-analyze endpoint tests passed');
  } finally {
    proc.kill('SIGTERM');
    await sleep(300);
    if (proc.exitCode === null) {
      proc.kill('SIGKILL');
    }
  }

  if (output.includes('EADDRINUSE')) {
    throw new Error(output);
  }
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
