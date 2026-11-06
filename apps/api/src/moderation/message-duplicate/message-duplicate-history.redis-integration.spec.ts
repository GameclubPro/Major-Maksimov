import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { OfflineDuplicateWindow } from '../../scripts/replay-antiduplicate-corpus';
import { RedisCounterService } from '../redis-counter.service';
import {
  digestDuplicateContent,
  extractDuplicateMessageContent,
} from './message-duplicate-content';
import { MessageDuplicateHistoryService } from './message-duplicate-history.service';
import {
  MESSAGE_DUPLICATE_HISTORY_GRACE_MS,
  MESSAGE_DUPLICATE_HISTORY_RETENTION_MS,
  MESSAGE_DUPLICATE_HISTORY_STORAGE_VERSION,
  MESSAGE_DUPLICATE_HISTORY_FENCE_STORAGE_VERSION,
} from './message-duplicate-window.script';
import {
  messageDuplicateBindingSchema,
  type MessageDuplicateBinding,
} from './message-duplicate-state';
import {
  MessageDuplicatePolicyService,
  MESSAGE_DUPLICATE_CONTROL_KEY,
} from './message-duplicate-policy.service';
import { duplicateSettings } from './message-duplicate-test-fixtures';
import { MessageDuplicateMetricsService } from './message-duplicate-metrics.service';
import {
  duplicateTelemetryKey,
  DUPLICATE_TELEMETRY_BUCKET_MS,
} from './message-duplicate-telemetry';

