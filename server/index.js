/**
 * WebSocket proxy server for executor harness.
 * Spawns the C++ executor_harness process, proxies JSON messages between
 * the frontend WebSocket client and the C++ stdin/stdout.
 */

import { WebSocketServer } from 'ws';
import { spawn, execSync } from 'child_process';
import { createServer } from 'http';
import { dirname, join, resolve as pathResolve, isAbsolute, basename, sep as pathSep, extname } from 'path';
import { existsSync, statSync, readFileSync, readdirSync, createReadStream, mkdirSync, appendFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_BIN = join(__dirname, '..', 'backend', 'build', 'executor_harness');
const LOG_DIR = join(__dirname, '..', 'logs');
const HARNESS_LOG = join(LOG_DIR, 'executor_harness.log');
const RECORD2MCAP_BIN_CANDIDATES = [
  // Combined backend build (CMake add_subdirectory layout).
  join(__dirname, '..', 'backend', 'build', 'record2mcap', 'record2mcap'),
  // Stand-alone record2mcap build directory.
  join(__dirname, '..', 'backend', 'record2mcap', 'build', 'record2mcap'),
];
const STACKCOLLAPSE = join(__dirname, '..', 'tools', 'flamegraph', 'stackcollapse-perf.pl');
const AGENT_OUTPUT_ROOT = join(__dirname, '..', '.agent_output');
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

/**
 * Canonical directory where ad-topology stores all mcap-related artifacts:
 * - URL-Load cached mcaps (.mcap)
 * - record2mcap conversion outputs (.mcap, .mcap.report.json)
 * - YOLO sidecars (.yolo.json) - same basename as the mcap, ".yolo.json" suffix
 *
 * Centralizing the location makes ``/find-mcap`` reliably resolve a basename
 * to a path, simplifies cleanup, and keeps tooling outputs together.
 */
const MCAP_DIR = '/home/caros/workspace/mcap_file';
try {
  mkdirSync(MCAP_DIR, { recursive: true });
} catch (err) {
  console.warn(`[startup] cannot ensure ${MCAP_DIR}:`, err.message);
}
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch (err) {
  console.warn(`[startup] cannot ensure ${LOG_DIR}:`, err.message);
}

// ---------------------------------------------------------------------------
//  In-memory log capture + SSE for in-app Debug Console.
//
//  We monkey-patch console.{log,warn,error,info} so every backend log line
//  is mirrored into a ring buffer, and pushed out to any subscribed SSE
//  client (the in-app Debug Log pane). The original console functions still
//  write to the real stdout/stderr, so tail -f / journal still works.
// ---------------------------------------------------------------------------

const LOG_BUF_MAX = 500;
const logBuffer = [];
const sseClients = new Set();

function formatLogArg(arg) {
  if (typeof arg === 'string') { return arg; }
  if (arg instanceof Error) { return arg.stack || arg.message; }
  try { return JSON.stringify(arg); }
  catch { return String(arg); }
}

function pushLogEntry(level, args) {
  const line = args.map(formatLogArg).join(' ');
  const entry = { ts: Date.now(), level, line };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUF_MAX) { logBuffer.shift(); }
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const r of sseClients) {
    try { r.write(payload); }
    catch { /* dead client; will be cleaned on close */ }
  }
}

const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origErr = console.error.bind(console);
const _origInfo = console.info.bind(console);
console.log = (...a) => { _origLog(...a); pushLogEntry('log', a); };
console.warn = (...a) => { _origWarn(...a); pushLogEntry('warn', a); };
console.error = (...a) => { _origErr(...a); pushLogEntry('error', a); };
console.info = (...a) => { _origInfo(...a); pushLogEntry('info', a); };

function handleServerLogStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  // Replay history first so the client sees what happened before it connected.
  for (const e of logBuffer) {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  }
  // Comment line works as keep-alive for some proxies.
  res.write(': connected\n\n');
  sseClients.add(res);
  const onClose = () => {
    sseClients.delete(res);
    try { res.end(); } catch {}
  };
  req.on('close', onClose);
  req.on('aborted', onClose);
}

/** Strip path separators / parent refs / nul bytes; return basename only. */
function sanitizeBasename(name) {
  if (typeof name !== 'string' || name.length === 0) { return null; }
  // Take only the last path component.
  const base = name.replace(/\\/g, '/').split('/').pop();
  if (!base || base === '.' || base === '..') { return null; }
  // Allow alphanumerics, dot, underscore, hyphen.
  if (!/^[A-Za-z0-9._-]+$/.test(base)) { return null; }
  if (base.length > 200) { return null; }
  return base;
}

