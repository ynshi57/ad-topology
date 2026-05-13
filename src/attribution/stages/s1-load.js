/**
 * S1 Load — load .so + config + verify dependencies.
 * Connects to harness WS, sends load command, captures stderr for config warnings.
 */

import { evaluateRules } from '../rules/index.js';

const WS_URL = 'ws://localhost:8765';

export default {
  id: 'S1',
  name: 'Load',

  async run(ctx) {
    const warnings = [];
    const stderrLines = [];

    const ws = await connectWs(WS_URL);
    ctx.ws = ws;

    return new Promise((resolve, reject) => {
      let resolved = false;

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'stderr') {
          stderrLines.push(msg.message || '');
          ctx.stderrLines.push(msg.message || '');
        }

        if (msg.cmd === 'load_result') {
          resolved = true;
          const evidence = { stderrLines, loadError: msg.success ? null : msg.error };
          ctx.setEvidence('S1', 'stderrLines', stderrLines);
          ctx.setEvidence('S1', 'loadMode', msg.mode);

          const findings = evaluateRules('S1', evidence, ctx);
          for (const f of findings) {
            ctx.addFinding(f);
            if (f.severity === 'warn') {
              warnings.push(f.finding);
            }
          }

          // Clear the onmessage handler so S2's addEventListener-based
          // waitForResponse doesn't get starved by this stale handler.
          ws.onmessage = null;

          if (!msg.success) {
            const execErrors = (msg.executors || [])
              .filter(e => !e.success)
              .map(e => `${e.class}: ${e.error || 'unknown'}`)
              .join('; ');
            const detail = msg.error || msg.message || execErrors || 'Load failed';
            reject(new Error(detail));
          } else {
            if (msg.pid) {
              ctx.harnessPid = msg.pid;
            }
            resolve({
              status: warnings.length > 0 ? 'warn' : 'passed',
              mode: msg.mode,
              stderrLines,
              warnings,
              findings,
              executorResults: msg.executors || [],
            });
          }
        }
      };

      ws.onerror = () => {
        if (!resolved) {
          reject(new Error('WebSocket error — is the server running?'));
        }
      };

      // Single-executor mode: use session's soPath/className/configPaths
      // (populated from left panel inputs, which reflect selected executor)
      ws.send(JSON.stringify({
        cmd: 'load',
        so_path: ctx.soPath,
        class: ctx.className,
        config_paths: ctx.configPaths,
        input_topics: ctx.inputTopics,
        output_topics: ctx.outputTopics,
        output_data_names: ctx.outputDataNames,
        output_proto_types: ctx.outputProtoTypes || {},
        runtime: ctx.runtime,
      }));
    });
  },

  render(el, result) {
    const execResults = result.executorResults || [];
    const execHtml = execResults.length > 0
      ? execResults.map(er => `<div class="at-kv" style="margin-left:8px">
          <span>${esc(er.class)}:</span> <strong>${er.success ? 'OK' : 'FAILED'}</strong>
          ${er.error ? `<span style="color:#ef4444"> ${esc(er.error)}</span>` : ''}
        </div>`).join('')
      : '';

    el.innerHTML = `
      <div class="at-kv"><span>Mode:</span> <strong>${result.mode || 'unknown'}</strong></div>
      ${execHtml}
      <div class="at-kv"><span>Warnings:</span> <strong>${result.warnings?.length || 0}</strong></div>
      ${(result.findings || []).map(f =>
        `<div class="at-finding at-finding-${f.severity}"><strong>[${f.ruleId}]</strong> ${esc(f.finding)}</div>`
      ).join('')}
      ${result.stderrLines?.length > 0 ? `<details><summary>stderr (${result.stderrLines.length} lines)</summary><pre class="at-pre">${result.stderrLines.map(esc).join('\n')}</pre></details>` : ''}
    `;
  },
};

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`Cannot connect to ${url}`));
  });
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
