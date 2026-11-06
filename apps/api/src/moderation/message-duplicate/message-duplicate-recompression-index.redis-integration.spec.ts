import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { RedisCounterService } from '../redis-counter.service';
import {
  duplicateRecompressionIndexKeys,
  MessageDuplicateRecompressionIndex,
  type MessageDuplicateRecompressionCandidate,
} from './message-duplicate-recompression-index';

const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
const local = /^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/u.test(url);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const MAX_RETENTION_MS = 48 * 60 * 60 * 1000;

(local ? describe : describe.skip)('recompression candidate index with native Redis', () => {
  let counters: RedisCounterService;
  let inspector: Redis;
  let index: MessageDuplicateRecompressionIndex;
  let scope: string;
  let keys: Set<string>;
  let now: number;
  const hash = '0011223344556677';
  const candidate = (
    id: string,
    overrides: Partial<MessageDuplicateRecompressionCandidate> = {},
  ): MessageDuplicateRecompressionCandidate => ({
    webhookEventId: `event-${id}`,
    messageId: `message-${id}`,
    eventTimestampMs: now - 1000,
    publishedAtMs: now - 1000,
    canonicalHash: digest(id),
    recompressionHash: hash,
    expiresAtMs: now + 60_000,
    ...overrides,
  });
  const track = (value = hash, selectedScope = scope) => {
    const selected = duplicateRecompressionIndexKeys(selectedScope, value);
    selected.forEach((key) => keys.add(key));
    return selected;
  };
  beforeEach(() => {
    now = Date.now();
    scope = digest(randomUUID());
    keys = new Set();
    counters = new RedisCounterService(new ConfigService({ REDIS_URL: url }));
    inspector = new Redis(url);
    index = new MessageDuplicateRecompressionIndex(counters);
    track();
  });
  afterEach(async () => {
    if (keys.size) await inspector.del(...keys);
    await inspector.quit();
    await counters.onModuleDestroy();
  });

  it('retrieves one original through surviving bands after six changed bits', async () => {
    const original = candidate('original');
    await index.remember(scope, original);
    const changed = '0110233245546677';
    track(changed);
    expect(await index.read(scope, changed, now)).toEqual([original]);
    const unrelated = 'ffeeddccbbaa9900';
    track(unrelated);
    expect(await index.read(scope, unrelated, now)).toEqual([]);
    expect([...keys].some((key) => key.includes(original.messageId))).toBe(false);
  });

  it('filters distant band collisions before the global cap so a close original remains discoverable', async () => {
    const distantHash = '00aaaaaaaaaaaaaa';
    track(distantHash);
    const distant = Array.from({ length: 8 }, (_, i) =>
      candidate(`distant-${i}`, {
        recompressionHash: distantHash,
        publishedAtMs: now - 10_000 + i,
        eventTimestampMs: now - 10_000 + i,
      }),
    );
    for (const row of distant) await index.remember(scope, row);
    const nearHash = '0111223344556677';
    track(nearHash);
    const near = candidate('near', { recompressionHash: nearHash });
    await index.remember(scope, near);
    expect(await index.read(scope, hash, now)).toEqual([near]);
    expect(await index.read(scope, distantHash, now)).toEqual(distant);
  });

  it('ranks a later closest original before the global cap across distinct populated bands', async () => {
    const farther = Array.from({ length: 10 }, (_, i) => {
      const bytes = Buffer.from(hash, 'hex');
      const survivingBands = [i % bytes.length, (i + 1) % bytes.length];
      for (let band = 0; band < bytes.length; band += 1)
        if (!survivingBands.includes(band)) bytes[band]! ^= 1;
      const recompressionHash = bytes.toString('hex');
      track(recompressionHash);
      return candidate(`farther-${i}`, {
        recompressionHash,
        publishedAtMs: now - 10_000 + i,
        eventTimestampMs: now - 10_000 + i,
      });
    });
    for (const row of farther) await index.remember(scope, row);
    const closest = candidate('closest');
    await index.remember(scope, closest);
    const selected = track();
    for (const key of selected)
      expect(JSON.parse((await inspector.get(key))!)).toContainEqual(closest);
    const expiries = await Promise.all(selected.map((key) => inspector.call('PEXPIRETIME', key)));
    const ranked = await index.read(scope, hash, now);
    expect(ranked).toEqual([closest, ...farther.slice(0, 7)]);
    expect(await index.read(scope, hash, now)).toEqual(ranked);
    expect(await Promise.all(selected.map((key) => inspector.call('PEXPIRETIME', key)))).toEqual(
      expiries,
    );
    for (const key of selected) {
      const raw = (await inspector.get(key))!;
      expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(8192);
      expect(JSON.parse(raw).length).toBeLessThanOrEqual(8);
    }
  });

  it('breaks equally close candidate ties by publication, event and exact raster identity', async () => {
    const earlierEvent = candidate('earlier-event', {
      publishedAtMs: now - 2000,
      eventTimestampMs: now - 1500,
    });
    const laterEvent = candidate('later-event', {
      publishedAtMs: now - 2000,
      eventTimestampMs: now - 1000,
    });
    const laterPublication = candidate('later-publication', {
      publishedAtMs: now - 1500,
      eventTimestampMs: now - 1500,
    });
    const lowerRaster = candidate('lower-raster', { canonicalHash: '1'.repeat(64) });
    const higherRaster = candidate('higher-raster', { canonicalHash: 'f'.repeat(64) });
    const expected = [earlierEvent, laterEvent, laterPublication, lowerRaster, higherRaster];
    for (const row of [...expected].reverse()) await index.remember(scope, row);
    expect(await index.read(scope, hash, now)).toEqual(expected);
    expect(await index.read(scope, hash, now)).toEqual(expected);
  });

  it('isolates every opaque author/chat/settings/control/window scope', async () => {
    await index.remember(scope, candidate('original'));
    const otherScope = digest(randomUUID());
    track(hash, otherScope);
    expect(await index.read(otherScope, hash, now)).toEqual([]);
  });

  it('replaces a stale source pointer only with a newer exact canonical source after lifecycle recovery', async () => {
    const original = candidate('original');
    const replacement = candidate('replacement', {
      canonicalHash: original.canonicalHash,
      publishedAtMs: now - 500,
      eventTimestampMs: now - 500,
      expiresAtMs: now + 120_000,
    });
    await index.remember(scope, original);
    await index.remember(scope, replacement);
    expect(await index.read(scope, hash, now)).toEqual([replacement]);
    await index.remember(scope, original);
    expect(await index.read(scope, hash, now)).toEqual([replacement]);
    for (const key of track())
      expect(JSON.parse((await inspector.get(key))!)).toEqual([replacement]);
  });

  it('prefers a newer source event before publication time and uses publication time to break equal events', async () => {
    const original = candidate('original', {
      eventTimestampMs: now - 200,
      publishedAtMs: now - 1000,
    });
    const olderEvent = candidate('older-event', {
      canonicalHash: original.canonicalHash,
      eventTimestampMs: now - 500,
      publishedAtMs: now - 600,
    });
    const newerPublication = candidate('newer-publication', {
      canonicalHash: original.canonicalHash,
      eventTimestampMs: original.eventTimestampMs,
      publishedAtMs: now - 500,
    });
    await index.remember(scope, original);
    await index.remember(scope, olderEvent);
    expect(await index.read(scope, hash, now)).toEqual([original]);
    await index.remember(scope, newerPublication);
    expect(await index.read(scope, hash, now)).toEqual([newerPublication]);
  });

  it('retains distinct exact canonical originals even when all perceptual bands match', async () => {
    const original = candidate('original');
    const differentRaster = candidate('different-raster', {
      eventTimestampMs: now - 500,
      publishedAtMs: now - 500,
    });
    await index.remember(scope, original);
    await index.remember(scope, differentRaster);
    expect(await index.read(scope, hash, now)).toEqual([original, differentRaster]);
  });

  it('preserves same-delivery expiry and metadata when a replay requests different publication time', async () => {
    const original = candidate('original');
    await index.remember(scope, original);
    await index.remember(scope, {
      ...original,
      eventTimestampMs: now - 500,
      publishedAtMs: now - 500,
      expiresAtMs: now + 120_000,
    });
    expect(await index.read(scope, hash, now)).toEqual([original]);
    const shorter = { ...original, expiresAtMs: now + 30_000 };
    await index.remember(scope, shorter);
    expect(await index.read(scope, hash, now)).toEqual([shorter]);
    for (const key of track())
      expect(Number(await inspector.call('PEXPIRETIME', key))).toBe(shorter.expiresAtMs);
  });

  it('preserves the earliest absolute expiry across concurrent replay attempts', async () => {
    const original = candidate('original');
    await index.remember(scope, original);
    await Promise.all(
      Array.from({ length: 12 }, () =>
        index.remember(scope, { ...original, expiresAtMs: now + 120_000 }),
      ),
    );
    expect(await index.read(scope, hash, now)).toEqual([original]);
    for (const key of track())
      expect(Number(await inspector.call('PEXPIRETIME', key))).toBe(original.expiresAtMs);
  });

  it('clamps retention to both publication and the independent Redis clock', async () => {
    const original = candidate('original', {
      expiresAtMs: now + MAX_RETENTION_MS * 3,
    });
    await index.remember(scope, original);
    const [saved] = await index.read(scope, hash, now);
    expect(saved?.expiresAtMs).toBe(original.publishedAtMs + MAX_RETENTION_MS);
    const futureHash = 'aabbccddeeff0099';
    track(futureHash);
    const future = candidate('future', {
      recompressionHash: futureHash,
      publishedAtMs: now + 60_000,
      eventTimestampMs: now + 60_000,
      expiresAtMs: now + MAX_RETENTION_MS * 3,
    });
    await index.remember(scope, future);
    const clock = await inspector.time();
    const redisNow = Number(clock[0]) * 1000 + Math.floor(Number(clock[1]) / 1000);
    const [savedFuture] = await index.read(scope, futureHash, now + 60_000);
    expect(savedFuture?.expiresAtMs).toBeLessThanOrEqual(redisNow + MAX_RETENTION_MS);
    expect(await index.read(scope, futureHash, now)).toEqual([]);
  });

  it('physically prunes expired rows using Redis time even when event time is old', async () => {
    const expired = candidate('expired', {
      publishedAtMs: now - 2000,
      eventTimestampMs: now - 2000,
      expiresAtMs: now - 1000,
    });
    const live = candidate('live');
    for (const key of track())
      await inspector.set(key, JSON.stringify([expired, live]), 'PX', 60_000);
    expect(await index.read(scope, hash, now)).toEqual([live]);
    for (const key of track()) expect(JSON.parse((await inspector.get(key))!)).toEqual([live]);
    await index.remember(scope, expired);
    expect(await index.read(scope, hash, now)).toEqual([live]);
  });

  it('excludes candidates at their event-time expiry without discarding a still-live anchor', async () => {
    const original = candidate('original');
    await index.remember(scope, original);
    expect(await index.read(scope, hash, original.expiresAtMs - 1)).toEqual([original]);
    expect(await index.read(scope, hash, original.expiresAtMs)).toEqual([]);
    expect(await index.read(scope, hash, now)).toEqual([original]);
  });

  it('never persists a future publication beyond the Redis retention ceiling', async () => {
    const future = candidate('far-future', {
      publishedAtMs: now + MAX_RETENTION_MS * 2,
      eventTimestampMs: now + MAX_RETENTION_MS * 2,
      expiresAtMs: now + MAX_RETENTION_MS * 3,
    });
    await index.remember(scope, future);
    expect(await index.read(scope, hash, future.eventTimestampMs)).toEqual([]);
    expect(await inspector.exists(...track())).toBe(0);
  });

  it('rejects a valid-looking pointer transplanted into unrelated hash bands', async () => {
    const unrelated = candidate('unrelated', { recompressionHash: 'ffeeddccbbaa9900' });
    for (const key of track()) await inspector.set(key, JSON.stringify([unrelated]), 'PX', 60_000);
    await expect(index.read(scope, hash, now)).rejects.toThrow(
      'Invalid recompression index candidate',
    );
  });

  it('bounds collision buckets and returns eight unique earliest equally close candidates', async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      candidate(`original-${i}`, {
        publishedAtMs: now - 10_000 + i,
        eventTimestampMs: now - 10_000 + i,
      }),
    );
    await Promise.all([...rows].reverse().map((row) => index.remember(scope, row)));
    expect(await index.read(scope, hash, now)).toEqual(rows.slice(0, 8));
    for (const key of track()) {
      const raw = (await inspector.get(key))!;
      expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(8192);
      expect(JSON.parse(raw)).toHaveLength(8);
    }
  });

  it.each(['invalid-json', 'oversized', 'wrong-type', 'missing-source'] as const)(
    'refuses %s without partial pruning or candidate writes',
    async (kind) => {
      const original = candidate('original');
      await index.remember(scope, original);
      const selected = track();
      const untouched = (await inspector.get(selected[0]!))!;
      const broken = selected.at(-1)!;
      await inspector.del(broken);
      if (kind === 'wrong-type') await inspector.lpush(broken, 'not-a-bucket');
      else
        await inspector.set(
          broken,
          kind === 'invalid-json'
            ? '['
            : kind === 'oversized'
              ? ' '.repeat(8193)
              : JSON.stringify([{ ...original, webhookEventId: '' }]),
          'PX',
          60_000,
        );
      await expect(index.read(scope, hash, now)).rejects.toThrow();
      await expect(index.remember(scope, candidate('another'))).rejects.toThrow();
      expect(await inspector.get(selected[0]!)).toBe(untouched);
    },
  );

  it('rejects late admission before touching existing buckets', async () => {
    await index.remember(scope, candidate('original'));
    const selected = track();
    const previous = await Promise.all(selected.map((key) => inspector.get(key)));
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now - 1000);
    try {
      await expect(index.remember(scope, candidate('late'))).rejects.toThrow(
        'Recompression index deadline exceeded',
      );
    } finally {
      clock.mockRestore();
    }
    expect(await Promise.all(selected.map((key) => inspector.get(key)))).toEqual(previous);
  });
});