const httpServer = createServer(async (req, res) => {
  // CORS headers for frontend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'X-Saved-Path');

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

  if (req.url === '/yolo-detect' && req.method === 'POST') {
    await handleYoloDetect(req, res);
    return;
  }

  if ((req.url === '/file' || req.url?.startsWith('/file?')) && req.method === 'GET') {
    handleFileDownload(req, res);
    return;
  }

  // /find-mcap?name=<basename> -- locate an mcap by basename across known
  // mcap cache directories. Returns { found, path }.
  // Used by the URL Load / Select Files paths to recover the server-side
  // absolute path for tools that need it (YOLO sidecar fetch, etc.).
  if (req.url?.startsWith('/find-mcap?') && req.method === 'GET') {
    handleFindMcap(req, res);
    return;
  }

  // /list-mcaps -- enumerate cached mcaps in MCAP_DIR, group lite/camera
  // pairs by stem, attach YOLO sidecar summary if present. Returns
  // { entries: [{ stem, parts: [{variant, path, size, mtime}], hasSidecar, sidecarSummary }] }.
  if (req.url === '/list-mcaps' && req.method === 'GET') {
    handleListMcaps(req, res);
    return;
  }

  // GET /server-log/stream -- Server-Sent Events stream of backend console
  // output. Used by the in-app Debug Log pane. History is replayed first
  // (up to LOG_BUF_MAX entries) so a late-connecting client still sees
  // prior log lines.
  if (req.url === '/server-log/stream' && req.method === 'GET') {
    handleServerLogStream(req, res);
    return;
  }

  // POST /netron-launch -- make sure the ONNX file for `model` is on disk
  // (lazily exporting via export_onnx.py if missing) and return the
  // same-origin proxy path the frontend should open. NO process spawn:
  // /netron/<model>/* is served directly by Express from the netron
  // python package's static bundle, so this endpoint is purely a "prep
  // the model file" hook. As a result it has no port state, no race
  // conditions, and survives Express restarts trivially.
  if (req.url === '/netron-launch' && req.method === 'POST') {
    await handleNetronLaunch(req, res);
    return;
  }

  // POST /model-analyze -- return a structured static analysis summary for
  // YOLO11 models. This complements Netron's visual graph with machine-readable
  // ONNX metadata, operator counts, file sizes, and lightweight health checks.
  if (req.url === '/model-analyze' && req.method === 'POST') {
    await handleModelAnalyze(req, res);
    return;
  }

  // /netron/<model>/* -- serve Netron's static viewer directly from the
  // installed `netron` python package's bundle directory; /data/<*.onnx>
  // is served from yolo_weights/. No subprocess; nothing to clean up.
  if (req.url?.startsWith('/netron/')) {
    handleNetronStatic(req, res);
    return;
  }

  // Proxy endpoint: GET /proxy?url=<encoded_url>[&save=<basename>]
  // When ``save`` is provided, the streamed content is also written to
  // ``/tmp/ad-topology-cache/<sanitized_basename>``, and the absolute path
  // is reported back to the browser via the ``X-Saved-Path`` response header
  // (exposed via CORS). This lets URL-loaded mcaps reuse the path for
  // server-side tools (YOLO, record2mcap, etc.) without a second upload.
  if (req.url?.startsWith('/proxy?')) {
    const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const targetUrl = params.get('url');
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing url parameter' }));
      return;
    }

    let savePath = null;
    let saveStream = null;
    const saveRaw = params.get('save');
    if (saveRaw) {
      const safe = sanitizeBasename(saveRaw);
      if (!safe) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid save basename' }));
        return;
      }
      try {
        const { createWriteStream } = await import('fs');
        // Always cache into the canonical MCAP_DIR so /find-mcap can resolve
        // it later by basename.
        mkdirSync(MCAP_DIR, { recursive: true });
        savePath = `${MCAP_DIR}/${safe}`;
        saveStream = createWriteStream(savePath);
        res.setHeader('X-Saved-Path', savePath);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Cannot prepare save target: ${err.message}` }));
        return;
      }
    }

    console.log(
      `[Proxy] Downloading: ${targetUrl.slice(0, 100)}...`
      + (savePath ? ` (-> ${savePath})` : ''),
    );
    try {
      const response = await fetch(targetUrl);
      if (!response.ok) {
        if (saveStream) {
          saveStream.destroy();
          try {
            const { unlinkSync } = await import('fs');
            unlinkSync(savePath);
          } catch {}
        }
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Remote returned ${response.status}` }));
        return;
      }

      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const contentLength = response.headers.get('content-length');
      const headers = { 'Content-Type': contentType };
      if (contentLength) { headers['Content-Length'] = contentLength; }
      res.writeHead(200, headers);

      // Stream the response body to both the HTTP response and (optionally)
      // the temp file.
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }
        res.write(value);
        if (saveStream) { saveStream.write(value); }
      }
      res.end();
      if (saveStream) {
        await new Promise((r) => saveStream.end(r));
      }
      console.log(`[Proxy] Done: ${targetUrl.split('/').pop()?.split('?')[0]}`);
    } catch (err) {
      console.error('[Proxy] Error:', err.message);
      if (saveStream) {
        try { saveStream.destroy(); } catch {}
        try {
          const { unlinkSync } = await import('fs');
          unlinkSync(savePath);
        } catch {}
      }
      // If the response hasn't been started yet, return JSON; otherwise just
      // close the connection.
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        res.end();
      }
    }
    return;
  }

  if (req.url === '/perf-sample' && req.method === 'POST') {
    await handlePerfSample(req, res);
    return;
  }

  if (req.url === '/perf-start' && req.method === 'POST') {
    await handlePerfStart(req, res);
    return;
  }

  if (req.url === '/perf-stop' && req.method === 'POST') {
    await handlePerfStop(req, res);
    return;
  }

  if (req.url === '/agent-output-write' && req.method === 'POST') {
    await handleAgentOutputWrite(req, res);
    return;
  }

  if (req.url === '/perf-check' && req.method === 'GET') {
    handlePerfCheck(req, res);
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
    appendFileSync(HARNESS_LOG, `\n===== spawn ${new Date().toISOString()} ${HARNESS_BIN} =====\n`);
    harness = spawn(HARNESS_BIN, [], {
      env: ENV,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    harness.stdout.on('data', (chunk) => {
      appendFileSync(HARNESS_LOG, chunk);
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
      appendFileSync(HARNESS_LOG, chunk);
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

// Directories searched by /find-mcap, in priority order.
// MCAP_DIR is the canonical home for new artifacts; the rest are kept for
// backwards compatibility with files placed there by older versions of the
// tool or by users.
const MCAP_SEARCH_DIRS = [
  MCAP_DIR,
  '/home/caros/workspace',
  '/tmp/ad-topology-cache',
  '/tmp',
];

/**
 * Classify a basename into (stem, variant). Stems group lite+camera pairs
 * created by record splitting; ``single`` is for any other .mcap file.
 */
function classifyMcapBasename(name) {
  if (name.endsWith('.lite.mcap')) {
    return { stem: name.slice(0, -10), variant: 'lite' };
  }
  if (name.endsWith('.camera.mcap')) {
    return { stem: name.slice(0, -12), variant: 'camera' };
  }
  if (name.endsWith('.mcap')) {
    return { stem: name.slice(0, -5), variant: 'single' };
  }
  return null;
}

function handleListMcaps(_req, res) {
  try {
    let names;
    try {
      names = readdirSync(MCAP_DIR);
    } catch {
      // Directory missing -> return empty list, never error.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries: [], dir: MCAP_DIR }));
      return;
    }

    const groups = new Map();
    for (const name of names) {
      const info = classifyMcapBasename(name);
      if (!info) { continue; }
      const fullPath = `${MCAP_DIR}/${name}`;
      let st;
      try { st = statSync(fullPath); } catch { continue; }
      if (!st.isFile()) { continue; }
      if (!groups.has(info.stem)) {
        groups.set(info.stem, { stem: info.stem, parts: [], maxMtime: 0 });
      }
      const g = groups.get(info.stem);
      g.parts.push({
        variant: info.variant,
        path: fullPath,
        basename: name,
        size: st.size,
        mtime: Math.floor(st.mtimeMs),
      });
      if (st.mtimeMs > g.maxMtime) { g.maxMtime = st.mtimeMs; }
    }

    // Attach YOLO sidecar summary (if any). The sidecar's basename is derived
    // from the *input* mcap path used by detect.py, so for a record split
    // into ``<stem>.camera.mcap`` + ``<stem>.lite.mcap`` the sidecar is
    // typically ``<stem>.camera.yolo.json``. Probe a few canonical locations
    // in priority order (camera variant first, then bare stem, then lite).
    for (const g of groups.values()) {
      g.hasSidecar = false;
      g.sidecarSummary = null;
      g.sidecarPath = null;
      const candidates = [
        `${MCAP_DIR}/${g.stem}.camera.yolo.json`,
        `${MCAP_DIR}/${g.stem}.yolo.json`,
        `${MCAP_DIR}/${g.stem}.lite.yolo.json`,
      ];
      for (const sidecarPath of candidates) {
        try {
          if (!existsSync(sidecarPath)) { continue; }
          const sc = JSON.parse(readFileSync(sidecarPath, 'utf8'));
          const total = (sc.frames || []).reduce(
            (s, f) => s + (f.detections || []).length, 0,
          );
          g.hasSidecar = true;
          g.sidecarPath = sidecarPath;
          g.sidecarSummary = {
            model: sc.model,
            frames: (sc.frames || []).length,
            totalDetections: total,
          };
          break;
        } catch (err) {
          console.warn(`[list-mcaps] cannot read sidecar ${sidecarPath}:`, err.message);
        }
      }
      // Stable per-variant order: camera, lite, single
      const order = { camera: 0, lite: 1, single: 2 };
      g.parts.sort((a, b) => (order[a.variant] ?? 9) - (order[b.variant] ?? 9));
    }

    const entries = [...groups.values()]
      .sort((a, b) => b.maxMtime - a.maxMtime);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ entries, dir: MCAP_DIR }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ---------------------------------------------------------------------------
//  Netron model viewer integration  (STATELESS / NO SUBPROCESS)
//
//  Netron's own server.py is just a static file server: it serves files
//  from the netron python package directory and a single user-supplied
//  model file under /data/<basename>. Its index.html uses purely relative
//  asset URLs (href="grapher.css", src="index.js", ...).
//
//  Therefore we don't need to spawn a netron subprocess at all -- Express
//  serves the bundle directly. This eliminates the entire class of bugs
//  we hit before:
//
//    - port conflicts / EADDRINUSE
//    - orphan netron processes after Express crash/restart
//    - in-memory `netronProcs` Map losing state on Express restart
//    - readiness race between port-probe and our spawned process dying
//
//  /netron-launch becomes purely "make sure the ONNX file exists on disk"
//  (lazy export). /netron/<model>/* is a static handler.
// ---------------------------------------------------------------------------

const YOLO_WEIGHTS_DIR = '/home/caros/workspace/yolo_weights';
const KNOWN_YOLO_MODELS = new Set(['yolo11n', 'yolo11s', 'yolo11m', 'yolo11l', 'yolo11x']);
const EXPORT_ONNX_SCRIPT = join(__dirname, '..', 'tools', 'yolo_detect', 'export_onnx.py');

// Resolve the netron python package directory at startup (handles the case
// where the user upgrades / reinstalls and the python version changes).
const NETRON_PKG_DIR = (() => {
  try {
    const out = execSync(
      'python3 -c "import netron, os; print(os.path.dirname(netron.__file__))"',
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (out && existsSync(out)) {
      console.log(`[netron] static bundle: ${out}`);
      return out;
    }
    console.warn(`[netron] python returned a path that doesn't exist: ${out}`);
    return null;
  } catch (err) {
    console.warn(`[netron] cannot locate package: ${err.message}`);
    return null;
  }
})();

const NETRON_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.ttf':  'font/ttf',
  '.eot':  'application/vnd.ms-fontobject',
};

/** Lazily run export_onnx.py if <weights>/<model>.onnx is missing. */
function ensureOnnxExported(modelName) {
  return new Promise((resolve, reject) => {
    const onnxPath = `${YOLO_WEIGHTS_DIR}/${modelName}.onnx`;
    if (existsSync(onnxPath) && statSync(onnxPath).size > 1024) {
      resolve(onnxPath);
      return;
    }
    if (!existsSync(EXPORT_ONNX_SCRIPT)) {
      reject(new Error(`export script missing: ${EXPORT_ONNX_SCRIPT}`));
      return;
    }
    console.log(`[netron] exporting ONNX for ${modelName} ...`);
    const child = spawn('python3', [EXPORT_ONNX_SCRIPT, modelName], {
      env: { ...ENV, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrBuf = '';
    child.stdout.on('data', d => {
      const t = d.toString().trim();
      if (t) { console.log(`[netron:export:${modelName}] ${t}`); }
    });
    child.stderr.on('data', d => {
      const t = d.toString().trim();
      stderrBuf += t + '\n';
      if (t) { console.warn(`[netron:export:${modelName}] ${t}`); }
    });
    child.on('error', err => reject(err));
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`export failed (code ${code}): ${stderrBuf.slice(-500)}`));
      } else if (!existsSync(onnxPath)) {
        reject(new Error(`export reported success but ${onnxPath} missing`));
      } else {
        console.log(`[netron] exported ${onnxPath} (${statSync(onnxPath).size} bytes)`);
        resolve(onnxPath);
      }
    });
  });
}

async function handleNetronLaunch(req, res) {
  let body = '';
  try {
    for await (const chunk of req) {
      body += chunk.toString();
      if (body.length > 8 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'body too large' }));
        return;
      }
    }
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `read body: ${err.message}` }));
    return;
  }

  let payload;
  try { payload = body ? JSON.parse(body) : {}; }
  catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `invalid JSON: ${err.message}` }));
    return;
  }

  const modelName = payload.model;
  if (!KNOWN_YOLO_MODELS.has(modelName)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'invalid or missing model',
      allowed: [...KNOWN_YOLO_MODELS],
    }));
    return;
  }

  if (!NETRON_PKG_DIR) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'netron python package not installed',
      hint: 'pip3 install --user netron',
    }));
    return;
  }

  const ptPath = `${YOLO_WEIGHTS_DIR}/${modelName}.pt`;
  if (!existsSync(ptPath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: `model weights missing: ${ptPath}`,
      hint: `download ${modelName}.pt from GitHub and place at ${ptPath}`,
    }));
    return;
  }

  let onnxPath;
  try {
    onnxPath = await ensureOnnxExported(modelName);
  } catch (err) {
    console.error(`[netron-launch] ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `ONNX export failed: ${err.message}` }));
    return;
  }

  console.log(`[netron-launch] ready: ${modelName} -> ${onnxPath}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    proxyPath: `/netron/${modelName}/`,
    model: modelName,
    onnxPath,
    onnxSize: statSync(onnxPath).size,
  }));
}

