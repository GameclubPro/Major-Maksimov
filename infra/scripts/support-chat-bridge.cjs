// FLAG: Each process reads/replies only in one owner-approved CHAT. Keep the original
// chat's Redis namespace unchanged so uncertain sends remain fenced across upgrades.
const { createHash, randomUUID } = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');
const CHAT_IDS = Object.freeze(['-78271094414679', '-79143082792210']);
const CHAT_ID = process.env.SUPPORT_CHAT_ID ?? CHAT_IDS[0];
if (!CHAT_IDS.includes(CHAT_ID)) throw new Error('support_chat_refused');
const PREFIX = `support-cpu-pilot:v1:${CHAT_ID}`;
const SOURCE_AGE_MS = 180_000;
const RETENTION_MS = 7 * 86400_000;
const MODEL_SHA = '769d386a69d43782321c1bad04d41d29a2e84b2c06e6a277cd99fd6265ec0e80';
const API_PROFILE_SHA = '6d528271f60ea9dfb2005f8fa9f68ba231b4564ebf8c840065d3d64ebe84656b';
const DIGEST = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ANSWER_FOOTER = '✦ Ответ подготовлен ИИ-помощником «Майор Максимов»';

function supportProfileMatches(value) {
  // FLAG: API configuration identity is distinct from a CPU weight digest. Require exactly
  // one reviewed profile; neither a claimed model name nor an arbitrary endpoint grants access.
  return (
    (value.modelSha256 === MODEL_SHA && value.apiProfileSha256 === undefined) ||
    (value.apiProfileSha256 === API_PROFILE_SHA && value.modelSha256 === undefined)
  );
}

function validateSupportBotCatalog(catalog) {
  if (
    !Array.isArray(catalog) ||
    catalog.length !== 8 ||
    new Set(catalog.map((bot) => bot?.id)).size !== 8 ||
    new Set(catalog.map((bot) => bot?.url)).size !== 8 ||
    catalog.some(
      (bot) =>
        typeof bot?.id !== 'string' ||
        typeof bot.name !== 'string' ||
        !bot.name.trim() ||
        bot.name.length > 60 ||
        typeof bot.url !== 'string' ||
        !/^https:\/\/max\.ru\/[A-Za-z0-9_]+$/u.test(bot.url ?? '') ||
        !Array.isArray(bot.aliases) ||
        bot.aliases.length > 16 ||
        bot.aliases.some(
          (alias) => typeof alias !== 'string' || !alias.trim() || alias.length > 60,
        ),
    )
  )
    throw new Error('support_bot_catalog_refused');
  const names = new Map();
  for (const bot of catalog)
    for (const name of [bot.name, ...bot.aliases]) {
      const key = name.toLocaleLowerCase('ru');
      if (names.has(key) && names.get(key) !== bot.url)
        throw new Error('support_bot_catalog_ambiguous');
      names.set(key, bot.url);
    }
  return catalog;
}

function renderSupportMessage(text, catalog = []) {
  const escape = (value) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const footer = text.endsWith(`\n\n${ANSWER_FOOTER}`) ? `\n\n${ANSWER_FOOTER}` : '';
  const body = footer ? text.slice(0, -footer.length) : text;
  const aliases = new Map();
  for (const bot of catalog.length ? validateSupportBotCatalog(catalog) : [])
    for (const alias of [bot.name, ...bot.aliases]) {
      const key = alias.toLocaleLowerCase('ru');
      aliases.set(key, { url: bot.url, canonical: key === bot.name.toLocaleLowerCase('ru') });
    }
  let html = '',
    last = 0;
  if (aliases.size) {
    const pattern = [...aliases.keys()]
      .sort((a, b) => b.length - a.length)
      .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
      .join('|');
    const names = new RegExp(
      `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])(?!(?:\\s*[№#-]\\s*|\\s+)\\d)`,
      'giu',
    );
    const matches = [...body.matchAll(names)];
    const preferred = new Map();
    // FLAG: Model/user markup is escaped. Only verified catalog names create anchors;
    // directory items and canonical names outrank alias prose. Keep the AI footer separate.
    for (const match of matches) {
      const target = aliases.get(match[0].toLocaleLowerCase('ru'));
      if (!target) continue;
      const lineStart = body.lastIndexOf('\n', match.index - 1) + 1;
      const lineEnd = body.indexOf('\n', match.index);
      const before = body.slice(lineStart, match.index);
      const after = body.slice(match.index + match[0].length, lineEnd < 0 ? body.length : lineEnd);
      const item = /^\s*(?:[•*+–—-]|\d+[.)])\s+$/u.test(before);
      const standalone = target.canonical && !before.trim() && !after.trim();
      const rank = (item ? 4 : standalone ? 2 : 0) + Number(target.canonical);
      if (!preferred.has(target.url) || rank > preferred.get(target.url).rank)
        preferred.set(target.url, { index: match.index, rank });
    }
    for (const match of matches) {
      const target = aliases.get(match[0].toLocaleLowerCase('ru'));
      html += escape(body.slice(last, match.index));
      html +=
        target && preferred.get(target.url)?.index === match.index
          ? `<a href="${escape(target.url)}">${escape(match[0])}</a>`
          : escape(match[0]);
      last = match.index + match[0].length;
    }
  }
  html += escape(body.slice(last)) + escape(footer);
  if (!text.trim() || text.length > 1800 || html.length > 4000)
    throw new Error('support_presentation_budget');
  return { text: html, textFormat: 'html' };
}
const LEASE_RENEW =
  "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('PEXPIRE',KEYS[1],15000) return 1";
