#!/usr/bin/env node
/**
 * Sync the fault management table from the Feishu (Lark) wiki sheet into a JSON
 * that ad-topology consumes as the source of truth for fault definitions.
 *
 * Source: https://r3c0qt6yjw.feishu.cn/wiki/N2h0wBWnzi8DKJkQifHcXy1mnog?sheet=80eec3
 * Output: src/fault-table.json
 *
 * Requires: lark-cli installed and authenticated (user identity) on this host.
 *   The sheet is read via:  lark-cli sheets +read --spreadsheet-token <tok> --range <sheet>!A1:Y<N>
 *
 * Env overrides:
 *   FAULT_SHEET_TOKEN  spreadsheet token (default the wiki obj_token)
 *   FAULT_SHEET_ID     sheet/tab id (default 80eec3)
 *   FAULT_SHEET_ROWS   last row to read (default 614)
 */

import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(__dirname, '..', 'src', 'fault-table.json');

const SHEET_TOKEN = process.env.FAULT_SHEET_TOKEN || 'EXpZsdcsAhWQ7FtOlptcPCZjn4f';
const SHEET_ID = process.env.FAULT_SHEET_ID || '80eec3';
const LAST_ROW = process.env.FAULT_SHEET_ROWS || '614';
const RANGE = `${SHEET_ID}!A1:Y${LAST_ROW}`;

// 表头中文名 -> 输出字段名(描述类列)
const COLUMN_MAP = {
  '序号': 'seq',
  '用户故障码Usercode': 'user_code',
  '故障描述': 'desc',
  'APP名称': 'app',
  '模块名称': 'module',
  '子模块名称': 'sub_module',
  '类别名称': 'category',          // 多为监控的 topic，是依赖图的关键
  '故障等级': 'level',
  '故障原因': 'reason',
  '持续时间': 'duration',
  '故障生成条件': 'gen_condition',
  '故障恢复条件': 'rec_condition',
  '车辆响应': 'vehicle_action',
  '上报策略': 'sd_action',          // SD 接管建议 NONE/RESTART/RELOCATE/RETURN_SERVICE
  '数据记录策略': 'record_action',
  '云端提示语': 'prompt',
};

// 故障码列是 Excel 公式(飞书返回公式文本)，不可直接用；用 ID 列重算，
// 规则与 generate_fault_config.py 的 compute_fault_code 一致。
const ID_COLUMN_MAP = {
  'soc id': 'soc_id',
  'APP ID': 'app_id',
  '模块ID': 'mod_id',
  '子模块ID': 'submod_id',
  '类别ID': 'cat_id',
  '原因ID': 'reason_id',
};