// ---------------------------------------------------------------------------
//  Model analysis endpoint
// ---------------------------------------------------------------------------

const MODEL_ANALYZE_SCRIPT = String.raw`
import json
import os
import sys
import traceback
from collections import Counter

onnx_path, pt_path, model_name = sys.argv[1:4]

def file_info(path):
    st = os.stat(path)
    return {
        "path": path,
        "bytes": st.st_size,
        "mtimeMs": int(st.st_mtime * 1000),
    }

def tensor_type(value_info):
    tensor = value_info.type.tensor_type
    elem = tensor.elem_type
    try:
        dtype = onnx.TensorProto.DataType.Name(elem)
    except Exception:
        dtype = str(elem)
    shape = []
    for dim in tensor.shape.dim:
        if dim.HasField("dim_value"):
            shape.append(dim.dim_value)
        elif dim.HasField("dim_param"):
            shape.append(dim.dim_param)
        else:
            shape.append(None)
    return {
        "name": value_info.name,
        "dtype": dtype,
        "shape": shape,
    }

def ultralytics_summary(path):
    try:
        from ultralytics import YOLO
        yolo = YOLO(path)
        torch_model = getattr(yolo, "model", None)
        if torch_model is None:
            return {"ok": False, "error": "YOLO model object has no .model"}
        params = sum(p.numel() for p in torch_model.parameters())
        gradients = sum(p.numel() for p in torch_model.parameters() if p.requires_grad)
        modules = sum(1 for _ in torch_model.modules())
        return {
            "ok": True,
            "params": params,
            "gradients": gradients,
            "modules": modules,
            "task": getattr(yolo, "task", None),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

try:
    try:
        import onnx
        from onnx import checker, shape_inference
    except Exception as exc:
        print(json.dumps({
            "dependencyMissing": "onnx",
            "error": str(exc),
        }))
        sys.exit(2)

    health = {"load": {"ok": False}, "checker": {"ok": False}, "shapeInference": {"ok": False}}
    model = onnx.load(onnx_path)
    health["load"] = {"ok": True}

    try:
        checker.check_model(model)
        health["checker"] = {"ok": True}
    except Exception as exc:
        health["checker"] = {"ok": False, "error": str(exc)}

    inferred = None
    try:
        inferred = shape_inference.infer_shapes(model)
        health["shapeInference"] = {"ok": True}
    except Exception as exc:
        health["shapeInference"] = {"ok": False, "error": str(exc)}

    graph = (inferred or model).graph
    initializer_names = {init.name for init in graph.initializer}
    inputs = [tensor_type(v) for v in graph.input if v.name not in initializer_names]
    outputs = [tensor_type(v) for v in graph.output]
    value_info_count = len(graph.value_info)

    counts = Counter(node.op_type for node in model.graph.node)
    top = [{"op": op, "count": count} for op, count in counts.most_common(20)]

    result = {
        "model": model_name,
        "netronUrl": f"/netron/{model_name}/",
        "files": {
            "pt": file_info(pt_path),
            "onnx": file_info(onnx_path),
        },
        "onnx": {
            "irVersion": model.ir_version,
            "producerName": model.producer_name,
            "producerVersion": model.producer_version,
            "opsets": [
                {"domain": opset.domain or "ai.onnx", "version": opset.version}
                for opset in model.opset_import
            ],
        },
        "graph": {
            "name": model.graph.name,
            "nodes": len(model.graph.node),
            "initializers": len(model.graph.initializer),
            "valueInfo": value_info_count,
            "inputs": inputs,
            "outputs": outputs,
        },
        "operators": {
            "unique": len(counts),
            "total": sum(counts.values()),
            "top": top,
            "counts": dict(sorted(counts.items())),
        },
        "health": health,
        "ultralytics": ultralytics_summary(pt_path),
    }
    print(json.dumps(result))
except Exception as exc:
    print(json.dumps({
        "error": str(exc),
        "traceback": traceback.format_exc(limit=8),
    }))
    sys.exit(1)
`;

