/**
 * Unit tests for fault-code.js — 64-bit alarm code bitfield decoding and
 * domain classification, validated against known entries in
 * ad_dag/config/nexis/resource/security/fault_table.pbtxt.
 */
import { strict as assert } from 'assert';
import { decodeFaultCode, classifyDomain, FaultDomain, reasonName, isDataStarvationReason } from '../src/fault-rca/fault-code.js';

// fault_table: "/mapping/lidar_freespace帧率错误"
// extra: "soc1, system_monitor, topic_monitor, /mapping/lidar_freespace, kTopicFrameRateDegradeError"
const CODE_TOPIC_MONITOR = '765633291309023232';
// fault_table: "LFS输入不更新"
// extra: "soc1, pnc, data_center, /mapping/lidar_freespace, kDataDelayTooMuch"
const CODE_PNC_DATA_DELAY = '1693374814494982144';

{
  const f = decodeFaultCode(CODE_TOPIC_MONITOR);
  assert.equal(f.module, 40, 'system_monitor module id');
  assert.equal(f.subModule, 1, 'topic_monitor sub-module id');
  assert.equal(f.reason, 1200, 'kTopicFrameRateDegradeError reason id');
  assert.equal(f.level, 0);
  assert.equal(classifyDomain(CODE_TOPIC_MONITOR), FaultDomain.SYSTEM, 'system_monitor -> SYSTEM domain');
}

{
  const f = decodeFaultCode(CODE_PNC_DATA_DELAY);
  assert.equal(f.module, 32, 'PNC module id');
  assert.equal(f.reason, 401, 'kDataDelayTooMuch reason id');
  assert.equal(reasonName(401), 'kDataDelayTooMuch', 'reason name lookup');
  assert.ok(isDataStarvationReason(401), 'kDataDelayTooMuch is a data-starvation reason');
  assert.equal(classifyDomain(CODE_PNC_DATA_DELAY), FaultDomain.PNC, 'PNC module -> PNC domain');
}

// Accept bigint / decimal string / hex string; high-order fields must be stable.
{
  assert.equal(decodeFaultCode(BigInt(CODE_TOPIC_MONITOR)).module, 40, 'bigint input');
  assert.equal(decodeFaultCode('0x' + BigInt(CODE_TOPIC_MONITOR).toString(16)).module, 40, 'hex string input');
}

// Frame-rate degrade is a producer/topic-health reason, not data-starvation.
assert.ok(!isDataStarvationReason(1200), 'frame-rate degrade is not consumer data-starvation');

console.log('fault-code tests passed');
