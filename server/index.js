/**
 * WebSocket proxy server for executor harness.
 * Spawns the C++ executor_harness process, proxies JSON messages between
 * the frontend WebSocket client and the C++ stdin/stdout.
 */

import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import { createServer } from 'http';
import { dirname, join, resolve as pathResolve, isAbsolute, basename } from 'path';
import { existsSync, statSync, readFileSync, createReadStream } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_BIN = join(__dirname, '..', 'backend', 'build', 'executor_harness');
const RECORD2MCAP_BIN_CANDIDATES = [
  // Combined backend build (CMake add_subdirectory layout).
  join(__dirname, '..', 'backend', 'build', 'record2mcap', 'record2mcap'),
  // Stand-alone record2mcap build directory.
  join(__dirname, '..', 'backend', 'record2mcap', 'build', 'record2mcap'),
];
const PORT = parseInt(process.env.WS_PORT || '8765');

const ENV = {
  ...process.env,
  LD_LIBRARY_PATH: [
    '/home/caros/workspace/gears/x86_64/lib',
    '/home/caros/cyberrt/lib',
    process.env.LD_LIBRARY_PATH || '',
  ].join(':'),
  CYBER_PATH: '/home/caros/cyberrt',
};

const httpServer = createServer(async (req, res) => {
  // CORS headers for frontend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/rebuild-config') {
    try {
      const { execSync } = await import('child_process');
      const scriptPath = join(__dirname, '..', 'scripts', 'build-nexis-config.js');
      const output = execSync(`node ${scriptPath}`, { cwd: join(__dirname, '..'), timeout: 15000 }).toString();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, output }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.url === '/ls-lib') {
    try {
      const { readdirSync } = await import('fs');
      const libDir = '/home/caros/cyberrt/lib';
      const files = readdirSync(libDir).filter(f => f.endsWith('.so'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(files));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.url === '/record2mcap' && req.method === 'POST') {
    await handleRecordToMcap(req, res);
    return;
  }

  if ((req.url === '/file' || req.url?.startsWith('/file?')) && req.method === 'GET') {
    handleFileDownload(req, res);
    return;
  }

  // Proxy endpoint: GET /proxy?url=<encoded_mcap_url>
  if (req.url?.startsWith('/proxy?')) {
    const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const targetUrl = params.get('url');
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing url parameter' }));
      return;
    }

    console.log(`[Proxy] Downloading: ${targetUrl.slice(0, 100)}...`);
    try {
      const response = await fetch(targetUrl);
      if (!response.ok) {
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Remote returned ${response.status}` }));
        return;
      }

      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const contentLength = response.headers.get('content-length');
      const headers = { 'Content-Type': contentType };
      if (contentLength) headers['Content-Length'] = contentLength;
      res.writeHead(200, headers);

      // Stream the response body
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
      console.log(`[Proxy] Done: ${targetUrl.split('/').pop()?.split('?')[0]}`);
    } catch (err) {
      console.error(`[Proxy] Error:`, err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Executor Harness WebSocket Server\n');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');

  let harness = null;
  let lineBuffer = '';

  function spawnHarness() {
    if (harness) return;

    console.log('[Harness] Spawning:', HARNESS_BIN);
    harness = spawn(HARNESS_BIN, [], {
      env: ENV,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    harness.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            ws.send(JSON.stringify(msg));
          } catch {
            ws.send(JSON.stringify({ error: 'Invalid harness output', raw: line }));
          }
        }
      }
    });

    harness.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        console.log('[Harness stderr]', text);
        ws.send(JSON.stringify({ type: 'stderr', message: text }));
      }
    });

    harness.on('exit', (code, signal) => {
      console.log(`[Harness] Exited: code=${code}, signal=${signal}`);
      ws.send(JSON.stringify({ type: 'harness_exit', code, signal }));
      harness = null;
    });

    harness.on('error', (err) => {
      console.error('[Harness] Spawn error:', err.message);
      ws.send(JSON.stringify({ type: 'harness_error', message: err.message }));
      harness = null;
    });
  }

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ error: 'Invalid JSON from client' }));
      return;
    }

    // Handle build command server-side (not forwarded to harness)
    if (msg.cmd === 'build') {
      handleBuild(ws, msg.command);
      return;
    }

    // Auto-spawn harness on first command
    if (!harness) spawnHarness();

    // Forward to harness stdin
    if (harness?.stdin?.writable) {
      harness.stdin.write(JSON.stringify(msg) + '\n');
    } else {
      ws.send(JSON.stringify({ error: 'Harness not available' }));
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
    if (harness) {
      harness.stdin.write('{"cmd":"quit"}\n');
      setTimeout(() => {
        if (harness) { harness.kill('SIGTERM'); harness = null; }
      }, 2000);
    }
  });
});

function handleBuild(ws, command) {
  if (!command) {
    ws.send(JSON.stringify({ cmd: 'build_result', success: false, error: 'No build command' }));
    return;
  }

  console.log('[Build] Executing:', command);
  const startMs = Date.now();

  const proc = spawn('bash', ['-c', command], {
    env: ENV,
    cwd: '/home/caros/workspace',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 600000,
  });

  let stdout = '', stderr = '';

  proc.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    ws.send(JSON.stringify({ type: 'build_output', stream: 'stdout', text: chunk.toString() }));
  });

  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    ws.send(JSON.stringify({ type: 'build_output', stream: 'stderr', text: chunk.toString() }));
  });

  proc.on('close', (code) => {
    const durationMs = Date.now() - startMs;
    console.log(`[Build] Finished: code=${code}, ${durationMs}ms`);
    ws.send(JSON.stringify({
      cmd: 'build_result',
      success: code === 0,
      exit_code: code,
      duration_ms: durationMs,
      stdout: stdout.slice(-2000),
      stderr: stderr.slice(-2000),
      error: code !== 0 ? `Build exited with code ${code}` : undefined,
    }));
  });

  proc.on('error', (err) => {
    ws.send(JSON.stringify({
      cmd: 'build_result',
      success: false,
      error: err.message,
      duration_ms: Date.now() - startMs,
    }));
  });
}

// ---------------------------------------------------------------------------
// Read-only file download endpoint (only serves .mcap / .mcap.report.json
// for the record2mcap round-trip).
// ---------------------------------------------------------------------------

function handleFileDownload(req, res) {
  try {
    const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const requested = params.get('path');
    if (!requested) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path parameter required' }));
      return;
    }
    if (!isAbsolute(requested)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path must be absolute' }));
      return;
    }
    const resolved = pathResolve(requested);
    const isMcap = resolved.toLowerCase().endsWith('.mcap');
    const isReport = resolved.toLowerCase().endsWith('.mcap.report.json');
    if (!isMcap && !isReport) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'only .mcap and .mcap.report.json files may be served',
      }));
      return;
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `file not found: ${resolved}` }));
      return;
    }
    const stat = statSync(resolved);
    const contentType = isReport ? 'application/json'
                                 : 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${basename(resolved)}"`,
      'Cache-Control': 'no-cache',
    });
    const stream = createReadStream(resolved);
    stream.pipe(res);
    stream.on('error', (err) => {
      console.error('[file] stream error:', err.message);
      if (!res.writableEnded) {
        res.end();
      }
    });
  } catch (err) {
    console.error('[file] error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ---------------------------------------------------------------------------
// record2mcap endpoint
// ---------------------------------------------------------------------------

function findRecord2McapBin() {
  for (const candidate of RECORD2MCAP_BIN_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function deriveMcapOutputPath(inputPath) {
  // Accepts `<x>.record`, `<x>.record.NNNNN`, `<x>.record.NNNNN.MMMMM` etc.
  // Produces `<x>.mcap` in the same directory, dropping every `.record[.NNNNN...]`
  // trailing segment.
  const match = inputPath.match(/^(.*?)\.record(?:\.\d+)*$/);
  if (match) {
    return `${match[1]}.mcap`;
  }
  return `${inputPath}.mcap`;
}

function writeJsonLine(res, obj) {
  res.write(JSON.stringify(obj) + '\n');
}

async function handleRecordToMcap(req, res) {
  // Collect request body (JSON).
  let body = '';
  try {
    for await (const chunk of req) {
      body += chunk.toString();
      if (body.length > 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        return;
      }
    }
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Failed to read body: ${err.message}` }));
    return;
  }

  let payload;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
    return;
  }

  const inputPathRaw = payload.inputPath;
  if (typeof inputPathRaw !== 'string' || !inputPathRaw) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'inputPath is required' }));
    return;
  }
  if (!isAbsolute(inputPathRaw)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'inputPath must be absolute' }));
    return;
  }
  const inputPath = pathResolve(inputPathRaw);
  if (!existsSync(inputPath) || !statSync(inputPath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Input not found: ${inputPath}` }));
    return;
  }

  const bin = findRecord2McapBin();
  if (!bin) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'record2mcap binary not built',
      hint: 'Run `cmake -S ad-topology/backend -B ad-topology/backend/build && make -C ad-topology/backend/build -j`',
      searched: RECORD2MCAP_BIN_CANDIDATES,
    }));
    return;
  }

  const outputPath = typeof payload.outputPath === 'string' && payload.outputPath
    ? pathResolve(payload.outputPath)
    : deriveMcapOutputPath(inputPath);
  const reportPath = typeof payload.reportPath === 'string' && payload.reportPath
    ? pathResolve(payload.reportPath)
    : `${outputPath}.report.json`;
  const overwrite = payload.overwrite === true;

  if (!overwrite && existsSync(outputPath)) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: `Output already exists: ${outputPath}`,
      hint: 'Pass overwrite=true in the JSON body to replace it.',
    }));
    return;
  }

  const args = [inputPath, outputPath];
  const compression = payload.compression;
  if (compression && ['none', 'zstd', 'lz4'].includes(compression)) {
    args.push('--compression', compression);
  }
  if (Array.isArray(payload.include) && payload.include.length > 0) {
    args.push('--include', payload.include.join(','));
  }
  if (Array.isArray(payload.exclude) && payload.exclude.length > 0) {
    args.push('--exclude', payload.exclude.join(','));
  }
  if (payload.verify === true) {
    args.push('--verify');
    if (Number.isFinite(payload.verifySamples)) {
      args.push('--verify-samples', String(payload.verifySamples));
    }
  }
  args.push('--report', reportPath);

  console.log('[record2mcap] spawn:', bin, args.join(' '));

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  writeJsonLine(res, {
    type: 'start',
    binary: bin,
    inputPath,
    outputPath,
    reportPath,
    args,
  });

  let child;
  try {
    child = spawn(bin, args, { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    writeJsonLine(res, { type: 'done', ok: false, error: err.message });
    res.end();
    return;
  }

  let killed = false;
  const onClientClose = () => {
    killed = true;
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
  };
  req.on('close', onClientClose);

  const streamLines = (stream, label) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) {
        if (line.length > 0) {
          writeJsonLine(res, { type: 'log', stream: label, line });
        }
      }
    });
    stream.on('end', () => {
      if (buf.length > 0) {
        writeJsonLine(res, { type: 'log', stream: label, line: buf });
      }
    });
  };
  streamLines(child.stdout, 'stdout');
  streamLines(child.stderr, 'stderr');

  child.on('error', (err) => {
    writeJsonLine(res, { type: 'done', ok: false, error: err.message });
    res.end();
  });

  child.on('close', (code, signal) => {
    req.removeListener('close', onClientClose);
    let report = null;
    if (existsSync(reportPath)) {
      try {
        report = JSON.parse(readFileSync(reportPath, 'utf8'));
      } catch (err) {
        writeJsonLine(res, {
          type: 'log',
          stream: 'stderr',
          line: `failed to read report: ${err.message}`,
        });
      }
    }
    writeJsonLine(res, {
      type: 'done',
      ok: code === 0 && !killed,
      killed,
      exitCode: code,
      signal,
      inputPath,
      outputPath,
      reportPath,
      outputExists: existsSync(outputPath),
      outputSizeBytes: existsSync(outputPath) ? statSync(outputPath).size : 0,
      report,
    });
    res.end();
  });
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Executor Harness WS Server listening on ws://0.0.0.0:${PORT}`);
});
