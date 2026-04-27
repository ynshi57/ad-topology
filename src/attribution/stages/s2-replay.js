/**
 * S2 Offline Replay — run executor process() on mcap data, collect per-frame metrics.
 * Ported from test-panel.js replayExecutorMode logic.
 */

import nexisConfig from '../../nexis-config.json';
import { evaluateRules } from '../rules/index.js';

export default {
  id: 'S2',
  name: 'Replay',

  async run(ctx) {
    const ws = ctx.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('S1 did not establish WS connection');
    }

    const inputTopics = ctx.inputTopics;
    if (inputTopics.length === 0) {
      return { status: 'warn', warnings: ['No input topics configured'], frameTimes: [], findings: [] };
    }

    // Use shared msgDataCache from main.js instead of re-scanning the mcap file.
    // Falls back to full mcap scan if cache is not available.
    let rawMsgs;
    if (ctx.msgDataCache && ctx.startTimeNs != null) {
      console.log('[S2] Using shared msgDataCache for', inputTopics.length, 'input topics');
      rawMsgs = buildRawMsgsFromCache(ctx.msgDataCache, inputTopics, ctx.startTimeNs);
      console.log('[S2] Got', rawMsgs.length, 'messages from cache');
    } else {
      const readers = ctx.summary?.readers;
      if (!readers || readers.length === 0) {
        throw new Error('No mcap readers and no msgDataCache in session');
      }
      console.log('[S2] Cache unavailable, scanning mcap for', inputTopics.length, 'input topics...');
      rawMsgs = await readRawMessages(readers, inputTopics, ctx.summary.startTimeNs, ctx.summary.endTimeNs);
      console.log('[S2] Found', rawMsgs.length, 'messages from mcap scan');
    }
    if (rawMsgs.length === 0) {
      return { status: 'warn', warnings: ['No messages found for input topics'], frameTimes: [], findings: [] };
    }

    const topicToDataName = buildTopicToDataNameMap(ctx.nodeId);
    const topicToProto = buildTopicToProtoMap(ctx.nodeId);
    const flow = findExecutorFlow(ctx.nodeId);
    const hz = ctx.hz;
    const intervalNs = BigInt(Math.floor(1e9 / hz));
    const allRequiredFromFlow = flow?.requiredInputs || [];
    const availableDataNames = new Set();
    for (const msg of rawMsgs) {
      const dn = topicToDataName.get(msg.topic);
      if (dn) {
        availableDataNames.add(dn);
      }
    }
    const requiredSet = new Set(allRequiredFromFlow.filter(r => availableDataNames.has(r)));

    const startTime = rawMsgs[0].logTime;
    const endTime = rawMsgs[rawMsgs.length - 1].logTime;

    const latestValues = new Map();
    let msgCursor = 0;
    let tickTime = startTime;

    const frameTimes = [];
    const frameResults = [];
    const allInputMetrics = [];
    const allOutputMetrics = [];
    const stderrLines = [];
    let okFrames = 0;
    let totalFrames = 0;
    let skippedTicks = 0;

    const waitForResponse = () => new Promise((resolve, reject) => {
      const TIMEOUT_MS = 30000;
      let timer = null;
      const handler = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.cmd === 'process_result') {
          clearTimeout(timer);
          ws.removeEventListener('message', handler);
          resolve(msg);
        }
        if (msg.type === 'stderr') {
          stderrLines.push(msg.message || '');
          ctx.stderrLines.push(msg.message || '');
        }
      };
      ws.addEventListener('message', handler);
      timer = setTimeout(() => {
        ws.removeEventListener('message', handler);
        reject(new Error('Timeout waiting for process_result (30s). Check browser console for WS state.'));
      }, TIMEOUT_MS);
    });

    console.log('[S2] Starting replay loop: requiredSet=', [...requiredSet], 'hz=', hz, 'totalMsgs=', rawMsgs.length);
    console.log('[S2] WS readyState=', ws.readyState, '(OPEN=1)');

    // Start perf sampling in background if harness PID is available
    if (ctx.harnessPid) {
      try {
        const perfResp = await fetch('http://localhost:8765/perf-start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid: ctx.harnessPid, freq: 99 }),
        });
        const perfData = await perfResp.json();
        console.log('[S2] perf-start:', perfData.ok ? 'attached' : perfData.error);
      } catch (e) {
        console.warn('[S2] perf-start failed:', e.message);
      }
    }

    while (tickTime <= endTime) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[S2] WS closed during replay, breaking');
        break;
      }

      while (msgCursor < rawMsgs.length && rawMsgs[msgCursor].logTime <= tickTime) {
        const msg = rawMsgs[msgCursor];
        const dataName = topicToDataName.get(msg.topic) || msg.topic.split('/').pop() || msg.topic;
        const encoding = msg.schemaEncoding || 'protobuf';
        const protoType = encoding === 'protobuf'
          ? (topicToProto.get(msg.topic) || msg.schemaName || '') : '';
        latestValues.set(dataName, { data: msg.data, ts: msg.logTime, protoType, encoding });
        msgCursor++;
      }

      let shouldProcess = latestValues.size > 0;
      if (requiredSet.size > 0) {
        for (const req of requiredSet) {
          if (!latestValues.has(req)) {
            shouldProcess = false;
            break;
          }
        }
      }

      if (shouldProcess) {
        const inputs = [];
        for (const [name, val] of latestValues) {
          if (val.encoding && val.encoding !== 'protobuf') {
            continue;
          }
          if (!val.protoType) {
            continue;
          }
          inputs.push({
            name,
            timestamp_ns: Number(val.ts),
            data_base64: uint8ToBase64(val.data),
            proto_type: val.protoType,
          });
        }

        if (totalFrames === 0) {
          console.log('[S2] Sending first process frame with', inputs.length, 'inputs');
        }
        ws.send(JSON.stringify({ cmd: 'process', frames: [{ timestamp_ns: Number(tickTime), inputs }] }));
        const resp = await waitForResponse();

        for (const r of (resp.results || [])) {
          totalFrames++;
          const ok = r.status_code === 1 || r.status === 'kProcessOk';
          if (ok) {
            okFrames++;
          }
          frameTimes.push(r.process_time_ms || 0);
          frameResults.push(r);
          if (r.input_metrics) {
            allInputMetrics.push(...r.input_metrics);
          }
          if (r.output_metrics) {
            allOutputMetrics.push(...r.output_metrics);
          }
        }
      } else {
        skippedTicks++;
      }

      tickTime = tickTime + intervalNs;
    }

    const evidence = {
      totalFrames,
      okFrames,
      frameTimes,
      stderrLines,
    };
    // Run perf_replay: send all frames as a batch to harness for tight-loop
    // execution while perf is sampling, then stop perf.
    if (ctx.harnessPid) {
      try {
        // Build batch frames from the last N frames (or all if small)
        const batchSize = Math.min(totalFrames, 50);
        const batchFrames = [];
        const latestValues2 = new Map();
        let cursor2 = 0;
        let tick2 = rawMsgs[0].logTime;
        let collected = 0;

        while (tick2 <= rawMsgs[rawMsgs.length - 1].logTime && collected < batchSize) {
          while (cursor2 < rawMsgs.length && rawMsgs[cursor2].logTime <= tick2) {
            const msg = rawMsgs[cursor2];
            const dataName = topicToDataName.get(msg.topic) || msg.topic.split('/').pop() || msg.topic;
            const encoding = msg.schemaEncoding || 'protobuf';
            const protoType = encoding === 'protobuf'
              ? (topicToProto.get(msg.topic) || msg.schemaName || '') : '';
            latestValues2.set(dataName, { data: msg.data, ts: msg.logTime, protoType, encoding });
            cursor2++;
          }

          if (latestValues2.size > 0) {
            const inputs = [];
            for (const [name, val] of latestValues2) {
              if (val.encoding && val.encoding !== 'protobuf') { continue; }
              if (!val.protoType) { continue; }
              inputs.push({
                name,
                timestamp_ns: Number(val.ts),
                data_base64: uint8ToBase64(val.data),
                proto_type: val.protoType,
              });
            }
            if (inputs.length > 0) {
              batchFrames.push({ timestamp_ns: Number(tick2), inputs });
              collected++;
            }
          }
          tick2 = tick2 + intervalNs;
        }

        if (batchFrames.length > 0) {
          console.log('[S2] perf_replay: sending', batchFrames.length, 'frames x20 repeats');

          const perfReplayPromise = new Promise((resolve) => {
            const handler = (event) => {
              const msg = JSON.parse(event.data);
              if (msg.cmd === 'perf_replay_result') {
                ws.removeEventListener('message', handler);
                resolve(msg);
              }
            };
            ws.addEventListener('message', handler);
            setTimeout(() => { ws.removeEventListener('message', handler); resolve(null); }, 60000);
          });

          ws.send(JSON.stringify({
            cmd: 'perf_replay',
            frames: batchFrames,
            repeat: 20,
          }));

          const perfReplayResult = await perfReplayPromise;
          if (perfReplayResult) {
            console.log('[S2] perf_replay done:', perfReplayResult.total_frames, 'frames,',
                        perfReplayResult.avg_ms?.toFixed(3), 'ms avg');
          }
        }

        // Now stop perf and collect results
        const stopResp = await fetch('http://localhost:8765/perf-stop', { method: 'POST' });
        if (stopResp.ok) {
          const perfResult = await stopResp.json();
          ctx.setEvidence('S5', 'perfFromS2', perfResult);
          console.log('[S2] perf-stop: samples=', perfResult.totalSamples);
        }
      } catch (e) {
        console.warn('[S2] perf collection failed:', e.message);
      }
    }

    ctx.setEvidence('S2', 'totalFrames', totalFrames);
    ctx.setEvidence('S2', 'okFrames', okFrames);
    ctx.setEvidence('S2', 'frameTimes', frameTimes);
    ctx.setEvidence('S2', 'stderrLines', stderrLines);
    ctx.setEvidence('S2', 'allInputMetrics', allInputMetrics);
    ctx.setEvidence('S2', 'allOutputMetrics', allOutputMetrics);

    const findings = evaluateRules('S2', { ...evidence, ...ctx.evidence.S2 }, ctx);
    for (const f of findings) {
      ctx.addFinding(f);
    }

    const warnings = findings.filter(f => f.severity === 'warn').map(f => f.finding);
    const errors = findings.filter(f => f.severity === 'error');

    return {
      status: errors.length > 0 ? 'failed' : warnings.length > 0 ? 'warn' : 'passed',
      totalFrames,
      okFrames,
      skippedTicks,
      totalMessages: rawMsgs.length,
      frameTimes,
      warnings,
      findings,
    };
  },

  render(el, result) {
    const times = result.frameTimes || [];
    const avg = times.length > 0 ? (times.reduce((a, b) => a + b, 0) / times.length) : 0;
    const max = times.length > 0 ? Math.max(...times) : 0;
    const sorted = [...times].sort((a, b) => a - b);
    const p50 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)] : 0;
    const p99 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.99)] : 0;

    el.innerHTML = `
      <div class="at-stats-row">
        <div class="at-stat"><span class="at-stat-val">${result.totalFrames}</span><span class="at-stat-label">Frames</span></div>
        <div class="at-stat"><span class="at-stat-val">${result.okFrames}</span><span class="at-stat-label">OK</span></div>
        <div class="at-stat"><span class="at-stat-val">${result.skippedTicks}</span><span class="at-stat-label">Skipped</span></div>
        <div class="at-stat"><span class="at-stat-val">${avg.toFixed(2)}ms</span><span class="at-stat-label">Avg</span></div>
        <div class="at-stat"><span class="at-stat-val">${p50.toFixed(2)}ms</span><span class="at-stat-label">p50</span></div>
        <div class="at-stat"><span class="at-stat-val">${p99.toFixed(2)}ms</span><span class="at-stat-label">p99</span></div>
        <div class="at-stat"><span class="at-stat-val">${max.toFixed(2)}ms</span><span class="at-stat-label">Max</span></div>
      </div>
      ${(result.findings || []).map(f =>
        `<div class="at-finding at-finding-${f.severity}"><strong>[${f.ruleId}]</strong> ${esc(f.finding)}</div>`
      ).join('')}
    `;
  },
};

