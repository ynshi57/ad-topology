#!/usr/bin/env node
/**
 * Build a process topology config for ad-topology, driven by a platform's
 * app_config.json (NOT by blindly scanning every deploy dir).
 *
 * Why app_config-driven:
 *   ad_dag now ships per-platform launch profiles (conf/25_6090, conf/26_6012)
 *   and versioned / test-only deploy dirs (25_*, 26_*, test_*). Scanning all of
 *   deploy/* would conflate platforms and pull in sim/test pods. Instead we read
 *   the chosen platform's app_config, take only the enabled apps, resolve each
 *   nexis_app's `-p <profile>` to its deploy dir, and use the app `name` as the
 *   topology node id. mainboard (CyberRT) apps that define channels in code use
 *   a small CODE_TOPICS fallback.
 *
 * Output per platform: src/nexis-config.<platform>.json
 * Default mirror (for static imports): src/nexis-config.json
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(__dirname, '..', '..');
const AD_DAG = join(WORKSPACE, 'ad_dag');
const NEXIS_DEPLOY = join(AD_DAG, 'config/nexis/deploy');
const NEXIS_DATA = join(AD_DAG, 'config/nexis/resource/data.d');
const NEXIS_FLOW = join(AD_DAG, 'config/nexis/resource/flow.d');
const NEXIS_TASK = join(AD_DAG, 'config/nexis/resource/task.d');
const SRC_DIR = join(__dirname, '..', 'src');

// Platform launch profiles. Each maps to an app_config.json under ad_dag/conf.
const PLATFORMS = {
  '25_6090': 'conf/25_6090/app_config.json',
  '26_6012': 'conf/26_6012/app_config.json',
};
const DEFAULT_PLATFORM = process.env.DEFAULT_PLATFORM || '26_6012';

// Domain + layer for each app (topology node id == app `name` in app_config).
// Layer drives the left→right DAG banding in the graph view.
const APP_META = {
  driver_gnss:       { domain: 'sensor',       layer: 0 },
  canbus:            { domain: 'sensor',       layer: 0 },
  udp_canbus:        { domain: 'sensor',       layer: 0 },
  location:          { domain: 'localization', layer: 1 },
  state_machine:     { domain: 'system',       layer: 1 },
  openapi:           { domain: 'openapi',      layer: 1 },
  baidu_map_service: { domain: 'maprouter',    layer: 2 },
  dynamic_layer:     { domain: 'pnc',          layer: 2 },
  model_infer:       { domain: 'perception',   layer: 2 },
  orin_ivi:          { domain: 'system',       layer: 2 },
  maprouter:         { domain: 'maprouter',    layer: 3 },
  system_monitor:    { domain: 'system',       layer: 3 },
  pnc:               { domain: 'pnc',          layer: 4 },
  fault_manager:     { domain: 'system',       layer: 4 },
  aeb:               { domain: 'pnc',          layer: 5 },
  dcl:               { domain: 'system',       layer: 6 },
  tsp_client:        { domain: 'system',       layer: 6 },
  proto_recorder:    { domain: 'recorder',     layer: 6 },
  camera_recorder:   { domain: 'recorder',     layer: 6 },
  lidar_recorder:    { domain: 'recorder',     layer: 6 },
};

// CyberRT (mainboard) apps publish/subscribe channels from code, not transport.
// Only the topics needed to resolve cross-process edges are listed here, and
// these are code-derived (verified against the driver/app source), so they are
// applied as a fallback that never overrides a real nexis transport publisher.
const CODE_TOPICS = {
  // dag_driver_gnss.dag — Novatel GNSS/IMU driver (raw sensor source).
  driver_gnss: {
    pub: [
      '/sensor/novatel/Imu',
      '/sensor/novatel/bestgnsspos',
      '/sensor/novatel/bestgnssvel',
      '/sensor/novatel/Heading',
    ],
    sub: [],
  },
  // dcl.dag — data collection / report.
  dcl: { pub: ['/dcl/report'], sub: [] },
};

const GLOBAL_SERVICES = {
  VehiclePoseManager: {
    feedTopics: {
      DR: {
        topic: '/localization/100hz/localization_vehicle_speed',
        proto: 'neodrive.global.localization_dr.LocalizationVehicleSpeed',
      },
      GNSS: {
        topic: '/localization/100hz/inspvax_gnss_msf',
        proto: 'neodrive.global.localization.LocalizationEstimate',
      },
      CAN: {
        topic: '/canbus/vehicle_speed/Vehicle_speed',
        proto: 'neodrive.global.canbus.PbCarStatus',
      },
    },
  },
};

// ========================================================================
// Transport / data parsing helpers
// ========================================================================

function extractNestedBlock(text, keyword) {
  const re = new RegExp(`\\b${keyword}\\s*:?\\s*\\{`);
  const m = re.exec(text);
  if (!m) return null;
  let depth = 1, i = m.index + m[0].length;
  while (i < text.length && depth > 0) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    i++;
  }
  return text.slice(m.index + m[0].length, i - 1);
}

function parseTransportFile(content) {
  const blocks = [];
  const starts = [...content.matchAll(/transport\s*:?\s*\{/g)];
  for (const m of starts) {
    let depth = 1, i = m.index + m[0].length;
    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      i++;
    }
    const body = content.slice(m.index + m[0].length, i - 1);
    const entry = { name: '', direction: '', topic: '', commType: '' };
    const nameMatch = body.match(/name\s*:\s*"([^"]+)"/);
    if (nameMatch) entry.name = nameMatch[1];

    const hasPub = /\bpub\s*:?\s*\{/.test(body);
    entry.direction = hasPub ? 'pub' : 'sub';
    const dirBody = extractNestedBlock(body, hasPub ? 'pub' : 'sub');
    if (dirBody) {
      const tm = dirBody.match(/topic\s*:\s*"([^"]+)"/);
      if (tm) entry.topic = tm[1];
      const cm = dirBody.match(/comm_type\s*:\s*"([^"]+)"/);
      if (cm) entry.commType = cm[1];
    }
    const switchBody = extractNestedBlock(body, 'switch_to');
    if (switchBody) {
      const st = switchBody.match(/topic\s*:\s*"([^"]+)"/);
      if (st && !entry.topic) { entry.topic = st[1]; entry.direction = 'pub'; }
      const sc = switchBody.match(/comm_type\s*:\s*"([^"]+)"/);
      if (sc && sc[1] === 'cyber') entry.commType = 'cyber';
    }
    blocks.push(entry);
  }
  return blocks;
}

function parseDataFiles(dataDir) {
  const types = {};
  if (!existsSync(dataDir)) return types;
  for (const file of readdirSync(dataDir).filter(f => f.endsWith('.pbtxt'))) {
    const content = readFileSync(join(dataDir, file), 'utf8');
    const re = /data\s*\{([\s\S]*?)\n\}/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const nm = m[1].match(/name\s*:\s*"([^"]+)"/);
      const tm = m[1].match(/type\s*:\s*"([^"]+)"/);
      if (nm && tm) types[nm[1]] = tm[1];
    }
  }
  return types;
}

function parseFlowFiles(flowDir) {
  const executorFlows = {};
  if (!existsSync(flowDir)) return executorFlows;

  for (const file of readdirSync(flowDir).filter(f => f.endsWith('.pbtxt'))) {
    const content = readFileSync(join(flowDir, file), 'utf8');
    const nodeLines = [...content.matchAll(/node\s*:\s*"([^"]+)"/g)];
    const bundleLines = [...content.matchAll(/bundle\s*:\s*"([^"]+)"/g)];

    const bundleMap = {};
    for (const bm of bundleLines) {
      const parts = bm[1].split('@');
      const header = parts[0].trim().split(/\s+/);
      const bundleName = header[0];
      const queueSize = parseInt(header[1]) || 5;
      const intervalUs = parseInt(header[2]) || 200000;

      const inputsPart = (parts[1] || '').trim();
      const required = [];
      const optional = [];

      for (const token of inputsPart.split(/\s+/).filter(Boolean)) {
        const clean = token.replace(/\(.*?\)/g, '');
        if (clean.startsWith('[!')) {
          required.push(clean.replace(/[\[\]!]/g, ''));
        } else if (clean.startsWith('!')) {
          required.push(clean.replace('!', ''));
        } else if (clean.startsWith('[')) {
          optional.push(clean.replace(/[\[\]]/g, ''));
        }
      }

      bundleMap[bundleName] = { queueSize, intervalUs, required, optional };
    }

    for (const nm of nodeLines) {
      const nodeStr = nm[1];
      const execMatch = nodeStr.match(/(\S+)\s*<<\s*(\S+)\s*>>/);
      if (!execMatch) continue;
      const bundleName = execMatch[1];
      const executorName = execMatch[2];
      const bundle = bundleMap[bundleName];
      if (bundle) {
        executorFlows[executorName] = {
          intervalUs: bundle.intervalUs,
          hz: Math.round(1e6 / bundle.intervalUs * 10) / 10,
          queueSize: bundle.queueSize,
          requiredInputs: bundle.required,
          optionalInputs: bundle.optional,
        };
      }
    }
  }
  return executorFlows;
}

// Base directories to search when resolving a relative cfg_file path.
const CFG_RESOLUTION_BASES = (() => {
  const bases = [
    '/home/caros/cyberrt',
    '/home/caros/cyberrt/conf',
    '/home/caros/x86_64/opt',
    '/home/caros/adu',
    '/home/caros',
    WORKSPACE,
  ];
  if (existsSync(WORKSPACE)) {
    for (const entry of readdirSync(WORKSPACE)) {
      const candidate = join(WORKSPACE, entry);
      try {
        if (statSync(candidate).isDirectory()) {
          bases.push(candidate);
        }
      } catch {
        // ignore unreadable entries
      }
    }
  }
  return bases;
})();

let cfgResolutionWarnings = [];

function resolveCfgFile(rawPath) {
  if (!rawPath) return rawPath;
  if (rawPath.startsWith('/')) {
    if (!existsSync(rawPath)) {
      cfgResolutionWarnings.push(`absolute cfg_file missing on disk: ${rawPath}`);
    }
    return rawPath;
  }
  for (const base of CFG_RESOLUTION_BASES) {
    const candidate = join(base, rawPath);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  cfgResolutionWarnings.push(
    `could not resolve relative cfg_file '${rawPath}' under ${CFG_RESOLUTION_BASES.join(', ')}`,
  );
  return rawPath;
}

function parseTaskFiles(taskDir) {
  const executorTasks = {};
  if (!existsSync(taskDir)) return executorTasks;

  for (const file of readdirSync(taskDir).filter(f => f.endsWith('.pbtxt'))) {
    const content = readFileSync(join(taskDir, file), 'utf8');
    const taskBlocks = [...content.matchAll(/\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)];

    for (const block of taskBlocks) {
      const body = block[1];
      const nameMatch = body.match(/name\s*:\s*"([^"]+)"/);
      const classMatch = body.match(/class_name\s*:\s*"([^"]+)"/);
      const libMatch = body.match(/lib_name\s*:\s*"([^"]+)"/);
      const cfgMatches = [...body.matchAll(/cfg_file\s*:\s*"([^"]+)"/g)];
      const typeMatch = body.match(/type\s*:\s*"([^"]+)"/);

      if (!classMatch || !libMatch) continue;
      const taskType = (typeMatch?.[1] || '').toLowerCase();
      if (['capture', 'emitter', 'emit'].includes(taskType)) continue;
      const className = classMatch[1];
      if (['BusCapture', 'BusEmitter', 'AlarmCapture'].includes(className)) continue;

      const libName = libMatch[1];
      const cfgFiles = cfgMatches.map(m => resolveCfgFile(m[1]));

      executorTasks[className] = {
        taskName: nameMatch?.[1] || '',
        libName,
        cfgFiles,
        sourceFile: file,
      };
    }
  }
  return executorTasks;
}

function parseProcessExecutors(taskDir, flowDir) {
  const processExecutors = {};
  const executorDependencies = {};

  if (!existsSync(taskDir)) return { processExecutors, executorDependencies };

  // Step 1: Parse flow.d to get each executor's inputs and outputs from node lines
  const flowNodeMap = {}; // taskName -> { inputs: [...], outputs: [...], bundleName }
  if (existsSync(flowDir)) {
    for (const file of readdirSync(flowDir).filter(f => f.endsWith('.pbtxt'))) {
      const processName = file.replace('.pbtxt', '');
      const content = readFileSync(join(flowDir, file), 'utf8');

      const nodeMatches = [...content.matchAll(/node\s*:\s*"([^"]+)"/g)];
      for (const nm of nodeMatches) {
        const nodeLine = nm[1].trim();
        const execMatch = nodeLine.match(/^(\S+)\s+<<\s*(\S+)\s*>>\s*(.*)/);
        if (!execMatch) continue;
        const bundleName = execMatch[1];
        const taskName = execMatch[2];
        const outputsStr = execMatch[3].trim();
        const outputs = outputsStr ? outputsStr.split(/\s+/).filter(Boolean).map(o => o.replace(/^!/, '')) : [];
        flowNodeMap[taskName] = { bundleName, outputs, processName };
      }

      const bundleMatches = [...content.matchAll(/bundle\s*:\s*"([^"]+)"/g)];
      for (const bm of bundleMatches) {
        const bundleLine = bm[1].trim();
        const parts = bundleLine.split('@');
        if (parts.length < 2) continue;
        const bundleName = parts[0].trim().split(/\s+/)[0];
        const inputsPart = parts[1].trim();
        const inputs = [...inputsPart.matchAll(/[!\[]?([a-zA-Z_][a-zA-Z0-9_]*)/g)]
          .map(m => m[1])
          .filter(Boolean);

        for (const [taskName, info] of Object.entries(flowNodeMap)) {
          if (info.bundleName === bundleName) {
            info.inputs = inputs;
          }
        }
      }
    }
  }

  // Step 2: Parse task.d to get executor metadata, filter to testable executors only
  for (const file of readdirSync(taskDir).filter(f => f.endsWith('.pbtxt'))) {
    const processName = file.replace('.pbtxt', '');
    const content = readFileSync(join(taskDir, file), 'utf8');
    const taskBlocks = [...content.matchAll(/\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)];

    const executors = [];

    for (const block of taskBlocks) {
      const body = block[1];
      const nameMatch = body.match(/name\s*:\s*"([^"]+)"/);
      const classMatch = body.match(/class_name\s*:\s*"([^"]+)"/);
      const libMatch = body.match(/lib_name\s*:\s*"([^"]+)"/);
      const typeMatch = body.match(/type\s*:\s*"([^"]+)"/);
      const cfgMatches = [...body.matchAll(/cfg_file\s*:\s*"([^"]+)"/g)];

      if (!classMatch || !libMatch) continue;
      const taskType = (typeMatch?.[1] || '').toLowerCase();
      const className = classMatch[1];
      if (['capture', 'emitter', 'emit'].includes(taskType)) continue;
      if (['BusCapture', 'BusEmitter', 'AlarmCapture'].includes(className)) continue;

      const taskName = nameMatch?.[1] || '';
      const libName = libMatch[1];
      const cfgFiles = cfgMatches.map(m => resolveCfgFile(m[1]));

      const flowInfo = flowNodeMap[taskName] || {};

      executors.push({
        taskName,
        className,
        libName,
        cfgFiles,
        inputs: flowInfo.inputs || [],
        outputs: flowInfo.outputs || [],
      });
    }

    if (executors.length > 0) {
      processExecutors[processName] = executors;
    }
  }

  // Step 3: Infer dependencies via transport.pbtxt topic bridging.
  for (const [processName, executors] of Object.entries(processExecutors)) {
    const deps = [];

    const transportPath = join(NEXIS_DEPLOY, processName, 'transport.pbtxt');
    const dataNameToTopic = {};
    if (existsSync(transportPath)) {
      const content = readFileSync(transportPath, 'utf8');
      const blocks = [...content.matchAll(/transport\s*:\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g)];
      for (const block of blocks) {
        const body = block[1];
        const nameMatch = body.match(/name\s*:\s*"([^"]+)"/);
        const topicMatch = body.match(/topic\s*:\s*"([^"]+)"/);
        if (!nameMatch || !topicMatch) continue;
        const isPub = /pub\s*:/.test(body);
        const isSub = /sub\s*:/.test(body);
        dataNameToTopic[nameMatch[1]] = {
          topic: topicMatch[1],
          direction: isPub ? 'pub' : isSub ? 'sub' : 'unknown',
        };
      }
    }

    const outputTopicToExec = {};
    for (const ex of executors) {
      for (const outData of ex.outputs) {
        const mapping = dataNameToTopic[outData];
        if (mapping) {
          outputTopicToExec[mapping.topic] = { className: ex.className, dataName: outData };
        }
      }
    }

    for (const ex of executors) {
      for (const inpData of ex.inputs) {
        const mapping = dataNameToTopic[inpData];
        if (!mapping) continue;
        const producer = outputTopicToExec[mapping.topic];
        if (producer && producer.className !== ex.className) {
          const existing = deps.find(d => d.from === producer.className && d.to === ex.className && d.topic === mapping.topic);
          if (!existing) {
            deps.push({
              from: producer.className,
              to: ex.className,
              topic: mapping.topic,
              fromData: producer.dataName,
              toData: inpData,
            });
          }
        }
      }
    }

    if (deps.length === 0) {
      const outputMap = {};
      for (const ex of executors) {
        for (const out of ex.outputs) {
          outputMap[out] = ex.className;
        }
      }
      for (const ex of executors) {
        for (const inp of ex.inputs) {
          if (outputMap[inp] && outputMap[inp] !== ex.className) {
            deps.push({ from: outputMap[inp], to: ex.className, topic: '', fromData: inp, toData: inp });
          }
        }
      }
    }

    if (deps.length > 0) {
      executorDependencies[processName] = deps;
    }
  }

  return { processExecutors, executorDependencies };
}

// ========================================================================
// app_config helpers
// ========================================================================

/**
 * Extract the enabled apps from a platform's app_config.json.
 * @returns {Array<{ name, command, profile, runtime }>}
 *   profile = the `-p` deploy dir (nexis_app) or null; runtime = 'nexis'|'cyber'|'other'.
 */