async function readJsonBody(req, maxBytes = 64 * 1024) {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
    if (body.length > maxBytes) {
      const err = new Error('body too large');
      err.status = 413;
      throw err;
    }
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch (err) {
    const parseErr = new Error(`invalid JSON: ${err.message}`);
    parseErr.status = 400;
    throw parseErr;
  }
}

function runModelAnalyzeScript({ modelName, ptPath, onnxPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', MODEL_ANALYZE_SCRIPT, onnxPath, ptPath, modelName], {
      env: { ...ENV, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      let parsed = null;
      try {
        parsed = stdout.trim() ? JSON.parse(stdout.trim().split(/\r?\n/).pop()) : null;
      } catch (err) {
        const parseErr = new Error(`analyzer returned non-JSON output: ${err.message}`);
        parseErr.stderr = stderr.slice(-1000);
        parseErr.stdout = stdout.slice(-1000);
        reject(parseErr);
        return;
      }
      if (parsed?.dependencyMissing) {
        const depErr = new Error(`python dependency missing: ${parsed.dependencyMissing}: ${parsed.error}`);
        depErr.status = 503;
        depErr.dependency = parsed.dependencyMissing;
        reject(depErr);
        return;
      }
      if (code !== 0) {
        const err = new Error(parsed?.error || `analyzer exited with code ${code}`);
        err.status = 500;
        err.stderr = stderr.slice(-1000);
        err.traceback = parsed?.traceback;
        reject(err);
        return;
      }
      if (!parsed) {
        reject(new Error('analyzer produced no JSON result'));
        return;
      }
      if (stderr.trim()) {
        parsed.analyzerStderr = stderr.trim().slice(-1000);
      }
      resolve(parsed);
    });
  });
}

