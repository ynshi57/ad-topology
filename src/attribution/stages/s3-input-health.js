/**
 * S3 Input Health — analyze input topic frequency, missing required, timing jitter.
 */

import nexisConfig from '../../nexis-config.json';
import { evaluateRules } from '../rules/index.js';

export default {
  id: 'S3',
  name: 'Input Health',

  async run(ctx) {
    const readers = ctx.summary?.readers;
    if (!readers) {
      throw new Error('No mcap readers');
    }

    const inputTopics = ctx.inputTopics;
    const topicStats = {};
    for (const topic of inputTopics) {
      topicStats[topic] = { count: 0, firstNs: 0, lastNs: 0, actualHz: 0, designHz: 0 };
    }

    const proc = nexisConfig.processes?.[ctx.nodeId];
    const flow = findFlow(ctx.nodeId);
    const requiredDataNames = new Set(flow?.requiredInputs || []);
    const dataNameToTopic = new Map();
    if (proc) {
      for (const sub of proc.sub || []) {
        if (sub.dataName && sub.topic) {
          dataNameToTopic.set(sub.dataName, sub.topic);
        }
      }
    }

    for (const { reader } of readers) {
      const stats = reader.statistics;
      if (!stats) {
        continue;
      }
      for (const [channelId, channel] of reader.channelsById) {
        if (!topicStats[channel.topic]) {
          continue;
        }
        const msgCount = Number(stats.channelMessageCounts?.get(channelId) ?? 0);
        const startNs = stats.messageStartTime;
        const endNs = stats.messageEndTime;
        const durationSec = Number(endNs - startNs) / 1e9;

        topicStats[channel.topic].count += msgCount;
        if (!topicStats[channel.topic].firstNs || startNs < topicStats[channel.topic].firstNs) {
          topicStats[channel.topic].firstNs = startNs;
        }
        if (endNs > topicStats[channel.topic].lastNs) {
          topicStats[channel.topic].lastNs = endNs;
        }
        topicStats[channel.topic].actualHz = durationSec > 0 ? Math.round(msgCount / durationSec * 10) / 10 : 0;
      }
    }

    const missingRequired = [];
    for (const dn of requiredDataNames) {
      const topic = dataNameToTopic.get(dn);
      if (topic && topicStats[topic] && topicStats[topic].count === 0) {
        missingRequired.push(dn);
      }
      if (!topic) {
        missingRequired.push(`${dn} (no topic mapping)`);
      }
    }

    const evidence = { topicStats, missingRequired, stderrLines: ctx.stderrLines };
    ctx.setEvidence('S3', 'topicStats', topicStats);
    ctx.setEvidence('S3', 'missingRequired', missingRequired);

    const findings = evaluateRules('S3', evidence, ctx);
    for (const f of findings) {
      ctx.addFinding(f);
    }

    const warnings = findings.filter(f => f.severity === 'warn').map(f => f.finding);
    const errors = findings.filter(f => f.severity === 'error');

    const channels = Object.entries(topicStats).map(([topic, s]) => ({
      topic,
      count: s.count,
      hz: s.actualHz,
      healthy: s.count > 0,
    }));

    return {
      status: errors.length > 0 ? 'failed' : warnings.length > 0 ? 'warn' : 'passed',
      channels,
      missingRequired,
      warnings,
      findings,
    };
  },

  render(el, result) {
    const rows = (result.channels || []).map(ch => {
      const cls = ch.healthy ? 'at-health-ok' : 'at-health-bad';
      const bar = ch.healthy ? '\u2588'.repeat(Math.min(Math.ceil(ch.hz / 5), 10)) : '\u2588';
      return `<div class="at-health-row ${cls}">
        <span class="at-health-indicator">${ch.healthy ? '\u25CF' : '\u26A0'}</span>
        <span class="at-health-topic">${esc(ch.topic)}</span>
        <span class="at-health-hz">${ch.hz} Hz</span>
        <span class="at-health-count">${ch.count} msgs</span>
        <span class="at-health-bar">${bar}</span>
      </div>`;
    }).join('');

    el.innerHTML = `
      <div class="at-health-grid">${rows}</div>
      ${result.missingRequired?.length > 0
        ? `<div class="at-finding at-finding-warn">Missing required: ${result.missingRequired.join(', ')}</div>`
        : ''}
      ${(result.findings || []).map(f =>
        `<div class="at-finding at-finding-${f.severity}"><strong>[${f.ruleId}]</strong> ${esc(f.finding)}</div>`
      ).join('')}
    `;
  },
};

function findFlow(nodeId) {
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

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