export function resolveApps(appConfig) {
  const apps = [];
  for (const app of appConfig.applications || []) {
    if (app.enabled === false) continue;
    const args = app.args || [];
    const pIdx = args.indexOf('-p');
    const profile = pIdx >= 0 ? args[pIdx + 1] : null;
    let runtime;
    if (app.command === 'nexis_app') {
      runtime = 'nexis';
    } else if (app.command === 'mainboard') {
      runtime = 'cyber';
    } else {
      runtime = 'other';
    }
    apps.push({ name: app.name, command: app.command, profile, runtime });
  }
  return apps;
}

// ========================================================================
// Build a full topology config for one platform
// ========================================================================

export function buildConfig(platform, { verbose = false } = {}) {
  if (!PLATFORMS[platform]) {
    throw new Error(`unknown platform '${platform}'. Known: ${Object.keys(PLATFORMS).join(', ')}`);
  }
  const appConfigPath = join(AD_DAG, PLATFORMS[platform]);
  if (!existsSync(appConfigPath)) {
    throw new Error(`app_config not found for platform ${platform}: ${appConfigPath}`);
  }

  cfgResolutionWarnings = [];
  const log = (...a) => { if (verbose) console.log(...a); };

  const dataTypes = parseDataFiles(NEXIS_DATA);
  const processes = {};
  const topicToPublisher = {};
  const topicToSubscribers = {};

  function ensureProc(proc, meta, runtime) {
    if (!processes[proc]) {
      processes[proc] = { domain: meta.domain, layer: meta.layer, runtime, pub: [], sub: [] };
    }
    processes[proc].domain = meta.domain;
    processes[proc].layer = meta.layer;
    processes[proc].runtime = runtime;
  }

  function addPub(proc, topic, proto, dataName, options = {}) {
    // A code/fallback publisher must never override a real transport publisher.
    if (options.source === 'codeFallback' && topicToPublisher[topic]) return;
    if (!processes[proc]) processes[proc] = { domain: 'system', layer: 5, runtime: 'unknown', pub: [], sub: [] };
    const existing = processes[proc].pub.find(p => p.topic === topic);
    if (!existing) {
      processes[proc].pub.push({ topic, proto: proto || '', dataName: dataName || topic.split('/').pop() || topic });
    } else if (dataName && !existing.dataName) {
      existing.dataName = dataName;
    }
    topicToPublisher[topic] = proc;
  }

  function addSub(proc, topic, proto, dataName) {
    if (!processes[proc]) processes[proc] = { domain: 'system', layer: 5, runtime: 'unknown', pub: [], sub: [] };
    const existing = processes[proc].sub.find(s => s.topic === topic);
    if (!existing) {
      processes[proc].sub.push({ topic, proto: proto || '', dataName: dataName || topic.split('/').pop() || topic });
    } else if (dataName && !existing.dataName) {
      existing.dataName = dataName;
    }
    if (!topicToSubscribers[topic]) topicToSubscribers[topic] = [];
    if (!topicToSubscribers[topic].includes(proc)) topicToSubscribers[topic].push(proc);
  }

  const appConfig = JSON.parse(readFileSync(appConfigPath, 'utf8'));
  const apps = resolveApps(appConfig);

  // Pass 1: nexis apps — authoritative pub/sub from their `-p` transport.pbtxt.
  for (const app of apps) {
    if (app.runtime !== 'nexis' || !app.profile) continue;
    const tPath = join(NEXIS_DEPLOY, app.profile, 'transport.pbtxt');
    const meta = APP_META[app.name] || { domain: 'system', layer: 5 };
    ensureProc(app.name, meta, 'nexis');
    if (!existsSync(tPath)) {
      cfgResolutionWarnings.push(`nexis app '${app.name}' profile '${app.profile}' has no transport.pbtxt`);
      continue;
    }
    for (const b of parseTransportFile(readFileSync(tPath, 'utf8'))) {
      if (!b.topic) continue;
      const proto = dataTypes[b.name] || '';
      if (b.direction === 'pub') addPub(app.name, b.topic, proto, b.name);
      else addSub(app.name, b.topic, proto, b.name);
    }
  }

  // Pass 2: mainboard (CyberRT) apps — code-defined topics as a fallback only.
  for (const app of apps) {
    if (app.runtime !== 'cyber') continue;
    const meta = APP_META[app.name] || { domain: 'system', layer: 5 };
    ensureProc(app.name, meta, 'cyber');
    const code = CODE_TOPICS[app.name];
    if (!code) continue;
    for (const topic of code.pub) addPub(app.name, topic, '', undefined, { source: 'codeFallback' });
    for (const topic of code.sub) addSub(app.name, topic, '');
  }

  log(`[${platform}] ${Object.keys(processes).length} processes, ` +
      `${Object.keys(topicToPublisher).length} pub, ${Object.keys(topicToSubscribers).length} sub`);
  for (const [name, p] of Object.entries(processes)) {
    log(`  ${name}: ${p.pub.length} pub, ${p.sub.length} sub [${p.domain}/${p.runtime}]`);
  }

  const executorFlows = parseFlowFiles(NEXIS_FLOW);
  const executorTasks = parseTaskFiles(NEXIS_TASK);
  const { processExecutors, executorDependencies } = parseProcessExecutors(NEXIS_TASK, NEXIS_FLOW);

  if (verbose && cfgResolutionWarnings.length > 0) {
    log(`  ${cfgResolutionWarnings.length} warning(s):`);
    for (const w of cfgResolutionWarnings) log(`    WARN: ${w}`);
  }

  return {
    platform,
    processes,
    dataTypes,
    topicToPublisher,
    topicToSubscribers,
    executorFlows,
    executorTasks,
    processExecutors,
    executorDependencies,
    globalServices: GLOBAL_SERVICES,
  };
}

// ========================================================================
// CLI: emit per-platform files + a default mirror for static imports
// ========================================================================

function isMain() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMain()) {
  console.log('Building topology configs (app_config-driven)...');
  for (const platform of Object.keys(PLATFORMS)) {
    const cfg = buildConfig(platform, { verbose: true });
    const out = join(SRC_DIR, `nexis-config.${platform}.json`);
    writeFileSync(out, JSON.stringify(cfg, null, 2));
    console.log(`Written ${out}`);
  }
  // Default mirror consumed by static `import './nexis-config.json'` sites.
  const def = buildConfig(DEFAULT_PLATFORM);
  const defOut = join(SRC_DIR, 'nexis-config.json');
  writeFileSync(defOut, JSON.stringify(def, null, 2));
  console.log(`Written ${defOut} (default platform: ${DEFAULT_PLATFORM})`);
}