const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
const local = /^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
(local ? describe : describe.skip)('message duplicate Redis integration', () => {
  let redis: RedisCounterService;
  let inspector: Redis;
  let history: MessageDuplicateHistoryService;
  let keys: Set<string>;
  let chatId: string;
  const settings = duplicateSettings();
  const start = Date.now() - 10000;
  beforeEach(() => {
    redis = new RedisCounterService(new ConfigService({ REDIS_URL: url }));
    inspector = new Redis(url);
    history = new MessageDuplicateHistoryService(redis);
    keys = new Set();
    chatId = randomUUID();
    const original = redis.replaceRevisionedSetMembershipsBeforeDeadline.bind(redis);
    jest
      .spyOn(redis, 'replaceRevisionedSetMembershipsBeforeDeadline')
      .mockImplementation((params) => {
        keys.add(params.stateKey);
        params.membershipKeys.forEach((key) => keys.add(key));
        return original(params);
      });
  });
  afterEach(async () => {
    await redis.deleteKeysByPattern(`dup:window:v1:${digestDuplicateContent(chatId)}:*`);
    await redis.deleteKeysByPattern(`dup:window:v1:${digestDuplicateContent(`${chatId}-other`)}:*`);
    if (keys.size) await inspector.del(...keys);
    await inspector.quit();
    await redis.onModuleDestroy();
  });
  const observe = (messageId: string, time: number, text = 'a', override = {}) =>
    history.observe({
      chatId,
      userId: '123',
      messageId,
      eventTimestampMs: start + time,
      controlRevision: 1,
      settings,
      content: extractDuplicateMessageContent({ message: { body: { text } } }),
      ...override,
    });

  const windowPrefix = () =>
    `dup:window:v1:${digestDuplicateContent(chatId)}:${MESSAGE_DUPLICATE_HISTORY_STORAGE_VERSION}:`;
  const fencePrefix = () =>
    `dup:window:v1:${digestDuplicateContent(chatId)}:${MESSAGE_DUPLICATE_HISTORY_FENCE_STORAGE_VERSION}:`;
  const recordExpiry = async (key: string) => Number(await inspector.call('PEXPIRETIME', key));

  it('rejects an expired Redis admission before mutation despite the longer reply wait', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValueOnce(now - 1_000);
    try {
      await expect(redis.duplicateWindow(chatId, { op: 'reset', author: 'user' })).rejects.toThrow(
        'Message duplicate window deadline exceeded',
      );
    } finally {
      clock.mockRestore();
    }
    expect(await inspector.keys(`${windowPrefix()}*`)).toEqual([]);
    expect(await observe('fresh', 0, 'Fresh original')).toBeNull();
    expect(await inspector.keys(`${windowPrefix()}*`)).not.toHaveLength(0);
  });

  describe.each(['STANDARD', 'STRICT', 'CUSTOM_NEAR', 'CUSTOM_PHONE'] as const)(
    '%s case-sensitive numeric quantities',
    (preset) => {
      it.each(
        (['MESSAGE', 'TEXT'] as const).flatMap((mode) =>
          [
            ['100 MB/s', '100 Mb/s'],
            ['10 MΩ', '10 mΩ'],
            ['10 MWh', '10 mWh'],
            ['MAh: 10', 'mAh: 10'],
            ['MVA²: 10', 'mVA²: 10'],
            ['10 Mvar/V', '10 mvar/V'],
            ['10 МВтч', '10 мВтч'],
            ['МАч: 10', 'мАч: 10'],
            ['+79991234567 MWh', '+79991234567 mWh'],
            ['MAh = +79991234567', 'mAh = +79991234567'],
            ['5 MW', '5 mW'],
            ['100 MBps', '100 Mbps'],
            ['10 V/(MΩ)', '10 V/(mΩ)'],
            ['+79991234567 MΩ', '+79991234567 mΩ'],
            ['MΩ: 10', 'mΩ: 10'],
            ['MΩ²: 10', 'mΩ²: 10'],
            ['MΩ⁺²: 10', 'mΩ⁺²: 10'],
            ['V/MΩ⁺²: 10', 'V/mΩ⁺²: 10'],
            ['MW²: 10', 'mW²: 10'],
            ['MΩ³/V: 10', 'mΩ³/V: 10'],
            ['(MB): 100', '(Mb): 100'],
            ['MB/s — 100', 'Mb/s — 100'],
            ['MB = +79991234567', 'Mb = +79991234567'],
            ['MB/s — +79991234567', 'Mb/s — +79991234567'],
          ].map(([first, second]) => ({ mode, first, second })),
        ),
      )(
        'never authorizes $mode $first as $second, but allows the true repeat',
        async ({ mode, first, second }) => {
          const override = {
            settings: duplicateSettings({
              duplicateCompareMode: mode,
              duplicateDetectionPreset:
                preset === 'CUSTOM_NEAR' || preset === 'CUSTOM_PHONE' ? 'CUSTOM' : preset,
              duplicateNearMatchEnabled: preset === 'CUSTOM_NEAR',
              duplicateIgnorePhonesEnabled: preset === 'CUSTOM_PHONE',
            }),
          };
          const text = (unit: string) =>
            `Промышленное оборудование доступно со склада с доставкой в регионы. Параметр устройства ${unit} по техническому паспорту производителя.`;
          await observe('first', 0, text(first!), override);
          expect(await observe('different', 100, text(second!), override)).toBeNull();
          const repeat = await observe('repeat', 200, text(second!), override);
          expect(repeat?.binding.original?.messageId).toBe('different');
          expect(await history.stillMatches(chatId, repeat!.binding)).toBe(true);
          expect(await history.qualify(chatId, repeat!.binding)).toBe(1);
          const changed = extractDuplicateMessageContent({
            message: { body: { text: text(first!) } },
          });
          await history.observeLifecycle({
            chatId,
            messageId: 'different',
            eventTimestampMs: start + 300,
            content: changed,
          });
          expect(await history.stillMatches(chatId, repeat!.binding)).toBe(false);
        },
      );
    },
  );

  describe.each(['STRICT', 'CUSTOM_PHONE'] as const)(
    '%s unlabelled signed numeric values',
    (preset) => {
      it.each(['TEXT', 'MESSAGE'] as const)(
        'never authorizes different %s numeric values, but retains exact repeats',
        async (mode) => {
          const override = {
            settings: duplicateSettings({
              duplicateCompareMode: mode,
              duplicateDetectionPreset: preset === 'STRICT' ? 'STRICT' : 'CUSTOM',
              duplicateIgnorePhonesEnabled: preset === 'CUSTOM_PHONE',
              duplicateNearMatchEnabled: true,
            }),
          };
          const text = (value: string) =>
            `Изменение показателя предприятия ${value} по итогам полного аудита за этот месяц`;
          await observe('numeric-original', 0, text('+79991234567'), override);
          expect(
            await observe('numeric-different', 100, text('+79991234568'), override),
          ).toBeNull();
          const repeat = await observe('numeric-repeat', 200, text('+79991234568'), override);
          expect(repeat?.binding.original?.messageId).toBe('numeric-different');
          expect(await history.stillMatches(chatId, repeat!.binding)).toBe(true);
          expect(await history.qualify(chatId, repeat!.binding)).toBe(1);
        },
      );
    },
  );

  it.each([false, true])(
    'does not join unrelated numeric statements via CUSTOM phone evidence with near %s',
    async (near) => {
      const override = {
        settings: duplicateSettings({
          duplicateDetectionPreset: 'CUSTOM',
          duplicateIgnorePhonesEnabled: true,
          duplicateNearMatchEnabled: near,
        }),
      };
      await observe(
        'signed-original',
        0,
        'Прирост прибыли предприятия +79991234567 по итогам полного финансового аудита за этот месяц',
        override,
      );
      const unrelated =
        'Изменение показателя компании +79991234567 подтверждено независимой комиссией после годового отчёта';
      expect(await observe('signed-unrelated', 100, unrelated, override)).toBeNull();
      const repeat = await observe('signed-repeat', 200, unrelated, override);
      expect(repeat?.binding.original?.messageId).toBe('signed-unrelated');
      expect(await history.qualify(chatId, repeat!.binding)).toBe(1);
    },
  );

  describe.each(['STRICT', 'CUSTOM_PHONE'] as const)(
    '%s protected padded numeric context',
    (preset) => {
      it.each([
        ['$value' + ' '.repeat(65) + 'рублей'],
        ['$' + '('.repeat(129) + '$value' + ')'],
        ['$value' + '\u200b'.repeat(65) + '@example.test'],
        ['$value: 1000'],
      ])(
        'never authorizes different values in %s, but detects an exact repeat',
        async (expression) => {
          const override = {
            settings: duplicateSettings({
              duplicateDetectionPreset: preset === 'STRICT' ? 'STRICT' : 'CUSTOM',
              duplicateIgnorePhonesEnabled: preset === 'CUSTOM_PHONE',
            }),
          };
          const text = (value: string) =>
            `Промышленное оборудование доступно со склада доставка в регионы. ${expression.replace('$value', value)}`;
          await observe('first', 0, text('+79991234567'), override);
          expect(await observe('different', 100, text('+79991234568'), override)).toBeNull();
          const repeat = await observe('repeat', 200, text('+79991234568'), override);
          expect(repeat?.binding.original?.messageId).toBe('different');
          expect(await history.stillMatches(chatId, repeat!.binding)).toBe(true);
          expect(await history.qualify(chatId, repeat!.binding)).toBe(1);
        },
      );
    },
  );

  it.each([3600, 43_200])(
    'retains message/qualification proof for its own %is window without extending ordinary history',
    async (windowSeconds) => {
      const eventAt = Date.now() - 20_000;
      const ownRetention = windowSeconds * 1000 + MESSAGE_DUPLICATE_HISTORY_GRACE_MS;
      const override = { settings: duplicateSettings({ duplicateWarnWindowSec: windowSeconds }) };
      await observe('short-original', eventAt - start, 'a', override);
      const repeated = await observe('short-target', eventAt + 100 - start, 'a', override);
      expect(repeated?.binding.original?.messageId).toBe('short-original');
      const prefix = windowPrefix();
      const stateKey = `${prefix}message:${digestDuplicateContent('short-target')}:MESSAGE`;
      const qualificationKey = `${prefix}qualification:${digestDuplicateContent('short-target')}`;
      const expectedExpiry = eventAt + 100 + ownRetention;
      expect(await recordExpiry(stateKey)).toBe(expectedExpiry);
      expect(await inspector.pttl(stateKey)).toBeLessThan(windowSeconds * 2000 + 61_000);
      expect(await history.qualify(chatId, repeated!.binding)).toBe(1);
      expect(await recordExpiry(qualificationKey)).toBe(expectedExpiry);
      expect(await recordExpiry(stateKey)).toBe(expectedExpiry);
      const replay = await observe('short-target', eventAt + 100 - start, 'a', override);
      expect(await history.qualify(chatId, replay!.binding)).toBe(1);
      expect(await recordExpiry(qualificationKey)).toBe(expectedExpiry);
      expect(await recordExpiry(stateKey)).toBe(expectedExpiry);
      expect(await history.stillMatches(chatId, repeated!.binding)).toBe(true);
      const originalState = `${prefix}message:${digestDuplicateContent('short-original')}:MESSAGE`;
      expect(await recordExpiry(originalState)).toBe(eventAt + ownRetention);
      const lifeKey = `${prefix}life:${digestDuplicateContent('short-original')}:MESSAGE`;
      expect(await recordExpiry(lifeKey)).toBe(eventAt + MESSAGE_DUPLICATE_HISTORY_RETENTION_MS);
    },
  );

  it('keeps late-delivered proof expiry anchored through replay and qualification', async () => {
    const eventAt = Date.now() - 12 * 3600_000;
    const override = { settings: duplicateSettings({ duplicateWarnWindowSec: 172_800 }) };
    await observe('retained-original', eventAt - start, 'a', override);
    const repeated = await observe('retained-target', eventAt + 100 - start, 'a', override);
    expect(repeated).not.toBeNull();
    const prefix = windowPrefix();
    const stateKey = `${prefix}message:${digestDuplicateContent('retained-target')}:MESSAGE`;
    const lifeKey = `${prefix}life:${digestDuplicateContent('retained-original')}:MESSAGE`;
    const groupKey = `${prefix}group:${digestDuplicateContent('123')}:${repeated!.binding.fingerprint}`;
    const counterKey = `${prefix}count:${digestDuplicateContent('123')}:${repeated!.binding.fingerprint}:${repeated!.binding.original!.originalId}:0:0`;
    const stateExpiry = eventAt + 100 + MESSAGE_DUPLICATE_HISTORY_RETENTION_MS;
    const originalExpiry = eventAt + MESSAGE_DUPLICATE_HISTORY_RETENTION_MS;
    expect(await recordExpiry(stateKey)).toBe(stateExpiry);
    expect(await recordExpiry(lifeKey)).toBe(originalExpiry);
    expect(await recordExpiry(groupKey)).toBe(
      repeated!.binding.original!.expiresAtMs + MESSAGE_DUPLICATE_HISTORY_GRACE_MS,
    );
    expect(
      (await observe('retained-target', eventAt + 100 - start, 'a', override))?.binding,
    ).toEqual(repeated!.binding);
    expect(await history.qualify(chatId, repeated!.binding)).toBe(1);
    const countExpiry = await recordExpiry(counterKey);
    expect(countExpiry).toBe(originalExpiry);
    expect(await history.qualify(chatId, repeated!.binding)).toBe(1);
    expect(await history.stillMatches(chatId, repeated!.binding)).toBe(true);
    expect(await recordExpiry(counterKey)).toBe(countExpiry);
    expect(await recordExpiry(stateKey)).toBe(stateExpiry);
    expect(await recordExpiry(lifeKey)).toBe(originalExpiry);
    expect(
      await recordExpiry(`${prefix}qualification:${digestDuplicateContent('retained-target')}`),
    ).toBe(stateExpiry);
    for (const key of await inspector.keys(`${prefix}*`)) {
      expect(await inspector.pttl(key)).toBeLessThanOrEqual(MESSAGE_DUPLICATE_HISTORY_RETENTION_MS);
    }
  });

  it.each([false, true])(
    'revokes reset-only future replay with missing message state %s while admitting a fresh post',
    async (loseState) => {
      const futureAt = Date.now() + 59_000;
      await observe('future-original', futureAt - start);
      const old = await observe('future-target', futureAt + 1 - start);
      expect(await history.qualify(chatId, old!.binding)).toBe(1);
      await redis.resetDuplicateWindow(chatId, '123');
      const resetAt = Number(
        await inspector.get(`${fencePrefix()}reset:${digestDuplicateContent('123')}`),
      );
      const stateKey = `${windowPrefix()}message:${digestDuplicateContent('future-original')}:MESSAGE`;
      if (loseState) await inspector.del(stateKey);
      expect(await observe('future-original', futureAt - start)).toBeNull();
      expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
      expect(await history.qualify(chatId, old!.binding)).toBeNull();
      expect(await observe('fresh-original', resetAt + 1 - start)).toBeNull();
      const fresh = await observe('fresh-target', futureAt + 100 - start);
      expect(fresh?.binding.original?.messageId).toBe('fresh-original');
      expect(await history.qualify(chatId, fresh!.binding)).toBe(1);
    },
  );

  it.each(['retained', 'lost', 'lifecycle', 'invalidate'] as const)(
    'never freshens equal content after reset through %s lifecycle state',
    async (state) => {
      const futureAt = Date.now() + 59_000;
      await observe('future-original', futureAt - start);
      await redis.resetDuplicateWindow(chatId, '123');
      if (state !== 'retained') {
        await inspector.del(
          `${windowPrefix()}message:${digestDuplicateContent('future-original')}:MESSAGE`,
        );
      }
      const changed = extractDuplicateMessageContent({
        message: { body: { text: 'unverified replacement' } },
      });
      if (state === 'lifecycle') {
        await history.observeLifecycle({
          chatId,
          messageId: 'future-original',
          eventTimestampMs: futureAt + 50,
          content: changed,
        });
      } else if (state === 'invalidate') {
        await history.invalidateLifecycle({
          chatId,
          messageId: 'future-original',
          content: changed,
        });
      }
      expect(await observe('future-original', futureAt + 100 - start)).toBeNull();
      expect(await observe('fresh-original', futureAt + 200 - start)).toBeNull();
      const fresh = await observe('fresh-target', futureAt + 300 - start);
      expect(fresh?.binding.original?.messageId).toBe('fresh-original');
      expect(await history.qualify(chatId, fresh!.binding)).toBe(1);
    },
  );

  it.each([false, true])(
    'admits a proved text edit after reset with missing message state %s and revokes it on another reset',
    async (loseState) => {
      const futureAt = Date.now() + 59_000;
      await observe('future-original', futureAt - start);
      const old = await observe('future-target', futureAt + 1 - start);
      await redis.resetDuplicateWindow(chatId, '123');
      if (loseState) {
        await inspector.del(
          `${windowPrefix()}message:${digestDuplicateContent('future-original')}:MESSAGE`,
        );
      }
      await observe('future-original', futureAt + 100 - start, 'proved replacement');
      const edited = await observe('edited-target', futureAt + 200 - start, 'proved replacement');
      expect(edited?.binding.original?.messageId).toBe('future-original');
      expect(edited?.binding.original?.publishedAtMs).toBe(futureAt + 100);
      expect(edited?.binding.original?.revision).not.toBe(old!.binding.original!.revision);
      expect(edited?.binding.original?.originalId).not.toBe(old!.binding.original!.originalId);
      expect(await history.qualify(chatId, edited!.binding)).toBe(1);
      expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
      await redis.resetDuplicateWindow(chatId, '123');
      await observe('future-original', futureAt + 300 - start, 'proved replacement');
      expect(
        await observe('fresh-original', futureAt + 400 - start, 'proved replacement'),
      ).toBeNull();
      const fresh = await observe('fresh-target', futureAt + 500 - start, 'proved replacement');
      expect(fresh?.binding.original?.messageId).toBe('fresh-original');
      expect(await history.stillMatches(chatId, edited!.binding)).toBe(false);
    },
  );

  it('keeps an unknown-time replacement out of the new epoch after reset and state loss', async () => {
    const futureAt = Date.now() + 59_000;
    await observe('future-original', futureAt - start);
    await redis.resetDuplicateWindow(chatId, '123');
    await inspector.del(
      `${windowPrefix()}message:${digestDuplicateContent('future-original')}:MESSAGE`,
    );
    const changed = extractDuplicateMessageContent({
      message: { body: { text: 'unknown-time replacement' } },
    });
    await history.invalidateLifecycle({ chatId, messageId: 'future-original', content: changed });
    await observe('future-original', futureAt + 100 - start, 'unknown-time replacement');
    expect(
      await observe('fresh-original', futureAt + 200 - start, 'unknown-time replacement'),
    ).toBeNull();
    const fresh = await observe('fresh-target', futureAt + 300 - start, 'unknown-time replacement');
    expect(fresh?.binding.original?.messageId).toBe('fresh-original');
  });

  it('makes reset/removal fences outlive pre-fence proof including accepted future timestamps', async () => {
    const admittedBefore = Date.now();
    const futureAt = admittedBefore + 59_000;
    const override = { settings: duplicateSettings({ duplicateWarnWindowSec: 172_800 }) };
    await observe('future-original', futureAt - start, 'a', override);
    const proofKeys = await inspector.keys(`${windowPrefix()}*`);
    const proofExpiries = await Promise.all(proofKeys.map((key) => recordExpiry(key)));
    expect(Math.max(...proofExpiries)).toBeLessThanOrEqual(
      Date.now() + MESSAGE_DUPLICATE_HISTORY_RETENTION_MS,
    );
    await redis.resetDuplicateWindow(chatId, '123');
    const resetExpiry = await recordExpiry(
      `${fencePrefix()}reset:${digestDuplicateContent('123')}`,
    );
    expect(resetExpiry).toBeGreaterThanOrEqual(Math.max(...proofExpiries));
    await history.remove(chatId, 'future-original');
    const removalKey = `${fencePrefix()}removed:${digestDuplicateContent('future-original')}`;
    const removalExpiry = await recordExpiry(removalKey);
    expect(removalExpiry).toBeGreaterThanOrEqual(Math.max(...proofExpiries));
    await history.remove(chatId, 'future-original');
    expect(await recordExpiry(removalKey)).toBe(removalExpiry);
    expect(await observe('future-original', futureAt + 100 - start, 'a', override)).toBeNull();
  });

  it('keeps absolute proof expiry fixed while accepted event timestamps are still ahead of Redis TIME', async () => {
    const futureAt = Date.now() + 59_000;
    const override = { settings: duplicateSettings({ duplicateWarnWindowSec: 172_800 }) };
    await observe('future-original', futureAt - start, 'a', override);
    const first = await observe('future-first', futureAt + 1 - start, 'a', override);
    const prefix = windowPrefix();
    const stateKey = `${prefix}message:${digestDuplicateContent('future-first')}:MESSAGE`;
    const lifeKey = `${prefix}life:${digestDuplicateContent('future-original')}:MESSAGE`;
    const stateExpiry = await recordExpiry(stateKey);
    const lifeExpiry = await recordExpiry(lifeKey);
    expect(await history.qualify(chatId, first!.binding)).toBe(1);
    const countKey = `${prefix}count:${digestDuplicateContent('123')}:${first!.binding.fingerprint}:${first!.binding.original!.originalId}:0:0`;
    const countExpiry = await recordExpiry(countKey);
    await observe('future-original', futureAt - start, 'a', override);
    await observe('future-first', futureAt + 1 - start, 'a', override);
    const next = await observe('future-next', futureAt + 2 - start, 'a', override);
    expect(await history.qualify(chatId, next!.binding)).toBe(2);
    expect(await recordExpiry(countKey)).toBe(countExpiry);
    expect(await recordExpiry(stateKey)).toBe(stateExpiry);
    expect(await recordExpiry(lifeKey)).toBe(lifeExpiry);
  });

  it('isolates current history and reset/removal fences from retired v2 storage', async () => {
    const oldPrefix = `dup:window:v1:${digestDuplicateContent(chatId)}:`;
    const oldReset = `${oldPrefix}reset:${digestDuplicateContent('123')}`;
    const oldRemoved = `${oldPrefix}v2:removed:${digestDuplicateContent('original')}`;
    const oldState = `${oldPrefix}v2:message:${digestDuplicateContent('original')}:MESSAGE`;
    const oldResetValue = String(Date.now() + 60_000);
    await inspector.set(oldReset, oldResetValue, 'EX', 1_209_661);
    await inspector.set(oldRemoved, 'true', 'EX', 1_209_661);
    await inspector.set(oldState, '{"legacy":true}', 'EX', 1_209_661);
    await observe('original', 0);
    const match = await observe('target', 100);
    expect(match?.binding.original?.messageId).toBe('original');
    expect(await history.qualify(chatId, match!.binding)).toBe(1);
    await redis.resetDuplicateWindow(chatId, '123');
    expect(await history.stillMatches(chatId, match!.binding)).toBe(false);
    expect(await inspector.get(oldReset)).toBe(oldResetValue);
    expect(await inspector.get(oldRemoved)).toBe('true');
    expect(await inspector.get(oldState)).toBe('{"legacy":true}');
  });

  it('retains v3 removal and reset fences without importing its incorrect positive clock', async () => {
    const oldAt = start - 1800_000;
    const oldLifeKey = `${fencePrefix()}life:${digestDuplicateContent('original')}:MESSAGE`;
    const oldLife = JSON.stringify({
      at: start,
      introducedAt: start,
      introducedKnown: true,
      source: extractDuplicateMessageContent({ message: { body: { text: 'offer' } } }).sourceDigest,
      revision: 'old',
    });
    await inspector.set(oldLifeKey, oldLife, 'EX', 172800);
    await observe('original', 0, 'offer', { publishedAtMs: oldAt });
    const match = await observe('target', 100, 'offer');
    expect(match?.binding.original?.publishedAtMs).toBe(oldAt);
    expect(match?.binding.original?.expiresAtMs).toBe(oldAt + match!.binding.windowSeconds * 1000);
    expect(await inspector.get(oldLifeKey)).toBe(oldLife);
    const removedKey = `${fencePrefix()}removed:${digestDuplicateContent('original')}`;
    await inspector.set(removedKey, 'true', 'EX', 172800);
    const removedExpiry = await recordExpiry(removedKey);
    expect(await history.stillMatches(chatId, match!.binding)).toBe(false);
    await history.remove(chatId, 'original');
    expect(await recordExpiry(removedKey)).toBe(removedExpiry);
    const resetKey = `${fencePrefix()}reset:${digestDuplicateContent('123')}`;
    await inspector.set(resetKey, JSON.stringify(Date.now()), 'EX', 172800);
    expect(await observe('older-copy', 200, 'offer')).toBeNull();
    expect(
      await inspector.get(
        `${windowPrefix()}message:${digestDuplicateContent('older-copy')}:MESSAGE`,
      ),
    ).toBeNull();
  });

  it('keeps a reset future-dated v3 incarnation revoked after positive history advances', async () => {
    const at = Date.now() + 30_000;
    await observe('old-future', at - start, 'offer');
    const lifeKey = `life:${digestDuplicateContent('old-future')}:MESSAGE`;
    const life = await inspector.get(`${windowPrefix()}${lifeKey}`);
    expect(life).not.toBeNull();
    await inspector.set(`${fencePrefix()}${lifeKey}`, life!, 'EX', 172800);
    await redis.deleteKeysByPattern(`${windowPrefix()}*`);
    await redis.resetDuplicateWindow(chatId, '123');
    await history.observeLifecycle({
      chatId,
      messageId: 'old-future',
      eventTimestampMs: at + 1,
      publishedAtMs: at,
      content: extractDuplicateMessageContent({ message: { body: { text: 'offer' } } }),
    });
    expect(await observe('old-future', at + 1 - start, 'offer')).toBeNull();
    expect(
      await inspector.get(
        `${windowPrefix()}message:${digestDuplicateContent('old-future')}:MESSAGE`,
      ),
    ).toBeNull();
    await observe('old-future', at + 2 - start, 'new offer', { publishedAtMs: at });
    const match = await observe('new-repeat', at + 3 - start, 'new offer');
    expect(match?.binding.original?.messageId).toBe('old-future');
    expect(match?.binding.original?.publishedAtMs).toBe(at + 2);
  });

  it.each(['none', 'lifecycle', 'invalidate'])(
    'preserves old stale/conflicting lifecycle refusal with preliminary observation=%s',
    async (preliminary) => {
      for (const scenario of ['older', 'conflict', 'equal-change', 'unknown-time']) {
        const messageId = `transition-${scenario}`;
        await observe(messageId, 0, 'offer');
        const content = (text: string) =>
          extractDuplicateMessageContent({ message: { body: { text } } });
        if (scenario === 'conflict') {
          await history.observeLifecycle({
            chatId,
            messageId,
            eventTimestampMs: start,
            content: content('conflict'),
          });
        } else if (scenario === 'unknown-time') {
          await history.invalidateLifecycle({ chatId, messageId, content: content('unknown') });
        }
        const lifeKey = `life:${digestDuplicateContent(messageId)}:MESSAGE`;
        const oldLife = await inspector.get(`${windowPrefix()}${lifeKey}`);
        expect(oldLife).not.toBeNull();
        await inspector.set(`${fencePrefix()}${lifeKey}`, oldLife!, 'EX', 172800);
        await redis.deleteKeysByPattern(`${windowPrefix()}*`);
        const time = scenario === 'older' ? -1 : scenario === 'unknown-time' ? 100 : 0;
        const text =
          scenario === 'equal-change'
            ? 'changed'
            : scenario === 'unknown-time'
              ? 'unknown'
              : 'offer';
        if (preliminary === 'lifecycle') {
          await history.observeLifecycle({
            chatId,
            messageId,
            eventTimestampMs: start + time,
            publishedAtMs: start - 1000,
            content: content(text),
          });
        } else if (preliminary === 'invalidate') {
          await history.invalidateLifecycle({ chatId, messageId, content: content(text) });
        }
        await observe(messageId, time, text, { publishedAtMs: start - 1000 });
        expect(await observe(`fresh-${scenario}`, 200, text)).toBeNull();
        expect((await observe(`repeat-${scenario}`, 300, text))?.binding.original?.messageId).toBe(
          `fresh-${scenario}`,
        );
        await observe(messageId, 400, 'proven later edit', { publishedAtMs: start - 1000 });
        const later = await observe(`later-${scenario}`, 500, 'proven later edit');
        expect(later?.binding.original?.messageId).toBe(messageId);
        expect(later?.binding.original?.publishedAtMs).toBe(start + 400);
        expect(await inspector.get(`${fencePrefix()}${lifeKey}`)).toBe(oldLife);
        await redis.deleteKeysByPattern(`${windowPrefix()}*`);
      }
    },
  );

  it('replays current absolute expiry and equal-timestamp qualification against its private virtual clock', async () => {
    const offline = new OfflineDuplicateWindow(inspector);
    const replayHistory = new MessageDuplicateHistoryService(
      offline as unknown as RedisCounterService,
    );
    const eventAt = Date.parse('2025-01-01T12:00:00Z');
    const input = {
      chatId,
      userId: '123',
      eventTimestampMs: eventAt,
      controlRevision: 1,
      settings: duplicateSettings({ duplicateWarnWindowSec: 172_800 }),
      content: extractDuplicateMessageContent({ message: { body: { text: 'a' } } }),
    };
    try {
      offline.now = eventAt;
      expect(await replayHistory.observe({ ...input, messageId: 'offline-original' })).toBeNull();
      const match = await replayHistory.observe({ ...input, messageId: 'offline-target' });
      expect(match?.binding.original?.messageId).toBe('offline-original');
      expect(await replayHistory.qualify(chatId, match!.binding)).toBe(1);
      expect(await replayHistory.qualify(chatId, match!.binding)).toBe(1);
      offline.now = eventAt + MESSAGE_DUPLICATE_HISTORY_RETENTION_MS;
      expect(await replayHistory.stillMatches(chatId, match!.binding)).toBe(false);
      expect(await replayHistory.observe({ ...input, messageId: 'offline-original' })).toBeNull();
      expect(await replayHistory.stillMatches(chatId, match!.binding)).toBe(false);
      expect(
        await replayHistory.observe({
          ...input,
          eventTimestampMs: offline.now,
          messageId: 'offline-new-original',
        }),
      ).toBeNull();
    } finally {
      await offline.close();
    }
  });

  it('merges concurrent diagnostic attempts atomically with TTL and isolates chats', async () => {
    const bucket = Math.floor(Date.now() / DUPLICATE_TELEMETRY_BUCKET_MS);
    const key = duplicateTelemetryKey(chatId, bucket);
    keys.add(key);
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        redis.mergeDuplicateTelemetry(
          key,
          index % 2
            ? { supported: 1, verified: 1, COMPARED_NO_MATCH: 1 }
            : { supported: 1, DEFERRED: 1 },
        ),
      ),
    );
    const metrics = new MessageDuplicateMetricsService(redis);
    try {
      expect(await metrics.readObservations(chatId)).toMatchObject({
        state: 'AVAILABLE',
        supportedAttempts: 24,
        verifiedAttempts: 12,
        coverage: 0.5,
        completeness: 'BEST_EFFORT',
        basis: 'ATTEMPTS',
      });
      expect(await metrics.readObservations(`${chatId}-other`)).toMatchObject({
        state: 'NO_DATA',
        coverage: null,
      });
      expect(await inspector.ttl(key)).toBeGreaterThan(7100);
      await inspector.set(key, JSON.stringify({ unexpected: 'private-data' }));
      expect(await metrics.readObservations(chatId)).toMatchObject({
        state: 'UNAVAILABLE',
        coverage: null,
        outcomes: [],
      });
    } finally {
      metrics.onModuleDestroy();
    }
  });

  it('returns a typed non-match separately from unverifiable history and stale revisions', async () => {
    const input = {
      chatId,
      userId: '123',
      messageId: 'typed',
      eventTimestampMs: start,
      controlRevision: 1,
      settings,
      content: extractDuplicateMessageContent({ message: { body: { text: 'hello' } } }),
    };
    expect(await history.observeWithOutcome(input)).toEqual({
      outcome: 'COMPARED_NO_MATCH',
      match: null,
    });
    expect(await history.observeWithOutcome({ ...input, eventTimestampMs: start - 100 })).toEqual({
      outcome: 'STALE',
      match: null,
    });
    expect(
      await history.observeWithOutcome({
        ...input,
        messageId: 'unverified',
        content: { ...input.content, complete: false, reason: 'invalid_content' },
      }),
    ).toEqual({ outcome: 'CONTENT_UNVERIFIED', match: null });
  });

  it('counts exact short repeats, not retries, and invalidates edits without retroactive hits', async () => {
    expect(await observe('a', 0)).toBeNull();
    expect(await observe('a', 0)).toBeNull();
    const hit = await observe('b', 100);
    expect(hit?.hit.count).toBe(1);
    expect(await history.stillMatches(chatId, hit!.binding)).toBe(true);
    expect((await observe('b', 100))?.hit.count).toBe(1);
    expect(await observe('a', 200, 'different')).toBeNull();
    expect(await history.stillMatches(chatId, hit!.binding)).toBe(false);
    expect(await observe('a', 0)).toBeNull();
    expect(await observe('c', 50)).toBeNull();
  });

  it('counts distinct concurrent messages with the same timestamp without counting their replays', async () => {
    const override = { settings: duplicateSettings({ duplicateWarnWindowSec: 3600 }) };
    const observations = await Promise.all(
      ['same-first', 'same-second', 'same-third'].map((id) => observe(id, 0, 'a', override)),
    );
    expect(observations.filter((match) => match === null)).toHaveLength(1);
    const matches = observations.filter((match) => match !== null);
    const originalId = matches[0]!.binding.original!.messageId;
    expect(matches.every((match) => match.binding.original!.messageId === originalId)).toBe(true);
    expect(matches.every((match) => match.binding.messageId !== originalId)).toBe(true);
    const qualifications = await Promise.all(
      matches.map((match) => history.qualify(chatId, match.binding)),
    );
    expect([...qualifications].sort()).toEqual([1, 2]);
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index]!;
      expect(await history.stillMatches(chatId, match.binding)).toBe(true);
      const replay = await observe(match.binding.messageId, 0, 'a', override);
      expect(replay?.binding.lifecycleRevision).toBe(match.binding.lifecycleRevision);
      expect(await history.qualify(chatId, replay!.binding)).toBe(qualifications[index]);
    }
    expect(await observe(originalId, 0, 'a', override)).toBeNull();
    expect(await observe('earlier', -1, 'a', override)).toBeNull();
    expect((await observe('later', 100, 'a', override))?.hit.count).toBe(3);
    expect(await observe('after-window', 3600_000, 'a', override)).toBeNull();
  });

  it.each([0x12345678, 0xdeadbeef, 0x5eedc0de])(
    'keeps invalidated proof revoked through seeded history transitions (seed %i)',
    async (seed) => {
      type Message = {
        id: string;
        text: string;
        at: number;
        version: number;
        generation: number;
        removed: boolean;
      };
      type Evidence = {
        binding: MessageDuplicateBinding;
        generation: number;
        targetVersion: number;
        originalVersion: number;
        invalidWhenCaptured: boolean;
      };
      const messages = new Map<string, Message>();
      const evidence = new Map<string, Evidence>();
      const exercised = new Set<string>();
      let generation = 0;
      let sequence = 0;
      let eventTime = Date.now();
      let randomState = seed;
      const pick = <T>(values: T[]): T => {
        randomState ^= randomState << 13;
        randomState ^= randomState >>> 17;
        randomState ^= randomState << 5;
        return values[(randomState >>> 0) % values.length]!;
      };
      const nextTime = () => (eventTime = Math.max(Date.now(), eventTime + 1));
      const current = () =>
        [...messages.values()].filter(
          (message) => message.generation === generation && !message.removed,
        );
      const content = (text: string) =>
        extractDuplicateMessageContent({ message: { body: { text } } });
      const runObservation = async (message: Message) => {
        const input = {
          chatId,
          userId: '123',
          messageId: message.id,
          eventTimestampMs: message.at,
          controlRevision: 1,
          settings,
          content: content(message.text),
        };
        const result = await history.observe(input);
        // Exact transport replay neither creates another occurrence nor changes its proof.
        expect(await history.observe(input)).toEqual(result);
        if (result) {
          const original = messages.get(result.binding.original!.messageId)!;
          const key = `${message.id}:${result.binding.lifecycleRevision}:${result.binding.original!.revision}`;
          if (!evidence.has(key)) {
            // Replay may return an old comparison snapshot. Only the proof check is authority.
            const live = await history.stillMatches(chatId, result.binding);
            if (live) {
              expect(original).toMatchObject({
                text: message.text,
                generation,
                removed: false,
              });
              expect(original.at).toBeLessThan(message.at);
            }
            evidence.set(key, {
              binding: result.binding,
              generation,
              targetVersion: message.version,
              originalVersion: original.version,
              invalidWhenCaptured: !live,
            });
          }
        }
        return result;
      };
      const append = async (text: string) => {
        const message: Message = {
          id: `model-${sequence++}`,
          text,
          at: nextTime(),
          version: 0,
          generation,
          removed: false,
        };
        messages.set(message.id, message);
        return runObservation(message);
      };
      // The oracle owns only business facts: material versions, deletion and history loss.
      // It deliberately does not reproduce Redis keys, fingerprints or window algorithms.
      const assertProofs = async () => {
        for (const saved of evidence.values()) {
          const target = messages.get(saved.binding.messageId)!;
          const original = messages.get(saved.binding.original!.messageId)!;
          const valid =
            !saved.invalidWhenCaptured &&
            saved.generation === generation &&
            !target.removed &&
            !original.removed &&
            target.version === saved.targetVersion &&
            original.version === saved.originalVersion;
          const matches = await history.stillMatches(chatId, saved.binding);
          if (matches) expect(valid).toBe(true);
          if (!valid) {
            expect(matches).toBe(false);
            expect(await history.qualify(chatId, saved.binding)).toBeNull();
          }
        }
      };
      const establishLivePair = async () => {
        const text = `live pair ${generation} ${sequence}`;
        expect(await append(text)).toBeNull();
        const repeat = await append(text);
        expect(repeat?.hit.count).toBe(1);
        expect(await history.stillMatches(chatId, repeat!.binding)).toBe(true);
        expect(await history.qualify(chatId, repeat!.binding)).toBe(1);
        expect(await history.qualify(chatId, repeat!.binding)).toBe(1);
      };
      await establishLivePair();
      const operations = ['observe', 'edit', 'remove', 'reset', 'qualify', 'retry', 'loss'];
      const prefix = ['retry', 'edit', 'remove', 'reset', 'loss', 'qualify', 'observe'];
      for (let step = 0; step < 90; step += 1) {
        const operation = prefix[step] ?? pick(operations);
        exercised.add(operation);
        if (operation === 'observe') {
          await append(pick(current()).text);
        } else if (operation === 'edit') {
          const message = pick(current());
          message.text = `${message.text} changed ${step}`;
          message.at = nextTime();
          message.version += 1;
          await history.observeLifecycle({
            chatId,
            messageId: message.id,
            eventTimestampMs: message.at,
            content: content(message.text),
          });
        } else if (operation === 'remove') {
          const message = pick(current());
          message.removed = true;
          await history.remove(chatId, message.id);
        } else if (operation === 'retry') {
          await runObservation(pick(current()));
        } else if (operation === 'qualify') {
          const saved = pick([...evidence.values()]);
          const first = await history.qualify(chatId, saved.binding);
          expect(await history.qualify(chatId, saved.binding)).toBe(first);
        } else {
          if (operation === 'reset') {
            await redis.resetDuplicateWindow(chatId, '123');
          } else {
            await redis.deleteKeysByPattern(`dup:window:v1:${digestDuplicateContent(chatId)}:*`);
          }
          generation += 1;
          await assertProofs();
          const [seconds, microseconds] = await inspector.time();
          eventTime = Math.max(
            eventTime,
            Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000),
          );
          // Real Redis TIME owns reset cutoffs. Fresh IDs and later events prove recovery.
          await establishLivePair();
        }
        await assertProofs();
        if (!current().length) await establishLivePair();
      }
      expect([...exercised].sort()).toEqual([...operations].sort());
      expect(evidence.size).toBeGreaterThan(10);
    },
    30_000,
  );

  it('does not let many links starve an enabled phone fingerprint', async () => {
    const override = {
      settings: duplicateSettings({
        duplicateDetectionPreset: 'CUSTOM',
        duplicateIgnoreLinksEnabled: true,
        duplicateIgnorePhonesEnabled: true,
      }),
    };
    const text = (prefix: string) =>
      `${prefix} +7 (999) 123-45-67 ${Array.from({ length: 24 }, (_, index) => `https://${prefix}.example/item-${index}`).join(' ')}`;
    await observe('original', 0, text('first'), override);
    const result = await observe('repeat', 100, text('second'), override);
    expect(result?.hit.fingerprintType).toBe('phone');
    expect(result?.hit.count).toBe(1);
    expect(await history.stillMatches(chatId, result!.binding)).toBe(true);
  });

  it.each(['Path', '?id=Token', '#Section'])(
    'does not merge case-sensitive link destinations (%s) in CUSTOM mode',
    async (suffix) => {
      const override = {
        settings: duplicateSettings({
          duplicateDetectionPreset: 'CUSTOM',
          duplicateIgnoreLinksEnabled: true,
        }),
      };
      await observe('original', 0, `First offer https://example.org/${suffix}`, override);
      expect(
        await observe(
          'different',
          100,
          `Another offer https://example.org/${suffix.toLowerCase()}`,
          override,
        ),
      ).toBeNull();
      expect(
        (await observe('repeat', 200, `Third offer https://example.org/${suffix}`, override))?.hit
          .fingerprintType,
      ).toBe('link');
    },
  );

  it('does not reuse observations from a prior rollout revision for new sanctions', async () => {
    await observe('a', 0);
    expect(await observe('b', 100, 'a', { controlRevision: 2 })).toBeNull();
    expect((await observe('c', 200, 'a', { controlRevision: 2 }))?.hit.count).toBe(1);
  });

  it('preserves a new event date under STRICT while still detecting a real repeat', async () => {
    const override = { settings: duplicateSettings({ duplicateDetectionPreset: 'STRICT' }) };
    const text = (date: string) =>
      `Family swimming registration remains available until ${date} for every participant`;
    await observe('original', 0, text('22.09.2026'), override);
    expect(await observe('new-date', 100, text('23.09.2026'), override)).toBeNull();
    const repeat = await observe('repeat', 200, text('23.09.2026'), override);
    expect(repeat?.hit.count).toBe(1);
    expect(await history.stillMatches(chatId, repeat!.binding)).toBe(true);
  });

  it('preserves plain-text destinations in CUSTOM near matching', async () => {
    const override = {
      settings: duplicateSettings({
        duplicateDetectionPreset: 'CUSTOM',
        duplicateNearMatchEnabled: true,
      }),
    };
    const prefix = 'Comfortable swimming lessons available every weekday for families';
    await observe('original', 0, `${prefix} https://example.org/Offer?id=Token`, override);
    expect(
      await observe('different', 100, `${prefix} https://example.org/offer?id=token`, override),
    ).toBeNull();
  });

  describe.each(['STRICT', 'CUSTOM'] as const)('%s Unicode comparison', (preset) => {
    it.each([
      ['✅', '❌'],
      ['同意', '拒绝'],
      ['условие 5 < 9', 'условие 5 > 9'],
    ])('does not qualify changed protected content (%s / %s)', async (first, second) => {
      const override = {
        settings: duplicateSettings({
          duplicateDetectionPreset: preset,
          duplicateNearMatchEnabled: true,
        }),
      };
      const text = (suffix: string) =>
        `Подробная инструкция для участников встречи доступна после завершения регистрации ${suffix}`;
      expect(await observe('original', 0, text(first), override)).toBeNull();
      expect(await observe('changed', 100, text(second), override)).toBeNull();
      const repeated = await observe('repeat', 200, text(second), override);
      expect(repeated?.hit).toMatchObject({ count: 1, fingerprintType: 'exact' });
      expect(repeated?.binding.original?.messageId).toBe('changed');
      expect(await history.qualify(chatId, repeated!.binding)).toBe(1);
      expect(await history.qualify(chatId, repeated!.binding)).toBe(1);
    });

    it.each([
      ...[
        'Артикул телефона: $value',
        'Код телефона: $value',
        'Модель телефона: $value',
        'Сертификат телефона: $value',
        'Штрихкод телефона: $value',
        'IMEI телефона: $value',
        'Телефон $value + 2',
        'Выражение z · $value',
        'Выражение z ≈ $value',
        'Выражение x\u200e $value',
        'Выражение 2\u200e $value',
        'Итого €\u200b $value',
        'Итого $value \u200e₽',
        'Прирост $value тыс. руб.',
        'Прирост $value GiB',
        'Прирост $value bps',
        'Прирост $value участников',
      ].map((expression) => [
        `source-bound numeric expression ${expression}`,
        `Подробное описание оборудования с гарантией и доставкой по стране: ${expression.replace('$value', '+79991234567')}`,
        `Подробное описание оборудования с гарантией и доставкой по стране: ${expression.replace('$value', '+79991234568')}`,
      ]),
      [
        'unknown grouped international phone and quantity',
        'Подробная инструкция для участников доступна после регистрации телефон: +44 20 7946 0958 100 участников',
        'Подробная инструкция для участников доступна после регистрации телефон: +44 20 7946 0958 200 участников',
      ],
      ...['Телефон', 'Модель телефона', 'Сертификат телефона'].map((label) => [
        `unprefixed EAN cannot inherit ${label} evidence`,
        `Подробное описание оборудования с гарантией и доставкой по стране: ${label}: 4601234567890`,
        `Подробное описание оборудования с гарантией и доставкой по стране: ${label}: 4601234567891`,
      ]),
      [
        'numeric fragments separated by a URL',
        'Подробная инструкция для участников доступна после регистрации данные +7999 https://example.test 1234567 пользователей',
        'Подробная инструкция для участников доступна после регистрации данные +7999 https://example.test 1234568 пользователей',
      ],
      [
        'signed decimal with an unknown dotted group',
        'Подробная инструкция для участников доступна после регистрации погрешность +7999.1234567 согласована',
        'Подробная инструкция для участников доступна после регистрации погрешность +7999.1234568 согласована',
      ],
      ...[
        'ABC$value-Z',
        'ABC-$value',
        '$value-ABC',
        'ABC:$value',
        '$value/ABC',
        '$value.ABC',
        '_$value',
        '$value_',
        'ABC[($value)]',
        '[($value)]Z',
        'x$value',
        '$value*x',
        'x = $value',
        '2 $value',
        'x $value',
        'Номера $value',
        'Коды $value',
        'Идентификаторы $value',
        'Артикулы $value',
      ].map((expression) => [
        `protected expression ${expression}`,
        `Подробное описание оборудования с гарантией и доставкой по стране: ${expression.replace('$value', '+79991234567')}`,
        `Подробное описание оборудования с гарантией и доставкой по стране: ${expression.replace('$value', '+79991234568')}`,
      ]),
      ...[
        '+79991234567',
        '+12025550123',
        '79991234567',
        '19991234567',
        '89991234567',
        '999-123-45-67',
      ].map((phone) => [
        `bare quantity after ${phone}`,
        `Подробная инструкция для участников доступна после регистрации телефон: ${phone} 1000`,
        `Подробная инструкция для участников доступна после регистрации телефон: ${phone} 2000`,
      ]),
      ...['Телевизор', 'Тележка', 'Телескоп', 'Мобильность', 'Звонок', 'Звонки'].map((label) => [
        `product phone-prefix ${label}`,
        `${label} 999-123-45-67 продаётся с подробным описанием гарантии и доставкой по стране`,
        `${label} 999-123-45-68 продаётся с подробным описанием гарантии и доставкой по стране`,
      ]),
      ...['Серия', 'Модель', 'Версия', ''].map((label) => [
        label ? `grouped ${label}` : 'unlabelled grouped number',
        `${label} (999-123-45-67) доступна для заказа в нашем интернет магазине с доставкой по стране`,
        `${label} (999-123-45-68) доступна для заказа в нашем интернет магазине с доставкой по стране`,
      ]),
      [
        'order identifier',
        'Номер заказа 1234567890 для получения оплаченного оборудования отправлен представителю организации',
        'Номер заказа 2234567890 для получения оплаченного оборудования отправлен представителю организации',
      ],
      [
        'wrapped part identifier',
        'Артикул (999-123-45-67) доступен для заказа в нашем интернет магазине с доставкой по стране',
        'Артикул (999-123-45-68) доступен для заказа в нашем интернет магазине с доставкой по стране',
      ],
      [
        'long modified part identifier',
        'Артикул нового оборудования для нашего каталога (999-123-45-67) доступен для заказа с доставкой по стране',
        'Артикул нового оборудования для нашего каталога (999-123-45-68) доступен для заказа с доставкой по стране',
      ],
      [
        'wrapped order identifier',
        'Номер заказа №(123-456-78-90) доступен для получения оплаченного оборудования сегодня',
        'Номер заказа №(123-456-78-91) доступен для получения оплаченного оборудования сегодня',
      ],
      [
        'phone label word suffix',
        'Recall 1234567890 подтвержден для оборудования с доставкой по стране после регистрации',
        'Recall 1234567891 подтвержден для оборудования с доставкой по стране после регистрации',
      ],
      [
        'phone-shaped price',
        'Продается промышленное предприятие стоимостью 9000000000 рублей документы готовы подробности по запросу',
        'Продается промышленное предприятие стоимостью 9100000000 рублей документы готовы подробности по запросу',
      ],
      [
        'phone-shaped measurement',
        'Согласно технической документации масса оборудования составляет 9000000000 кг включая упаковку',
        'Согласно технической документации масса оборудования составляет 9100000000 кг включая упаковку',
      ],
      [
        'comma placement',
        'Казнить, нельзя помиловать виновного сегодня согласно решению комиссии',
        'Казнить нельзя, помиловать виновного сегодня согласно решению комиссии',
      ],
    ])('does not match or qualify changed %s', async (_label, first, second) => {
      const override = {
        settings: duplicateSettings({
          duplicateDetectionPreset: preset,
          duplicateNearMatchEnabled: true,
          duplicateIgnorePhonesEnabled: true,
        }),
      };
      await observe('original', 0, first, override);
      expect(await observe('changed', 100, second, override)).toBeNull();
      const repeated = await observe('repeat', 200, second, override);
      expect(repeated?.hit.fingerprintType).toBe('exact');
      expect(repeated?.binding.original?.messageId).toBe('changed');
      expect(await history.stillMatches(chatId, repeated!.binding)).toBe(true);
      expect(await history.qualify(chatId, repeated!.binding)).toBe(1);
    });
  });

  it('keeps rotated true phones and punctuation spacing comparable under STRICT', async () => {
    const override = { settings: duplicateSettings({ duplicateDetectionPreset: 'STRICT' }) };
    const prefix =
      'Подробная инструкция, для участников встречи доступна после завершения регистрации телефон:';
    await observe('original', 0, `${prefix} +7 (999) 123-45-67`, override);
    const rotated = await observe('rotated', 100, `${prefix} +7 (999) 123-45-68`, override);
    expect(rotated?.hit.fingerprintType).toBe('content');
    expect(await history.qualify(chatId, rotated!.binding)).toBe(1);
    const spaced = await observe(
      'spaced',
      200,
      `${prefix.toUpperCase().replace(',', ' , ')} +7 (999) 123-45-69`,
      override,
    );
    expect(spaced?.hit.fingerprintType).toBe('near');
    expect(await history.stillMatches(chatId, spaced!.binding)).toBe(true);
    expect(await history.qualify(chatId, spaced!.binding)).toBe(1);
  });

  it.each(['. ', '\n'])(
    'keeps the numeric phrase after a true phone in STRICT across %j',
    async (separator) => {
      const override = { settings: duplicateSettings({ duplicateDetectionPreset: 'STRICT' }) };
      const text = (count: number) =>
        `Запись на встречу открыта для всех желающих телефон: +7 (999) 123-45-67${separator}${count} участников`;
      await observe('original', 0, text(100), override);
      expect(await observe('changed', 100, text(200), override)).toBeNull();
      const repeated = await observe('repeat', 200, text(200), override);
      expect(repeated?.hit.fingerprintType).toBe('exact');
      expect(repeated?.binding.original?.messageId).toBe('changed');
      expect(await history.qualify(chatId, repeated!.binding)).toBe(1);
    },
  );

  it('does not treat order IDs as CUSTOM phone values even without near matching', async () => {
    const override = {
      settings: duplicateSettings({
        duplicateDetectionPreset: 'CUSTOM',
        duplicateIgnorePhonesEnabled: true,
      }),
    };
    await observe('order', 0, 'Номер заказа 1234567890 готов', override);
    expect(
      await observe('invoice', 100, 'Документ номер 1234567890 проверен', override),
    ).toBeNull();
    await observe('phone', 200, 'Телефон +7 (999) 123-45-67 для доставки', override);
    const repeated = await observe(
      'same-phone',
      300,
      'Связаться +7 (999) 123-45-67 для консультации',
      override,
    );
    expect(repeated?.hit.fingerprintType).toBe('phone');
    expect(await history.qualify(chatId, repeated!.binding)).toBe(1);
  });

  it.each([
    ...[
      'ABC+79991234567Z',
      'ABC-+79991234567',
      '+79991234567-ABC',
      'ABC:+79991234567',
      '+79991234567/ABC',
      '+79991234567.ABC',
      '_+79991234567',
      '+79991234567_',
      'ABC[(+79991234567)]',
      '[(+79991234567)]Z',
      'x+12345678901',
      '+12345678901*x',
      'x = +79991234567',
      '2 +79991234567',
      'x +79991234567',
      'Номера +79991234567',
      'Коды +79991234567',
      'Идентификаторы +79991234567',
      'Артикулы +79991234567',
      'https://example.test/+79991234567',
      'https://example.test/?phone=+79991234567',
      '+79991234567@example.test',
      'tel:+79991234567',
      'Телефон +79991234567 1000',
      'Телефон +12025550123 1000',
      'Телефон 79991234567 1000',
      'Phone 19991234567 1000',
      'Телефон 89991234567 1000',
      'Телефон 999-123-45-67 1000',
    ].map((expression) => [
      `Продаётся оборудование с гарантией: ${expression}`,
      `Требуется помощь в новом проекте: ${expression}`,
    ]),
    ...['Телевизор', 'Тележка', 'Телескоп', 'Мобильность', 'Звонок', 'Звонки'].map((label) => [
      `${label} 999-123-45-67 продаётся с подробным описанием`,
      `${label} 999-123-45-67 требуется для нового оборудования`,
    ]),
    ...['Серия', 'Модель', 'Версия', ''].map((label) => [
      `${label} (999-123-45-67) доступна для заказа в нашем интернет магазине`,
      `${label} (999-123-45-67) опубликована после завершения регистрации участников`,
    ]),
    ['Артикул (999-123-45-67) доступен', 'Код заказа №(999-123-45-67) подтвержден'],
    [
      'Артикул нового оборудования для нашего каталога [(999-123-45-67)] доступен',
      'Номер заказа нового оборудования для нашего склада №[(999-123-45-67)] подтвержден',
    ],
    ['Recall 1234567890 подтвержден', 'Расширенный recall 1234567890 опубликован'],
  ])('does not join protected values through CUSTOM phone matching: %s', async (first, second) => {
    const override = {
      settings: duplicateSettings({
        duplicateDetectionPreset: 'CUSTOM',
        duplicateIgnorePhonesEnabled: true,
        duplicateNearMatchEnabled: false,
      }),
    };
    await observe('protected-original', 0, first, override);
    expect(await observe('unrelated-protected', 100, second, override)).toBeNull();
  });

  describe.each(['STRICT', 'CUSTOM_PHONE'] as const)('%s bounded phone labels', (mode) => {
    it.each([
      ['Тел+79991234567', 'Тел+79991234568'],
      ['Телефон=+79991234567', 'Телефон=+79991234568'],
      ['Телефон79991234567', 'Телефон79991234568'],
      ['Phone19991234567', 'Phone19991234568'],
      ['Связаться +12025550123', 'Связаться +12025550124'],
      ['Связаться +80011122233', 'Связаться +80011122234'],
      [
        'Телефон:+79991234567 https://example.test/+79991234569',
        'Телефон:+79991234568 https://example.test/+79991234569',
      ],
    ])('qualifies a real phone with safe boundaries in %s', async (first, rotated) => {
      const strict = mode === 'STRICT';
      const override = {
        settings: duplicateSettings({
          duplicateDetectionPreset: strict ? 'STRICT' : 'CUSTOM',
          duplicateIgnorePhonesEnabled: !strict,
          duplicateNearMatchEnabled: false,
        }),
      };
      const description =
        'Подробная инструкция для участников встречи доступна после завершения регистрации';
      await observe('original', 0, `${description} ${first}`, override);
      const repeated = await observe(
        'repeat',
        100,
        strict ? `${description} ${rotated}` : `Новая консультация сегодня ${first}`,
        override,
      );
      expect(repeated?.hit.fingerprintType).toBe(strict ? 'content' : 'phone');
      expect(await history.stillMatches(chatId, repeated!.binding)).toBe(true);
      expect(await history.qualify(chatId, repeated!.binding)).toBe(1);
    });

    it.each([
      'Телефон',
      'Телефоном',
      'Телефоны',
      'Тел.',
      'Позвоните',
      'Звоните',
      'WhatsApp',
      'Ватсап',
      'Viber',
      'Вайбер',
    ])(
      'matches and qualifies explicit %s evidence without an international prefix',
      async (label) => {
        const strict = mode === 'STRICT';
        const override = {
          settings: duplicateSettings({
            duplicateDetectionPreset: strict ? 'STRICT' : 'CUSTOM',
            duplicateIgnorePhonesEnabled: !strict,
            duplicateNearMatchEnabled: false,
          }),
        };
        const description =
          'Подробная инструкция для участников встречи доступна после завершения регистрации';
        const first = `${description} ${label}: 999-123-45-67`;
        const second = strict
          ? `${description} ${label}: 999-123-45-68`
          : `Связаться для консультации ${label}: 999-123-45-67`;
        expect(await observe('original', 0, first, override)).toBeNull();
        const matched = await observe('matched', 100, second, override);
        expect(matched?.hit).toMatchObject({
          count: 1,
          fingerprintType: strict ? 'content' : 'phone',
        });
        expect(await history.stillMatches(chatId, matched!.binding)).toBe(true);
        expect(await history.qualify(chatId, matched!.binding)).toBe(1);
      },
    );
  });

  it.each(['photo', 'video', 'audio', 'file', 'sticker', 'contact', 'location'])(
    'verifies TEXT with known unavailable %s and revokes material caption edits',
    async (type) => {
      const textSettings = duplicateSettings({ duplicateCompareMode: 'TEXT' });
      const content = (text: string) =>
        extractDuplicateMessageContent({
          message: { body: { text, attachments: [{ type, payload: {} }] } },
        });
      const input = { settings: textSettings, content: content('Повторяемая подпись') };
      expect(await observe('original', 0, '', input)).toBeNull();
      const repeated = await observe('repeat', 100, '', input);
      expect(repeated?.hit.fingerprintType).toBe('exact');
      expect(await history.stillMatches(chatId, repeated!.binding)).toBe(true);
      await history.observeLifecycle({
        chatId,
        messageId: 'original',
        eventTimestampMs: start + 200,
        content: content(' ПОВТОРЯЕМАЯ  подпись '),
      });
      expect(await history.stillMatches(chatId, repeated!.binding)).toBe(true);
      await history.observeLifecycle({
        chatId,
        messageId: 'original',
        eventTimestampMs: start + 300,
        content: content('Совершенно другая подпись'),
      });
      expect(await history.stillMatches(chatId, repeated!.binding)).toBe(false);
      expect(await history.qualify(chatId, repeated!.binding)).toBeNull();
      for (const mode of ['MESSAGE', 'IMAGE'] as const) {
        const unsupported = {
          ...input,
          settings: duplicateSettings(),
          ...(mode === 'IMAGE' ? { imageScope: 'SAME_AUTHOR' as const } : {}),
          mediaHashes: ['a'.repeat(64)],
        };
        expect(await observe(`${mode}-original`, 400, '', unsupported)).toBeNull();
        expect(await observe(`${mode}-repeat`, 500, '', unsupported)).toBeNull();
      }
    },
  );

  const imageInput = () => ({
    imageScope: 'CHAT' as const,
    content: extractDuplicateMessageContent({
      message: {
        body: {
          text: 'caption',
          attachments: [
            { type: 'image', payload: { photo_id: 'photo', url: 'https://i.oneme.ru/a' } },
          ],
        },
      },
    }),
    mediaHashes: ['a'.repeat(64)],
  });

  it('keeps exact source identities and individual counts for verified recompression copies', async () => {
    const input = imageInput();
    await observe('original', 0, '', input);
    const imageOriginal = await history.findImageOriginal({
      ...input,
      chatId,
      userId: '123',
      messageId: 'original',
      eventTimestampMs: start,
      controlRevision: 1,
      settings,
    });
    const copy = {
      ...input,
      mediaHashes: ['b'.repeat(64)],
      imageRecompression: {
        version: 'native-recompression-v2' as const,
        originalHash: 'a'.repeat(64),
        currentHash: 'b'.repeat(64),
      },
      imageOriginal: imageOriginal!,
      userId: '456',
    };
    const match = await observe('copy', 100, '', copy);
    expect(match?.binding.original?.messageId).toBe('original');
    expect(match?.binding.mediaHashes).toEqual(copy.mediaHashes);
    expect(match?.binding.original?.mediaHashes).toEqual(input.mediaHashes);
    expect(await history.qualify(chatId, match!.binding)).toBe(1);
    expect(await history.qualify(chatId, match!.binding)).toBe(1);
    const withoutProof = { ...match!.binding, imageRecompression: undefined };
    expect(messageDuplicateBindingSchema.safeParse(withoutProof).success).toBe(false);
    expect(await history.stillMatches(chatId, withoutProof)).toBe(false);
    expect(await history.qualify(chatId, withoutProof)).toBeNull();
    const tampered = {
      ...match!.binding,
      imageRecompression: {
        ...copy.imageRecompression,
        currentHash: 'c'.repeat(64),
      },
    };
    expect(messageDuplicateBindingSchema.safeParse(tampered).success).toBe(false);
    expect(await history.qualify(chatId, tampered)).toBeNull();
    const other = await observe('other-author', 200, '', { ...copy, userId: '789' });
    expect(await history.qualify(chatId, other!.binding)).toBe(1);
    await history.remove(chatId, 'original');
    expect(await history.stillMatches(chatId, match!.binding)).toBe(false);
    expect(await history.stillMatches(chatId, other!.binding)).toBe(false);
  });

  it.each(['remove', 'reset', 'edit'] as const)(
    'never seeds an approximate copy after its accepted anchor changes (%s)',
    async (change) => {
      const input = imageInput();
      await observe('original', 0, '', input);
      const imageOriginal = await history.findImageOriginal({
        ...input,
        chatId,
        userId: '123',
        messageId: 'original',
        eventTimestampMs: start,
        controlRevision: 1,
        settings,
      });
      expect(imageOriginal?.messageId).toBe('original');
      if (change === 'remove') await history.remove(chatId, 'original');
      else if (change === 'reset') await redis.resetDuplicateWindow(chatId, '123');
      else
        await history.observeLifecycle({
          chatId,
          messageId: 'original',
          eventTimestampMs: start + 50,
          content: { ...input.content, complete: false, reason: 'invalid_content' },
        });
      expect(
        await observe('copy', 100, '', {
          ...input,
          userId: '456',
          mediaHashes: ['b'.repeat(64)],
          imageOriginal,
          imageRecompression: {
            version: 'native-recompression-v2',
            originalHash: 'a'.repeat(64),
            currentHash: 'b'.repeat(64),
          },
        }),
      ).toBeNull();
      expect(
        await inspector.get(`${windowPrefix()}message:${digestDuplicateContent('copy')}:IMAGE`),
      ).toBeNull();
      expect(await observe('fresh-original', 200, '', { ...input, userId: '789' })).toBeNull();
      const repeat = await observe('fresh-repeat', 300, '', { ...input, userId: '456' });
      expect(repeat?.binding.original?.messageId).toBe('fresh-original');
    },
  );

  it.each(['retained', 'lost', 'lifecycle', 'invalidate'] as const)(
    'never freshens equal image bytes through a later locator after reset (%s)',
    async (state) => {
      const futureAt = Date.now() + 59_000;
      const input = imageInput();
      await observe('future-original', futureAt - start, '', input);
      const old = await observe('future-target', futureAt + 1 - start, '', input);
      await redis.resetDuplicateWindow(chatId, '123');
      if (state !== 'retained') {
        await inspector.del(
          `${windowPrefix()}message:${digestDuplicateContent('future-original')}:IMAGE`,
        );
      }
      const refreshed = extractDuplicateMessageContent({
        message: {
          body: {
            attachments: [
              {
                type: 'image',
                payload: { photo_id: 'renewed', url: 'https://i.oneme.ru/renewed' },
              },
            ],
          },
        },
      });
      if (state === 'lifecycle') {
        await history.observeLifecycle({
          chatId,
          messageId: 'future-original',
          eventTimestampMs: futureAt + 100,
          content: refreshed,
        });
      } else if (state === 'invalidate') {
        await history.invalidateLifecycle({
          chatId,
          messageId: 'future-original',
          content: refreshed,
        });
      }
      const refresh = { ...input, content: refreshed };
      await observe('future-original', futureAt + 100 - start, '', { ...refresh, mediaHashes: [] });
      await observe('future-original', futureAt + 100 - start, '', refresh);
      expect(await observe('fresh-original', futureAt + 200 - start, '', input)).toBeNull();
      const fresh = await observe('fresh-target', futureAt + 300 - start, '', input);
      expect(fresh?.binding.original?.messageId).toBe('fresh-original');
      expect(await history.qualify(chatId, fresh!.binding)).toBe(1);
      expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
    },
  );

  describe.each([false, true])('reset with missing image state %s', (loseState) => {
    it.each([false, true])(
      'admits proved changed image bytes with a changed locator %s',
      async (changeLocator) => {
        const futureAt = Date.now() + 59_000;
        const input = imageInput();
        await observe('future-original', futureAt - start, '', input);
        const old = await observe('future-target', futureAt + 1 - start, '', input);
        await redis.resetDuplicateWindow(chatId, '123');
        if (loseState) {
          await inspector.del(
            `${windowPrefix()}message:${digestDuplicateContent('future-original')}:IMAGE`,
          );
        }
        const changed = {
          ...input,
          mediaHashes: ['b'.repeat(64)],
          ...(changeLocator
            ? {
                content: extractDuplicateMessageContent({
                  message: {
                    body: {
                      attachments: [
                        {
                          type: 'image',
                          payload: {
                            photo_id: 'new-content',
                            url: 'https://i.oneme.ru/new-content',
                          },
                        },
                      ],
                    },
                  },
                }),
              }
            : {}),
        };
        await observe('future-original', futureAt + 100 - start, '', changed);
        const edited = await observe('edited-target', futureAt + 200 - start, '', changed);
        expect(edited?.binding.original?.messageId).toBe('future-original');
        expect(edited?.binding.original?.publishedAtMs).toBe(futureAt + 100);
        expect(edited?.binding.original?.revision).not.toBe(old!.binding.original!.revision);
        expect(edited?.binding.original?.originalId).not.toBe(old!.binding.original!.originalId);
        expect(await history.qualify(chatId, edited!.binding)).toBe(1);
        expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
      },
    );
  });

  it.each([false, true])(
    'never promotes a pre-reset pending locator as fresh verified content with missing state %s',
    async (loseState) => {
      const futureAt = Date.now() + 59_000;
      const input = imageInput();
      await observe('future-original', futureAt - start, '', input);
      const changed = {
        ...input,
        content: extractDuplicateMessageContent({
          message: {
            body: {
              attachments: [
                {
                  type: 'image',
                  payload: { photo_id: 'pending', url: 'https://i.oneme.ru/pending' },
                },
              ],
            },
          },
        }),
        mediaHashes: ['b'.repeat(64)],
      };
      await observe('future-original', futureAt + 10 - start, '', { ...changed, mediaHashes: [] });
      await redis.resetDuplicateWindow(chatId, '123');
      if (loseState) {
        await inspector.del(
          `${windowPrefix()}message:${digestDuplicateContent('future-original')}:IMAGE`,
        );
      }
      await observe('future-original', futureAt + 100 - start, '', changed);
      expect(await observe('fresh-original', futureAt + 200 - start, '', changed)).toBeNull();
      const fresh = await observe('fresh-target', futureAt + 300 - start, '', changed);
      expect(fresh?.binding.original?.messageId).toBe('fresh-original');
      expect(await history.qualify(chatId, fresh!.binding)).toBe(1);
    },
  );

  it.each(['SAME_AUTHOR', 'CHAT'] as const)(
    'never chains image repeats into another window (%s)',
    async (scope) => {
      const input = {
        ...imageInput(),
        imageScope: scope,
        settings: duplicateSettings({ duplicateWarnWindowSec: 86400 }),
      };
      await observe('original', 0, '', input);
      const morning = await observe('morning', 21 * 3600000, '', input);
      expect(morning?.binding.original?.messageId).toBe('original');
      expect(await history.qualify(chatId, morning!.binding)).toBe(1);
      expect(await observe('evening', 30 * 3600000, '', input)).toBeNull();
      const next = await observe('next', 43 * 3600000, '', input);
      expect(next?.binding.original?.messageId).toBe('evening');
      expect(next?.binding.original?.expiresAtMs).toBe(start + 54 * 3600000);
      expect(next?.hit.count).toBe(1);
    },
  );

  it('keeps another author’s shared image original on a per-author reset', async () => {
    const input = imageInput();
    await observe('original', 0, '', input);
    await redis.resetDuplicateWindow(chatId, '456');
    const afterReset = Date.now() - start + 100;
    const match = await observe('new-author', afterReset, '', { ...input, userId: '456' });
    expect(match?.binding.original?.messageId).toBe('original');
    expect(await history.qualify(chatId, match!.binding)).toBe(1);
  });

  it('does not promote a rejected message through an unmatched secondary fingerprint', async () => {
    const override = {
      settings: duplicateSettings({
        duplicateDetectionPreset: 'CUSTOM',
        duplicateIgnorePhonesEnabled: true,
      }),
    };
    await observe('original', 0, 'one +7 (999) 123-45-67', override);
    expect(await observe('rejected', 100, 'two +7 (999) 123-45-67', override)).not.toBeNull();
    await history.remove(chatId, 'original');
    expect(await observe('new', 200, 'two +7 (999) 123-45-67', override)).toBeNull();
  });

  it('isolates author escalation while sharing exact-image matching and replay snapshots', async () => {
    const input = imageInput();
    expect(await observe('a1', 0, '', input)).toBeNull();
    const a2 = await observe('a2', 100, '', input);
    expect(await history.qualify(chatId, a2!.binding)).toBe(1);
    const a3 = await observe('a3', 200, '', input);
    expect(await history.qualify(chatId, a3!.binding)).toBe(2);
    const b = await observe('b1', 300, '', { ...input, userId: '456' });
    expect(b?.hit.count).toBe(1);
    expect(await history.qualify(chatId, b!.binding)).toBe(1);
    expect(await history.stillMatches(chatId, b!.binding)).toBe(true);
    expect(await history.stillMatches(chatId, { ...b!.binding, requiredCount: 3 })).toBe(false);
    expect((await observe('a4', 400, '', input))?.hit.count).toBe(3);
    expect((await observe('b2', 500, '', { ...input, userId: '456' }))?.hit.count).toBe(2);
    expect((await observe('b1', 300, '', { ...input, userId: '456' }))?.hit.count).toBe(1);
  });

  it('atomically invalidates shared and author memberships when the original is edited', async () => {
    const input = imageInput();
    await observe('a1', 0, '', input);
    const b = await observe('b1', 100, '', { ...input, userId: '456' });
    await observe('a1', 200, '', {
      ...input,
      content: { ...input.content, complete: false, reason: 'invalid_content' },
    });
    expect(await history.stillMatches(chatId, b!.binding)).toBe(false);
    expect(await observe('a1', 0, '', input)).toBeNull();
  });

  it('matches same-clock photos across authors while keeping qualification per author and replay', async () => {
    const input = imageInput();
    await observe('a1', 0, '', input);
    const tied = await observe('b1', 0, '', { ...input, userId: '456' });
    expect(tied?.binding.original?.messageId).toBe('a1');
    expect(tied?.hit.count).toBe(1);
    expect(await history.qualify(chatId, tied!.binding)).toBe(1);
    expect(await observe('a1', 0, '', input)).toBeNull();
    const replay = await observe('b1', 0, '', { ...input, userId: '456' });
    expect(await history.qualify(chatId, replay!.binding)).toBe(1);
    const sameAuthor = await observe('a2', 100, '', input);
    expect(sameAuthor?.hit.count).toBe(1);
    expect(await history.qualify(chatId, sameAuthor!.binding)).toBe(1);
    const otherAuthor = await observe('b2', 200, '', { ...input, userId: '456' });
    expect(otherAuthor?.hit.count).toBe(2);
    expect(await history.qualify(chatId, otherAuthor!.binding)).toBe(2);
  });

  it.each([59_999, 60_000, 60_001])(
    'uses an exclusive lower window bound at %ims',
    async (gapMs) => {
      const override = { settings: duplicateSettings({ duplicateWarnWindowSec: 60 }) };
      await observe('original', 0, 'a', override);
      const result = await observe('repeat', gapMs, 'a', override);
      if (gapMs < 60_000) {
        expect(result?.hit.count).toBe(1);
        expect(await history.stillMatches(chatId, result!.binding)).toBe(true);
      } else {
        expect(result).toBeNull();
      }
    },
  );

  it('preserves the event-time comparison window while a valid delete waits for dispatch', async () => {
    const now = Date.now();
    const override = { settings: duplicateSettings({ duplicateWarnWindowSec: 60 }) };
    await observe('original', now - start - 65_000, 'a', override);
    const hit = await observe('repeat', now - start - 10_000, 'a', override);
    expect(hit?.hit.count).toBe(1);
    expect(await history.stillMatches(chatId, hit!.binding)).toBe(true);
    await observe('original', now - start - 1_000, 'edited', override);
    expect(await history.stillMatches(chatId, hit!.binding)).toBe(false);
  });

  it('persists an explicitly global full policy without expiry and supports a permanent stop', async () => {
    keys.add(MESSAGE_DUPLICATE_CONTROL_KEY);
    keys.add(`${MESSAGE_DUPLICATE_CONTROL_KEY}:revision`);
    const policy = new MessageDuplicatePolicyService(redis, new ConfigService());
    const control = {
      version: 2,
      revision: 1,
      mode: 'full',
      scope: 'all_enabled_chats',
      chatIds: [],
      effectiveAt: new Date().toISOString(),
      expiresAt: null,
    };
    expect(await policy.set(control, 0)).toEqual({ applied: true, revision: 1 });
    expect(await inspector.ttl(MESSAGE_DUPLICATE_CONTROL_KEY)).toBe(-1);
    expect(await policy.resolve('-987654321', true)).toMatchObject({ mode: 'full', revision: 1 });
    expect(await policy.set({ ...control, mode: 'off', revision: 2 }, 1)).toEqual({
      applied: true,
      revision: 2,
    });
    expect(await inspector.ttl(MESSAGE_DUPLICATE_CONTROL_KEY)).toBe(-1);
    expect(await policy.resolve('-987654321', true)).toMatchObject({ mode: 'off', revision: 2 });
    expect(await policy.set(control, 0)).toEqual({ applied: false, revision: 2 });
  });
  it('materializes media after a pending phase and removes stale media after a text edit', async () => {
    const content = extractDuplicateMessageContent({
      message: {
        body: {
          caption: 'a',
          attachments: [{ type: 'file', payload: { url: 'https://fd.oneme.ru/a' } }],
        },
      },
    });
    expect(await observe('a', 0, '', { content })).toBeNull();
    expect(await observe('a', 0, '', { content, mediaHashes: ['a'.repeat(64)] })).toBeNull();
    expect(await observe('b', 100, '', { content, mediaHashes: ['b'.repeat(64)] })).toBeNull();
    const hit = await observe('c', 200, '', { content, mediaHashes: ['a'.repeat(64)] });
    expect(hit?.hit.count).toBe(1);
    expect(await observe('a', 300, 'other')).toBeNull();
    expect(await observe('a', 0, '', { content, mediaHashes: ['a'.repeat(64)] })).toBeNull();
    expect(await history.stillMatches(chatId, hit!.binding)).toBe(false);
  });
  it('isolates authors/chats and permits only one insertion under concurrent replay', async () => {
    await observe('a', 0);
    const results = await Promise.all(Array.from({ length: 8 }, () => observe('b', 100)));
    expect(results.every((result) => result?.hit.count === 1)).toBe(true);
    expect(await observe('c', 200, 'a', { userId: '456' })).toBeNull();
    expect(await observe('c', 200, 'a', { chatId: `${chatId}-other` })).toBeNull();
  });
  it('does not revive an old action after content changes away and back', async () => {
    await observe('original', 0);
    const old = await observe('target', 100);
    await observe('target', 200, 'different');
    await observe('target', 300, 'a');
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
  });

  it('does not revive old evidence when the original changes away and back', async () => {
    await observe('original', 0);
    const old = await observe('target', 100);
    await observe('original', 200, 'different');
    await observe('original', 300, 'a');
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
    const next = await observe('next', 400);
    expect(next?.binding.original?.publishedAtMs).toBe(start + 300);
  });

  it.each(['original', 'target'])(
    'never revives a binding after lifecycle-only A -> B -> A on %s',
    async (messageId) => {
      await observe('original', 0);
      const old = await observe('target', 100);
      const edit = async (time: number, text: string) =>
        history.observeLifecycle({
          chatId,
          messageId,
          eventTimestampMs: start + time,
          content: extractDuplicateMessageContent({ message: { body: { text } } }),
        });
      await edit(200, 'different');
      expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
      await edit(300, 'a');
      expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
      expect(await history.qualify(chatId, old!.binding)).toBeNull();
      const fresh = await observe(messageId, 300);
      const next = await observe('next', 400);
      expect(next).not.toBeNull();
      if (messageId === 'original') {
        expect(next!.binding.original!.revision).not.toBe(old!.binding.original!.revision);
      } else {
        expect(fresh?.binding.lifecycleRevision).not.toBe(old!.binding.lifecycleRevision);
        expect(next!.binding.original!.revision).toBe(old!.binding.original!.revision);
      }
    },
  );

  it('keeps an equal-time conflict revoked after replay and an older event', async () => {
    await observe('original', 0);
    const old = await observe('target', 100);
    const edit = (time: number, text: string) =>
      history.observeLifecycle({
        chatId,
        messageId: 'original',
        eventTimestampMs: start + time,
        content: extractDuplicateMessageContent({ message: { body: { text } } }),
      });
    await edit(0, 'conflict');
    await edit(0, 'a');
    await edit(-1, 'a');
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
    expect(await observe('original', 0)).toBeNull();
    await observe('original', 200);
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
    expect((await observe('next', 300))?.binding.original?.messageId).toBe('original');
  });

  it('does not recreate an old lifecycle incarnation after its Redis record disappears', async () => {
    await observe('original', 0);
    const old = await observe('target', 100);
    const key = `${windowPrefix()}life:${digestDuplicateContent('original')}:MESSAGE`;
    await inspector.del(key);
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
    await observe('original', 0);
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
    const next = await observe('next', 200);
    expect(next?.binding.original?.revision).not.toBe(old!.binding.original!.revision);
    expect(next?.binding.original?.originalId).not.toBe(old!.binding.original!.originalId);
  });

  it.each(['original', 'target'])(
    'never restores an old binding after only %s message state expires',
    async (messageId) => {
      await observe('original', 0);
      const old = await observe('target', 100);
      const key = `${windowPrefix()}message:${digestDuplicateContent(messageId)}:MESSAGE`;
      await inspector.pexpireat(key, Date.now() - 1);
      expect(await inspector.exists(key)).toBe(0);
      expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
      const fresh = await observe(messageId, messageId === 'original' ? 0 : 100);
      expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
      if (messageId === 'target') {
        expect(fresh?.binding.lifecycleRevision).not.toBe(old!.binding.lifecycleRevision);
        expect(await history.stillMatches(chatId, fresh!.binding)).toBe(true);
      } else {
        const next = await observe('next', 200);
        expect(next?.binding.original?.revision).not.toBe(old!.binding.original!.revision);
        expect(next?.binding.original?.originalId).not.toBe(old!.binding.original!.originalId);
      }
    },
  );

  it('does not admit an unknown-time MAX replacement after a later cosmetic event', async () => {
    await observe('original', 0);
    const old = await observe('target', 100);
    const changed = extractDuplicateMessageContent({ message: { body: { text: 'replacement' } } });
    await history.invalidateLifecycle({ chatId, messageId: 'original', content: changed });
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
    await observe('original', 200, 'replacement');
    expect(await observe('replacement-first', 300, 'replacement')).toBeNull();
    const next = await observe('replacement-repeat', 400, 'replacement');
    expect(next?.binding.original?.messageId).toBe('replacement-first');
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
  });

  it('retains unknown-time invalidation after expired lifecycle proof and another MAX refresh', async () => {
    await observe('original', 0);
    const old = await observe('target', 100);
    const lifeKey = `${windowPrefix()}life:${digestDuplicateContent('original')}:MESSAGE`;
    await inspector.pexpireat(lifeKey, Date.now() - 1);
    const content = (text: string) =>
      extractDuplicateMessageContent({ message: { body: { text } } });
    await history.invalidateLifecycle({ chatId, messageId: 'original', content: content('first') });
    await history.invalidateLifecycle({
      chatId,
      messageId: 'original',
      content: content('second'),
    });
    expect(await inspector.pttl(lifeKey)).toBeGreaterThan(0);
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
    await observe('original', 200, 'second', { publishedAtMs: start });
    expect(await observe('new-original', 300, 'second')).toBeNull();
    expect((await observe('new-repeat', 400, 'second'))?.binding.original?.messageId).toBe(
      'new-original',
    );
  });

  it('preserves image escalation and the original identity through caption-only pending refresh', async () => {
    const input = imageInput();
    await observe('original', 0, '', input);
    const first = await observe('first', 100, '', input);
    expect(await history.qualify(chatId, first!.binding)).toBe(1);
    const captionContent = {
      ...input.content,
      text: 'New caption with another link',
      rawText: 'New caption with another link',
    };
    await history.observeLifecycle({
      chatId,
      messageId: 'original',
      eventTimestampMs: start + 200,
      publishedAtMs: start,
      content: captionContent,
    });
    await observe('original', 200, '', { ...input, content: captionContent, mediaHashes: [] });
    expect(await history.stillMatches(chatId, first!.binding)).toBe(true);
    await observe('original', 200, '', { ...input, content: captionContent });
    const next = await observe('next', 300, '', input);
    expect(next?.hit.count).toBe(2);
    expect(await history.qualify(chatId, next!.binding)).toBe(2);
    expect(next?.binding.original).toEqual(first!.binding.original);
  });

  it('does not grant another allowance after a caption-only refresh of the original', async () => {
    const input = {
      ...imageInput(),
      settings: duplicateSettings({ duplicateWarnEnabled: true, duplicateWarnMaxCount: 2 }),
    };
    await observe('original', 0, '', input);
    expect(await observe('allowed', 100, '', input)).toBeNull();
    await observe('original', 200, '', { ...input, mediaHashes: [] });
    await observe('original', 200, '', input);
    const next = await observe('next', 300, '', input);
    expect(next?.hit.count).toBe(2);
    expect(await history.qualify(chatId, next!.binding)).toBe(2);
    expect(next?.binding.original?.publishedAtMs).toBe(start);
    expect(next?.binding.original?.observedAtMs).toBe(start);
  });

  it('revokes reused photo locators when independent bytes change and return', async () => {
    const input = imageInput();
    await observe('original', 0, '', input);
    const old = await observe('target', 100, '', input);
    await observe('original', 200, '', { ...input, mediaHashes: ['b'.repeat(64)] });
    await observe('original', 300, '', input);
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
    const next = await observe('next', 400, '', input);
    expect(next?.binding.original?.publishedAtMs).toBe(start + 300);
    expect(next?.binding.original?.revision).not.toBe(old!.binding.original!.revision);
  });

  it('retains the original counter only after one independently verified locator refresh', async () => {
    const input = imageInput();
    await observe('original', 0, '', input);
    const old = await observe('target', 100, '', input);
    expect(await history.qualify(chatId, old!.binding)).toBe(1);
    const refreshed = extractDuplicateMessageContent({
      message: {
        body: {
          attachments: [
            { type: 'image', payload: { photo_id: 'renewed', url: 'https://i.oneme.ru/renewed' } },
          ],
        },
      },
    });
    await history.observeLifecycle({
      chatId,
      messageId: 'original',
      eventTimestampMs: start + 200,
      content: refreshed,
    });
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
    await observe('original', 200, '', { ...input, content: refreshed, mediaHashes: [] });
    await observe('original', 200, '', { ...input, content: refreshed });
    const next = await observe('next', 300, '', input);
    expect(next?.hit.count).toBe(2);
    expect(next?.binding.original?.originalId).toBe(old!.binding.original!.originalId);
    expect(next?.binding.original?.revision).not.toBe(old!.binding.original!.revision);
    expect(next?.binding.original?.publishedAtMs).toBe(start);
    expect(next?.binding.original?.expiresAtMs).toBe(old!.binding.original!.expiresAtMs);
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
  });

  it('does not retain a counter through an unverified intermediate image source', async () => {
    const input = imageInput();
    await observe('original', 0, '', input);
    const old = await observe('target', 100, '', input);
    expect(await history.qualify(chatId, old!.binding)).toBe(1);
    const source = (photoId: string) =>
      extractDuplicateMessageContent({
        message: {
          body: {
            attachments: [
              {
                type: 'image',
                payload: { photo_id: photoId, url: `https://i.oneme.ru/${photoId}` },
              },
            ],
          },
        },
      });
    for (const [offset, photoId] of [
      [200, 'intermediate'],
      [300, 'photo'],
    ] as const) {
      await history.observeLifecycle({
        chatId,
        messageId: 'original',
        eventTimestampMs: start + offset,
        content: source(photoId),
      });
    }
    await observe('original', 300, '', input);
    const next = await observe('next', 400, '', input);
    expect(next?.hit.count).toBe(1);
    expect(next?.binding.original?.originalId).not.toBe(old!.binding.original!.originalId);
    expect(await history.stillMatches(chatId, old!.binding)).toBe(false);
  });

  it('does not consume a second allowance when an accepted duplicate changes only its locator', async () => {
    const input = {
      ...imageInput(),
      settings: duplicateSettings({ duplicateWarnEnabled: true, duplicateWarnMaxCount: 3 }),
    };
    await observe('original', 0, '', input);
    expect(await observe('allowed', 100, '', input)).toBeNull();
    const refreshed = extractDuplicateMessageContent({
      message: {
        body: {
          attachments: [
            { type: 'image', payload: { photo_id: 'new-locator', url: 'https://i.oneme.ru/new' } },
          ],
        },
      },
    });
    await observe('allowed', 200, '', { ...input, content: refreshed, mediaHashes: [] });
    expect(await observe('allowed', 200, '', { ...input, content: refreshed })).toBeNull();
    expect(await observe('allowed-second', 300, '', input)).toBeNull();
    const rejected = await observe('rejected', 400, '', input);
    expect(rejected?.hit.count).toBe(3);
    expect(await history.qualify(chatId, rejected!.binding)).toBe(3);
  });

  it('bounds accepted occurrence state across policy changes and verified locator refreshes', async () => {
    const input = imageInput();
    for (let revision = 0; revision < 24; revision += 1) {
      const changed = {
        settings: duplicateSettings({
          duplicateWarnEnabled: true,
          duplicateWarnMaxCount: 2,
          duplicateHistoryRevision: revision,
          duplicatePolicyRevision: revision,
        }),
      };
      await observe('original', 0, '', { ...input, ...changed });
      const refreshed = extractDuplicateMessageContent({
        message: {
          body: {
            attachments: [
              {
                type: 'image',
                payload: {
                  photo_id: `locator-${revision}`,
                  url: `https://i.oneme.ru/locator-${revision}`,
                },
              },
            ],
          },
        },
      });
      expect(
        await observe('accepted', 100 + revision * 100, '', {
          ...input,
          ...changed,
          content: refreshed,
        }),
      ).toBeNull();
    }
    const key = `${windowPrefix()}message:${digestDuplicateContent('accepted')}:IMAGE`;
    const state = JSON.parse((await inspector.get(key))!);
    expect(Object.keys(state.accepted).length).toBeLessThanOrEqual(16);
    const next = await observe('next', 3000, '', {
      ...input,
      settings: duplicateSettings({
        duplicateWarnEnabled: true,
        duplicateWarnMaxCount: 2,
        duplicateHistoryRevision: 23,
        duplicatePolicyRevision: 23,
      }),
    });
    expect(next?.hit.count).toBe(2);
  });

  it('does not carry another policy context through a pending locator promotion', async () => {
    const input = {
      ...imageInput(),
      settings: duplicateSettings({ duplicateWarnEnabled: true, duplicateWarnMaxCount: 2 }),
    };
    await observe('original', 0, '', input);
    expect(await observe('accepted', 100, '', input)).toBeNull();
    const refreshed = extractDuplicateMessageContent({
      message: {
        body: {
          attachments: [
            { type: 'image', payload: { photo_id: 'new-locator', url: 'https://i.oneme.ru/new' } },
          ],
        },
      },
    });
    await observe('accepted', 200, '', { ...input, content: refreshed, mediaHashes: [] });
    const changed = {
      ...input,
      settings: { ...input.settings, duplicateHistoryRevision: 1, duplicatePolicyRevision: 1 },
    };
    await observe('original', 0, '', changed);
    expect(await observe('accepted', 200, '', { ...changed, content: refreshed })).toBeNull();
    const key = `${windowPrefix()}message:${digestDuplicateContent('accepted')}:IMAGE`;
    const state = JSON.parse((await inspector.get(key))!);
    expect(Object.keys(state.accepted)).toHaveLength(1);
    expect((await observe('next', 300, '', changed))?.hit.count).toBe(2);
  });

  it('resumes the same qualified count through one verified duplicate locator refresh', async () => {
    const input = imageInput();
    await observe('original', 0, '', input);
    const target = await observe('target', 100, '', input);
    expect(await history.qualify(chatId, target!.binding)).toBe(1);
    const refreshed = extractDuplicateMessageContent({
      message: {
        body: {
          attachments: [
            { type: 'image', payload: { photo_id: 'new-locator', url: 'https://i.oneme.ru/new' } },
          ],
        },
      },
    });
    await observe('target', 200, '', { ...input, content: refreshed, mediaHashes: [] });
    const resumed = await observe('target', 200, '', { ...input, content: refreshed });
    expect(resumed?.hit.count).toBe(1);
    expect(await history.qualify(chatId, resumed!.binding)).toBe(1);
    const next = await observe('next', 300, '', input);
    expect(next?.hit.count).toBe(2);
    expect(await history.qualify(chatId, next!.binding)).toBe(2);
  });

  it('keeps outside-period material introduction through an inside-period cosmetic edit', async () => {
    const day = 86400_000;
    const clockOffset = Math.ceil((Date.now() - Date.parse('2026-10-02T10:00:00Z')) / day) * day;
    const freshTime = (iso: string) => Date.parse(iso) + clockOffset;
    const dailySettings = duplicateSettings({
      duplicateWindowMode: 'DAILY',
      duplicateStartTimeMinutes: 540,
      duplicateEndTimeMinutes: 1080,
      duplicateTimezone: 'UTC',
      duplicateCompareMode: 'TEXT',
    });
    const at = (messageId: string, iso: string, text: string, publishedAtMs?: number) =>
      observe(messageId, freshTime(iso) - start, text, { settings: dailySettings, publishedAtMs });
    const publication = freshTime('2026-10-01T12:00:00Z');
    await at('old', '2026-10-01T12:00:00Z', 'a');
    await at('old', '2026-10-02T08:00:00Z', 'different', publication);
    await at('old', '2026-10-02T10:00:00Z', ' different ', publication);
    expect(await at('first', '2026-10-02T10:00:00.100Z', 'different')).toBeNull();
    const next = await at('next', '2026-10-02T10:00:00.200Z', 'different');
    expect(next?.binding.original?.messageId).toBe('first');
  });

  it('re-evaluates unchanged content when its comparison settings change', async () => {
    await observe('original', 0);
    await observe('target', 100);
    const changed = { settings: duplicateSettings({ duplicateWarnWindowSec: 3600 }) };
    expect(await observe('target', 200, 'a', changed)).toBeNull();
    const next = await observe('next', 300, 'a', changed);
    expect(next?.binding.original?.messageId).toBe('target');
    expect(next?.binding.original?.publishedAtMs).toBe(start + 100);
  });

  it('preserves material-edit time when pending media becomes verified', async () => {
    const file = (url: string) =>
      extractDuplicateMessageContent({
        message: {
          body: {
            attachments: [{ type: 'file', payload: { url } }],
          },
        },
      });
    const oldTime = start - 2 * 86400_000;
    await observe('old', oldTime - start, '', {
      content: file('https://fd.oneme.ru/old'),
      mediaHashes: ['a'.repeat(64)],
    });
    await observe('old', 0, '', {
      content: file('https://fd.oneme.ru/new'),
      publishedAtMs: oldTime,
    });
    await observe('old', 0, '', {
      content: file('https://fd.oneme.ru/new'),
      publishedAtMs: oldTime,
      mediaHashes: ['b'.repeat(64)],
    });
    const repeated = await observe('repeat', 100, '', {
      content: file('https://fd.oneme.ru/new'),
      mediaHashes: ['b'.repeat(64)],
    });
    expect(repeated?.binding.original?.publishedAtMs).toBe(start);
    expect(repeated?.binding.original?.messageId).toBe('old');
  });

  it.each(['TEXT', 'IMAGE'] as const)(
    'resets %s evidence and sanctions at each daily period',
    async (mode) => {
      const day = 86400_000;
      const clockOffset = Math.ceil((Date.now() - Date.parse('2026-09-29T14:59Z')) / day) * day;
      const freshTime = (iso: string) => Date.parse(iso) + clockOffset;
      const dailySettings = duplicateSettings({
        duplicateWindowMode: 'DAILY',
        duplicateStartTimeMinutes: 540,
        duplicateEndTimeMinutes: 1080,
        duplicateCompareMode: mode === 'TEXT' ? 'TEXT' : 'MESSAGE',
      });
      const extra =
        mode === 'IMAGE'
          ? {
              content: extractDuplicateMessageContent({
                message: {
                  body: {
                    attachments: [{ type: 'image', payload: { url: 'https://i.oneme.ru/a' } }],
                  },
                },
              }),
              imageScope: 'CHAT' as const,
              mediaHashes: ['a'.repeat(64)],
            }
          : {};
      const at = (id: string, iso: string, overrides = {}) =>
        observe(id, freshTime(iso) - start, 'a', {
          settings: dailySettings,
          ...extra,
          ...overrides,
        });
      expect(await at('outside', '2026-09-29T05:59Z')).toBeNull();
      expect(await at('first', '2026-09-29T06:00Z')).toBeNull();
      const repeat = await at('repeat', '2026-09-29T14:59Z');
      expect(repeat?.binding.original?.messageId).toBe('first');
      expect(repeat?.binding.original?.expiresAtMs).toBe(freshTime('2026-09-29T15:00Z'));
      expect(await history.qualify(chatId, repeat!.binding)).toBe(1);
      expect(await at('closed', '2026-09-29T15:00Z')).toBeNull();
      // Yesterday's unchanged original and rejected target cannot become today's evidence.
      expect(
        await at('first', '2026-09-30T06:00Z', { publishedAtMs: freshTime('2026-09-29T06:00Z') }),
      ).toBeNull();
      expect(
        await at('repeat', '2026-09-30T06:01Z', { publishedAtMs: freshTime('2026-09-29T14:59Z') }),
      ).toBeNull();
      expect(await at('new-day', '2026-09-30T06:02Z')).toBeNull();
      const next = await at('new-repeat', '2026-09-30T06:03Z');
      expect(next?.binding.original?.messageId).toBe('new-day');
      expect(await history.qualify(chatId, next!.binding)).toBe(1);
    },
  );

  it('never lets a pending media observation downgrade an already verified revision', async () => {
    await observe('a', 0);
    const hit = await observe('b', 100);
    await observe('b', 100, '', {
      content: {
        ...extractDuplicateMessageContent({ message: { body: { text: 'a' } } }),
        complete: false,
        reason: 'invalid_content',
      },
    });
    expect(await history.stillMatches(chatId, hit!.binding)).toBe(true);
  });
  it('keeps policy CAS revisions after expiry and never overwrites a concurrent operator', async () => {
    const key = `message-duplicate:test-control:${chatId}`;
    keys.add(key);
    keys.add(`${key}:revision`);
    const set = (expectedRevision: number) =>
      redis.compareAndSetRevisionedControl({
        key,
        expectedRevision,
        value: JSON.stringify({ version: 1, revision: expectedRevision + 1 }),
        expiresAtMs: Date.now() + 10000,
      });
    const result = await Promise.all([set(0), set(0)]);
    expect(result.filter((item) => item.applied)).toHaveLength(1);
    await inspector.del(key);
    expect(await set(0)).toEqual({ applied: false, revision: 1 });
    expect(await set(1)).toEqual({ applied: true, revision: 2 });
    expect(
      await new MessageDuplicatePolicyService(
        redis,
        new ConfigService({ MESSAGE_DUPLICATE_ENABLED: false }),
      ).resolve('-123'),
    ).toMatchObject({ mode: 'off' });
  });

  it('requires explicit CUSTOM link matching to join a URL containing a phone-shaped value', async () => {
    const url = 'https://example.test/?phone=+79991234567';
    const phoneOnly = duplicateSettings({
      duplicateDetectionPreset: 'CUSTOM',
      duplicateIgnorePhonesEnabled: true,
    });
    await observe('phone-only-original', 0, `Продажа оборудования ${url}`, { settings: phoneOnly });
    expect(
      await observe('phone-only-unrelated', 100, `Консультация для участников ${url}`, {
        settings: phoneOnly,
      }),
    ).toBeNull();
    const explicitLink = { ...phoneOnly, duplicateIgnoreLinksEnabled: true };
    await observe('link-original', 200, `Продажа оборудования ${url}`, { settings: explicitLink });
    const repeated = await observe('link-repeat', 300, `Консультация для участников ${url}`, {
      settings: explicitLink,
    });
    expect(repeated?.hit.fingerprintType).toBe('link');
    expect(await history.qualify(chatId, repeated!.binding)).toBe(1);
  });
});
