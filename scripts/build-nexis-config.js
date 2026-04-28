#!/usr/bin/env node
/**
 * Build a comprehensive process topology config from ALL sources:
 * 1. Nexis transport.pbtxt (nexis_app deploys)
 * 2. CyberRT DAG files + app_config.json (mainboard processes)
 * 3. Domain knowledge for CyberRT processes that define topics in code
 *
 * Output: nexis-config.json with complete topic→publisher and topic→subscribers mapping.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(__dirname, '..', '..');
const NEXIS_DEPLOY = join(WORKSPACE, 'ad_dag/config/nexis/deploy');
const NEXIS_DATA = join(WORKSPACE, 'ad_dag/config/nexis/resource/data.d');
const APP_CONFIG = join(WORKSPACE, 'ad_dag/conf/app_config.json');
const OUTPUT = join(__dirname, '..', 'src', 'nexis-config.json');

// ========================================================================
// 1. Parse nexis transport.pbtxt
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

// ========================================================================
// 2. CyberRT process topic definitions (from DAG analysis + code knowledge)
//    These processes use CyberRT channels defined in code, not nexis transport.
// ========================================================================

const CYBER_PROCESSES = {
  location: {
    domain: 'localization',
    layer: 1,
    pub: [
      '/localization/100hz/localization_pose',
      '/localization/100hz/localization_vehicle_speed',
      '/localization/100hz/inspvax_gnss_msf',
      '/localization/100hz/inspvax_gnss_msf_02',
      '/localization/100hz/inspvax_gnss_msf_delta',
    ],
    sub: [
      '/sensor/novatel/bestgnsspos',
      '/sensor/novatel/bestgnssvel',
      '/sensor/novatel/Heading',
      '/sensor/novatel/Imu',
      '/canbus/vehicle_speed/Vehicle_speed',
    ],
  },
  planning: {
    domain: 'pnc',
    layer: 4,
    pub: [
      '/pnc/planning',
      '/pnc/pnc_state',
      '/planning/pilot_state',
      '/planning/monitor',
    ],
    sub: [
      '/neo_map_router/router_output',
      '/localization/100hz/localization_pose',
      '/planning/proxy/DuDriveChassis',
      '/pnc/prediction',
      '/state_machine/transition',
    ],
  },
  control: {
    domain: 'pnc',
    layer: 5,
    pub: [
      '/pnc/control',
      '/pnc/control_monitor',
    ],
    sub: [
      '/pnc/planning',
      '/localization/100hz/localization_pose',
      '/planning/proxy/DuDriveChassis',
    ],
  },
  aeb: {
    domain: 'pnc',
    layer: 5,
    pub: ['/aeb/aeb_cmd'],
    sub: [
      '/localization/100hz/localization_pose',
      '/planning/proxy/DuDriveChassis',
    ],
  },
  perception: {
    domain: 'perception',
    layer: 3,
    pub: [
      '/pnc/prediction',
      '/perception/environment_monitor',
    ],
    sub: [
      '/perception/obj_infer',
      '/perception/tld_infer',
    ],
  },
  state_machine: {
    domain: 'system',
    layer: 1,
    pub: ['/state_machine/transition'],
    sub: [],
  },
  guardian_cyber: {
    domain: 'system',
    layer: 1,
    pub: ['/patrol/discode', '/patrol/status'],
    sub: [],
  },
  orin_ivi: {
    domain: 'system',
    layer: 2,
    pub: [
      '/maprouter/location',
      '/maprouter/guideinfo',
      '/maprouter/navirouteinfo',
      '/maprouter/maps',
    ],
    sub: ['/localization/100hz/localization_vehicle_speed'],
  },
  openapi: {
    domain: 'system',
    layer: 1,
    pub: [
      '/openapi/auto_driver_status',
      '/maprouter/routing_request',
      '/maprouter/adjusted_navi_request_info',
      '/openapi_ld/pilot_state',
      '/openapi_ld/zone_report',
      '/openapi_ld/dispatch_request',
    ],
    sub: [],
  },
  dynamic_layer: {
    domain: 'pnc',
    layer: 2,
    pub: [
      '/maprouter/dynamic_layer_on_path',
      '/maprouter/dynamic_layer',
      '/maprouter/dynamic_layer_query_request',
      '/dynamiclayer/vehicle_area_status',
      '/dynamiclayer/dynamic_layer_query_response',
    ],
    sub: [],
  },
  system_monitor: {
    domain: 'system',
    layer: 3,
    pub: [
      '/system/system_monitor',
      '/nexis/security/alarm/alarm_state_data',
      '/neolix/e2e/latency',
    ],
    sub: [],
  },
  dcl: {
    domain: 'system',
    layer: 6,
    pub: ['/dcl/report'],
    sub: [],
  },
  lidar_freespace: {
    domain: 'perception',
    layer: 2,
    pub: ['/mapping/lidar_freespace_3d'],
    sub: [],
  },
  mpu_monitor: { domain: 'system', layer: 6, pub: [], sub: [] },
  tsp_client: { domain: 'system', layer: 6, pub: [], sub: [] },
};

// ========================================================================
// 3. Nexis deploy → process name mapping + domain/layer
// ========================================================================

const NEXIS_META = {
  neo_sensor:      { process: 'neo_sensor',    domain: 'sensor',       layer: 0 },
  neo_camera:      { process: 'neo_camera',    domain: 'sensor',       layer: 0 },
  neo_canbus:      { process: 'neo_canbus',    domain: 'sensor',       layer: 0 },
  neo_lidar:       { process: 'neo_lidar',     domain: 'sensor',       layer: 0 },
  model_infer:     { process: 'model_infer',   domain: 'perception',   layer: 2 },
  x86_model_infer: { process: 'model_infer',   domain: 'perception',   layer: 2 },
  localization:    { process: 'location',      domain: 'localization', layer: 1 },
  map_router:      { process: 'map_router',    domain: 'maprouter',    layer: 3 },
  default:         { process: 'default',       domain: 'system',       layer: 3 },
  fault_manager:   { process: 'fault_manager', domain: 'system',       layer: 4 },
};

// ========================================================================
// 4. Parse flow.d — executor scheduling (bundle definitions)
// ========================================================================

const NEXIS_FLOW = join(WORKSPACE, 'ad_dag/config/nexis/resource/flow.d');

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

// ========================================================================
// 5. Parse task.d — executor task definitions (so, class, config)
// ========================================================================

const NEXIS_TASK = join(WORKSPACE, 'ad_dag/config/nexis/resource/task.d');

// Base directories to search when resolving a relative cfg_file path. Order
// matters: production deployment first, then source-tree mirrors so we catch
// modules whose configs live next to their code. Add new bases here if a
// module ships configs under a non-standard prefix.
const CFG_RESOLUTION_BASES = (() => {
  const bases = [
    '/home/caros/cyberrt',
    '/home/caros/cyberrt/conf',
    '/home/caros/x86_64/opt',
    '/home/caros/adu',
    '/home/caros',
    WORKSPACE,
  ];
  // Each first-level workspace subdirectory is also a valid base, since many
  // modules carry their own conf/ and config/ trees that task.d entries
  // reference with a `conf/...` or `config/...` relative path.
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

const cfgResolutionWarnings = [];

function resolveCfgFile(rawPath) {
  if (!rawPath) return rawPath;
  // Already absolute and present? leave as-is. Absolute but missing? still
  // leave it (don't silently rewrite a value the user explicitly authored).
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

// ========================================================================
// 6. Parse process executors — multi-executor per process + dependency chain
// ========================================================================

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

      // Parse node lines: "inputBundle << executorName >> output1 output2"
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

      // Parse bundle lines to get inputs for each bundle
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

        // Attach inputs to the executor that uses this bundle
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
      // Skip capture, emitter, emit types and known non-executor classes
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
  // Two data names in different executors may map to the same topic, creating
  // a dependency that cannot be seen from data names alone.
  const NEXIS_DEPLOY = join(WORKSPACE, 'ad_dag/config/nexis/deploy');

  for (const [processName, executors] of Object.entries(processExecutors)) {
    const deps = []; // { from, to, topic, fromData, toData }

    // Build dataName -> topic mapping from transport.pbtxt
    const transportPath = join(NEXIS_DEPLOY, processName, 'transport.pbtxt');
    const dataNameToTopic = {};   // dataName -> { topic, direction }
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

    // Build output topic -> executor className mapping
    const outputTopicToExec = {}; // topic -> { className, dataName }
    for (const ex of executors) {
      for (const outData of ex.outputs) {
        const mapping = dataNameToTopic[outData];
        if (mapping) {
          outputTopicToExec[mapping.topic] = { className: ex.className, dataName: outData };
        }
      }
    }

    // Check each executor's inputs: if any input's topic matches an output topic
    // from another executor in the same process, that's a dependency.
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

    // Fallback: also check direct data name matches (for processes without transport)
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
// Main
// ========================================================================

console.log('Building comprehensive topology config...');

const dataTypes = parseDataFiles(NEXIS_DATA);
console.log(`  ${Object.keys(dataTypes).length} data type definitions`);

// All processes: { processName: { domain, layer, pub: [{topic,proto}], sub: [{topic,proto}] } }
const processes = {};
const topicToPublisher = {};
const topicToSubscribers = {};

function addPub(proc, topic, proto, dataName) {
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

// --- Nexis transport ---
if (existsSync(NEXIS_DEPLOY)) {
  for (const dir of readdirSync(NEXIS_DEPLOY)) {
    const tPath = join(NEXIS_DEPLOY, dir, 'transport.pbtxt');
    if (!existsSync(tPath)) continue;
    const blocks = parseTransportFile(readFileSync(tPath, 'utf8'));
    const meta = NEXIS_META[dir] || { process: dir, domain: 'system', layer: 5 };
    const proc = meta.process;
    if (!processes[proc]) processes[proc] = { domain: meta.domain, layer: meta.layer, runtime: 'nexis', pub: [], sub: [] };
    processes[proc].domain = meta.domain;
    processes[proc].layer = meta.layer;
    processes[proc].runtime = 'nexis';

    for (const b of blocks) {
      if (!b.topic) continue;
      const proto = dataTypes[b.name] || '';
      if (b.direction === 'pub') addPub(proc, b.topic, proto, b.name);
      else addSub(proc, b.topic, proto, b.name);
    }
  }
}

// --- CyberRT processes ---
for (const [proc, info] of Object.entries(CYBER_PROCESSES)) {
  if (!processes[proc]) processes[proc] = { domain: info.domain, layer: info.layer, runtime: 'cyber', pub: [], sub: [] };
  processes[proc].domain = info.domain;
  processes[proc].layer = info.layer;
  processes[proc].runtime = 'cyber';
  for (const topic of info.pub) addPub(proc, topic, '');
  for (const topic of info.sub) addSub(proc, topic, '');
}

// --- Summary ---
const totalPub = Object.keys(topicToPublisher).length;
const totalSub = Object.keys(topicToSubscribers).length;
const totalProc = Object.keys(processes).length;

console.log(`  ${totalProc} processes`);
console.log(`  ${totalPub} publisher mappings`);
console.log(`  ${totalSub} subscriber mappings`);

for (const [name, p] of Object.entries(processes)) {
  console.log(`  ${name}: ${p.pub.length} pub, ${p.sub.length} sub [${p.domain}]`);
}

// --- Parse flow definitions ---
const executorFlows = parseFlowFiles(NEXIS_FLOW);
console.log(`  ${Object.keys(executorFlows).length} executor flow definitions`);
for (const [name, flow] of Object.entries(executorFlows)) {
  console.log(`    ${name}: ${flow.hz}Hz, ${flow.requiredInputs.length} required, ${flow.optionalInputs.length} optional`);
}

// --- Parse task definitions ---
const executorTasks = parseTaskFiles(NEXIS_TASK);
console.log(`  ${Object.keys(executorTasks).length} executor task definitions`);
for (const [cls, task] of Object.entries(executorTasks)) {
  console.log(`    ${cls}: ${task.libName} cfg=[${task.cfgFiles.join(', ')}]`);
}
if (cfgResolutionWarnings.length > 0) {
  console.log(`  ${cfgResolutionWarnings.length} cfg_file resolution warning(s):`);
  for (const w of cfgResolutionWarnings) {
    console.log(`    WARN: ${w}`);
  }
}

// --- Parse process executors ---
const { processExecutors, executorDependencies } = parseProcessExecutors(NEXIS_TASK, NEXIS_FLOW);
console.log(`  ${Object.keys(processExecutors).length} processes with testable executors`);
for (const [proc, execs] of Object.entries(processExecutors)) {
  const deps = executorDependencies[proc] || [];
  console.log(`    ${proc}: ${execs.map(e => e.className).join(', ')}${deps.length > 0 ? ` (${deps.length} deps)` : ''}`);
}

// --- Auto-alias: task.d names may differ from topology process names.
// For each processExecutors key not in processes, try to find a matching
// process by checking scene.pbtxt executor references or fuzzy name matching.
const processNames = new Set(Object.keys(processes));
const execKeysCopy = Object.keys(processExecutors).filter(k => !processNames.has(k));

for (const taskKey of execKeysCopy) {
  // Strategy 1: Check scene.pbtxt — if a deploy/<taskKey>/scene.pbtxt exists,
  // its order lines reference executor names that appear in processExecutors[taskKey].
  // The process name in the topology is whoever has those executors' pub/sub topics.
  const execs = processExecutors[taskKey];
  if (!execs || execs.length === 0) { continue; }

  // Strategy 0: Known abbreviations (highest priority)
  const KNOWN_ABBREVIATIONS = { 'lfc': 'lidar_freespace' };
  let matched = null;
  if (KNOWN_ABBREVIATIONS[taskKey] && processNames.has(KNOWN_ABBREVIATIONS[taskKey])) {
    matched = KNOWN_ABBREVIATIONS[taskKey];
  }

  // Strategy 2: Find a process whose pub dataNames overlap with executor outputs.
  if (!matched) {
  for (const procName of processNames) {
    // Check if the process sub/pub topics overlap with executor inputs/outputs
    const proc = processes[procName];
    if (!proc) { continue; }
    const procSubTopics = new Set((proc.sub || []).map(s => s.topic));
    // If any executor's input topic (resolved via transport) appears in process subs
    for (const ex of execs) {
      for (const outDataName of ex.outputs) {
        const procPub = (proc.pub || []).find(p => p.dataName === outDataName);
        if (procPub) { matched = procName; break; }
      }
      if (matched) { break; }
    }
    if (matched) { break; }
  }
  }

  // Strategy 3: fuzzy name match
  if (!matched) {
    const kw = taskKey.replace(/_/g, '').toLowerCase();
    for (const procName of processNames) {
      const pkw = procName.replace(/_/g, '').toLowerCase();
      if (kw.includes(pkw) || pkw.includes(kw) ||
          kw.slice(0, 4) === pkw.slice(0, 4) ||
          pkw.includes(kw.slice(0, 3))) {
        matched = procName;
        break;
      }
    }
  }

  if (matched && !processExecutors[matched]) {
    processExecutors[matched] = processExecutors[taskKey];
    if (executorDependencies[taskKey]) {
      executorDependencies[matched] = executorDependencies[taskKey];
    }
    console.log(`  alias: ${taskKey} -> ${matched}`);
  }
}

const globalServices = {
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

const config = { processes, dataTypes, topicToPublisher, topicToSubscribers, executorFlows, executorTasks, processExecutors, executorDependencies, globalServices };
writeFileSync(OUTPUT, JSON.stringify(config, null, 2));
console.log(`\nWritten to ${OUTPUT}`);