async function analyzeOneModel(modelName) {
  if (!KNOWN_YOLO_MODELS.has(modelName)) {
    const err = new Error('invalid or missing model');
    err.status = 400;
    err.allowed = [...KNOWN_YOLO_MODELS];
    throw err;
  }
  const ptPath = `${YOLO_WEIGHTS_DIR}/${modelName}.pt`;
  if (!existsSync(ptPath)) {
    const err = new Error(`model weights missing: ${ptPath}`);
    err.status = 404;
    err.hint = `download ${modelName}.pt from GitHub and place at ${ptPath}`;
    throw err;
  }
  const onnxPath = await ensureOnnxExported(modelName);
  const analysis = await runModelAnalyzeScript({ modelName, ptPath, onnxPath });
  console.log(`[model-analyze] ${modelName}: nodes=${analysis.graph?.nodes ?? '?'} ops=${analysis.operators?.unique ?? '?'}`);
  return analysis;
}

async function handleModelAnalyze(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req, 16 * 1024);
  } catch (err) {
    res.writeHead(err.status || 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
    return;
  }

  const modelName = payload.model;
  const compareAll = payload.compareAll === true;

  try {
    const primary = await analyzeOneModel(modelName);
    if (compareAll) {
      const comparisons = [];
      for (const candidate of KNOWN_YOLO_MODELS) {
        const ptPath = `${YOLO_WEIGHTS_DIR}/${candidate}.pt`;
        if (!existsSync(ptPath)) {
          continue;
        }
        if (candidate === modelName) {
          const primaryComparison = { ...primary };
          delete primaryComparison.comparisons;
          comparisons.push(primaryComparison);
          continue;
        }
        comparisons.push(await analyzeOneModel(candidate));
      }
      primary.comparisons = comparisons;
    }
    const json = JSON.stringify(primary);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(json);
  } catch (err) {
    console.error(`[model-analyze] ${err.message}`);
    const body = {
      error: err.message,
      allowed: err.allowed,
      hint: err.hint,
      dependency: err.dependency,
      traceback: err.traceback,
    };
    if (!res.headersSent) {
      res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

/**
 * Static handler for ``/netron/<model>/<rest>``.
 *
 *   /netron/<model>/                  -> netron/index.html (with injected
 *                                        <meta name="file" content="...">)
 *   /netron/<model>/<asset>           -> netron/<asset> from python package
 *   /netron/<model>/data/<file>.onnx  -> YOLO_WEIGHTS_DIR/<file>.onnx
 *
 * No subprocess, no port, no state. Everything is recomputed per request
 * from the filesystem; safe across Express restarts.
 */
function handleNetronStatic(req, res) {
  if (!NETRON_PKG_DIR) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'netron python package not installed',
      hint: 'pip3 install --user netron',
    }));
    return;
  }

  const m = req.url.match(/^\/netron\/([a-zA-Z0-9_]+)(\/[^?]*)?(\?.*)?$/);
  if (!m) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad netron path' }));
    return;
  }
  const modelName = m[1];
  let restPath = m[2] || '/';

  if (!KNOWN_YOLO_MODELS.has(modelName)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: `unknown model: ${modelName}`,
      allowed: [...KNOWN_YOLO_MODELS],
    }));
    return;
  }

  // ---- /data/<basename>.onnx -- serve the model file ------------------
  if (restPath.startsWith('/data/')) {
    const safe = sanitizeBasename(decodeURIComponent(restPath.slice('/data/'.length)));
    if (!safe || !safe.toLowerCase().endsWith('.onnx')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'only .onnx basenames allowed' }));
      return;
    }
    const onnxPath = `${YOLO_WEIGHTS_DIR}/${safe}`;
    if (!existsSync(onnxPath) || !statSync(onnxPath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `not found: ${safe}` }));
      return;
    }
    const st = statSync(onnxPath);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    const stream = createReadStream(onnxPath);
    stream.on('error', err => {
      console.error('[netron-static] data stream err:', err.message);
      if (!res.writableEnded) { try { res.end(); } catch {} }
    });
    stream.pipe(res);
    return;
  }

  // ---- /<asset> -- serve from netron python package -------------------
  const fileRel = (restPath === '/' || restPath === '') ? '/index.html' : restPath;

  // Path-traversal protection.
  const pkgRoot = pathResolve(NETRON_PKG_DIR);
  const filePath = pathResolve(join(pkgRoot, fileRel));
  if (!filePath.startsWith(pkgRoot + pathSep) && filePath !== pkgRoot) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden' }));
    return;
  }

  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `not found: ${fileRel}` }));
    return;
  }
  const st = statSync(filePath);
  if (!st.isFile()) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `not a file: ${fileRel}` }));
    return;
  }
  const ext = extname(filePath).toLowerCase();
  const ctype = NETRON_MIME[ext];
  if (!ctype) {
    res.writeHead(415, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `unsupported asset type: ${ext}` }));
    return;
  }

  // index.html: replace netron's <meta name="version"> with one that
  // additionally tells the viewer where to fetch the model file. We
  // mirror netron's own substitution logic in server.py so future netron
  // upgrades stay compatible.
  //
  // IMPORTANT: the ``file`` meta MUST be a *relative* path (no leading
  // slash, no ``./``). netron's browser.js `_url(file)` treats absolute
  // paths as relative-to-host -- it strips the leading ``/`` and then
  // prepends ``location.pathname``. With pathname=``/netron/<model>/``
  // and content=``/netron/<model>/data/<model>.onnx`` that yields a
  // DOUBLED path ``/netron/<model>/netron/<model>/data/<model>.onnx``
  // and netron pops up "The web request failed with status code '404'."
  // Using a relative ``data/<model>.onnx`` makes _url() produce the
  // intended ``/netron/<model>/data/<model>.onnx``.
  if (fileRel === '/index.html') {
    let html = readFileSync(filePath, 'utf-8');
    const onnxBase = `${modelName}.onnx`;
    const versionMeta = html.match(/<meta name="version"[^>]*>/);
    const inject =
      `<meta name="file" content="data/${onnxBase}">\n` +
      `<meta name="name" content="${onnxBase}">`;
    if (versionMeta) {
      html = html.replace(versionMeta[0], versionMeta[0] + '\n' + inject);
    } else {
      // Fallback: inject into <head>.
      html = html.replace(/<head[^>]*>/i, (h) => h + '\n' + inject);
    }
    const buf = Buffer.from(html, 'utf-8');
    res.writeHead(200, {
      'Content-Type': ctype,
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
    return;
  }

  // Other assets: stream as-is.
  res.writeHead(200, {
    'Content-Type': ctype,
    'Content-Length': st.size,
    'Cache-Control': 'public, max-age=300',
  });
  const stream = createReadStream(filePath);
  stream.on('error', err => {
    console.error('[netron-static] asset stream err:', err.message);
    if (!res.writableEnded) { try { res.end(); } catch {} }
  });
  stream.pipe(res);
}

function handleFindMcap(req, res) {
  try {
    const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const name = params.get('name');
    const safe = sanitizeBasename(name);
    if (!safe || !safe.toLowerCase().endsWith('.mcap')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'name must be a basename ending in .mcap' }));
      return;
    }
    for (const dir of MCAP_SEARCH_DIRS) {
      const candidate = `${dir}/${safe}`;
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ found: true, path: candidate }));
          return;
        }
      } catch {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ found: false, searched: MCAP_SEARCH_DIRS }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

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
    const lower = resolved.toLowerCase();
    const isMcap = lower.endsWith('.mcap');
    const isReport = lower.endsWith('.mcap.report.json');
    const isYoloSidecar = lower.endsWith('.yolo.json');
    if (!isMcap && !isReport && !isYoloSidecar) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'only .mcap, .mcap.report.json, .yolo.json files may be served',
      }));
      return;
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `file not found: ${resolved}` }));
      return;
    }
    const stat = statSync(resolved);
    const contentType = (isReport || isYoloSidecar)
        ? 'application/json'
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
  // Strip ``.record[.NNNNN[.MMMMM]]`` trailing segments to get the canonical
  // mcap basename, then place the output in MCAP_DIR. Examples:
  //   /data/foo/20260416.record.00000  ->  <MCAP_DIR>/20260416.mcap
  //   /data/foo/bar.mcap               ->  <MCAP_DIR>/bar.mcap.mcap (rare)
  //   /any/where/baz.record            ->  <MCAP_DIR>/baz.mcap
  const baseFile = basename(inputPath);
  const match = baseFile.match(/^(.*?)\.record(?:\.\d+)*$/);
  const stem = match ? match[1] : baseFile;
  return `${MCAP_DIR}/${stem}.mcap`;
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
  if (typeof payload.platform === 'string' && payload.platform && payload.platform !== 'auto') {
    args.push('--platform', payload.platform);
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

// ---------------------------------------------------------------------------
// /yolo-detect endpoint -- spawn tools/yolo_detect/detect.py against an mcap.
// ---------------------------------------------------------------------------

const YOLO_DETECT_SCRIPT = join(__dirname, '..', 'tools', 'yolo_detect', 'detect.py');
const ALLOWED_YOLO_MODELS = new Set(['yolo11n', 'yolo11s', 'yolo11m', 'yolo11l', 'yolo11x']);

async function handleYoloDetect(req, res) {
  let body = '';
  try {
    for await (const chunk of req) {
      body += chunk.toString();
      if (body.length > 64 * 1024) {
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

  const inputPathRaw = payload.mcapPath;
  if (typeof inputPathRaw !== 'string' || !inputPathRaw) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'mcapPath is required' }));
    return;
  }
  if (!isAbsolute(inputPathRaw)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'mcapPath must be absolute' }));
    return;
  }
  const mcapPath = pathResolve(inputPathRaw);
  if (!existsSync(mcapPath) || !statSync(mcapPath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `mcap not found: ${mcapPath}` }));
    return;
  }

  const model = ALLOWED_YOLO_MODELS.has(payload.model) ? payload.model : 'yolo11n';
  const device = ['cpu', 'cuda:0', 'auto'].includes(payload.device) ? payload.device : 'auto';
  const confRaw = Number(payload.conf);
  const conf = Number.isFinite(confRaw) ? Math.max(0.01, Math.min(0.99, confRaw)) : 0.25;
  const skipFisheye = payload.skipFisheye === true;
  const maxFramesRaw = Number(payload.maxFramesPerCam);
  const maxFrames = Number.isInteger(maxFramesRaw) && maxFramesRaw > 0 ? maxFramesRaw : 0;

  if (!existsSync(YOLO_DETECT_SCRIPT)) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'detect.py missing',
      expectedAt: YOLO_DETECT_SCRIPT,
    }));
    return;
  }

  // Output sidecar path is fixed: <mcap-without-.mcap>.yolo.json
  const outputPath = mcapPath.toLowerCase().endsWith('.mcap')
    ? mcapPath.slice(0, -5) + '.yolo.json'
    : mcapPath + '.yolo.json';

  const args = [
    YOLO_DETECT_SCRIPT,
    '--mcap', mcapPath,
    '--model', model,
    '--device', device,
    '--conf', String(conf),
    '--output', outputPath,
  ];
  if (skipFisheye) { args.push('--skip-fisheye'); }
  if (maxFrames > 0) { args.push('--max-frames-per-cam', String(maxFrames)); }

  const pythonBin = process.env.YOLO_PYTHON || 'python3';

  console.log('[yolo-detect] spawn:', pythonBin, args.join(' '));

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  writeJsonLine(res, {
    type: 'start',
    mcapPath, outputPath, model, device, conf,
    skipFisheye, maxFramesPerCam: maxFrames,
    pythonBin,
  });

  let child;
  try {
    child = spawn(pythonBin, args, {
      env: { ...ENV, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
    const outputExists = existsSync(outputPath);
    let summary = null;
    if (outputExists) {
      try {
        const sc = JSON.parse(readFileSync(outputPath, 'utf8'));
        const totalDets = (sc.frames || []).reduce((s, f) => s + (f.detections || []).length, 0);
        summary = {
          model: sc.model, version: sc.version,
          frames: (sc.frames || []).length,
          totalDetections: totalDets,
          generatedAt: sc.generated_at,
        };
      } catch (err) {
        writeJsonLine(res, {
          type: 'log', stream: 'stderr',
          line: `failed to read sidecar: ${err.message}`,
        });
      }
    }
    writeJsonLine(res, {
      type: 'done',
      ok: code === 0 && !killed && outputExists,
      killed,
      exitCode: code,
      signal,
      mcapPath,
      outputPath,
      outputExists,
      outputSizeBytes: outputExists ? statSync(outputPath).size : 0,
      summary,
    });
    res.end();
  });
}

// ---------------------------------------------------------------------------
// perf-sample endpoint
// ---------------------------------------------------------------------------

function findPerfBin() {
  for (const candidate of ['/usr/bin/perf', '/usr/local/bin/perf']) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function handlePerfCheck(_req, res) {
  const perfBin = findPerfBin();
  let paranoid = null;
  try {
    paranoid = parseInt(readFileSync('/proc/sys/kernel/perf_event_paranoid', 'utf8').trim(), 10);
  } catch { /* ignore */ }

  const ok = perfBin !== null;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    perfAvailable: ok,
    perfBin,
    stackcollapseAvailable: existsSync(STACKCOLLAPSE),
    perfEventParanoid: paranoid,
    isRoot: process.getuid?.() === 0,
    hint: ok ? null : 'Run: apt install -y linux-tools-generic linux-tools-$(uname -r)',
  }));
}

