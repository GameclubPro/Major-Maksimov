import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { performance } from 'node:perf_hooks';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { maxApiMinuteCounterAddress } from '../max/max-api-counter-storage';
import {
  MAX_API_SOURCE_DIMENSION_BOOTSTRAP_COMPLETE_KEY,
  MAX_API_SOURCE_DIMENSION_CATALOG_KEY,
  parseMaxApiSourceMetricDimension,
  buildMaxApiSourceMetricKey,
  type MaxApiSourceMetricDimension,
} from '../max/max-api-metrics-key.util';

const CLASSES = ['critical', 'interactive', 'background'] as const;
const SOURCES = new Set<string>(Object.values(MAX_API_SOURCE_TAGS));
const MAX_DIMENSIONS = 512;
const MAX_BOTS = 32;
const MAX_COUNTERS_PER_SLICE = 120_000;
const SLICE_SECONDS = 60;
const COUNTER_BATCH = 200;
const DEADLINE_MS = 8_000;

// FLAG: This reader never bootstraps or scans the keyspace. The cardinality,
// member bytes and completion marker are checked atomically before returning data.
const READ_CATALOG = `
local markerType = redis.call('TYPE', KEYS[1]).ok
if markerType == 'none' then return {'catalog_unavailable'} end
if markerType ~= 'string' or redis.call('STRLEN', KEYS[1]) ~= 1 then
  return {'catalog_invalid'}
end
if redis.call('GET', KEYS[1]) ~= '1' then return {'catalog_unavailable'} end
local count = redis.call('SCARD', KEYS[2])
if count > 512 then return {'catalog_limit'} end
local bytes = redis.call('MEMORY', 'USAGE', KEYS[2], 'SAMPLES', 0) or 0
if bytes > 262144 then return {'catalog_limit'} end
local members = redis.call('SMEMBERS', KEYS[2])
for _, value in ipairs(members) do
  if string.len(value) > 256 then return {'catalog_invalid'} end
end
return {'ok', unpack(members)}
`;

// FLAG: Only observational legacy strings and requested minute fields are read.
// Missing counters remain zero-or-missing evidence, never proof of idle traffic.
const READ_COUNTERS = `
local function counter(key, field)
  local kind = redis.call('TYPE', key).ok
  if kind == 'none' then return 0, 0 end
  local value
  if field == '' then
    if kind ~= 'string' or redis.call('STRLEN', key) > 16 then
      error('baseline_counter_invalid', 0)
    end
    value = redis.call('GET', key)
  else
    if kind ~= 'hash' or redis.call('HSTRLEN', key, field) > 16 then
      error('baseline_counter_invalid', 0)
    end
    value = redis.call('HGET', key, field)
  end
  if not value then return 0, 0 end
  if not string.match(value, '^%d+$') then
    error('baseline_counter_invalid', 0)
  end
  local number = tonumber(value)
  if not number or number > 9007199254740991 then
    error('baseline_counter_invalid', 0)
  end
  return number, 1
end
local result = {}
for index = 1, #ARGV do
  local legacy, legacyPresent = counter(KEYS[index * 2 - 1], '')
  local minute, minutePresent = counter(KEYS[index * 2], ARGV[index])
  local sum = legacy + minute
  if sum > 9007199254740991 then error('baseline_counter_invalid', 0) end
  result[#result + 1] = sum
  result[#result + 1] = legacyPresent + minutePresent
end
return result
`;

type Traffic = Record<(typeof CLASSES)[number], number>;
type Bucket = {
  admitted: number;
  classes: Traffic;
  internalLimiterRejects: Traffic;
  external429: Traffic;
  sources: Record<string, Traffic>;
};
type Counter = { key: string; add: (count: number) => void };

function bucket(): Bucket {
  const traffic = (): Traffic => ({ critical: 0, interactive: 0, background: 0 });
  return {
    admitted: 0,
    classes: traffic(),
    internalLimiterRejects: traffic(),
    external429: traffic(),
    sources: {},
  };
}

function addCounter(value: number, count: number): number {
  const sum = value + count;
  if (!Number.isSafeInteger(sum)) throw new Error('counter_overflow');
  return sum;
}

function unavailable(code: string, observedAt: number) {
  return { schemaVersion: 1 as const, available: false as const, observedAt, code };
}