function safeInt(s) {
  const t = (s || '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function parseLevel(s) {
  let t = (s || '').trim();
  if (!t) return 0;
  if (/^L/i.test(t)) t = t.slice(1);
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function computeFaultCode(soc, app, mod, submod, cat, level, reason, dur) {
  const n = new Array(16).fill(0);
  n[0] = soc * 4 + Math.floor(app / 16);
  n[1] = app % 16;
  n[2] = Math.floor(mod / 4);
  n[3] = (mod % 4) * 4 + Math.floor(submod / 16);
  n[4] = submod % 16;
  n[5] = Math.floor(cat / 64);
  n[6] = Math.floor((cat % 64) / 4);
  n[7] = (cat % 4) * 4 + Math.floor(level / 4);
  n[8] = (level % 4) * 4 + Math.floor(reason / 4096);
  n[9] = Math.floor(reason / 256) % 16;
  n[10] = Math.floor(reason / 16) % 16;
  n[11] = reason % 16;
  n[12] = Math.floor(dur / 4096);
  n[13] = Math.floor(dur / 256) % 16;
  n[14] = Math.floor(dur / 16) % 16;
  n[15] = dur % 16;
  return '0x' + n.map((v) => v.toString(16)).join('');
}

function cellText(c) {
  if (c === null || c === undefined) return '';
  if (typeof c === 'string') return c;
  if (typeof c === 'number') return String(c);
  if (Array.isArray(c)) return c.map(cellText).join('');
  if (typeof c === 'object') {
    if (c.text !== undefined) return cellText(c.text);
    if (c.values !== undefined) return cellText(c.values);
    if (c.link !== undefined) return cellText(c.link);
    return '';
  }
  return String(c);
}

function readSheet() {
  let raw;
  try {
    raw = execFileSync(
      'lark-cli',
      ['sheets', '+read', '--spreadsheet-token', SHEET_TOKEN, '--range', RANGE],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err) {
    throw new Error(
      `lark-cli 读取飞书表失败(请确认 lark-cli 已安装且已 auth login): ${err.message}`,
    );
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new Error(`lark-cli 输出不是合法 JSON: ${e.message}\n前 200 字符: ${raw.slice(0, 200)}`);
  }
  const values = doc && doc.data && doc.data.valueRange && doc.data.valueRange.values;
  if (!Array.isArray(values) || values.length < 2) {
    throw new Error('飞书表返回的 values 为空或缺表头');
  }
  return values;
}

function build(values) {
  const header = values[0].map(cellText);
  // 中文表头 -> 列索引
  const idx = {};
  const idIdx = {};
  header.forEach((h, i) => {
    const key = COLUMN_MAP[h.trim()];
    if (key) idx[key] = i;
    const idKey = ID_COLUMN_MAP[h.trim()];
    if (idKey) idIdx[idKey] = i;
  });
  for (const need of ['desc', 'category', 'module', 'sd_action', 'vehicle_action']) {
    if (idx[need] === undefined) {
      throw new Error(`飞书表缺少必要列(映射后字段 '${need}')，实际表头: ${header.join(' | ')}`);
    }
  }
  for (const need of ['soc_id', 'app_id', 'mod_id', 'submod_id', 'cat_id']) {
    if (idIdx[need] === undefined) {
      throw new Error(`飞书表缺少 ID 列(用于算故障码) '${need}'，实际表头: ${header.join(' | ')}`);
    }
  }

  const faults = [];
  let skipped = 0;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const get = (k) => (idx[k] !== undefined ? cellText(row[idx[k]]).trim() : '');
    const getId = (k) => safeInt(cellText(row[idIdx[k]]));

    // 真实故障行: 五个核心 ID 必须齐全(与 generate_fault_config 跳过规则一致)
    const soc = getId('soc_id'), app = getId('app_id'), mod = getId('mod_id');
    const submod = getId('submod_id'), cat = getId('cat_id');
    if ([soc, app, mod, submod, cat].some((v) => v === null)) { skipped++; continue; }

    const level = parseLevel(get('level'));
    const reason = getId('reason_id') ?? 0;
    const dur = safeInt(get('duration')) ?? 0;
    const codeHex = computeFaultCode(soc, app, mod, submod, cat, level, reason, dur);
    if (/^0x0+$/i.test(codeHex)) { skipped++; continue; }

    const f = { row: r + 1, code: codeHex, code_dec: BigInt(codeHex).toString(), mod_id: mod };
    for (const [, key] of Object.entries(COLUMN_MAP)) {
      if (idx[key] !== undefined) f[key] = get(key);
    }
    faults.push(f);
  }
  return { faults, skipped };
}

function main() {
  console.error(`[sync-fault-table] reading Feishu sheet ${SHEET_TOKEN} range ${RANGE} ...`);
  const values = readSheet();
  const { faults, skipped } = build(values);

  const out = {
    source: 'feishu',
    sheet_url: `https://r3c0qt6yjw.feishu.cn/wiki/N2h0wBWnzi8DKJkQifHcXy1mnog?sheet=${SHEET_ID}`,
    spreadsheet_token: SHEET_TOKEN,
    sheet_id: SHEET_ID,
    synced_at: new Date().toISOString(),
    count: faults.length,
    faults,
  };
  writeFileSync(OUTPUT, JSON.stringify(out, null, 2), 'utf8');

  // 分布统计(便于核对)
  const bySd = {};
  for (const f of faults) {
    const k = (f.sd_action || 'EMPTY') || 'EMPTY';
    bySd[k] = (bySd[k] || 0) + 1;
  }
  console.error(`[sync-fault-table] OK -> ${OUTPUT}`);
  console.error(`  有码故障: ${faults.length}  (跳过空码行: ${skipped})`);
  console.error(`  上报策略分布: ${JSON.stringify(bySd)}`);
}

main();
