/**
 * Fault RCA view — aligns /nexis/security/alarm/alarm_state_data (raw per-module
 * alarms) with /nexis/security/alarm/fault_process (fault_manager output) on a
 * timeline, and for each output event shows an inferred root-cause chain.
 *
 * All causality is inferred (see attribution.js); edges carry confidence labels.
 */
import * as d3 from 'd3';
import { createSplitter } from '../splitter.js';
import {
  ALARM_TOPIC, FAULT_TOPIC,
  buildStreamsFromCache, buildAlarmTracks, buildFaultEvents,
} from './fault-events.js';
import { attribute, computeEpisodeScope, Confidence } from './attribution.js';
import { lookupFault } from './fault-catalog.js';

const DC = {
  sensor: '#4db8c7', perception: '#c7943a', localization: '#3aaa7a',
  pnc: '#5b8fd9', system: '#8a73c7', recorder: '#777777',
  maprouter: '#d4884d', openapi: '#6b8f8f', unknown: '#555',
};
const DOMAIN_COLOR = {
  PERCEPTION: DC.perception, LOCALIZATION: DC.localization, PNC: DC.pnc,
  SYSTEM: DC.system, OTHER: DC.unknown,
};
const CONF_LABEL = {
  [Confidence.OBSERVED]: '观测(时间先后)',
  [Confidence.CONFIGURED]: '配置(同topic)',
  [Confidence.INFERRED]: '推断(pub/sub图)',
};

/**
 * @param {HTMLElement} container
 * @param {object} opts
 *   msgDataCache, decode(entry)->decodedObj|null, nexisConfig, durationSec,
 *   platform, onBack
 */
