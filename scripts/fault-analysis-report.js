#!/usr/bin/env node
/**
 * 生成"每个故障的根因 + 上下游(精准到故障码) + sd_action 选择理由"分析。
 * 输入: src/fault-table.json (飞书同步) + src/nexis-config.json
 * 输出: fault-analysis.js / public/fault-analysis.js / src/fault-analysis.json
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildFaultGraph, explainFault } from '../src/fault-graph.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src');

const ft = JSON.parse(readFileSync(join(SRC, 'fault-table.json'), 'utf8'));
const nx = JSON.parse(readFileSync(join(SRC, 'nexis-config.json'), 'utf8'));

const g = buildFaultGraph(ft, nx);
const explained = g.faults.map((f) => explainFault(f, g.byCode));

const payload = {
  generated_at: new Date().toISOString(),
  source: ft.sheet_url || 'feishu',
  stats: g.stats,
  faults: explained,
};
writeFileSync(join(SRC, 'fault-analysis.json'), JSON.stringify(payload, null, 2), 'utf8');
const dataJs = 'window.__FAULT_ANALYSIS__ = ' + JSON.stringify(payload) + ';\n';
writeFileSync(join(__dirname, '..', 'fault-analysis.js'), dataJs, 'utf8');
writeFileSync(join(__dirname, '..', 'public', 'fault-analysis.js'), dataJs, 'utf8');

// ---- 报告 ----
const issues = [];
for (const e of explained) for (const fl of e.sd.flags) issues.push({ code: e.code, module: e.module, desc: e.desc, flag: fl });

const line = '─'.repeat(72);
console.log(line);
console.log('故障根因 & 上下游 & sd_action 分析  (来源: 飞书故障表 + nexis 真实 pub/sub)');
console.log(line);
console.log(`总故障 ${g.stats.total} | sd ${JSON.stringify(g.stats.bySd)}`);
console.log(`topic类 ${g.stats.topicFaults}(其中无发布者 ${g.stats.topicNoProducer}) | 非topic ${g.stats.nonTopicFaults}`);
console.log(`有上游 ${g.stats.withUpstream} | 有下游 ${g.stats.withDownstream}`);
console.log();
console.log('【需接管故障(sd != NONE)的根因 + 精准上下游 + 处置理由】');
for (const e of explained.filter((x) => x.sd.decision !== 'NONE')) {
  console.log(`\n● [${e.sd.decision}] ${e.module} :: ${e.desc}`);
  console.log(`  ${e.code} (${e.code_dec})  category=${e.category}`);
  console.log(`  根因: ${e.rootCause.text}`);
  if (e.upstream.length) {
    console.log(`  上游故障(${e.upstream.length}):`);
    for (const u of e.upstream.slice(0, 6)) console.log(`     ← ${u.module} ${u.code} ${u.desc} [${u.topic}]`);
  }
  if (e.downstream.length) {
    console.log(`  下游故障(${e.downstream.length}):`);
    for (const u of e.downstream.slice(0, 6)) console.log(`     → ${u.module} ${u.code} ${u.desc} [${u.topic}]`);
  }
  console.log(`  sd_action=${e.sd.decision}: ${e.sd.reason}`);
  if (e.sd.flags.length) console.log(`    ⚠ ${e.sd.flags.join(' | ')}`);
}
console.log(`\n${line}`);
console.log(`【一致性问题】共 ${issues.length} 条`);
for (const it of issues) console.log(`  ⚠ ${it.flag}  <- ${it.module} :: ${it.desc} (${it.code})`);
console.log(line);
console.log('已写出 fault-analysis.js / src/fault-analysis.json');