async function handlePerfSample(req, res) {
  let body = '';
  try {
    for await (const chunk of req) {
      body += chunk.toString();
      if (body.length > 64 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        return;
      }
    }
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
    return;
  }

  let payload;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Invalid JSON: ${err.message}` }));
    return;
  }

  const pid = payload.pid;
  const durationSec = Math.min(Math.max(payload.duration_sec || 5, 1), 30);

  if (!pid || !Number.isFinite(pid)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'pid is required and must be a number' }));
    return;
  }

  const perfBin = findPerfBin();
  if (!perfBin) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'perf not installed',
      hint: 'Run: apt install -y linux-tools-generic linux-tools-$(uname -r)',
    }));
    return;
  }

  if (!existsSync(STACKCOLLAPSE)) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'stackcollapse-perf.pl not found',
      hint: `Expected at: ${STACKCOLLAPSE}`,
    }));
    return;
  }

  const perfDataPath = join(tmpdir(), `ad-topo-perf-${pid}-${Date.now()}.data`);

  console.log(`[perf-sample] pid=${pid} duration=${durationSec}s output=${perfDataPath}`);

  try {
    const recordResult = await runShellCmd(
      `${perfBin} record -F 99 -g --call-graph fp -p ${pid} -o ${perfDataPath} -- sleep ${durationSec}`,
      durationSec * 1000 + 10000,
    );

    if (!existsSync(perfDataPath) || statSync(perfDataPath).size === 0) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'perf record produced no data',
        stderr: recordResult.stderr?.slice(-500),
      }));
      cleanup(perfDataPath);
      return;
    }

    const scriptResult = await runShellCmd(
      `LD_LIBRARY_PATH="/home/caros/cyberrt/lib:/home/caros/workspace/gears/x86_64/lib:$LD_LIBRARY_PATH" ${perfBin} script --no-demangle -i ${perfDataPath} | c++filt | perl ${STACKCOLLAPSE}`,
      60000,
    );

    cleanup(perfDataPath);

    if (!scriptResult.stdout) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'stackcollapse produced no output',
        stderr: scriptResult.stderr?.slice(-500),
      }));
      return;
    }

    const foldedLines = scriptResult.stdout.trim().split('\n').filter(Boolean);
    const stacks = foldedLines.map(line => {
      const lastSpace = line.lastIndexOf(' ');
      if (lastSpace < 0) {
        return { stack: line, count: 1 };
      }
      return {
        stack: line.slice(0, lastSpace),
        count: parseInt(line.slice(lastSpace + 1), 10) || 1,
      };
    });

    const totalSamples = stacks.reduce((sum, s) => sum + s.count, 0);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      pid,
      durationSec,
      totalSamples,
      foldedStacks: scriptResult.stdout.trim(),
      stacks,
    }));
  } catch (err) {
    cleanup(perfDataPath);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

function runShellCmd(cmd, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn('bash', ['-c', cmd], {
      env: ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: `${stderr}\n${e.message}`.trim() });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        exitCode: timedOut ? -1 : (code ?? -1),
        stdout,
        stderr: timedOut ? `${stderr}\nTimeout after ${timeoutMs}ms` : stderr,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// perf-start / perf-stop: async perf recording during S2 replay
// ---------------------------------------------------------------------------

let activePerfSession = null; // { proc, dataPath, pid }

async function handlePerfStart(req, res) {
  let body = '';
  for await (const chunk of req) { body += chunk.toString(); }
  let payload;
  try { payload = body ? JSON.parse(body) : {}; } catch { payload = {}; }

  const pid = payload.pid;
  if (!pid || !Number.isFinite(pid)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'pid required' }));
    return;
  }

  const perfBin = findPerfBin();
  if (!perfBin) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'perf not installed' }));
    return;
  }

  if (activePerfSession) {
    try { activePerfSession.proc.kill('SIGINT'); } catch {}
    cleanup(activePerfSession.dataPath);
    activePerfSession = null;
  }

  const dataPath = join(tmpdir(), `ad-topo-perf-${pid}-${Date.now()}.data`);
  const freq = payload.freq || 99;

  const proc = spawn(perfBin, [
    'record', '-F', String(freq), '-g', '--call-graph', 'fp',
    '-p', String(pid), '-o', dataPath,
  ], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });

  activePerfSession = { proc, dataPath, pid };

  // Give perf a moment to attach
  await new Promise(r => setTimeout(r, 500));

  console.log(`[perf-start] attached to pid=${pid}, freq=${freq}, output=${dataPath}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, pid, dataPath }));
}