function buildTopicToDataNameMap(nodeId) {
  const map = new Map();
  const proc = nexisConfig.processes?.[nodeId];
  if (proc) {
    for (const sub of proc.sub || []) {
      if (sub.topic && sub.dataName) {
        map.set(sub.topic, sub.dataName);
      }
    }
  }
  return map;
}

function buildTopicToProtoMap(nodeId) {
  const map = new Map();
  const proc = nexisConfig.processes?.[nodeId];
  if (proc) {
    for (const sub of proc.sub || []) {
      if (sub.topic && sub.proto) {
        map.set(sub.topic, sub.proto);
      }
    }
  }
  if (nexisConfig.dataTypes) {
    const proc2 = nexisConfig.processes?.[nodeId];
    if (proc2) {
      for (const sub of proc2.sub || []) {
        const type = nexisConfig.dataTypes[sub.dataName];
        if (type && !map.has(sub.topic)) {
          map.set(sub.topic, type);
        }
      }
    }
  }
  return map;
}

function findExecutorFlow(nodeId) {
  const flows = nexisConfig.executorFlows || {};
  const kw = nodeId.replace(/_/g, '');
  for (const [name, flow] of Object.entries(flows)) {
    const nkw = name.replace(/_/g, '');
    if (nkw.includes(kw) || kw.includes(nkw.replace('executor', ''))) {
      return flow;
    }
  }
  return null;
}

