/**
 * fault-graph.js — 把飞书故障表(fault-table.json) + 进程拓扑(nexis-config.json)
 * 融合成"故障依赖图"。
 *
 * 精准原则(只用事实,不猜测):
 *   - 故障的依赖只来自它的 category(=它监控的 topic) + nexis 的真实 pub/sub。
 *   - 故障码 F 监控 topic T_F; T_F 的发布进程 = topicToPublisher[T_F](事实)。
 *   - 上游故障 = 监控了"T_F 发布者所订阅的 topic"的故障(即该发布者的真实输入)。
 *   - 下游故障 = 由"订阅 T_F 的进程"所发布 topic 上的故障。
 *   - category 非 topic(内部判定 / 逻辑输入名)→ 不进 topic 依赖图(不编造上游)。
 */

export const SD_RANK = { NONE: 0, RESTART: 1, RELOCATE: 2, RETURN_SERVICE: 3 };

function normSd(v) {
  const s = (v || '').trim().toUpperCase();
  return SD_RANK[s] !== undefined ? s : 'NONE';
}

function isTopic(cat) { return typeof cat === 'string' && cat.startsWith('/'); }

/**
 * @param {{faults:Array}} faultTable
 * @param {{topicToPublisher:Object, topicToSubscribers:Object}} nexisConfig
 */
export function buildFaultGraph(faultTable, nexisConfig) {
  const topicToPublisher = (nexisConfig && nexisConfig.topicToPublisher) || {};

  // 规整故障
  const faults = (faultTable.faults || []).map((raw) => {
    const category = (raw.category || '').trim();
    const topic = isTopic(category) ? category : null;
    const producer = topic ? (topicToPublisher[topic] || null) : null;
    return {
      code: raw.code,
      code_dec: raw.code_dec,
      module: raw.module || '',
      category,
      topic,
      producer,             // 发布 F 所监控 topic 的进程(事实) 或 null
      desc: raw.desc || '',
      sd_action: normSd(raw.sd_action),
      vehicle_action: (raw.vehicle_action || 'NONE').trim() || 'NONE',
      gen_condition: raw.gen_condition || '',
      rec_condition: raw.rec_condition || '',
    };
  });

  // 故障表 module(检测方) -> 真实发布进程(由 nexis topicToPublisher 命名空间归属得到,事实)。
  // 关系规则: G 是 F 的上游 ⟺ G 所在模块的进程 == 发布"F 所监控 topic"的进程。
  const PROC_OF_MODULE = {
    localization: 'location', map_route: 'map_router', pnc: 'planning', control: 'control',
    model_infer: 'model_infer', parking: 'neo_parking', can_bus: 'neo_canbus', system_monitor: 'system_monitor',
  };
  const procOfModule = (m) => PROC_OF_MODULE[m] || null;

  // byOwnerProc[P] = 由进程 P "拥有/生产"的故障(即模块进程==P 的故障)
  const byOwnerProc = {};
  // byMonitoredProducer[P] = 监控了"由进程 P 发布的 topic"的故障(即 F.producer==P)
  const byMonitoredProducer = {};
  for (const f of faults) {
    const owner = procOfModule(f.module);
    if (owner) (byOwnerProc[owner] = byOwnerProc[owner] || []).push(f);
    if (f.producer) (byMonitoredProducer[f.producer] = byMonitoredProducer[f.producer] || []).push(f);
  }

  const byCode = new Map(faults.map((f) => [f.code, f]));
  for (const f of faults) {
    f.upstream = [];
    f.downstream = [];
    // 上游: 生产"F 所监控 topic"的进程, 其拥有的故障(跨模块, 排除同模块 peer)
    if (f.producer && byOwnerProc[f.producer]) {
      for (const g of byOwnerProc[f.producer])
        if (g.code !== f.code && g.module !== f.module) f.upstream.push({ code: g.code, topic: f.topic });
    }
    // 下游: 监控了"本模块进程所发布 topic"的故障(跨模块, 排除同模块 peer)
    const owner = procOfModule(f.module);
    if (owner && byMonitoredProducer[owner]) {
      for (const h of byMonitoredProducer[owner])
        if (h.code !== f.code && h.module !== f.module) f.downstream.push({ code: h.code, topic: h.topic });
    }
  }

  // 统计
  const stats = { total: faults.length, bySd: {}, topicFaults: 0, nonTopicFaults: 0, topicNoProducer: 0,
                  withUpstream: 0, withDownstream: 0 };
  for (const f of faults) {
    stats.bySd[f.sd_action] = (stats.bySd[f.sd_action] || 0) + 1;
    if (f.topic) { stats.topicFaults++; if (!f.producer) stats.topicNoProducer++; }
    else stats.nonTopicFaults++;
    if (f.upstream.length) stats.withUpstream++;
    if (f.downstream.length) stats.withDownstream++;
  }

  return { faults, byCode, stats };
}

