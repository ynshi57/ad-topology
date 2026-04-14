/**
 * WebSocket proxy server for executor harness.
 * Spawns the C++ executor_harness process, proxies JSON messages between
 * the frontend WebSocket client and the C++ stdin/stdout.
 */

import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import { createServer } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_BIN = join(__dirname, '..', 'backend', 'build', 'executor_harness');
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

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Executor Harness WS Server listening on ws://0.0.0.0:${PORT}`);
});
