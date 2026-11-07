import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { commercialLlmWorkstationBridgeCommand } from './commercial-llm-runtime.mjs';

const root = resolve(import.meta.dirname, '../..');

test('the host selects only the fixed compiled bridge and an allowlisted PC identity', () => {
  assert.deepEqual(commercialLlmWorkstationBridgeCommand(), [
    'node',
    'apps/api/dist/apps/api/src/scripts/commercial-llm-workstation-bridge.js',
  ]);
  for (const nodeId of ['pc-a-4b', 'pc-b-9b', 'pc-a-cpu-9b'])
    assert.deepEqual(commercialLlmWorkstationBridgeCommand(nodeId), [
      'node',
      'apps/api/dist/apps/api/src/scripts/commercial-llm-pool-bridge.js',
      nodeId,
    ]);
  for (const nodeId of ['', null, 'server-9b', '../script', 'pc-b-9b;id', '--apply'])
    assert.throws(() => commercialLlmWorkstationBridgeCommand(nodeId));
});

test('the connector rejects extra or untrusted pool arguments before remote execution', () => {
  const connector = readFileSync(resolve(root, 'infra/scripts/vps-connect.sh'), 'utf8');
  const start = connector.indexOf('commercial_llm() {');
  assert.notEqual(start, -1);
  const end = connector.indexOf('\n}\n', start);
  const fn = connector.slice(start, end + 2);
  const dispatchStart = connector.indexOf('\ncommand="${1:-}"\n');
  assert.notEqual(dispatchStart, -1);
  const dispatch = connector.slice(dispatchStart);
  const invoke = (...args) =>
    spawnSync(
      'bash',
      [
        '-c',
        `${fn}\nremote_exec() { printf 'remote:%s\\n' "$1"; }\nshell_quote_args() { printf '%q ' "$@"; }\n${dispatch}`,
        'pool-host-test',
        'commercial-llm',
        ...args,
      ],
      { encoding: 'utf8' },
    );
  for (const nodeId of ['pc-a-4b', 'pc-b-9b', 'pc-a-cpu-9b']) {
    const result = invoke('workstation-pool-bridge', nodeId);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`workstation-pool-bridge ${nodeId}`, 'u'));
  }
  for (const args of [
    [],
    ['foreign'],
    ['pc-a-4b', 'extra'],
    ['pc-a-cpu-9b', 'extra'],
    ['pc-b-9b;id'],
    ['pc-a-cpu-9b;id'],
    ['pc-a-cpu-9b$(id)'],
    ['pc-a-cpu-9b', '--apply'],
  ]) {
    const result = invoke('workstation-pool-bridge', ...args);
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stdout, /remote:/u);
  }
});

test('pool flags default to legacy routing consistently across all fourteen API services', () => {
  const compose = JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        '--env-file',
        '.env.example',
        '-p',
        'infra',
        '-f',
        'infra/docker-compose.yml',
        'config',
        '--format',
        'json',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          MAXIM_COMPOSE_SERVICE_ENV_FILE: '../.env.example',
          COMMERCIAL_LLM_POOL_WORKERS_ENABLED: 'false',
          COMMERCIAL_LLM_POOL_ENABLED: 'false',
          COMMERCIAL_LLM_POOL_4B_POLICY: 'confirm-positive',
        },
      },
    ),
  );
  const services = Object.entries(compose.services).filter(([name]) => name.startsWith('api-'));
  assert.equal(services.length, 14);
  for (const [, service] of services) {
    assert.equal(service.environment.COMMERCIAL_LLM_POOL_WORKERS_ENABLED, 'false');
    assert.equal(service.environment.COMMERCIAL_LLM_POOL_ENABLED, 'false');
    assert.equal(service.environment.COMMERCIAL_LLM_POOL_4B_POLICY, 'confirm-positive');
  }
  assert.equal(compose.services['api-moderation-background'].ports, undefined);
});
