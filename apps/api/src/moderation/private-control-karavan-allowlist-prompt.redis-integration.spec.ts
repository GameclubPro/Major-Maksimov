import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  deliverKaravanAllowlistPrompt,
  karavanAllowlistPromptKey,
  prepareKaravanAllowlistLaunch,
} from './private-control-karavan-allowlist-prompt';
import type { PendingKaravanAllowlistFlow } from './private-control.types';
import { RedisCounterService } from './redis-counter.service';

const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
const local = /^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);

(local ? describe : describe.skip)('Karavan private prompt on native Redis', () => {
  it('allows only one request to prepare a flow for a bot and actor', async () => {
    const first = new RedisCounterService(new ConfigService({ REDIS_URL: url }));
    const second = new RedisCounterService(new ConfigService({ REDIS_URL: url }));
    const key = `private-handoff-test:${randomUUID()}`;
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = prepareKaravanAllowlistLaunch(first, key, async () => {
      started();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    try {
      await held;
      const prepare = jest.fn(async () => true);
      await expect(prepareKaravanAllowlistLaunch(second, key, prepare)).rejects.toThrow(
        'уже запускается',
      );
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      release?.();
      await pending;
      await Promise.all([first.onModuleDestroy(), second.onModuleDestroy()]);
    }
  });

  it('suppresses a concurrent prompt and retries only after definite rejection', async () => {
    const first = new RedisCounterService(new ConfigService({ REDIS_URL: url }));
    const second = new RedisCounterService(new ConfigService({ REDIS_URL: url }));
    const flow: PendingKaravanAllowlistFlow = {
      chatId: '-1',
      chatTitle: 'Chat',
      actorUserId: '1',
      botId: 'test_bot',
      nonce: randomUUID(),
      stage: 'await_forward',
      targetUserId: null,
      targetDisplayName: null,
      sourceMessageId: null,
      expiresAt: Date.now() + 60_000,
    };
    const key = karavanAllowlistPromptKey(flow);
    const reject = jest.fn(async () => {
      throw { response: { status: 403 } };
    });
    const send = jest.fn(async () => ({ messageId: 'accepted' }));
    const onFailure = jest.fn();
    try {
      await deliverKaravanAllowlistPrompt({ flow, redis: first, send: reject, onFailure });
      expect(await first.getString(key)).toBeNull();
      await Promise.all(
        [first, second].map((redis) =>
          deliverKaravanAllowlistPrompt({ flow, redis, send, onFailure }),
        ),
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(await second.getString(key)).toBe('sent');
      const next = { ...flow, stage: 'await_duration' as const };
      const unknown = new Error('MAX unavailable');
      await expect(
        deliverKaravanAllowlistPrompt({
          flow: next,
          redis: first,
          onFailure,
          send: async () => {
            throw Object.assign(unknown, { response: { status: 503 } });
          },
        }),
      ).rejects.toBe(unknown);
      expect(await second.getString(karavanAllowlistPromptKey(next))).toBe('unknown');
      await expect(
        deliverKaravanAllowlistPrompt({ flow: next, redis: second, send, onFailure }),
      ).resolves.toBeUndefined();
      expect(send).toHaveBeenCalledTimes(1);
      await second.deleteKey(karavanAllowlistPromptKey(next));
    } finally {
      await first.deleteKey(key);
      await Promise.all([first.onModuleDestroy(), second.onModuleDestroy()]);
    }
  });
});