export function createFaultRcaView(container, opts) {
  const { msgDataCache, decode, nexisConfig, durationSec = 0, platform = '', onBack } = opts;

  const el = document.createElement('div');
  el.className = 'fr-view';
  container.appendChild(el);

  // --- Build data ---
  const { alarmStream, faultStream } = buildStreamsFromCache(msgDataCache || {}, decode);
  const alarmResult = buildAlarmTracks(alarmStream);
  const faultEvents = buildFaultEvents(faultStream);

  const hasAlarmTopic = !!(msgDataCache && msgDataCache[ALARM_TOPIC]);
  const hasFaultTopic = !!(msgDataCache && msgDataCache[FAULT_TOPIC]);
  const decodedOk = alarmStream.length > 0 || faultStream.length > 0;

  const splitters = [];

  el.innerHTML = `
    <div class="fr-header">
      <button class="fr-back" id="fr-back">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7" fill="none" stroke="currentColor" stroke-width="2"/></svg>
        Back
      </button>
      <div class="fr-title">
        <span class="view-label">Fault RCA</span>
        <span>fault_manager 故障归因</span>
        ${platform ? `<span class="fr-badge">${esc(platform)}</span>` : ''}
      </div>
      <div class="fr-stats">
        <span class="fr-stat">${faultEvents.length} 事件</span>
        <span class="fr-stat">${alarmResult.tracks.length} 告警码</span>
      </div>
    </div>
    <div class="fr-body" id="fr-body"></div>
    <div class="fr-gantt" id="fr-gantt"></div>
  `;

  el.querySelector('#fr-back').addEventListener('click', () => { if (onBack) onBack(); });

  const body = el.querySelector('#fr-body');

  if (!decodedOk) {
    body.innerHTML = `
      <div class="fr-empty">
        <p>无法从当前 mcap 解析告警/故障数据。</p>
        <ul>
          <li>${ALARM_TOPIC}: ${hasAlarmTopic ? '存在但未解码(缺 proto 描述符?)' : '录制中不存在'}</li>
          <li>${FAULT_TOPIC}: ${hasFaultTopic ? '存在但未解码(缺 proto 描述符?)' : '录制中不存在'}</li>
        </ul>
        <p class="fr-hint">需要录制内嵌 FileDescriptorSet(含 nexis.security.alarm.*),或用带 proto schema 的录制。</p>
      </div>`;
    el.querySelector('#fr-gantt').style.display = 'none';
    return { destroy() { splitters.forEach(s => s.destroy()); el.remove(); }, setTime() {} };
  }

  body.innerHTML = `
    <div class="fr-events" id="fr-events"></div>
    <div class="fr-detail" id="fr-detail"><div class="fr-detail-empty">选择左侧一个故障事件查看归因</div></div>
  `;
  const eventsEl = body.querySelector('#fr-events');
  const detailEl = body.querySelector('#fr-detail');
  splitters.push(createSplitter(eventsEl, detailEl, { direction: 'horizontal', min: 220, max: 640 }));
  splitters.push(createSplitter(body, el.querySelector('#fr-gantt'), { direction: 'vertical', min: 120, max: 520 }));

  let selectedIdx = -1;

  function renderEventList() {
    if (faultEvents.length === 0) {
      eventsEl.innerHTML = '<div class="fr-detail-empty">该录制中 fault_process 无显著事件</div>';
      return;
    }
    eventsEl.innerHTML = '';
    faultEvents.forEach((ev, i) => {
      const w = ev.winner;
      const cat = w ? lookupFault(w.code) : null;
      const dom = w ? w.domain : 'OTHER';
      const row = document.createElement('button');
      row.className = 'fr-event' + (i === selectedIdx ? ' active' : '');
      row.innerHTML = `
        <span class="fr-ev-time">${ev.sec.toFixed(2)}s</span>
        <span class="fr-ev-flag ${ev.summary.flag === 'SYSTEM_ERROR' ? 'err' : 'ok'}">${esc(String(ev.summary.flag))}</span>
        <span class="fr-ev-dot" style="background:${DOMAIN_COLOR[dom] || DC.unknown}"></span>
        <span class="fr-ev-desc">${esc(w ? (w.message || cat?.desc || w.reasonName) : '(SYSTEM_OK)')}</span>
        <span class="fr-ev-va">${esc(String(ev.summary.vehicleAction ?? ''))}</span>
        <span class="fr-ev-n">${ev.activeSnapshot.length}</span>
      `;
      row.addEventListener('click', () => selectEvent(i));
      eventsEl.appendChild(row);
    });
  }

  function nodeRow(node, roleLabel, incoming) {
    const a = node.alarm;
    const cat = lookupFault(a.code);
    const inc = incoming
      ? `<div class="fr-node-edge">← ${esc(shortCode(incoming.from))} <span class="fr-conf ${incoming.confidence}">${CONF_LABEL[incoming.confidence] || incoming.confidence}</span> ${esc(incoming.kind)}</div>`
      : '';
    return `
      <div class="fr-node ${node.isWinner ? 'winner' : ''}">
        <div class="fr-node-head">
          ${roleLabelHtml(roleLabel)}
          <span class="fr-node-dot" style="background:${DOMAIN_COLOR[a.domain] || DC.unknown}"></span>
          <span class="fr-node-mod">${esc(a.moduleName)}${a.subModule ? '/' + esc(a.subModule) : ''}</span>
          <span class="fr-node-reason">${esc(a.reasonName)}</span>
          <span class="fr-node-first">${node.firstRaiseSec != null ? 'RAISE@' + node.firstRaiseSec.toFixed(2) + 's' : ''}</span>
        </div>
        <div class="fr-node-sub">
          ${a.topic ? `<span class="fr-node-topic">${esc(a.topic)}</span>` : `<span class="fr-node-topic muted">${esc(a.category || '-')}</span>`}
          <span class="fr-node-code">${esc(a.code)}</span>
        </div>
        ${a.message ? `<div class="fr-node-desc">${esc(a.message)}</div>` : (cat?.desc ? `<div class="fr-node-desc">${esc(cat.desc)}</div>` : '')}
        ${inc}
      </div>`;
  }

  function selectEvent(i) {
    selectedIdx = i;
    renderEventList();
    const ev = faultEvents[i];
    // Auto scope: the incident episode. No user knob.
    const episodeEndSec = faultEvents[i + 1] ? faultEvents[i + 1].sec : alarmResult.endSec;
    const scope = computeEpisodeScope(ev, alarmResult, episodeEndSec);
    const rca = attribute(ev, alarmResult, nexisConfig || {}, { scope });

    const incomingByCode = new Map();
    for (const e of rca.edges) {
      if (!incomingByCode.has(e.to)) incomingByCode.set(e.to, e);
    }
    const rootSet = new Set(rca.roots);
    const w = ev.winner;

    // Split cluster into cause candidates (active when fault_manager decided)
    // and consequences (raised after the decision -> chained / downstream).
    const candidates = rca.ranked.filter(n => !n.raisedAfterEvent);
    const consequences = rca.ranked.filter(n => n.raisedAfterEvent);

    const candHtml = candidates.length
      ? candidates.map(n => nodeRow(n, rootSet.has(n.code) ? 'ROOT' : (n.isWinner ? 'WINNER' : ''), incomingByCode.get(n.code))).join('')
      : '<div class="fr-note">决策时刻无活跃告警(该事件可能是恢复/OK)。</div>';
    const consHtml = consequences.length
      ? consequences.map(n => nodeRow(n, 'AFTER', null)).join('')
      : '';

    detailEl.innerHTML = `
      <div class="fr-detail-head">
        <span class="fr-ev-time">${ev.sec.toFixed(2)}s</span>
        <span class="fr-ev-flag ${ev.summary.flag === 'SYSTEM_ERROR' ? 'err' : 'ok'}">${esc(String(ev.summary.flag))}</span>
        <span>下发 FSM: <b>${esc(String(ev.summary.vehicleAction ?? 'NONE'))}</b> / SD ${esc(String(ev.summary.sdAction ?? 'NONE'))}</span>
      </div>
      <div class="fr-verdict">${buildVerdict(ev, rca, candidates, consequences)}</div>
      <div class="fr-arb">
        <div>仲裁赢家(下发给FSM的那条): ${alarmTitle(w)}</div>
        <div class="fr-note">仲裁按"域内最高等级"选出赢家,它解释"为何下发此动作",<b>不一定是根因</b>——见上游回溯。</div>
      </div>
      <div class="fr-section-title">上游回溯(根因追踪)</div>
      ${renderUpstream(rca)}
      <div class="fr-section-title">候选根因 · 决策时活跃 (${candidates.length})</div>
      <div class="fr-nodes">${candHtml}</div>
      ${consequences.length ? `<div class="fr-section-title">后继 / 连锁 · 决策后新增 (${consequences.length})</div><div class="fr-nodes">${consHtml}</div>` : ''}
    `;

    drawGantt(rca, scope);
  }

  // Human-readable one-liner for an alarm: message first, then module/topic.
  function alarmTitle(a) {
    if (!a) return '<span class="muted">-</span>';
    const cat = lookupFault(a.code);
    const label = a.message || cat?.desc || a.reasonName;
    const where = a.topic || a.category || '';
    return `<b>${esc(label)}</b> <span class="fr-node-mod">[${esc(a.moduleName)}${a.subModule ? '/' + esc(a.subModule) : ''}${a.domain ? ' · ' + esc(a.domain) : ''}]</span>${where ? ` <span class="fr-node-topic">${esc(where)}</span>` : ''}`;
  }

  // Render the pub/sub upstream backtrace: winner input topic -> producer -> ...
  function renderUpstream(rca) {
    const chain = rca.upstreamChain;
    if (!chain || !chain.hops.length) {
      return '<div class="fr-note">赢家无可解析的输入 topic,无法沿 pub/sub 图回溯。</div>';
    }
    const rows = chain.hops.map((h, i) => {
      const observed = h.kind === 'observed';
      const isRoot = chain.root && chain.root.topic === h.topic;
      const al = h.alarm;
      return `
        <div class="fr-hop ${isRoot ? 'root' : ''}">
          <span class="fr-hop-idx">${i + 1}</span>
          <span class="fr-node-topic">${esc(h.topic)}</span>
          <span class="fr-hop-arrow">由</span>
          <span class="fr-hop-prod">${esc(h.producer || '未知发布者')}</span>
          <span class="fr-hop-arrow">发布</span>
          ${observed
            ? `<span class="fr-conf CONFIGURED">该处有告警</span> ${al ? alarmTitle(al) : ''}`
            : '<span class="fr-conf INFERRED">该处无告警</span>'}
          ${isRoot ? '<span class="fr-role root">根因</span>' : ''}
        </div>`;
    }).join('');
    const root = chain.root;
    const summary = root
      ? (root.kind === 'observed'
          ? `<div class="fr-hop-verdict">观测根因: <b>${esc(root.producer)}</b> 上报了故障(见上)。</div>`
          : `<div class="fr-hop-verdict">疑似根因: <b>${esc(root.producer || '?')}</b>——它发布赢家缺失的输入,但本次<b>未上报告警</b>(可能是其内部或更上游异常,该录制无对应告警)。</div>`)
      : '';
    return `<div class="fr-hops">${rows}</div>${summary}`;
  }

  // Plain-language summary: winner -> upstream backtrace -> root.
  function buildVerdict(ev, rca, candidates, consequences) {
    if (ev.summary.flag !== 'SYSTEM_ERROR') {
      return '该事件为系统恢复 (SYSTEM_OK),无需归因。';
    }
    const w = ev.winner;
    if (!w) return '决策时刻未捕获到赢家告警(录制可能不完整)。';

    const wWhere = w.topic || w.category || '';
    let s = `fault_manager 于 <b>${ev.sec.toFixed(2)}s</b> 下发 <b>${esc(String(ev.summary.vehicleAction ?? 'NONE'))}</b>,赢家是 <b>${esc(w.moduleName)}${w.subModule ? '/' + esc(w.subModule) : ''}</b>: “${esc(w.message || lookupFault(w.code)?.desc || w.reasonName)}”${wWhere ? ` (${esc(wWhere)})` : ''}。`;

    const root = rca.upstreamChain?.root;
    if (root && root.producer && root.producer !== w.app && root.producer !== w.moduleName) {
      if (root.kind === 'observed' && root.alarm) {
        s += ` <b>回溯根因</b>: 该输入源头 <b>${esc(root.producer)}</b> 上报了故障“${esc(root.alarm.message || root.alarm.reasonName)}”——赢家只是被传导方,<b>真正根因在 ${esc(root.producer)}</b>。`;
      } else {
        s += ` <b>回溯</b>: 赢家缺失的输入由 <b>${esc(root.producer)}</b> 发布,但它本次未上报告警——疑似 ${esc(root.producer)}(或其更上游)异常,需结合 ${esc(root.producer)} 侧日志确认。`;
      }
    } else {
      s += ' 赢家即该输入的源头(或无更上游依赖),暂无更上游可回溯。';
    }
    if (consequences.length) s += ` 另有 ${consequences.length} 个后继告警(结果,非根因)。`;
    return s;
  }

  // --- Gantt (alarm swimlanes over time) ---
  const ganttEl = el.querySelector('#fr-gantt');

  function drawGantt(activeRca, scope) {
    ganttEl.innerHTML = '';
    const tracks = alarmResult.tracks.filter(t => t.intervals.length > 0);
    if (tracks.length === 0) {
      ganttEl.innerHTML = '<div class="fr-detail-empty">无 RAISE 区间</div>';
      return;
    }
    // Earliest RAISE at top => likely root is at the top.
    tracks.sort((a, b) => (a.firstRaiseSec ?? Infinity) - (b.firstRaiseSec ?? Infinity));
    const clusterCodes = activeRca ? new Set(activeRca.cluster.map(n => n.code)) : new Set();

    // Legend explaining the marks.
    const legend = document.createElement('div');
    legend.className = 'fr-legend';
    legend.innerHTML = `
      <span><i class="fr-lg-bar"></i> 故障持续 RAISE→CLEAR (颜色=域)</span>
      <span><i class="fr-lg-band"></i> 当前事件分析区间</span>
      <span><i class="fr-lg-sel"></i> 当前选中事件</span>
      <span><i class="fr-lg-decision"></i> 其他报错事件 (SYSTEM_ERROR)</span>
      <span><i class="fr-lg-ok"></i> 恢复事件 (SYSTEM_OK)</span>
      <span><i class="fr-lg-dim"></i> 非本次相关(变淡)</span>`;
    ganttEl.appendChild(legend);

    const W = ganttEl.clientWidth || 900;
    const rowH = 20, padR = 16, padT = 24, padB = 18;
    const CHAR_W = 6.2; // approx px per char at 10px Inter
    // Label = module/subModule:reason. Size the left gutter to the longest name
    // so it isn't truncated; the chart area scrolls horizontally if needed.
    const labelOf = (t) => `${t.alarm.moduleName}${t.alarm.subModule ? '/' + t.alarm.subModule : ''}:${t.alarm.reasonName}`;
    const maxLabelLen = Math.max(0, ...tracks.map(t => labelOf(t).length));
    const padL = Math.min(Math.max(220, maxLabelLen * CHAR_W + 16), 560);
    const labelChars = Math.floor((padL - 14) / CHAR_W);
    const H = padT + padB + tracks.length * rowH;
    const svgW = Math.max(W, padL + 340); // keep a usable chart area; scroll if wide
    const maxT = Math.max(durationSec, alarmResult.endSec, ...faultEvents.map(e => e.sec), 1);
    const x = d3.scaleLinear().domain([0, maxT]).range([padL, svgW - padR]);

    const svg = d3.select(ganttEl).append('svg').attr('width', svgW).attr('height', H);

    // Analysis-scope band for the selected event.
    if (scope) {
      svg.append('rect').attr('x', x(scope.start)).attr('y', padT - 4)
        .attr('width', Math.max(1, x(scope.end) - x(scope.start))).attr('height', H - padB - (padT - 4))
        .attr('fill', '#5b8fd9').attr('opacity', 0.10);
    }

    // time axis ticks
    const ticks = x.ticks(8);
    svg.append('g').selectAll('line').data(ticks).join('line')
      .attr('x1', d => x(d)).attr('x2', d => x(d)).attr('y1', padT - 4).attr('y2', H - padB)
      .attr('stroke', '#1f1f1f').attr('stroke-width', 1);
    svg.append('g').selectAll('text').data(ticks).join('text')
      .attr('x', d => x(d)).attr('y', padT - 10).attr('fill', '#666').attr('font-size', 9)
      .attr('text-anchor', 'middle').attr('font-family', 'Inter, system-ui').text(d => d + 's');

    tracks.forEach((t, i) => {
      const y = padT + i * rowH;
      const color = DOMAIN_COLOR[t.alarm.domain] || DC.unknown;
      const inCluster = clusterCodes.has(t.code);
      const cat = lookupFault(t.alarm.code);
      const label = labelOf(t);
      const g = svg.append('g').style('opacity', inCluster || !activeRca ? 1 : 0.35);
      g.append('title').text(`${label}\n${t.alarm.topic || t.alarm.category || ''}\n${t.alarm.message || cat?.desc || ''}\ncode=${t.alarm.code}`);
      const txt = g.append('text').attr('x', padL - 6).attr('y', y + rowH - 6).attr('text-anchor', 'end')
        .attr('fill', inCluster ? '#e6e6e6' : '#888').attr('font-size', 10).attr('font-family', 'Inter, system-ui')
        .text(clip(label, labelChars));
      txt.append('title').text(label);
      for (const [s, e] of t.intervals) {
        g.append('rect').attr('x', x(s)).attr('y', y + 3).attr('width', Math.max(3, x(e) - x(s))).attr('height', rowH - 7)
          .attr('rx', 2).attr('fill', color);
      }
    });

    // fault event markers (decision points)
    faultEvents.forEach((ev, idx) => {
      const isSel = idx === selectedIdx;
      const isErr = ev.summary.flag === 'SYSTEM_ERROR';
      svg.append('line').attr('x1', x(ev.sec)).attr('x2', x(ev.sec)).attr('y1', padT - 4).attr('y2', H - padB)
        .attr('stroke', isSel ? '#fff' : (isErr ? '#e0533d' : '#3aaa7a')).attr('stroke-width', isSel ? 2 : 1)
        .attr('stroke-dasharray', isSel ? 'none' : '3,2').style('cursor', 'pointer')
        .on('click', () => selectEvent(idx))
        .append('title').text(`${ev.sec.toFixed(2)}s ${ev.summary.flag} ${ev.summary.vehicleAction ?? ''}`);
    });
  }

  renderEventList();
  drawGantt(null, null);
  // Default to the first meaningful event (a confirmed fault with a winner),
  // so the panels aren't empty on a SYSTEM_OK frame.
  if (faultEvents.length > 0) {
    let firstMeaningful = faultEvents.findIndex(e => e.summary.flag === 'SYSTEM_ERROR' || e.winner);
    if (firstMeaningful < 0) firstMeaningful = 0;
    selectEvent(firstMeaningful);
  }

  return {
    destroy() { splitters.forEach(s => s.destroy()); el.remove(); },
  };
}

