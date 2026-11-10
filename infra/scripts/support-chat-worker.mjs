import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { answerSupport } from './support-llm-client.mjs';
import { SUPPORT_MODEL } from './support-llm-profile.mjs';
import {
  SUPPORT_API_PROFILE,
  readSupportProvider,
  readSupportProviderKey,
} from './support-llm-provider.mjs';

const root = join(homedir(), '.local/share/maxim-support-llm');
const state = join(root, 'service');
const bundle = dirname(fileURLToPath(import.meta.url));
export const SUPPORT_CHAT_IDS = Object.freeze([
  '-78271094414679',
  '-79143082792210',
  '-71583403182087',
]);
export function supportChatSshArgs(chatId = SUPPORT_CHAT_IDS[0]) {
  if (!SUPPORT_CHAT_IDS.includes(chatId)) throw new Error('support_chat_refused');
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=8',
    '-o',
    'ServerAliveInterval=5',
    '-o',
    'ServerAliveCountMax=2',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ClearAllForwardings=yes',
    'maxim-vps',
    `cd /var/www/Chat_bot && exec node infra/scripts/support-chat-remote.mjs bridge ${chatId}`,
  ];
}

const failureCodes = new Set([
  'support_ssh_unavailable',
  'support_server_heartbeat_stale',
  'support_handshake_deadline',
  'support_frame_limit',
  'support_frame_refused',
  'support_frame_invalid',
  'support_question_refused',
  'support_question_overlap',
  'support_clock_skew',
]);
export const supportChatFailureCode = (error) =>
  error instanceof Error && failureCodes.has(error.message)
    ? error.message
    : 'support_session_failed';

export class SupportReconnectPolicy {
  consecutive = 0;
  connectedAt = null;
  connected(now = Date.now()) {
    this.connectedAt = now;
  }
  observed(sampleAt, now = Date.now()) {
    // FLAG: Hello alone or stale polling cannot erase a failing reconnect history.
    if (
      this.connectedAt !== null &&
      now - this.connectedAt >= 30_000 &&
      Number.isSafeInteger(sampleAt) &&
      sampleAt >= 0 &&
      sampleAt <= now + 5000 &&
      now - sampleAt <= 30_000
    )
      this.consecutive = 0;
  }
  disconnected() {
    this.connectedAt = null;
    this.consecutive = Math.min(15, this.consecutive + 1);
    return 2000 * this.consecutive;
  }
}

export function validateQuestion(value) {
  const now = Date.now();
  const interaction = value?.interaction;
  return (
    value?.type === 'question' &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 200 &&
    typeof value.text === 'string' &&
    value.text.trim().length > 0 &&
    value.text.length <= 1200 &&
    (interaction === undefined ||
      (interaction !== null &&
        typeof interaction === 'object' &&
        !Array.isArray(interaction) &&
        Object.keys(interaction).length === 2 &&
        Object.hasOwn(interaction, 'addressedToSupport') &&
        Object.hasOwn(interaction, 'replyToOther') &&
        typeof interaction.addressedToSupport === 'boolean' &&
        typeof interaction.replyToOther === 'boolean')) &&
    Number.isSafeInteger(value.issuedAt) &&
    value.issuedAt >= 0 &&
    value.issuedAt <= now + 5000 &&
    Number.isFinite(value.deadline) &&
    value.deadline > now &&
    value.deadline > value.issuedAt &&
    // FLAG: Source timestamps may lead bridge time by five seconds; bridge time may
    // lead this host by five seconds. Keep the original source+180s absolute deadline.
    value.deadline <= value.issuedAt + 180_000 + 5000 &&
    Array.isArray(value.history) &&
    value.history.length <= 6 &&
    value.history.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        ['user', 'assistant'].includes(item.role) &&
        typeof item.text === 'string' &&
        item.text.length <= 300,
    )
  );
}

