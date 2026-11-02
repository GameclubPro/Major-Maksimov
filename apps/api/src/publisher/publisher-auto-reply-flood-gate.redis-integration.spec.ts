import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import {
  PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS,
  PUBLISHER_AUTO_REPLY_FLOOD_GATE_BURST_WINDOW_SEC,
} from './publisher-auto-reply-flood-gate.config';
import {
  PublisherAutoReplyFloodGateAmbiguousError,
  PublisherAutoReplyFloodGateService,
} from './publisher-auto-reply-flood-gate.service';

const QUOTA_FIXTURE_REDIS_TIMEOUT_MS = 1_000;
const REPLAY_FIXTURE_TTL_MS = 30_000;

const redisIntegrationUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const isLocalRedisUrl = (() => {
  try {
    const hostname = new URL(redisIntegrationUrl).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
})();
const describeLocalRedis = isLocalRedisUrl ? describe : describe.skip;

type FloodIdentity = Parameters<PublisherAutoReplyFloodGateService['replay']>[0];
type FixtureOperation =
  | 'setup'
  | 'user_reserve'
  | 'user_deny'
  | 'replay_allow'
  | 'replay_deny'
  | 'chat_reserve'
  | 'chat_deny'
  | 'replay_miss'
  | 'after_miss_reserve'
  | 'lost_reserve'
  | 'replay_committed'
  | 'inspect'
  | 'cleanup';
type FloodState = {
  decision: string | null;
  user: string[];
  chat: string[];
  expiresAtMs: number[];
  ttlMs: number[];
};

describeLocalRedis('PublisherAutoReplyFloodGateService Redis integration', () => {
  const originalRole = process.env.APP_ROLE;

  beforeAll(() => {
    process.env.APP_ROLE = 'enqueue';
  });

  afterAll(() => {
    process.env.APP_ROLE = originalRole;
  });

  it('enforces exact burst boundaries and keeps replay-only decisions read-only', async () => {
    const fixture = createFixture();
    const { service, inspector, identity, observe } = fixture;

    try {
      await fixture.ready();

      const allowedUserMessages = Array.from({ length: 3 }, (_, index) =>
        identity('user-burst-chat', 'user-burst', `user-message-${index}`),
      );
      for (const [index, message] of allowedUserMessages.entries()) {
        await expect(
          observe('user_reserve', index, () => service.reserve(message)),
        ).resolves.toEqual({
          allowed: true,
          replayed: false,
        });
      }
      const deniedUserMessage = identity('user-burst-chat', 'user-burst', 'user-message-denied');
      await expect(
        observe('user_deny', 3, () => service.reserve(deniedUserMessage)),
      ).resolves.toEqual({
        allowed: false,
        reason: 'user_burst',
      });
      await expect(
        observe('replay_allow', 0, () => service.replay(allowedUserMessages[0]!)),
      ).resolves.toEqual({
        allowed: true,
        replayed: true,
      });
      await expect(
        observe('replay_deny', 0, () => service.replay(deniedUserMessage)),
      ).resolves.toEqual({
        allowed: false,
        reason: 'user_burst',
      });

      const burstStartedAtMs = await observe('inspect', 0, () => redisTimeMs(inspector));
      for (let index = 0; index < 30; index += 1) {
        await expect(
          observe('chat_reserve', index, () =>
            service.reserve(identity('chat-burst', `chat-user-${index}`, `chat-message-${index}`)),
          ),
        ).resolves.toEqual({ allowed: true, replayed: false });
      }
      const chatDenial = await observe('chat_deny', 30, () =>
        service.reserve(identity('chat-burst', 'chat-user-denied', 'chat-message-denied')),
      );
      const burstFinishedAtMs = await observe('inspect', 30, () => redisTimeMs(inspector));
      // FLAG: A larger command budget must not turn a rolled-over burst window into quota evidence.
      const burstElapsedMs = burstFinishedAtMs - burstStartedAtMs;
      expect(burstElapsedMs).toBeGreaterThanOrEqual(0);
      expect(burstElapsedMs).toBeLessThan(PUBLISHER_AUTO_REPLY_FLOOD_GATE_BURST_WINDOW_SEC * 1_000);
      expect(chatDenial).toEqual({ allowed: false, reason: 'chat_burst' });

      const missing = identity('missing-chat', 'missing-user', 'missing-message');
      await expect(observe('replay_miss', 0, () => service.replay(missing))).resolves.toEqual({
        allowed: false,
        reason: 'decision_missing',
      });
      expect(
        await observe('inspect', 0, () => inspector.exists(...buildFloodGateKeys(missing))),
      ).toBe(0);
      await expect(
        observe('after_miss_reserve', 0, () => service.reserve(missing)),
      ).resolves.toEqual({
        allowed: true,
        replayed: false,
      });
    } finally {
      await fixture.close();
    }
  });

  it('replays a committed admission after response loss without changing counters or expiry', async () => {
    const fixture = createFixture();
    const { service, inspector, observe } = fixture;
    const message = fixture.identity('lost-chat', 'lost-user', 'lost-message');
    const keys = buildFloodGateKeys(message);
    const lostResponse = new Error('Synthetic flood-gate response loss after commit');
    let committedReply: unknown;
    let injected = false;
    let restoreEval: (() => void) | undefined;

    try {
      await fixture.ready();
      const redis = serviceRedis(service);
      const originalEval = redis.eval.bind(redis);
      const evalSpy = jest.spyOn(redis, 'eval').mockImplementationOnce(async (...args) => {
        // FLAG: Commit the real Lua operation before losing only its response; never retry reserve.
        committedReply = await originalEval(...args);
        injected = true;
        throw lostResponse;
      });
      restoreEval = () => evalSpy.mockRestore();
      try {
        const rejectedAsExpected = await observe('lost_reserve', 0, async () => {
          try {
            await service.reserve(message);
            return false;
          } catch (error: unknown) {
            if (
              error instanceof PublisherAutoReplyFloodGateAmbiguousError &&
              error.cause === lostResponse
            ) {
              return true;
            }
            throw error;
          }
        });
        expect(rejectedAsExpected).toBe(true);
        expect(injected).toBe(true);
        expect(evalSpy.mock.calls.length).toBe(1);
        expect(isDeepStrictEqual(committedReply, [1, 0, 1, 1, 1, 1])).toBe(true);
      } finally {
        restoreEval();
        restoreEval = undefined;
      }

      const committed = await observe('inspect', 0, () => readFloodState(inspector, keys));
      expectAdmittedState(committed, message);
      // FLAG: Earlier owned fixture expiries make a replay refresh visible even within one millisecond.
      const fixtureExpiresAtMs =
        (await observe('inspect', 0, () => redisTimeMs(inspector))) + REPLAY_FIXTURE_TTL_MS;
      expect(committed.expiresAtMs.every((expiry) => fixtureExpiresAtMs < expiry)).toBe(true);
      const shortened = await observe('inspect', 0, () =>
        Promise.all(keys.map((key) => inspector.pexpireat(key, fixtureExpiresAtMs))),
      );
      expect(shortened.every((result) => result === 1)).toBe(true);
      const beforeReplay = await observe('inspect', 0, () => readFloodState(inspector, keys));
      expectAdmittedState(beforeReplay, message);
      expect(beforeReplay.expiresAtMs.every((expiry) => expiry === fixtureExpiresAtMs)).toBe(true);

      await expect(observe('replay_committed', 0, () => service.replay(message))).resolves.toEqual({
        allowed: true,
        replayed: true,
      });
      const afterReplay = await observe('inspect', 0, () => readFloodState(inspector, keys));
      expectAdmittedState(afterReplay, message);
      expect({
        decisionUnchanged: afterReplay.decision === beforeReplay.decision,
        userMembersAndScoresUnchanged: isDeepStrictEqual(afterReplay.user, beforeReplay.user),
        chatMembersAndScoresUnchanged: isDeepStrictEqual(afterReplay.chat, beforeReplay.chat),
        absoluteExpiriesUnchanged: isDeepStrictEqual(
          afterReplay.expiresAtMs,
          beforeReplay.expiresAtMs,
        ),
        positiveNonincreasingTtls: afterReplay.ttlMs.every(
          (ttl, index) => ttl > 0 && ttl <= beforeReplay.ttlMs[index]!,
        ),
      }).toEqual({
        decisionUnchanged: true,
        userMembersAndScoresUnchanged: true,
        chatMembersAndScoresUnchanged: true,
        absoluteExpiriesUnchanged: true,
        positiveNonincreasingTtls: true,
      });
    } finally {
      restoreEval?.();
      await fixture.close();
    }
  });
});

describe('Publisher flood-gate native fixture diagnostics', () => {
  it('keeps hostile cause fields private and reports only fixed categories and bounded scalars', () => {
    const privateValue = 'private-bot-chat-user-message-token';
    const cause = Object.assign(new Error(privateValue), {
      name: privateValue,
      code: privateValue,
      stack: privateValue,
    });
    const diagnostic = fixtureFailure(
      'chat_reserve',
      999,
      Number.POSITIVE_INFINITY,
      privateValue,
      new PublisherAutoReplyFloodGateAmbiguousError(cause),
    );
    expect(diagnostic.message).toBe(
      'Flood-gate native fixture failed: ' +
        JSON.stringify({
          operation: 'chat_reserve',
          index: 30,
          elapsedMs: 0,
          timeoutMs: QUOTA_FIXTURE_REDIS_TIMEOUT_MS,
          redisState: 'unknown',
          outer: 'ambiguous',
          cause: 'unknown',
        }),
    );
    expect(diagnostic.cause).toBeUndefined();
    expect(diagnostic.stack?.includes(privateValue)).toBe(false);
    expect(
      fixtureFailure(
        'chat_reserve',
        1,
        1_001.4,
        'ready',
        new PublisherAutoReplyFloodGateAmbiguousError(new Error('Command timed out')),
      ).message,
    ).toContain('"cause":"redis_command_timeout"');
  });
});

function createFixture() {
  expect(QUOTA_FIXTURE_REDIS_TIMEOUT_MS).toBeGreaterThanOrEqual(
    PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.redisTimeoutMs.min,
  );
  expect(QUOTA_FIXTURE_REDIS_TIMEOUT_MS).toBeLessThanOrEqual(
    PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.redisTimeoutMs.max,
  );
  const suffix = randomUUID();
  const ownedKeys = new Set<string>();
  const service = new PublisherAutoReplyFloodGateService(
    new ConfigService({
      REDIS_URL: redisIntegrationUrl,
      PUBLISHER_AUTO_REPLY_FLOOD_GATE_REDIS_TIMEOUT_MS: QUOTA_FIXTURE_REDIS_TIMEOUT_MS,
    }),
  );
  const inspector = new Redis(redisIntegrationUrl, {
    commandTimeout: QUOTA_FIXTURE_REDIS_TIMEOUT_MS,
    connectTimeout: QUOTA_FIXTURE_REDIS_TIMEOUT_MS,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  inspector.on('error', () => undefined);
  const observe = async <T>(
    operation: FixtureOperation,
    index: number,
    run: () => Promise<T>,
  ): Promise<T> => {
    const startedAtMs = performance.now();
    try {
      return await run();
    } catch (error: unknown) {
      throw fixtureFailure(
        operation,
        index,
        performance.now() - startedAtMs,
        serviceRedis(service).status,
        error,
      );
    }
  };
  return {
    service,
    inspector,
    observe,
    identity: (chat: string, user: string, message: string): FloodIdentity => {
      const value = {
        publisherBotId: `publisher-bot-${suffix}`,
        chatId: `${chat}-${suffix}`,
        senderUserId: `${user}-${suffix}`,
        sourceMessageId: `${message}-${suffix}`,
      };
      for (const key of buildFloodGateKeys(value)) ownedKeys.add(key);
      return value;
    },
    ready: () =>
      observe('setup', 0, async () => {
        await Promise.all([waitForRedis(serviceRedis(service)), waitForRedis(inspector)]);
      }),
    close: () =>
      observe('cleanup', 0, async () => {
        try {
          if (ownedKeys.size > 0) await inspector.del(...ownedKeys);
        } finally {
          try {
            await inspector.quit();
          } finally {
            inspector.disconnect(false);
            service.onModuleDestroy();
          }
        }
      }),
  };
}

function fixtureFailure(
  operation: FixtureOperation,
  index: number,
  elapsedMs: number,
  redisState: string,
  error: unknown,
): Error {
  const ambiguous = error instanceof PublisherAutoReplyFloodGateAmbiguousError;
  const cause = ambiguous ? error.cause : error;
  let causeCategory = 'unknown';
  if (cause instanceof Error) {
    if (cause.message === 'Command timed out') causeCategory = 'redis_command_timeout';
    else if (cause.name === 'ReplyError') causeCategory = 'redis_reply_error';
  }
  const states = ['wait', 'connecting', 'connect', 'ready', 'reconnecting', 'close', 'end'];
  return new Error(
    'Flood-gate native fixture failed: ' +
      JSON.stringify({
        operation,
        index: Number.isFinite(index) ? Math.max(0, Math.min(30, Math.floor(index))) : 0,
        elapsedMs: Number.isFinite(elapsedMs)
          ? Math.max(0, Math.min(60_000, Math.round(elapsedMs)))
          : 0,
        timeoutMs: QUOTA_FIXTURE_REDIS_TIMEOUT_MS,
        redisState: states.includes(redisState) ? redisState : 'unknown',
        outer: ambiguous ? 'ambiguous' : 'other',
        cause: causeCategory,
      }),
  );
}

function serviceRedis(service: PublisherAutoReplyFloodGateService): Redis {
  const redis = (service as unknown as { readonly redis: Redis | null }).redis;
  if (!redis) throw new Error('Flood-gate native fixture has no Redis client');
  return redis;
}

async function redisTimeMs(redis: Redis): Promise<number> {
  const [seconds, microseconds] = await redis.time();
  const milliseconds = Number(seconds) * 1_000 + Math.floor(Number(microseconds) / 1_000);
  expect(Number.isSafeInteger(milliseconds)).toBe(true);
  return milliseconds;
}

async function readFloodState(redis: Redis, keys: [string, string, string]): Promise<FloodState> {
  const [decision, user, chat, expiresAtMs, ttlMs] = await Promise.all([
    redis.get(keys[0]),
    redis.zrange(keys[1], 0, -1, 'WITHSCORES'),
    redis.zrange(keys[2], 0, -1, 'WITHSCORES'),
    Promise.all(keys.map((key) => redis.pexpiretime(key))),
    Promise.all(keys.map((key) => redis.pttl(key))),
  ]);
  return { decision, user, chat, expiresAtMs, ttlMs };
}

function expectAdmittedState(state: FloodState, identity: FloodIdentity): void {
  const member = digestIdentity(
    'decision',
    identity.publisherBotId,
    identity.chatId,
    identity.sourceMessageId,
  );
  expect({
    decisionStored: state.decision === '1',
    userCardinality: state.user.length / 2,
    chatCardinality: state.chat.length / 2,
    exactUserMember: state.user[0] === member,
    exactChatMember: state.chat[0] === member,
    samePositiveIntegerScore:
      state.user[1] === state.chat[1] &&
      Number.isSafeInteger(Number(state.user[1])) &&
      Number(state.user[1]) > 0,
    positiveFiniteTtls: state.ttlMs.every((ttl) => Number.isSafeInteger(ttl) && ttl > 0),
    positiveFiniteExpiries: state.expiresAtMs.every(
      (expiry) => Number.isSafeInteger(expiry) && expiry > 0,
    ),
  }).toEqual({
    decisionStored: true,
    userCardinality: 1,
    chatCardinality: 1,
    exactUserMember: true,
    exactChatMember: true,
    samePositiveIntegerScore: true,
    positiveFiniteTtls: true,
    positiveFiniteExpiries: true,
  });
}

function buildFloodGateKeys(identity: FloodIdentity): [string, string, string] {
  const chatDigest = digestIdentity('chat', identity.publisherBotId, identity.chatId);
  const userDigest = digestIdentity(
    'user',
    identity.publisherBotId,
    identity.chatId,
    identity.senderUserId,
  );
  const decisionDigest = digestIdentity(
    'decision',
    identity.publisherBotId,
    identity.chatId,
    identity.sourceMessageId,
  );
  const prefix = `publisher:auto-reply:flood:v1:{${chatDigest}}`;
  return [`${prefix}:decision:${decisionDigest}`, `${prefix}:user:${userDigest}`, `${prefix}:chat`];
}

function digestIdentity(domain: string, ...parts: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([domain, ...parts]))
    .digest('hex')
    .slice(0, 32);
}

async function waitForRedis(redis: Redis): Promise<void> {
  if (redis.status === 'ready') {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for flood-gate Redis integration client'));
    }, 5_000);
    timeout.unref();
    const cleanup = () => {
      clearTimeout(timeout);
      redis.off('ready', onReady);
      redis.off('end', onEnd);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onEnd = () => {
      cleanup();
      reject(new Error('Flood-gate Redis integration client closed before becoming ready'));
    };
    redis.once('ready', onReady);
    redis.once('end', onEnd);
  });
}