const LEASE_RELEASE =
  "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0";
const SEND_CAS = `
if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('GET',KEYS[2])~=ARGV[1] then return 0 end
local now=redis.call('TIME'); local ms=now[1]*1000+math.floor(now[2]/1000)
if ms>tonumber(ARGV[2]) or redis.call('GET',KEYS[3])~='PREPARED:'..ARGV[1] then return 0 end
redis.call('SET',KEYS[3],'SENDING:'..ARGV[1],'PX',ARGV[3]); return 1`;

function sourceMessage(row, now = Date.now()) {
  if (!row || String(row.recipient?.chat_id) !== CHAT_ID || row.sender?.is_bot !== false)
    return null;
  const id = row.body?.mid,
    text = row.body?.text,
    userId = row.sender?.user_id;
  let timestamp = Number(row.timestamp);
  if (timestamp > 0 && timestamp < 1e12) timestamp *= 1000;
  if (
    typeof id !== 'string' ||
    !id ||
    id.length > 200 ||
    typeof text !== 'string' ||
    !text.trim() ||
    text.length > 1200 ||
    (typeof userId !== 'number' && typeof userId !== 'string') ||
    !/^\d+$/u.test(String(userId)) ||
    !Number.isFinite(timestamp) ||
    timestamp > now + 5000 ||
    now - timestamp > SOURCE_AGE_MS
  )
    return null;
  const value = {
    id,
    text,
    userId: String(userId),
    timestamp,
    edited: row.last_updated_time ?? row.body?.last_updated_time ?? null,
  };
  return { ...value, fingerprint: DIGEST(value) };
}

class PilotFence {
  constructor(redis, owner = randomUUID()) {
    this.redis = redis;
    this.owner = owner;
    this.lease = `${PREFIX}:lease`;
    this.enabled = `${PREFIX}:enabled`;
  }
  key(id) {
    return `${PREFIX}:source:${DIGEST(id)}`;
  }
  async acquire() {
    if ((await this.redis.set(this.lease, this.owner, 'PX', 15000, 'NX')) !== 'OK') return false;
    await this.redis.set(this.enabled, this.owner, 'PX', 15000);
    return true;
  }
  async renew() {
    if (Number(await this.redis.eval(LEASE_RENEW, 1, this.lease, this.owner)) !== 1) return false;
    return Number(await this.redis.eval(LEASE_RENEW, 1, this.enabled, this.owner)) === 1;
  }
  async prepare(id) {
    return (
      (await this.redis.set(this.key(id), `PREPARED:${this.owner}`, 'PX', RETENTION_MS, 'NX')) ===
      'OK'
    );
  }
  async begin(id, deadline) {
    return (
      Number(
        await this.redis.eval(
          SEND_CAS,
          3,
          this.lease,
          this.enabled,
          this.key(id),
          this.owner,
          String(deadline),
          String(RETENTION_MS),
        ),
      ) === 1
    );
  }
  async settle(id, state, expected = 'SENDING') {
    // FLAG: No transition ever makes an attempted SEND executable again, including lost ACKs.
    return this.redis.eval(
      "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('SET',KEYS[1],ARGV[2],'PX',ARGV[3]); return 1",
      1,
      this.key(id),
      `${expected}:${this.owner}`,
      state,
      String(RETENTION_MS),
    );
  }
  async close() {
    await this.redis.eval(LEASE_RELEASE, 1, this.enabled, this.owner);
    await this.redis.eval(LEASE_RELEASE, 1, this.lease, this.owner);
  }
}

