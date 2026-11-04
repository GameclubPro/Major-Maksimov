import {
  safetyDeskOverviewResponseSchema,
  type SafetyDeskOverviewResponse,
} from '@maxim/contracts/safety-desk';

export function overviewFixture(now = Date.now()): SafetyDeskOverviewResponse {
  const at = new Date(now).toISOString();
  const observed = <T>(value: T) => ({ availability: 'FRESH' as const, observedAt: at, value });
  const latency = { sampleCount: 13, p50Ms: 250, p95Ms: 800, p99Ms: 1200 };
  const pending = {
    countLowerBound: 0,
    sampleComplete: true,
    oldestAgeMs: null,
    ageBasis: 'receipt_created' as const,
  };
  const unfinished = { ...pending, ageBasis: 'state_updated_sample' as const };
  const bot = (botId: string, label: string) => ({
    botId,
    label,
    kind: 'moderator' as const,
    state: 'active' as const,
    subscription: observed({ configured: true, subscribed: true, lastIncomingAt: at }),
    publisher: null,
    pendingReceipts: observed(pending),
    unfinishedActions: observed(unfinished),
    actionLatency: observed(latency),
    lastTerminalAt: observed({ at }),
    outcomes: observed([
      { outcome: 'SUCCEEDED', count: 10 },
      { outcome: 'AMBIGUOUS', count: 2 },
      { outcome: 'FAILED_TERMINAL', count: 1 },
    ]),
  });
  return safetyDeskOverviewResponseSchema.parse({
    schemaVersion: 1,
    generatedAt: at,
    collector: { availability: 'FRESH', observedAt: at, lastSuccessfulAt: at },
    queues: observed({
      rows: [
        {
          name: 'moderation-default-0',
          family: 'webhook',
          waiting: 24,
          prioritized: 4,
          active: 3,
          delayed: 8,
          failed: 1234,
          completed: 40000,
        },
        {
          name: 'action-send',
          family: 'actions',
          waiting: 8,
          prioritized: 2,
          active: 1,
          delayed: 3,
          failed: 5,
          completed: 8000,
        },
        {
          name: 'photo-analysis',
          family: 'auxiliary',
          waiting: 0,
          prioritized: 0,
          active: 1,
          delayed: 0,
          failed: 0,
          completed: 23,
        },
      ],
    }),
    receipts: observed({
      ...pending,
      countLowerBound: 64,
      sampleComplete: false,
      oldestAgeMs: 45_000,
    }),
    unfinishedActions: observed({ ...unfinished, countLowerBound: 3, oldestAgeMs: 120_000 }),
    actions: observed({
      windowSec: 900,
      windowStartedAt: new Date(now - 900_000).toISOString(),
      windowEndedAt: at,
      sampleCount: 13,
      sampleComplete: true,
      latency,
      outcomes: [
        { outcome: 'SUCCEEDED', count: 10 },
        { outcome: 'AMBIGUOUS', count: 2 },
        { outcome: 'FAILED_TERMINAL', count: 1 },
      ],
    }),
    workers: observed({
      expectedCount: 2,
      freshCount: 2,
      rows: [
        { service: 'api-action', observedAt: at },
        { service: 'api-enqueue', observedAt: at },
      ],
    }),
    bots: [
      bot('major-1', 'Майор'),
      {
        ...bot('major-2', 'Майор 2'),
        pendingReceipts: observed({
          ...pending,
          countLowerBound: 64,
          sampleComplete: false,
          oldestAgeMs: 45_000,
        }),
        unfinishedActions: observed({ ...unfinished, countLowerBound: 3, oldestAgeMs: 120_000 }),
      },
      {
        ...bot('publisher', 'Публик'),
        kind: 'publisher',
        publisher: observed({ dispatchEnabled: false, blocker: 'global_paused' }),
      },
    ],
    history: {
      availability: 'FRESH',
      observedAt: at,
      windowSec: 86400,
      bucketSec: 60,
      retentionPoints: 1440,
      points: Array.from({ length: 8 }, (_, index) => ({
        at: new Date(Math.floor(now / 60_000) * 60_000 - (7 - index) * 60_000).toISOString(),
        waiting: index === 3 ? null : 34 - index,
        active: index === 3 ? null : 5,
        delayed: index === 3 ? null : 11,
        oldestReceiptAgeMs: index === 3 ? null : 45000,
        oldestActionAgeMs: index === 3 ? null : 120000,
        p50Ms: index === 3 ? null : 250,
        p95Ms: index === 3 ? null : 800 + index * 50,
        p99Ms: index === 3 ? null : 1200 + index * 50,
      })),
    },
  });
}

export function overviewTimingGapFixture(now = Date.now()): SafetyDeskOverviewResponse {
  const snapshot = overviewFixture(now);
  const bot = snapshot.bots[0]!;
  snapshot.bots = [bot];
  snapshot.receipts.value = { ...bot.pendingReceipts.value! };
  snapshot.unfinishedActions.value = { ...bot.unfinishedActions.value! };
  bot.outcomes.value = [{ outcome: 'SUCCEEDED', count: 7 }];
  bot.actionLatency.value = { ...bot.actionLatency.value!, sampleCount: 2 };
  snapshot.actions.value = {
    ...snapshot.actions.value!,
    sampleCount: 7,
    outcomes: [{ outcome: 'SUCCEEDED', count: 7 }],
    latency: { ...snapshot.actions.value!.latency, sampleCount: 2 },
  };
  return safetyDeskOverviewResponseSchema.parse(snapshot);
}