async function handlePerfStop(_req, res) {
  if (!activePerfSession) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No active perf session' }));
    return;
  }

  const { proc, dataPath, pid } = activePerfSession;
  activePerfSession = null;

  // Send SIGINT to perf to stop recording gracefully
  try { proc.kill('SIGINT'); } catch {}

  // Wait for perf to finish writing
  await new Promise((resolve) => {
    const timeout = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} resolve(); }, 5000);
    proc.on('close', () => { clearTimeout(timeout); resolve(); });
  });

  if (!existsSync(dataPath) || statSync(dataPath).size === 0) {
    cleanup(dataPath);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'perf record produced no data' }));
    return;
  }

  const perfBin = findPerfBin();
  // Use --symfs to help perf resolve symbols in .so files loaded via RPATH.
  // Also set LD_LIBRARY_PATH so perf can find the .so by SONAME.
  const scriptResult = await runShellCmd(
    `LD_LIBRARY_PATH="/home/caros/cyberrt/lib:/home/caros/workspace/gears/x86_64/lib:$LD_LIBRARY_PATH" ${perfBin} script --no-demangle -i ${dataPath} | c++filt | perl ${STACKCOLLAPSE}`,
    60000,
  );

  cleanup(dataPath);

  if (!scriptResult.stdout) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'stackcollapse produced no output', stderr: scriptResult.stderr?.slice(-500) }));
    return;
  }

  const foldedLines = scriptResult.stdout.trim().split('\n').filter(Boolean);
  const stacks = foldedLines.map(line => {
    const lastSpace = line.lastIndexOf(' ');
    return lastSpace < 0
      ? { stack: line, count: 1 }
      : { stack: line.slice(0, lastSpace), count: parseInt(line.slice(lastSpace + 1), 10) || 1 };
  });
  const totalSamples = stacks.reduce((sum, s) => sum + s.count, 0);

  console.log(`[perf-stop] pid=${pid}, samples=${totalSamples}, stacks=${stacks.length}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ pid, totalSamples, foldedStacks: scriptResult.stdout.trim(), stacks }));
}

function cleanup(filePath) {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// agent-output-write endpoint
// ---------------------------------------------------------------------------

async function handleAgentOutputWrite(req, res) {
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
    res.end(JSON.stringify({ error: err.message }));
    return;
  }

  let payload;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Invalid JSON: ${err.message}` }));
    return;
  }

  const slug = payload.slug;
  const stageId = payload.stage_id || '';
  const content = payload.content;

  if (!slug || typeof slug !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'slug is required' }));
    return;
  }
  if (content === undefined || content === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'content is required' }));
    return;
  }

  const safeSlug = slug.replace(/[^a-zA-Z0-9._-]/g, '_');
  const taskDir = join(AGENT_OUTPUT_ROOT, 'tasks', safeSlug);
  const taskFile = join(taskDir, `${safeSlug}.json`);

  try {
    mkdirSync(taskDir, { recursive: true });

    const entry = {
      agent: 'Analyzer',
      stage: stageId,
      type: 'ANALYSIS',
      time: new Date().toISOString(),
      content,
    };

    appendFileSync(taskFile, JSON.stringify(entry) + '\n', 'utf8');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      path: taskFile,
      slug: safeSlug,
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Executor Harness WS Server listening on ws://0.0.0.0:${PORT}`);
});