class PilotHistory {
  constructor() {
    this.users = new Map();
  }
  read(userId) {
    return (this.users.get(userId) ?? []).slice(-6);
  }
  push(userId, entry) {
    if (!this.users.has(userId) && this.users.size >= 32)
      this.users.delete(this.users.keys().next().value);
    this.users.set(userId, [...this.read(userId), entry].slice(-6));
  }
}

async function deliverAnswer(runtime, fence, source, answer, { signal, sessionEnd, heartbeatAt }) {
  let attempted = false;
  try {
    const presented = renderSupportMessage(answer, runtime.supportBotCatalog);
    const result = await runtime.client.sendMessageImmediateWithId(
      CHAT_ID,
      presented.text,
      {
        textFormat: presented.textFormat,
        messageLink: { type: 'reply', mid: source.id },
        beforeSend: async () => {
          if (
            signal.aborted ||
            Date.now() > source.timestamp + SOURCE_AGE_MS ||
            Date.now() - heartbeatAt() > 15000
          )
            throw new Error('support_source_expired');
          await runtime.assertSourceAllowed(source);
          const exact = sourceMessage(
            await runtime.client.getExactMessageRow(CHAT_ID, source.id, runtime.options()),
          );
          if (!exact || exact.fingerprint !== source.fingerprint)
            throw new Error('support_source_changed');
          await runtime.assertAccess();
          if (
            signal.aborted ||
            Date.now() > sessionEnd ||
            Date.now() - heartbeatAt() > 15000 ||
            !(await fence.begin(source.id, Math.min(sessionEnd, source.timestamp + SOURCE_AGE_MS)))
          )
            throw new Error('support_send_refused');
          attempted = true;
        },
      },
      {
        ...runtime.options(),
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        timeoutMs: 12000,
      },
    );
    if (!result?.messageId) throw new Error('support_ack_missing');
    if (Number(await fence.settle(source.id, `SENT:${result.messageId}`)) !== 1)
      throw new Error('support_receipt_lost');
    return 'sent';
  } catch {
    await fence.settle(
      source.id,
      attempted ? 'UNKNOWN' : 'REFUSED',
      attempted ? 'SENDING' : 'PREPARED',
    );
    return attempted ? 'unknown' : 'refused';
  }
}