export async function supportChatSession({
  key,
  api = false,
  chatId = SUPPORT_CHAT_IDS[0],
  signal,
  onStatus = () => {},
  onUsage = () => {},
  invoke = answerSupport,
  command = 'ssh',
  args = supportChatSshArgs(chatId),
}) {
  signal.throwIfAborted();
  if (!SUPPORT_CHAT_IDS.includes(chatId)) throw new Error('support_chat_refused');
  const sourceDigest = (id) => createHash('sha256').update(`${chatId}\0${id}`).digest('hex');
  const knowledgeSha = createHash('sha256')
    .update(readFileSync(new URL('./support-llm-knowledge.json', import.meta.url)))
    .digest('hex');
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const controller = new AbortController(),
    combined = AbortSignal.any([signal, controller.signal]);
  let hello = false,
    pending = Buffer.alloc(0),
    inference = null,
    failure = null,
    lastServerHeartbeat = Date.now();
  const send = (value) => {
    if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n');
  };
  const stop = () => {
    controller.abort();
    child.kill('SIGTERM');
  };
  signal.addEventListener('abort', stop, { once: true });
  child.stdin.on('error', stop);
  child.stderr.on('data', () => {});
  const closed = new Promise((resolve) => {
    child.once('error', () => {
      failure ??= new Error('support_ssh_unavailable');
      controller.abort();
      resolve();
    });
    child.once('close', (code) => {
      if (code !== 0) failure ??= new Error('support_ssh_unavailable');
      controller.abort();
      resolve();
    });
  });
  send({
    type: 'hello',
    knowledgeSha256: knowledgeSha,
    ...(api
      ? { apiProfileSha256: SUPPORT_API_PROFILE.sha256 }
      : { modelSha256: SUPPORT_MODEL.sha256 }),
  });
  const heartbeat = setInterval(() => {
    if (Date.now() - lastServerHeartbeat > 25000) {
      failure ??= new Error('support_server_heartbeat_stale');
      stop();
    } else if (hello) send({ type: 'heartbeat' });
  }, 5000);
  const handshake = setTimeout(() => {
    if (!hello) {
      failure ??= new Error('support_handshake_deadline');
      stop();
    }
  }, 15_000);
  try {
    for await (const chunk of child.stdout) {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 32768) throw new Error('support_frame_limit');
      let n;
      while ((n = pending.indexOf(10)) >= 0) {
        let value;
        try {
          value = JSON.parse(pending.subarray(0, n).toString('utf8'));
        } catch {
          throw new Error('support_frame_invalid');
        }
        pending = pending.subarray(n + 1);
        if (!value || typeof value !== 'object') throw new Error('support_frame_refused');
        if (
          hello &&
          ((value.type === 'heartbeat' &&
            Number.isFinite(value.sampleAt) &&
            value.sampleAt > Date.now() + 5000) ||
            (value.type === 'question' &&
              Number.isFinite(value.issuedAt) &&
              value.issuedAt > Date.now() + 5000))
        )
          throw new Error('support_clock_skew');
        if (value.type === 'hello' && value.chatId === chatId && !hello) {
          hello = true;
          lastServerHeartbeat = Date.now();
          onStatus('connected');
        } else if (
          hello &&
          value.type === 'heartbeat' &&
          (value.sampleAt === null ||
            (Number.isSafeInteger(value.sampleAt) &&
              value.sampleAt >= 0 &&
              value.sampleAt <= Date.now() + 5000))
        ) {
          lastServerHeartbeat = Date.now();
          onStatus('observation', { sampleAt: value.sampleAt });
        } else if (hello && value.type === 'question') {
          if (!validateQuestion(value)) throw new Error('support_question_refused');
          const previous = inference;
          if (previous) {
            if (
              previous.waiting ||
              previous.id === value.id ||
              (Date.now() < previous.deadline && value.issuedAt < previous.deadline)
            )
              throw new Error('support_question_overlap');
            // FLAG: A server-expired question loses all output authority immediately.
            // Admit one successor, but never start it before the prior invocation settles.
            previous.superseded = true;
            previous.controller.abort();
          }
          const current = {
            id: value.id,
            deadline: value.deadline,
            controller: new AbortController(),
            superseded: false,
            waiting: Boolean(previous),
            promise: null,
          };
          inference = current;
          current.promise = (async () => {
            try {
              if (previous) await previous.promise;
              current.waiting = false;
              if (combined.aborted) return;
              if (Date.now() >= value.deadline) {
                onStatus('inference_failed');
                return;
              }
              onStatus('answering');
              let observed = false;
              const observeUsage = (kind, usage) => {
                observed = true;
                onUsage({
                  sourceDigest: sourceDigest(value.id),
                  observedAt: new Date().toISOString(),
                  kind,
                  usage,
                });
              };
              const answer = await invoke({
                text: value.text,
                history: value.history,
                interaction: value.interaction ?? {
                  addressedToSupport: false,
                  replyToOther: false,
                },
                key,
                api,
                onUsage: (usage) => observeUsage('provider-reported', usage),
                signal: AbortSignal.any([
                  combined,
                  current.controller.signal,
                  AbortSignal.timeout(Math.min(120_000, value.deadline - Date.now())),
                ]),
              });
              if (api && !observed) observeUsage('no-api-request', null);
              if (!combined.aborted && !current.superseded) {
                if (Date.now() < value.deadline) {
                  send({
                    type: 'answer',
                    id: value.id,
                    reply: answer.action === 'reply',
                    text: answer.text,
                    ...(answer.action === 'reply' && answer.guideId !== undefined
                      ? { guideId: answer.guideId }
                      : {}),
                  });
                  onStatus(answer.action === 'reply' ? 'answered' : 'skipped');
                } else onStatus('inference_failed');
              }
            } catch {
              if (!combined.aborted && !current.superseded) {
                if (Date.now() < value.deadline)
                  send({ type: 'answer', id: value.id, reply: false, text: '' });
                onStatus('inference_failed');
              }
            }
          })().finally(() => {
            if (inference === current) inference = null;
          });
        } else if (
          hello &&
          value.type === 'settled' &&
          ['sent', 'unknown', 'refused'].includes(value.outcome)
        )
          onStatus(value.outcome, {
            sourceDigest: typeof value.id === 'string' ? sourceDigest(value.id) : null,
          });
        else throw new Error('support_frame_refused');
      }
    }
  } catch (error) {
    failure ??= error;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(handshake);
    stop();
    signal.removeEventListener('abort', stop);
    // FLAG: Abort requests cancellation; only raw invocation settlement releases ownership.
    // Reconnecting before cleanup settles can start a second inference in the same process.
    await inference?.promise?.catch(() => undefined);
    await Promise.race([closed, pause(3000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  // FLAG: A nonzero exit may arrive after stdout EOF. Preserve the first cause through cleanup.
  if (failure && !signal.aborted) throw failure;
}

export function supportChatsReady(chats, now = Date.now()) {
  return SUPPORT_CHAT_IDS.every((chatId) => {
    const chat = chats?.[chatId];
    const pollAge = now - Date.parse(chat?.lastSampleAt);
    const heartbeatAge = now - Date.parse(chat?.remoteHeartbeatAt);
    return (
      ['connected', 'answering'].includes(chat?.phase) &&
      Number.isFinite(pollAge) &&
      pollAge >= -5000 &&
      pollAge < 30_000 &&
      Number.isFinite(heartbeatAge) &&
      heartbeatAge >= 0 &&
      heartbeatAge < 25_000
    );
  });
}

export class SupportChatWorkerStatus {
  policies = new Map(SUPPORT_CHAT_IDS.map((chatId) => [chatId, new SupportReconnectPolicy()]));
  chats = Object.fromEntries(
    SUPPORT_CHAT_IDS.map((chatId) => [
      chatId,
      {
        chatId,
        phase: 'starting',
        lastSuccessAt: null,
        lastSampleAt: null,
        remoteHeartbeatAt: null,
        replies: 0,
        errors: 0,
        reconnects: 0,
        consecutiveReconnects: 0,
        reconnectDelayMs: 0,
        lastFailureCode: null,
        lastFailureAt: null,
        lastDisconnectCode: null,
        lastDisconnectAt: null,
        lastInference: null,
        lastReplyUsage: null,
      },
    ]),
  );
  event(chatId, event, details = {}) {
    const chat = this.chats[chatId],
      policy = this.policies.get(chatId);
    if (!chat || !policy) throw new Error('support_chat_refused');
    const now = new Date(Date.now()).toISOString();
    if (event === 'connected') policy.connected();
    if (event === 'connecting' || event === 'connected') {
      chat.lastSampleAt = null;
      chat.remoteHeartbeatAt = null;
      chat.reconnectDelayMs = 0;
    }
    if (event === 'observation') {
      chat.remoteHeartbeatAt = now;
      chat.lastSampleAt =
        details.sampleAt === null ? null : new Date(details.sampleAt).toISOString();
      policy.observed(details.sampleAt);
    } else if (event === 'usage') chat.lastInference = details;
    else if (event === 'disconnected') {
      chat.reconnects++;
      chat.lastDisconnectAt = now;
      chat.lastDisconnectCode = details.failureCode ?? 'support_session_closed';
      if (details.failureCode) {
        chat.errors++;
        chat.lastFailureCode = details.failureCode;
        chat.lastFailureAt = now;
      }
      chat.reconnectDelayMs = policy.disconnected();
      chat.lastSampleAt = null;
      chat.remoteHeartbeatAt = null;
      chat.phase = 'reconnecting';
    } else {
      chat.phase = event;
      if (event === 'sent') {
        chat.replies++;
        chat.lastSuccessAt = now;
        chat.lastReplyUsage =
          chat.lastInference?.sourceDigest === details.sourceDigest ? chat.lastInference : null;
      }
      // FLAG: Polls and periodic status writes never count a previous delivery failure again.
      if (['inference_failed', 'unknown', 'refused'].includes(event)) chat.errors++;
      if (['sent', 'unknown', 'refused', 'inference_failed', 'skipped', 'answered'].includes(event))
        chat.phase = 'connected';
    }
    chat.consecutiveReconnects = policy.consecutive;
  }
  snapshot(now = Date.now()) {
    const rows = Object.values(this.chats);
    const latest = (field, timeField = field) =>
      rows
        .filter((chat) => chat[field] !== null)
        .sort((a, b) => Date.parse(b[timeField]) - Date.parse(a[timeField]))[0]?.[field] ?? null;
    const oldest = (field) =>
      rows.every((chat) => chat[field] !== null) ? rows.map((chat) => chat[field]).sort()[0] : null;
    const ready = supportChatsReady(this.chats, now);
    return {
      phase: rows.every((chat) => chat.phase === 'stopped')
        ? 'stopped'
        : ready
          ? rows.some((chat) => chat.phase === 'answering')
            ? 'answering'
            : 'connected'
          : rows.some((chat) => chat.phase === 'reconnecting')
            ? 'reconnecting'
            : 'connecting',
      ready,
      chatIds: [...SUPPORT_CHAT_IDS],
      chats: Object.fromEntries(rows.map((chat) => [chat.chatId, { ...chat }])),
      lastSuccessAt: latest('lastSuccessAt'),
      lastSampleAt: oldest('lastSampleAt'),
      remoteHeartbeatAt: oldest('remoteHeartbeatAt'),
      ...Object.fromEntries(
        ['replies', 'errors', 'reconnects'].map((field) => [
          field,
          rows.reduce((sum, chat) => sum + chat[field], 0),
        ]),
      ),
      consecutiveReconnects: Math.max(...rows.map((chat) => chat.consecutiveReconnects)),
      reconnectDelayMs: Math.max(...rows.map((chat) => chat.reconnectDelayMs)),
      lastFailureCode: latest('lastFailureCode', 'lastFailureAt'),
      lastFailureAt: latest('lastFailureAt'),
      lastDisconnectCode: latest('lastDisconnectCode', 'lastDisconnectAt'),
      lastDisconnectAt: latest('lastDisconnectAt'),
      lastInference:
        rows
          .map((chat) => chat.lastInference)
          .filter(Boolean)
          .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0] ?? null,
      lastReplyUsage:
        rows
          .map((chat) => chat.lastReplyUsage)
          .filter(Boolean)
          .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0] ?? null,
    };
  }
}

export function serializeSupportInference(invoke) {
  let previous = Promise.resolve();
  return (options) => {
    // FLAG: The single CPU slot stays owned until raw cleanup settles, including cancellation.
    const current = previous.then(() => {
      options.signal.throwIfAborted();
      return invoke(options);
    });
    previous = current.catch(() => undefined);
    return current;
  };
}

export async function runSupportChatWorkers({
  key,
  api,
  signal,
  enabled = () => true,
  onStatus = () => {},
  session = supportChatSession,
  invoke = answerSupport,
  wait = pause,
}) {
  const status = new SupportChatWorkerStatus();
  const inference = api ? invoke : serializeSupportInference(invoke);
  const write = () => onStatus(status.snapshot());
  const event = (chatId, value, details) => {
    status.event(chatId, value, details);
    write();
  };
  const heartbeat = setInterval(write, 5000);
  write();
  try {
    await Promise.all(
      SUPPORT_CHAT_IDS.map(async (chatId) => {
        try {
          while (!signal.aborted && enabled()) {
            let failureCode = null;
            try {
              event(chatId, 'connecting');
              await session({
                key,
                api,
                chatId,
                signal,
                invoke: inference,
                onStatus: (value, details) => event(chatId, value, details),
                onUsage: (observation) => event(chatId, 'usage', observation),
              });
            } catch (error) {
              if (!signal.aborted) failureCode = supportChatFailureCode(error);
            }
            if (!signal.aborted && enabled()) {
              event(chatId, 'disconnected', { failureCode });
              await wait(status.chats[chatId].reconnectDelayMs, undefined, { signal }).catch(
                () => undefined,
              );
            }
          }
        } finally {
          event(chatId, 'stopped');
        }
      }),
    );
  } finally {
    clearInterval(heartbeat);
  }
}

async function run() {
  if (!existsSync(join(state, 'chat-enabled'))) return;
  const install = JSON.parse(readFileSync(join(state, 'installation.json'), 'utf8'));
  if (install.bundle !== bundle) throw new Error('support_installed_source_required');
  const provider = readSupportProvider(root);
  const api = provider.backend === 'api';
  const key = readSupportProviderKey(provider);
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const startTicks = readFileSync(`/proc/${process.pid}/stat`, 'utf8')
    .split(') ')[1]
    .split(' ')[19];
  mkdirSync(state, { recursive: true, mode: 0o700 });
  try {
    await runSupportChatWorkers({
      key,
      api,
      signal: controller.signal,
      enabled: () => existsSync(join(state, 'chat-enabled')),
      onStatus: (status) => {
        const value = {
          pid: process.pid,
          startTicks,
          bundle,
          ...status,
          heartbeatAt: new Date().toISOString(),
          model: provider.model,
          backend: provider.backend,
          ...(api
            ? {
                apiProfileSha256: SUPPORT_API_PROFILE.sha256,
                reasoningEffort: SUPPORT_API_PROFILE.reasoningEffort,
              }
            : {}),
        };
        const temporary = join(state, `chat-status.${process.pid}.tmp`);
        writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
        renameSync(temporary, join(state, 'chat-status.json'));
      },
    });
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.argv[2] === 'run'
)
  run().catch(() => {
    process.stderr.write('support_chat_unavailable\n');
    process.exitCode = 1;
  });
