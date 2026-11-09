#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readCurrentManifest, validateCompleteReleaseManifest } from './release-manifest.mjs';
import bridge from './support-chat-bridge.cjs';

const run = (file, args) =>
  execFileSync(file, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
export function verifySupportContainer(rows, imageId) {
  const value = rows[0];
  if (
    rows.length !== 1 ||
    value?.Image !== imageId ||
    value.State?.Running !== true ||
    (value.State?.Health && value.State.Health.Status !== 'healthy') ||
    value.Config?.Labels?.['com.maxim.release-protected'] !== 'true' ||
    value.Config?.Labels?.['com.docker.compose.project'] !== 'infra' ||
    value.Config?.Labels?.['com.docker.compose.service'] !== 'api-action' ||
    value.Config?.Env?.filter((entry) => entry === 'APP_SERVICE_NAME=api-action').length !== 1 ||
    value.Config?.Env?.filter((entry) => entry === 'APP_ROLE=action').length !== 1
  )
    throw new Error('support_container_refused');
  return value.Id;
}

export async function supportChatRemote(operation, chatId) {
  if (!['preview', 'bridge'].includes(operation)) throw new Error('support_operation_refused');
  if (chatId === undefined && operation === 'preview') {
    for (const selected of bridge.CHAT_IDS) await supportChatRemote(operation, selected);
    return;
  }
  chatId ??= bridge.CHAT_IDS[0];
  if (!bridge.CHAT_IDS.includes(chatId)) throw new Error('support_chat_refused');
  const readiness = JSON.parse(
    run('curl', [
      '--fail',
      '--silent',
      '--max-time',
      '5',
      'http://127.0.0.1:3001/api/health/ready',
    ]),
  );
  if (readiness.ok !== true || readiness.systemMode?.degraded === true)
    throw new Error('support_runtime_unhealthy');
  run('node', ['infra/scripts/release-manifest.mjs', 'validate-current']);
  const manifest = readCurrentManifest('/var/lib/maxim-deploy');
  validateCompleteReleaseManifest(manifest);
  const id = run('docker', [
    'compose',
    '--env-file',
    '.env',
    '-p',
    'infra',
    '-f',
    'infra/docker-compose.yml',
    'ps',
    '-q',
    'api-action',
  ]);
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('support_container_refused');
  verifySupportContainer(
    JSON.parse(run('docker', ['inspect', id])),
    manifest.components['api-shared'].imageId,
  );
  const code = readFileSync(new URL('./support-chat-bridge.cjs', import.meta.url), 'utf8');
  const knowledgeBytes = readFileSync(new URL('./support-llm-knowledge.json', import.meta.url));
  const knowledgeSha = createHash('sha256').update(knowledgeBytes).digest('hex');
  const knowledge = JSON.parse(knowledgeBytes);
  const botCatalog = knowledge.botCatalog;
  const guideCatalog = bridge.validateSupportGuideCatalog(knowledge.onboardingGuides ?? []);
  const child = spawn(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      `SUPPORT_KNOWLEDGE_SHA256=${knowledgeSha}`,
      '-e',
      `SUPPORT_BOT_CATALOG=${JSON.stringify(botCatalog)}`,
      '-e',
      `SUPPORT_GUIDE_CATALOG=${JSON.stringify(guideCatalog)}`,
      '-e',
      `SUPPORT_PREVIEW=${operation === 'preview' ? '1' : '0'}`,
      '-e',
      `SUPPORT_CHAT_ID=${chatId}`,
      '-e',
      'PRISMA_PG_POOL_MAX=1',
      '-e',
      'PRISMA_PG_POOL_CONNECTION_TIMEOUT_MS=2000',
      '-e',
      'PRISMA_PG_STATEMENT_TIMEOUT_MS=1500',
      '-e',
      'PRISMA_PG_POOL_IDLE_TIMEOUT_MS=1000',
      id,
      'node',
      '-e',
      code,
    ],
    { stdio: 'inherit', timeout: 31 * 60_000, killSignal: 'SIGTERM' },
  );
  const stop = () => child.kill('SIGTERM');
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('support_bridge_unavailable')));
      child.once('close', (exitCode) =>
        exitCode === 0 ? resolve() : reject(new Error('support_bridge_unavailable')),
      );
    });
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  supportChatRemote(process.argv[2], process.argv[3]).catch(() => {
    process.stderr.write('support_remote_unavailable\n');
    process.exitCode = 1;
  });
}