async function createRuntime() {
  const cleanups = [];
  const close = async () => {
    for (const cleanup of cleanups.reverse())
      await Promise.resolve()
        .then(cleanup)
        .catch(() => undefined);
    cleanups.length = 0;
  };
  try {
    const supportBotCatalog = validateSupportBotCatalog(
      JSON.parse(process.env.SUPPORT_BOT_CATALOG ?? 'null'),
    );
    require('reflect-metadata');
    const base = './apps/api/dist/apps/api/src/';
    const { Logger } = require('@nestjs/common');
    Logger.overrideLogger(false);
    const { ConfigService } = require('@nestjs/config');
    const { HttpService } = require('@nestjs/axios');
    const axios = require('axios').default;
    const { validateEnv } = require(base + 'config/env.schema.js');
    const { PrismaService } = require(base + 'prisma/prisma.service.js');
    const { MaxBotRegistryService } = require(base + 'max/max-bot-registry.service.js');
    const { MaxBotContextService } = require(base + 'max/max-bot-context.service.js');
    const { MaxClientService } = require(base + 'max/max-client.service.js');
    const { MaxBotLinkService } = require(base + 'max/max-bot-link.service.js');
    const { ModerationDeleteIntentAccessWakeService } = require(
      base + 'max/moderation-delete-intent-access-wake.service.js',
    );
    const { RedisCounterService } = require(base + 'moderation/redis-counter.service.js');
    const { ActionHealthService } = require(base + 'system/action-health.service.js');
    const { WebhookLegacyHoldService, assertLegacyActionAllowed } = require(
      base + 'webhook/webhook-legacy-hold.service.js',
    );
    const Redis = require('ioredis');
    const config = new ConfigService(validateEnv(process.env));
    if (
      config.get('APP_SERVICE_NAME') !== 'api-action' ||
      config.get('MAX_ACTION_DISPATCH_ENABLED') !== true
    )
      throw new Error('support_role_refused');
    const prisma = new PrismaService();
    cleanups.push(() => prisma.$disconnect());
    await prisma.$connect();
    const registry = new MaxBotRegistryService(config),
      context = new MaxBotContextService();
    const health = new ActionHealthService(config);
    cleanups.push(() => health.onModuleDestroy());
    const counters = new RedisCounterService(config);
    cleanups.push(() => counters.onModuleDestroy());
    const links = new MaxBotLinkService(
      prisma,
      registry,
      context,
      new ModerationDeleteIntentAccessWakeService(prisma),
      undefined,
      counters,
    );
    cleanups.push(() => links.onModuleDestroy());
    const holds = new WebhookLegacyHoldService(prisma);
    const client = new MaxClientService(
      new HttpService(axios.create({ timeout: 5000, maxRedirects: 0 })),
      config,
      health,
      registry,
      context,
      undefined,
      undefined,
      undefined,
      links,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      holds,
    );
    cleanups.push(() => client.onModuleDestroy());
    const redis = new Redis(config.getOrThrow('REDIS_URL'), {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      commandTimeout: 5000,
      enableOfflineQueue: false,
    });
    cleanups.push(() => redis.disconnect());
    await new Promise((resolve, reject) => {
      if (redis.status === 'ready') resolve();
      else {
        redis.once('ready', resolve);
        redis.once('error', reject);
      }
    });
    let botId;
    const current = () =>
      prisma.chat.findUnique({
        where: { id: CHAT_ID },
        select: { entityType: true, fixedModeratorBotId: true, primaryBotId: true, botId: true },
      });
    const assertAccess = async () => {
      const chat = await current();
      const selected = chat?.fixedModeratorBotId ?? chat?.primaryBotId ?? chat?.botId;
      if (chat?.entityType !== 'CHAT' || !selected || (botId && selected !== botId))
        throw new Error('support_assignment_refused');
      botId = selected;
      if (!registry.getActionableBots().some((bot) => bot.id === botId))
        throw new Error('support_bot_refused');
      const options = {
        botId,
        bypassCache: true,
        trafficClass: 'background',
        timeoutMs: 5000,
        sourceTag: 'support_cpu_pilot',
      };
      const snapshot = await client.getChatSnapshot(CHAT_ID, options);
      const access = await client.getCurrentChatMemberAccess(CHAT_ID, options);
      if (
        snapshot.entityType !== 'chat' ||
        (!access.isAdmin && !access.isOwner) ||
        !(await links.getFreshChatBotExecutionProof({
          chatId: CHAT_ID,
          botId,
          purpose: 'send_message',
        }))
      )
        throw new Error('support_access_refused');
      return { botId, title: snapshot.title };
    };
    return {
      client,
      redis,
      assertAccess,
      options: () => ({
        botId,
        trafficClass: 'background',
        sourceTag: 'support_cpu_pilot',
        timeoutMs: 5000,
      }),
      assertSourceAllowed: (source) =>
        assertLegacyActionAllowed(holds, {
          actionType: 'SEND_MESSAGE',
          chatId: CHAT_ID,
          botId,
          messageId: source.id,
          userId: source.userId,
          createdAt: new Date(source.timestamp).toISOString(),
          idempotencyKey: `${PREFIX}:${DIGEST(source.id)}`,
          attempt: 0,
          options: { messageLink: { type: 'reply', mid: source.id } },
        }),
      supportBotCatalog,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function runBridge(runtime, { preview = false } = {}) {
  const controller = new AbortController(),
    fence = new PilotFence(runtime.redis);
  const started = Date.now(),
    endAt = started + 30 * 60_000;
  let lastHeartbeat = started,
    hello = false,
    busy = null,
    pending = Buffer.alloc(0),
    lastPoll = 0,
    lastReport = 0,
    lastSampleAt = null,
    receiveFailure = null;
  const history = new PilotHistory();
  const abort = () => controller.abort();
  const deadlineTimer = setTimeout(abort, 30 * 60_000);
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  process.stdout.on('error', abort);
  try {
    const identity = await runtime.assertAccess();
    if (preview) {
      send({ type: 'preview', chatId: CHAT_ID, ...identity, readOnly: true });
      return;
    }
    if (!(await fence.acquire())) throw new Error('support_worker_busy');
    const receive = (async () => {
      for await (const chunk of process.stdin) {
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
            value.type === 'hello' &&
            !hello &&
            supportProfileMatches(value) &&
            value.knowledgeSha256 === process.env.SUPPORT_KNOWLEDGE_SHA256
          ) {
            hello = true;
            lastHeartbeat = Date.now();
            send({ type: 'hello', chatId: CHAT_ID, ...identity });
          } else if (value.type === 'heartbeat' && hello) lastHeartbeat = Date.now();
          else if (
            value.type === 'answer' &&
            hello &&
            busy &&
            value.id === busy.id &&
            typeof value.text === 'string' &&
            value.text.length <= 1800 &&
            typeof value.reply === 'boolean'
          ) {
            busy.answer = { reply: value.reply, text: value.text };
          } else throw new Error('support_frame_refused');
        }
      }
    })();
    // FLAG: Protocol failures must exit unsuccessfully, not masquerade as normal rotation.
    void receive.then(abort, (error) => {
      receiveFailure = error;
      abort();
    });
    while (!controller.signal.aborted && Date.now() < endAt) {
      if (Date.now() - lastHeartbeat > 15000 || !(await fence.renew()))
        throw new Error('support_heartbeat_lost');
      if (hello && Date.now() - lastReport > 5000) {
        lastReport = Date.now();
        send({ type: 'heartbeat', sampleAt: lastSampleAt });
      }
      if (busy?.answer) {
        const source = busy,
          answer = source.answer;
        busy = null;
        if (!answer.reply || !answer.text.trim())
          await fence.settle(source.id, 'SKIPPED', 'PREPARED');
        else {
          const outcome = await deliverAnswer(runtime, fence, source, answer.text, {
            signal: controller.signal,
            sessionEnd: endAt,
            heartbeatAt: () => lastHeartbeat,
          });
          if (outcome === 'sent')
            history.push(source.userId, { role: 'assistant', text: answer.text.slice(0, 300) });
          send({ type: 'settled', id: source.id, outcome });
        }
      }
      if (busy && Date.now() > busy.timestamp + SOURCE_AGE_MS) {
        await fence.settle(busy.id, 'EXPIRED', 'PREPARED');
        busy = null;
      }
      if (hello && !busy && Date.now() - lastPoll > 5000) {
        lastPoll = Date.now();
        const rows = await runtime.client.listMessages(CHAT_ID, {
          count: 30,
          ...runtime.options(),
        });
        lastSampleAt = Date.now();
        const fresh = rows
          .map((row) => sourceMessage(row))
          .filter((source) => source && source.timestamp > started)
          .sort((a, b) => a.timestamp - b.timestamp);
        for (const source of fresh) {
          if (!(await fence.prepare(source.id))) continue;
          busy = source;
          send({
            type: 'question',
            id: source.id,
            text: source.text,
            history: history.read(source.userId),
            issuedAt: Date.now(),
            deadline: source.timestamp + SOURCE_AGE_MS,
          });
          history.push(source.userId, { role: 'user', text: source.text.slice(0, 300) });
          break;
        }
      }
      await pause(500, undefined, { signal: controller.signal }).catch(() => undefined);
    }
    if (receiveFailure) throw receiveFailure;
  } finally {
    clearTimeout(deadlineTimer);
    controller.abort();
    process.stdin.destroy();
    await fence.close().catch(() => undefined);
    await runtime.close();
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
    process.stdout.removeListener('error', abort);
  }
}

module.exports = {
  CHAT_IDS,
  CHAT_ID,
  MODEL_SHA,
  API_PROFILE_SHA,
  supportProfileMatches,
  SOURCE_AGE_MS,
  sourceMessage,
  PilotFence,
  PilotHistory,
  deliverAnswer,
  validateSupportBotCatalog,
  renderSupportMessage,
  runBridge,
};
if (require.main === module || module.id === '[eval]' || module.id === '[stdin]') {
  createRuntime()
    .then((runtime) => runBridge(runtime, { preview: process.env.SUPPORT_PREVIEW === '1' }))
    .catch((error) => {
      const code = /^support_[a-z0-9_]{1,80}$/u.test(error?.message ?? '')
        ? error.message
        : 'support_bridge_unavailable';
      process.stderr.write(code + '\n');
      process.exitCode = 1;
    });
}