async function readRawMessages(readers, topics, startNs, endNs) {
  const msgs = [];
  const topicSet = new Set(topics);
  for (const { reader } of readers) {
    for await (const msg of reader.readMessages({ startTime: startNs, endTime: endNs })) {
      const ch = reader.channelsById.get(msg.channelId);
      if (!ch || !topicSet.has(ch.topic)) {
        continue;
      }
      const schema = reader.schemasById.get(ch.schemaId);
      msgs.push({
        topic: ch.topic,
        logTime: msg.logTime,
        data: new Uint8Array(msg.data),
        schemaName: schema?.name || '',
        schemaEncoding: schema?.encoding || '',
      });
    }
  }
  msgs.sort((a, b) => (a.logTime < b.logTime ? -1 : a.logTime > b.logTime ? 1 : 0));
  return msgs;
}

function uint8ToBase64(u8) {
  let binary = '';
  for (let i = 0; i < u8.byteLength; i++) {
    binary += String.fromCharCode(u8[i]);
  }
  return btoa(binary);
}

/**
 * Build rawMsgs array from the shared msgDataCache (populated by main.js buildMessageIndex).
 * Each entry in msgDataCache[topic] has { sec, schemaId, data, size, decoded }.
 * We reconstruct the same shape that readRawMessages produces: { topic, logTime, data, schemaName, schemaEncoding }.
 */
function buildRawMsgsFromCache(cache, inputTopics, startTimeNs) {
  const msgs = [];
  for (const topic of inputTopics) {
    const entries = cache[topic];
    if (!entries || entries.length === 0) {
      continue;
    }
    for (const entry of entries) {
      msgs.push({
        topic,
        logTime: startTimeNs + BigInt(Math.round(entry.sec * 1e9)),
        data: entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data || []),
        schemaName: '',
        schemaEncoding: 'protobuf',
      });
    }
  }
  msgs.sort((a, b) => (a.logTime < b.logTime ? -1 : a.logTime > b.logTime ? 1 : 0));
  return msgs;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
