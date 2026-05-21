#!/usr/bin/env node
import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const build = spawnSync(process.execPath, [join(__dirname, 'build-nexis-config.js')], {
  cwd: repoRoot,
  encoding: 'utf8',
});

if (build.status !== 0) {
  process.stdout.write(build.stdout || '');
  process.stderr.write(build.stderr || '');
  throw new Error(`build-nexis-config.js failed with status ${build.status}`);
}

const config = JSON.parse(readFileSync(join(repoRoot, 'src', 'nexis-config.json'), 'utf8'));

assert.equal(
  config.topicToPublisher['/openapi_ld/pilot_state'],
  'state_machine',
  'transport publisher should not be overwritten by CYBER_PROCESSES fallback',
);

assert.ok(
  !config.processes.openapi.pub.some((entry) => entry.topic === '/openapi_ld/pilot_state'),
  'openapi should not be shown as publishing pilot_state when it is only a code reader',
);

assert.ok(
  config.processes.openapi.sub.some((entry) => entry.topic === '/openapi_ld/pilot_state'),
  'openapi should be shown as subscribing to pilot_state',
);

assert.equal(
  config.topicToPublisher['/nexis/security/alarm/alarm_state_data'],
  'system_monitor',
  'generic default transport profile should not hide the concrete system_monitor publisher',
);

console.log('build-nexis-config regression tests passed');