export async function readMaxApiBaseline(
  redis: Pick<Redis, 'call'>,
  options: { botIds: readonly string[]; windowSec?: number; untilMs?: number },
) {
  const observedAt = Date.now();
  const deadline = performance.now() + DEADLINE_MS;
  const windowSec = options.windowSec ?? 60;
  const untilMs = options.untilMs ?? Math.floor((observedAt - 30_000) / 60_000) * 60_000;
  const botIds = [...new Set(options.botIds)].sort();
  if (
    ![60, 120, 300].includes(windowSec) ||
    !Number.isSafeInteger(untilMs) ||
    untilMs % 60_000 !== 0 ||
    untilMs > observedAt - 30_000 ||
    untilMs - windowSec * 1_000 < observedAt - (6 * 3_600 - 60) * 1_000 ||
    !botIds.length ||
    botIds.length > MAX_BOTS ||
    botIds.some((id) => id === 'stack' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id))
  )
    return unavailable('invalid_scope', observedAt);

  try {
    const catalog = await redis.call(
      'EVAL_RO',
      READ_CATALOG,
      2,
      MAX_API_SOURCE_DIMENSION_BOOTSTRAP_COMPLETE_KEY,
      MAX_API_SOURCE_DIMENSION_CATALOG_KEY,
    );
    if (!Array.isArray(catalog) || catalog[0] !== 'ok')
      return unavailable(
        Array.isArray(catalog) &&
          ['catalog_unavailable', 'catalog_limit', 'catalog_invalid'].includes(String(catalog[0]))
          ? String(catalog[0])
          : 'catalog_invalid',
        observedAt,
      );
    if (catalog.length > MAX_DIMENSIONS + 1) return unavailable('catalog_limit', observedAt);
    const dimensions: MaxApiSourceMetricDimension[] = [];
    const seen = new Set<string>();
    let excludedDimensions = 0;
    for (const raw of catalog.slice(1)) {
      const dimension = typeof raw === 'string' ? parseMaxApiSourceMetricDimension(raw) : null;
      if (
        !dimension ||
        !/^[a-zA-Z0-9_-]{1,128}$/u.test(dimension.botId) ||
        !/^[a-z0-9_-]{1,64}$/u.test(dimension.sourceTag)
      )
        return unavailable('catalog_invalid', observedAt);
      const identity = JSON.stringify([
        dimension.botId,
        dimension.trafficClass,
        dimension.sourceTag,
      ]);
      if (seen.has(identity)) return unavailable('catalog_invalid', observedAt);
      seen.add(identity);
      if (botIds.includes(dimension.botId)) dimensions.push(dimension);
      else excludedDimensions++;
    }
    const expectedCounters = (10 * (botIds.length + 1) + dimensions.length) * windowSec;
    if ((expectedCounters / windowSec) * SLICE_SECONDS > MAX_COUNTERS_PER_SLICE)
      return unavailable('counter_limit', observedAt);
    const stack = bucket();
    const bots = new Map(botIds.map((id) => [id, bucket()]));
    const fromSec = untilMs / 1_000 - windowSec;
    const targets = [['stack', stack] as const, ...bots];
    // FLAG: Generate one bounded Redis batch at a time; retained fleet dimensions
    // must not allocate a closure for every second of the complete window.
    function* countersForSlice(start: number, end: number): Generator<Counter> {
      for (let sec = start; sec < end; sec++) {
        for (const [id, target] of targets) {
          const prefix = id === 'stack' ? 'maxapi:rps:stack' : `maxapi:rps:global:${id}`;
          yield {
            key: `${prefix}:${sec}`,
            add: (n) => (target.admitted = addCounter(target.admitted, n)),
          };
          for (const trafficClass of CLASSES) {
            yield {
              key: `${prefix}:${trafficClass}:${sec}`,
              add: (n) =>
                (target.classes[trafficClass] = addCounter(target.classes[trafficClass], n)),
            };
            for (const [origin, counts] of [
              ['internal_limiter', target.internalLimiterRejects],
              ['external_429', target.external429],
            ] as const)
              yield {
                key: `maxapi:rate-limit:v1:${origin}:${id}:${trafficClass}:${sec}`,
                add: (n) => (counts[trafficClass] = addCounter(counts[trafficClass], n)),
              };
          }
        }
        for (const dimension of dimensions) {
          const target = bots.get(dimension.botId)!;
          const source = SOURCES.has(dimension.sourceTag) ? dimension.sourceTag : 'other';
          const counts = (target.sources[source] ??= {
            critical: 0,
            interactive: 0,
            background: 0,
          });
          yield {
            key: buildMaxApiSourceMetricKey({ ...dimension, sec }),
            add: (n) =>
              (counts[dimension.trafficClass] = addCounter(counts[dimension.trafficClass], n)),
          };
        }
      }
    }
    let countersPresent = 0;
    let countersRead = 0;
    let slicesRead = 0;
    const readBatch = async (batch: Counter[]): Promise<string | null> => {
      if (performance.now() >= deadline) return 'deadline';
      const addresses = batch.map(({ key }) => maxApiMinuteCounterAddress(key));
      const values = await redis.call(
        'EVAL_RO',
        READ_COUNTERS,
        batch.length * 2,
        ...batch.flatMap(({ key }, index) => [key, addresses[index]!.key]),
        ...addresses.map(({ field }) => field),
      );
      if (!Array.isArray(values) || values.length !== batch.length * 2) return 'counter_invalid';
      for (let index = 0; index < batch.length; index++) {
        const count = values[index * 2];
        const present = values[index * 2 + 1];
        if (
          !Number.isSafeInteger(count) ||
          Number(count) < 0 ||
          ![0, 1, 2].includes(Number(present))
        )
          return 'counter_invalid';
        batch[index]!.add(Number(count));
        if (Number(present) > 0) countersPresent++;
      }
      countersRead += batch.length;
      return null;
    };
    for (let start = fromSec; start < untilMs / 1_000; start += SLICE_SECONDS) {
      let batch: Counter[] = [];
      for (const counter of countersForSlice(
        start,
        Math.min(start + SLICE_SECONDS, untilMs / 1_000),
      )) {
        batch.push(counter);
        if (batch.length < COUNTER_BATCH) continue;
        const failure = await readBatch(batch);
        if (failure) return unavailable(failure, observedAt);
        batch = [];
      }
      if (batch.length) {
        const failure = await readBatch(batch);
        if (failure) return unavailable(failure, observedAt);
      }
      slicesRead++;
    }
    if (performance.now() >= deadline) return unavailable('deadline', observedAt);
    // FLAG: A changed source catalog is incomplete evidence even if every original
    // counter was read. Recheck the bounded catalog without scans or repair writes.
    const finalCatalog = await redis.call(
      'EVAL_RO',
      READ_CATALOG,
      2,
      MAX_API_SOURCE_DIMENSION_BOOTSTRAP_COMPLETE_KEY,
      MAX_API_SOURCE_DIMENSION_CATALOG_KEY,
    );
    const catalogIdentity = JSON.stringify(catalog.slice(1).sort());
    if (
      !Array.isArray(finalCatalog) ||
      finalCatalog[0] !== 'ok' ||
      JSON.stringify(finalCatalog.slice(1).sort()) !== catalogIdentity
    )
      return unavailable('catalog_changed', observedAt);
    if (performance.now() >= deadline) return unavailable('deadline', observedAt);
    // FLAG: Aliases only identify this exact configured catalog. They are not MAX
    // identities or proof that every HTTP call/effect was observed by diagnostics.
    return {
      schemaVersion: 1 as const,
      available: true as const,
      observedAt,
      from: new Date(fromSec * 1_000).toISOString(),
      until: new Date(untilMs).toISOString(),
      windowSec,
      basis: 'recorded_admissions_and_limiter_outcomes' as const,
      populationComplete: false,
      catalogFingerprint: createHash('sha256').update(JSON.stringify(botIds)).digest('hex'),
      catalogDimensions: catalog.length - 1,
      excludedDimensions,
      collectionComplete: true,
      sourceCatalogFingerprint: createHash('sha256').update(catalogIdentity).digest('hex'),
      slicesRead,
      countersRead,
      countersPresent,
      zeroOrMissingCounters: countersRead - countersPresent,
      stack,
      bots: botIds.map((id, index) => ({ alias: `token_${index + 1}`, ...bots.get(id)! })),
    };
  } catch {
    return unavailable('read_failed', observedAt);
  }
}
