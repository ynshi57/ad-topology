/**
 * Regression tests for the app_config-driven, platform-aware topology builder.
 *
 * These lock in the post-reorg reality of ad_dag:
 *  - planning + control are merged into a single `pnc` nexis process
 *  - openapi / aeb / dynamic_layer / state_machine are nexis (not CyberRT)
 *  - map topics are published by `baidu_map_service` (orin_ivi retired)
 *  - the topology is generated from a chosen platform's app_config, so the
 *    25_6090 / 26_6012 variants and test_/sim deploy dirs never get conflated.
 *  - `/neo_map/maps` (a pnc subscription) has no publisher -> dangling.
 */
import { strict as assert } from 'assert';
import { buildConfig } from './build-nexis-config.js';

const c25 = buildConfig('25_6090');
const c26 = buildConfig('26_6012');

// --- planning + control merged into pnc ---
assert.equal(c25.topicToPublisher['/pnc/planning'], 'pnc', '/pnc/planning should be published by pnc');
assert.equal(c25.topicToPublisher['/pnc/control'], 'pnc', '/pnc/control should be published by pnc');
assert.ok(c25.processes.pnc, 'pnc process should exist');
assert.ok(!c25.processes.planning, 'standalone planning process should be gone');
assert.ok(!c25.processes.control, 'standalone control process should be gone');

// --- nexis processes (formerly hardcoded CyberRT) ---
assert.equal(c25.topicToPublisher['/openapi_ld/pilot_state'], 'state_machine', 'pilot_state still published by state_machine');
assert.equal(c25.processes.openapi.runtime, 'nexis', 'openapi is now a nexis app');
assert.equal(c25.processes.aeb.runtime, 'nexis', 'aeb is now a nexis app');

// --- map topics now from baidu_map_service ---
assert.equal(c25.topicToPublisher['/maprouter/maps'], 'baidu_map_service', '/maprouter/maps published by baidu_map_service');

// --- dangling subscription surfaced, not silently mapped ---
assert.ok(!('/neo_map/maps' in c25.topicToPublisher), '/neo_map/maps has no publisher (dangling pnc sub)');
assert.ok((c25.topicToSubscribers['/neo_map/maps'] || []).includes('pnc'), 'pnc still subscribes /neo_map/maps');

// --- platform isolation: only the selected platform's canbus variant appears ---
assert.ok(c25.processes.canbus, '25_6090 uses the neo_canbus app named "canbus"');
assert.ok(c26.processes.udp_canbus, '26_6012 uses the udp_canbus app');
assert.ok(!c25.processes.udp_canbus, '25_6090 must not contain 26 udp_canbus');

// --- no versioned/test deploy dirs leak in as process nodes ---
for (const procName of Object.keys(c25.processes)) {
  assert.ok(!/^\d\d_/.test(procName), `process id should not be a versioned deploy dir: ${procName}`);
  assert.ok(!procName.startsWith('test_'), `process id should not be a test deploy dir: ${procName}`);
}

console.log('app-config topology tests passed');
