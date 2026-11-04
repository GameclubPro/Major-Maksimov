const DEFAULT_NOW = Date.parse('2026-11-04T06:00:00.000Z');

function merge(base, overrides) {
  if (
    base === null ||
    overrides === null ||
    typeof base !== 'object' ||
    typeof overrides !== 'object' ||
    Array.isArray(base) ||
    Array.isArray(overrides)
  )
    return structuredClone(overrides);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overrides))
    result[key] = Object.hasOwn(base, key) ? merge(base[key], value) : structuredClone(value);
  return result;
}

/** Full public contract fixture. Object overrides merge; arrays replace their field. */
export function makeObserverSnapshot(now = DEFAULT_NOW, overrides = {}) {
  const timestamp = new Date(now).toISOString();
  const observation = (value) => ({ availability: 'FRESH', observedAt: timestamp, value });
  const pending = (ageBasis) => ({
    countLowerBound: 0,
    sampleComplete: true,
    oldestAgeMs: null,
    ageBasis,
  });
  const percentiles = () => ({ sampleCount: 0, p50Ms: null, p95Ms: null, p99Ms: null });
  const bot = (botId, kind, state) => ({
    botId,
    label: botId,
    kind,
    state,
    subscription:
      kind === 'moderator'
        ? observation({ configured: true, subscribed: true, lastIncomingAt: null })
        : { availability: 'UNAVAILABLE', observedAt: null, value: null },
    publisher: kind === 'publisher' ? observation({ dispatchEnabled: true, blocker: null }) : null,
    pendingReceipts: observation(pending('receipt_created')),
    actionLatency: observation(percentiles()),
    unfinishedActions: observation(pending('state_updated_sample')),
    lastTerminalAt: observation({ at: null }),
    outcomes: observation([]),
  });
  return merge(
    {
      schemaVersion: 1,
      generatedAt: timestamp,
      collector: { availability: 'FRESH', observedAt: timestamp, lastSuccessfulAt: timestamp },
      queues: observation({
        rows: [
          {
            name: 'webhook-fixture',
            family: 'webhook',
            waiting: 0,
            prioritized: 0,
            active: 0,
            delayed: 0,
            failed: 0,
            completed: 0,
          },
        ],
      }),
      receipts: observation(pending('receipt_created')),
      unfinishedActions: observation(pending('state_updated_sample')),
      actions: observation({
        windowSec: 900,
        windowStartedAt: new Date(now - 900000).toISOString(),
        windowEndedAt: timestamp,
        sampleCount: 0,
        sampleComplete: true,
        latency: percentiles(),
        outcomes: [],
      }),
      workers: observation({
        expectedCount: 2,
        freshCount: 2,
        rows: [
          { service: 'api-webhook', observedAt: timestamp },
          { service: 'api-actions', observedAt: timestamp },
        ],
      }),
      bots: [
        bot('fixture-moderator-active', 'moderator', 'active'),
        bot('fixture-moderator-draining', 'moderator', 'draining'),
        bot('fixture-publisher', 'publisher', 'configured'),
      ],
      history: {
        availability: 'UNAVAILABLE',
        observedAt: null,
        windowSec: 86400,
        bucketSec: 60,
        retentionPoints: 1440,
        points: [],
      },
    },
    overrides,
  );
}