// Compact left-to-right causal chain SVG: roots on the left, winner on the right.
function renderChainSvg(rca) {
  const rootSet = new Set(rca.roots);
  const winner = rca.cluster.find(n => n.isWinner);
  const roots = rca.cluster.filter(n => rootSet.has(n.code));
  const mids = rca.cluster.filter(n => !rootSet.has(n.code) && !n.isWinner);
  const cols = [roots, mids, winner ? [winner] : []].filter(c => c.length > 0);
  if (cols.length < 2) return '<div class="fr-note">(单节点或无链路)</div>';
  const colW = 210, rowH = 30, padT = 8;
  const W = cols.length * colW;
  const H = padT * 2 + Math.max(...cols.map(c => c.length)) * rowH;
  const pos = new Map();
  let svg = `<svg class="fr-chain" width="${W}" height="${H}">`;
  cols.forEach((col, ci) => {
    col.forEach((n, ri) => {
      const cx = ci * colW + 10;
      const cy = padT + ri * rowH + rowH / 2;
      pos.set(n.code, { x: cx, y: cy });
      const color = DOMAIN_COLOR[n.alarm.domain] || DC.unknown;
      svg += `<circle cx="${cx}" cy="${cy}" r="5" fill="${color}"/>`;
      svg += `<text x="${cx + 10}" y="${cy + 3}" fill="#ccc" font-size="10" font-family="Inter, system-ui">${esc(clip(n.alarm.moduleName + ':' + n.alarm.reasonName, 22))}</text>`;
    });
  });
  for (const e of rca.edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    svg += `<line x1="${a.x + 4}" y1="${a.y}" x2="${b.x - 4}" y2="${b.y}" stroke="#4b4b4b" stroke-width="1.2" marker-end="url(#fr-arr)"/>`;
  }
  svg += `<defs><marker id="fr-arr" viewBox="0 -3 6 6" refX="6" refY="0" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,-2L6,0L0,2" fill="#4b4b4b"/></marker></defs>`;
  svg += '</svg>';
  return svg;
}

function roleLabelHtml(role) {
  if (role === 'ROOT') return '<span class="fr-role root">ROOT</span>';
  if (role === 'WINNER') return '<span class="fr-role winner">WINNER</span>';
  if (role === 'AFTER') return '<span class="fr-role after">后继</span>';
  return '';
}

function esc(s) { const d = document.createElement('span'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function shortCode(c) { const s = String(c); return s.length > 8 ? '…' + s.slice(-6) : s; }