/**
 * 解释单条故障的 sd_action 为何如此(规则 + 证据 + 一致性 flag)。
 * 规则(v1):非 NONE ⟺ 车辆响应非 NONE(只有影响行驶/已减速停车才需 SD 接管);
 * 类型 RELOCATE=环境/信号, RETURN_SERVICE=硬件/失控, RESTART=其它。
 */
export function explainSdAction(fault) {
  const sd = fault.sd_action;
  const va = (fault.vehicle_action || 'NONE').toUpperCase();
  const vaActive = va !== 'NONE' && va !== '';
  const flags = [];
  let rule, reason;
  if (sd === 'NONE') {
    rule = '车辆响应=NONE ⇒ 不影响行驶 ⇒ 无需 SD 接管';
    reason = vaActive ? `异常: 车辆响应=${va} 却 sd=NONE` : '故障存在但不影响车辆运行,不弹接管';
    if (vaActive) flags.push('UNDER_REPORT: 车辆已响应却未给接管建议(疑漏报)');
  } else {
    const typeReason = {
      RELOCATE: '环境/信号/定位质量类 ⇒ 行驶到空旷地带(重启无效)',
      RESTART: '软件/数据运行态类 ⇒ 重启 AD',
      RETURN_SERVICE: '硬件/失控/标定类 ⇒ 联系维修(重启无效)',
    }[sd] || '未知类型';
    rule = '车辆响应非 NONE ⇒ 影响行驶 ⇒ 需 SD 接管';
    reason = `车辆响应=${va}(影响行驶,需接管);类型=${sd}: ${typeReason}`;
    if (!vaActive) flags.push('OVER_REPORT?: 无车辆响应却标了接管建议(需登记)');
  }
  return { decision: sd, vehicle_action: va, rule, reason, flags };
}

/** 单条故障的完整、可追溯说明(根因来自事实 topic+pub/sub,上下游具体到故障码)。 */
export function explainFault(fault, byCode) {
  let rootCause;
  if (!fault.topic) {
    rootCause = { type: 'nontopic', text: `category=${fault.category}(非 topic,内部判定或逻辑输入),不在 topic 依赖图内` };
  } else if (!fault.producer) {
    rootCause = { type: 'topic_no_producer', topic: fault.topic,
      text: `监控 topic ${fault.topic};该 topic 发布者未在 nexis 配置中(多为传感器/驱动,按约定不追上游)` };
  } else {
    rootCause = { type: 'topic', topic: fault.topic, producer: fault.producer,
      text: `监控 topic ${fault.topic};发布进程 = ${fault.producer}` };
  }
  const resolve = (arr) => arr.map((u) => {
    const g = byCode.get(u.code);
    return { code: u.code, topic: u.topic, via: u.via, module: g ? g.module : '', desc: g ? g.desc : '',
             sd_action: g ? g.sd_action : 'NONE' };
  });
  return {
    code: fault.code, code_dec: fault.code_dec, module: fault.module, desc: fault.desc,
    category: fault.category, topic: fault.topic, producer: fault.producer,
    gen_condition: fault.gen_condition, rec_condition: fault.rec_condition,
    rootCause,
    upstream: resolve(fault.upstream),
    downstream: resolve(fault.downstream),
    sd: explainSdAction(fault),
  };
}
