import { WebhookSloService } from './webhook-slo.service';
import type {
  WebhookIngressMetricsSnapshot,
  WebhookRouteMetrics,
  WebhookRouteOutcomeCounts,
} from './webhook-ingress-metrics.service';

const SERVICE_ROUTE_FAILURE_OUTCOMES = [
  'admission_rejected',
  'invalid_json',
  'invalid_payload',
  'payload_too_large',
  'timed_out',
  'failed',
] as const;

function createRouteMetrics(
  outcomeOverrides: Partial<WebhookRouteOutcomeCounts> = {},
): WebhookRouteMetrics {
  const outcomes: WebhookRouteOutcomeCounts = {
    accepted: 0,
    authentication_rejected: 0,
    admission_rejected: 0,
    invalid_json: 0,
    invalid_payload: 0,
    payload_too_large: 0,
    timed_out: 0,
    failed: 0,
    ...outcomeOverrides,
  };
  return {
    attemptedRequests: Object.values(outcomes).reduce((sum, count) => sum + count, 0),
    outcomes,
    bots: {},
  };
}

function createHealthyIngress(
  overrides: Partial<WebhookIngressMetricsSnapshot> = {},
): WebhookIngressMetricsSnapshot {
  return {
    available: true,
    targetMs: 2_000,
    attemptedReceipts: 0,
    persistedReceipts: 0,
    failedReceipts: 0,
    rejectedReceipts: 0,
    sampledReceipts: 0,
    p95LatencyMs: null,
    p99LatencyMs: null,
    underTargetRatio: null,
    bots: {},
    route: createRouteMetrics(),
    membershipCache: {
      precheck: {
        hit: 0,
        miss: 0,
        failOpen: 0,
        timing: { sampled: 0, p95DurationMs: null, p99DurationMs: null, overflowSamples: 0 },
      },
      lua: {
        applied: 0,
        superseded: 0,
        conflict: 0,
        retry: 0,
        exhausted: 0,
        failed: 0,
        timing: { sampled: 0, p95DurationMs: null, p99DurationMs: null, overflowSamples: 0 },
      },
      budget: {
        completed: 0,
        timeout: 0,
        timing: { sampled: 0, p95DurationMs: null, p99DurationMs: null, overflowSamples: 0 },
      },
      detached: {
        completed: 0,
        timeout: 0,
        failure: 0,
        peakInFlight: 0,
        rejected: 0,
      },
    },
    membershipTransition: {
      edgeAdvance: {
        calls: 0,
        affectedRows: 0,
        noOpCalls: 0,
        timing: { sampled: 0, p95DurationMs: null, p99DurationMs: null, overflowSamples: 0 },
      },
    },
    ...overrides,
  };
}

function createConfig(overrides: Record<string, unknown> = {}) {
  return {
    get: jest.fn((key: string) => overrides[key]),
  };
}

describe('WebhookSloService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(
    ['RECEIVED', 'QUEUED'].flatMap((status) =>
      [14, 16, 40, 24 * 60].map((ageMinutes) => ({ status, ageMinutes })),
    ),
  )(
    'retains $status backlog aged $ageMinutes minutes outside the SLO window',
    async ({ status, ageMinutes }) => {
      const now = new Date('2026-09-26T12:00:00Z');
      jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
      const event = {
        id: 'old-event',
        createdAt: new Date(now.getTime() - ageMinutes * 60_000),
        // A retried RECEIVED event may retain evidence of its previous enqueue.
        queuedAt: new Date(now.getTime() - ageMinutes * 60_000 + 100),
      };
      const prisma = {
        $transaction: jest.fn((queries: Array<Promise<unknown>>) => Promise.all(queries)),
        webhookEvent: {
          count: jest.fn().mockResolvedValue(0),
          findMany: jest.fn().mockResolvedValue([]),
          findFirst: jest.fn(async ({ where }) => {
            const statusMatches = where.status === status || where.status?.in?.includes(status);
            const insideWindow = !where.createdAt?.gte || event.createdAt >= where.createdAt.gte;
            return statusMatches && insideWindow && where.queuedAt !== null ? event : null;
          }),
        },
        webhookExecutionClaim: { count: jest.fn().mockResolvedValue(0) },
      };
      const snapshot = await new WebhookSloService(
        prisma as never,
        createConfig() as never,
      ).getSnapshot();
      expect(snapshot).toMatchObject({
        status: 'critical',
        oldestUnprocessedEventId: event.id,
        oldestUnprocessedLagSec: ageMinutes * 60,
        enqueue: {
          oldestPendingLagSec: status === 'RECEIVED' ? ageMinutes * 60 : 0,
        },
      });
      expect(prisma.webhookEvent.findFirst).toHaveBeenCalledWith({
        where: { status },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
    },
  );

  it('computes webhook processing SLO from recent events', async () => {
    const now = new Date('2026-04-29T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    const prisma = {
      $transaction: jest.fn((queries: Array<Promise<unknown>>) => Promise.all(queries)),
      webhookEvent: {
        count: jest
          .fn()
          .mockResolvedValueOnce(10)
          .mockResolvedValueOnce(8)
          .mockResolvedValueOnce(1),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              createdAt: new Date('2026-04-29T11:59:58.000Z'),
              processedAt: new Date('2026-04-29T11:59:58.300Z'),
            },
            {
              createdAt: new Date('2026-04-29T11:59:57.000Z'),
              processedAt: new Date('2026-04-29T11:59:59.400Z'),
            },
            {
              createdAt: new Date('2026-04-29T11:59:56.000Z'),
              processedAt: new Date('2026-04-29T11:59:56.800Z'),
            },
          ])
          .mockResolvedValueOnce([
            {
              createdAt: new Date('2026-04-29T11:59:58.000Z'),
              queuedAt: new Date('2026-04-29T11:59:58.120Z'),
            },
            {
              createdAt: new Date('2026-04-29T11:59:57.000Z'),
              queuedAt: new Date('2026-04-29T11:59:58.600Z'),
            },
            {
              createdAt: new Date('2026-04-29T11:59:56.000Z'),
              queuedAt: new Date('2026-04-29T11:59:55.900Z'),
            },
          ]),
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'evt-pending-enqueue',
            createdAt: new Date('2026-04-29T11:59:52.000Z'),
          })
          .mockResolvedValueOnce({
            id: 'evt-old',
            createdAt: new Date('2026-04-29T11:59:50.000Z'),
          })
          .mockResolvedValueOnce({
            processedAt: new Date('2026-04-29T11:59:59.400Z'),
          })
          .mockResolvedValueOnce({
            queuedAt: new Date('2026-04-29T11:59:58.600Z'),
          }),
      },
      webhookExecutionClaim: {
        count: jest.fn().mockResolvedValue(4),
      },
    };
    const ingress = {
      available: true,
      targetMs: 2_000,
      attemptedReceipts: 11,
      persistedReceipts: 10,
      failedReceipts: 1,
      rejectedReceipts: 0,
      sampledReceipts: 10,
      p95LatencyMs: 1_500,
      p99LatencyMs: 2_000,
      underTargetRatio: 1,
      bots: {
        'bot-1': {
          attemptedReceipts: 11,
          persistedReceipts: 10,
          failedReceipts: 1,
          rejectedReceipts: 0,
        },
      },
    };
    const service = new WebhookSloService(
      prisma as never,
      createConfig({
        SYSTEM_WEBHOOK_SLO_WINDOW_SEC: 900,
        SYSTEM_WEBHOOK_SLO_TARGET_MS: 1000,
        SYSTEM_WEBHOOK_ENQUEUE_SLO_TARGET_MS: 500,
      }) as never,
      {
        getSnapshot: jest.fn().mockResolvedValue(ingress),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      status: 'critical',
      totalEvents: 10,
      processedEvents: 8,
      failedEvents: 1,
      sampleLimit: 5_000,
      sampledProcessedEvents: 3,
      processedSampleTruncated: false,
      processedSampledFrom: '2026-04-29T11:59:56.800Z',
      p95ProcessingMs: 2400,
      underTargetRatio: 0.667,
      oldestUnprocessedLagSec: 10,
      oldestUnprocessedEventId: 'evt-old',
      lastProcessedAt: '2026-04-29T11:59:59.400Z',
      ingress,
      enqueue: {
        targetMs: 500,
        sampledEvents: 3,
        sampleTruncated: false,
        sampledFrom: '2026-04-29T11:59:55.900Z',
        p95LatencyMs: 1600,
        p99LatencyMs: 1600,
        underTargetRatio: 0.5,
        oldestPendingLagSec: 8,
        oldestPendingEventId: 'evt-pending-enqueue',
        lastQueuedAt: '2026-04-29T11:59:58.600Z',
      },
      canonicalExecution: {
        receipts: 10,
        executionClaims: 4,
        claimsPerReceiptRatio: 0.4,
      },
      generatedAt: '2026-04-29T12:00:00.000Z',
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Array), {
      isolationLevel: 'RepeatableRead',
    });
    expect(prisma.webhookEvent.count).toHaveBeenNthCalledWith(1, {
      where: {
        createdAt: {
          gte: new Date('2026-04-29T11:45:00.000Z'),
          lte: now,
        },
      },
    });
    expect(prisma.webhookEvent.count).toHaveBeenNthCalledWith(2, {
      where: {
        createdAt: {
          gte: new Date('2026-04-29T11:45:00.000Z'),
          lte: now,
        },
        status: 'PROCESSED',
        processedAt: { not: null, lte: now },
      },
    });
    expect(prisma.webhookEvent.count).toHaveBeenNthCalledWith(3, {
      where: {
        createdAt: {
          gte: new Date('2026-04-29T11:45:00.000Z'),
          lte: now,
        },
        status: 'FAILED',
      },
    });
    expect(prisma.webhookEvent.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          createdAt: {
            gte: new Date('2026-04-29T11:45:00.000Z'),
            lte: now,
          },
          status: 'PROCESSED',
          processedAt: { not: null, lte: now },
        },
      }),
    );
    expect(prisma.webhookEvent.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          createdAt: {
            gte: new Date('2026-04-29T11:45:00.000Z'),
            lte: now,
          },
          queuedAt: { not: null, lte: now },
        },
      }),
    );
    expect(prisma.webhookEvent.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { status: 'RECEIVED' },
      }),
    );
    expect(prisma.webhookEvent.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { status: 'QUEUED' },
      }),
    );
    expect(prisma.webhookEvent.findFirst).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        where: {
          createdAt: {
            gte: new Date('2026-04-29T11:45:00.000Z'),
            lte: now,
          },
          status: 'PROCESSED',
          processedAt: { not: null, lte: now },
        },
      }),
    );
    expect(prisma.webhookEvent.findFirst).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        where: {
          createdAt: {
            gte: new Date('2026-04-29T11:45:00.000Z'),
            lte: now,
          },
          queuedAt: { not: null, lte: now },
        },
      }),
    );
    expect(prisma.webhookExecutionClaim.count).toHaveBeenCalledWith({
      where: {
        kind: 'EXECUTION',
        createdAt: {
          gte: new Date('2026-04-29T11:45:00.000Z'),
          lte: now,
        },
      },
    });
  });

  it('returns empty enqueue SLO fields when no recent event has been queued', async () => {
    const now = new Date('2026-04-29T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    const prisma = {
      $transaction: jest.fn((queries: Array<Promise<unknown>>) => Promise.all(queries)),
      webhookEvent: {
        count: jest.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(0),
        findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null),
      },
      webhookExecutionClaim: {
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = new WebhookSloService(
      prisma as never,
      createConfig({
        SYSTEM_WEBHOOK_SLO_WINDOW_SEC: 900,
      }) as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      status: 'healthy',
      sampleLimit: 5_000,
      sampledProcessedEvents: 0,
      processedSampleTruncated: false,
      processedSampledFrom: null,
      p95ProcessingMs: null,
      underTargetRatio: null,
      enqueue: {
        sampledEvents: 0,
        sampleTruncated: false,
        sampledFrom: null,
        p95LatencyMs: null,
        p99LatencyMs: null,
        underTargetRatio: null,
        oldestPendingLagSec: 0,
        oldestPendingEventId: null,
        lastQueuedAt: null,
      },
      ingress: {
        targetMs: 2_000,
        sampledReceipts: 0,
        failedReceipts: 0,
        rejectedReceipts: 0,
      },
      canonicalExecution: {
        receipts: 0,
        executionClaims: 0,
        claimsPerReceiptRatio: null,
      },
    });
  });

  it('caps the configured sample size before issuing database reads', async () => {
    const now = new Date('2026-04-29T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    const prisma = {
      $transaction: jest.fn((queries: Array<Promise<unknown>>) => Promise.all(queries)),
      webhookEvent: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      webhookExecutionClaim: {
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = new WebhookSloService(
      prisma as never,
      createConfig({
        SYSTEM_WEBHOOK_SLO_WINDOW_SEC: 900,
        SYSTEM_WEBHOOK_SLO_SAMPLE_LIMIT: 50_000,
      }) as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      sampleLimit: 5_000,
    });
    expect(prisma.webhookEvent.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ take: 5_001 }),
    );
    expect(prisma.webhookEvent.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ take: 5_001 }),
    );
  });

  it('reports sampled rows and truncation even when every duration has an inverted clock', async () => {
    const createdAt = new Date('2026-04-29T11:59:59.000Z');
    const before = new Date(createdAt.getTime() - 1);
    const prisma = {
      $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
      webhookEvent: {
        count: jest.fn().mockResolvedValue(2),
        findMany: jest
          .fn()
          .mockResolvedValueOnce(Array(2).fill({ createdAt, processedAt: before }))
          .mockResolvedValueOnce(Array(2).fill({ createdAt, queuedAt: before })),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      webhookExecutionClaim: { count: jest.fn().mockResolvedValue(0) },
    };
    const service = new WebhookSloService(
      prisma as never,
      createConfig({ SYSTEM_WEBHOOK_SLO_SAMPLE_LIMIT: 1 }) as never,
    );
    await expect(service.getSnapshot()).resolves.toMatchObject({
      sampledProcessedEvents: 1,
      processedSampleTruncated: true,
      processedSampledFrom: before.toISOString(),
      p95ProcessingMs: null,
      p99ProcessingMs: null,
      underTargetRatio: null,
      enqueue: {
        sampledEvents: 1,
        sampleTruncated: true,
        sampledFrom: before.toISOString(),
        p95LatencyMs: null,
        p99LatencyMs: null,
        underTargetRatio: null,
      },
    });
  });

  it('reports independently truncated processing and enqueue samples', async () => {
    const now = new Date('2026-04-29T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    const prisma = {
      $transaction: jest.fn((queries: Array<Promise<unknown>>) => Promise.all(queries)),
      webhookEvent: {
        count: jest.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(3).mockResolvedValueOnce(0),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              createdAt: new Date('2026-04-29T11:59:59.800Z'),
              processedAt: new Date('2026-04-29T11:59:59.900Z'),
            },
            {
              createdAt: new Date('2026-04-29T11:59:59.500Z'),
              processedAt: new Date('2026-04-29T11:59:59.700Z'),
            },
            {
              createdAt: new Date('2026-04-29T11:59:50.000Z'),
              processedAt: new Date('2026-04-29T11:59:59.600Z'),
            },
          ])
          .mockResolvedValueOnce([
            {
              createdAt: new Date('2026-04-29T11:59:59.900Z'),
              queuedAt: new Date('2026-04-29T11:59:59.950Z'),
            },
            {
              createdAt: new Date('2026-04-29T11:59:59.600Z'),
              queuedAt: new Date('2026-04-29T11:59:59.750Z'),
            },
            {
              createdAt: new Date('2026-04-29T11:59:50.000Z'),
              queuedAt: new Date('2026-04-29T11:59:59.650Z'),
            },
          ]),
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null),
      },
      webhookExecutionClaim: {
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = new WebhookSloService(
      prisma as never,
      createConfig({
        SYSTEM_WEBHOOK_SLO_WINDOW_SEC: 900,
        SYSTEM_WEBHOOK_SLO_SAMPLE_LIMIT: 2,
      }) as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      sampleLimit: 2,
      sampledProcessedEvents: 2,
      processedSampleTruncated: true,
      processedSampledFrom: '2026-04-29T11:59:59.700Z',
      p95ProcessingMs: 200,
      enqueue: {
        sampledEvents: 2,
        sampleTruncated: true,
        sampledFrom: '2026-04-29T11:59:59.750Z',
        p95LatencyMs: 150,
      },
    });
    expect(prisma.webhookEvent.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ take: 3 }),
    );
    expect(prisma.webhookEvent.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ take: 3 }),
    );
  });

  it('makes a slow ingress p99 critical even when downstream processing is empty', async () => {
    const now = new Date('2026-04-29T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    const prisma = {
      $transaction: jest.fn((queries: Array<Promise<unknown>>) => Promise.all(queries)),
      webhookEvent: {
        count: jest.fn().mockResolvedValueOnce(6).mockResolvedValueOnce(6).mockResolvedValueOnce(0),
        findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null),
      },
      webhookExecutionClaim: {
        count: jest.fn().mockResolvedValue(3),
      },
    };
    const service = new WebhookSloService(
      prisma as never,
      createConfig({ SYSTEM_WEBHOOK_SLO_WINDOW_SEC: 900 }) as never,
      {
        getSnapshot: jest.fn().mockResolvedValue({
          available: true,
          targetMs: 2_000,
          attemptedReceipts: 6,
          persistedReceipts: 6,
          failedReceipts: 0,
          rejectedReceipts: 0,
          sampledReceipts: 6,
          p95LatencyMs: 2_000,
          p99LatencyMs: 3_000,
          underTargetRatio: 0.833,
          bots: {},
        }),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      status: 'critical',
      ingress: {
        targetMs: 2_000,
        p99LatencyMs: 3_000,
      },
      canonicalExecution: {
        receipts: 6,
        executionClaims: 3,
        claimsPerReceiptRatio: 0.5,
      },
    });
  });

  it.each(SERVICE_ROUTE_FAILURE_OUTCOMES)(
    'marks the service-owned route outcome %s as warning',
    (outcome) => {
      const service = new WebhookSloService({} as never, createConfig() as never);
      const subject = service as unknown as {
        resolveStatus: (params: {
          failedEvents: number;
          underTargetRatio: number | null;
          oldestUnprocessedLagSec: number;
          p95ProcessingMs: number | null;
          p99ProcessingMs: number | null;
          ingress: WebhookIngressMetricsSnapshot;
        }) => string;
      };

      expect(
        subject.resolveStatus({
          failedEvents: 0,
          underTargetRatio: null,
          oldestUnprocessedLagSec: 0,
          p95ProcessingMs: null,
          p99ProcessingMs: null,
          ingress: createHealthyIngress({ route: createRouteMetrics({ [outcome]: 1 }) }),
        }),
      ).toBe('warning');
    },
  );

  it('makes sustained route failures critical without double-counting receipt failures', () => {
    const service = new WebhookSloService({} as never, createConfig() as never);
    const subject = service as unknown as {
      resolveStatus: (params: {
        failedEvents: number;
        underTargetRatio: number | null;
        oldestUnprocessedLagSec: number;
        p95ProcessingMs: number | null;
        p99ProcessingMs: number | null;
        ingress: WebhookIngressMetricsSnapshot;
      }) => string;
    };
    const resolveStatus = (ingress: WebhookIngressMetricsSnapshot) =>
      subject.resolveStatus({
        failedEvents: 0,
        underTargetRatio: null,
        oldestUnprocessedLagSec: 0,
        p95ProcessingMs: null,
        p99ProcessingMs: null,
        ingress,
      });

    expect(
      resolveStatus(
        createHealthyIngress({
          failedReceipts: 2,
          rejectedReceipts: 1,
          route: createRouteMetrics({ failed: 3 }),
        }),
      ),
    ).toBe('warning');
    expect(
      resolveStatus(
        createHealthyIngress({ route: createRouteMetrics({ timed_out: 3, failed: 2 }) }),
      ),
    ).toBe('critical');
  });

  it('keeps credential-scanning noise out of webhook health status', () => {
    const service = new WebhookSloService({} as never, createConfig() as never);
    const subject = service as unknown as {
      resolveStatus: (params: {
        failedEvents: number;
        underTargetRatio: number | null;
        oldestUnprocessedLagSec: number;
        p95ProcessingMs: number | null;
        p99ProcessingMs: number | null;
        ingress: WebhookIngressMetricsSnapshot;
      }) => string;
    };

    expect(
      subject.resolveStatus({
        failedEvents: 0,
        underTargetRatio: null,
        oldestUnprocessedLagSec: 0,
        p95ProcessingMs: null,
        p99ProcessingMs: null,
        ingress: createHealthyIngress({
          route: createRouteMetrics({ authentication_rejected: 10_000 }),
        }),
      }),
    ).toBe('healthy');
  });

  it('alerts only on sustained membership-cache degradation with explicit sample gates', () => {
    const service = new WebhookSloService({} as never, createConfig() as never);
    const subject = service as unknown as {
      resolveStatus: (params: {
        failedEvents: number;
        underTargetRatio: number | null;
        oldestUnprocessedLagSec: number;
        p95ProcessingMs: number | null;
        p99ProcessingMs: number | null;
        ingress: WebhookIngressMetricsSnapshot;
      }) => string;
      buildMembershipCacheSloSnapshot: (ingress: WebhookIngressMetricsSnapshot) => {
        status: string;
        budgetTimeout: { sampled: number; affected: number; ratio: number | null };
        detachedFailure: { sampled: number; affected: number; ratio: number | null };
        thresholds: {
          warning: { minimumSamples: number; minimumAffected: number; ratio: number };
          critical: { minimumSamples: number; minimumAffected: number; ratio: number };
        };
      };
    };
    const withBudgetOutcomes = (completed: number, timeout: number) => {
      const ingress = createHealthyIngress();
      return {
        ...ingress,
        membershipCache: {
          ...ingress.membershipCache,
          budget: {
            ...ingress.membershipCache.budget,
            completed,
            timeout,
          },
        },
      };
    };
    const withDetachedOutcomes = (completed: number, failure: number, rejected: number) => {
      const ingress = createHealthyIngress();
      return {
        ...ingress,
        membershipCache: {
          ...ingress.membershipCache,
          detached: {
            completed,
            timeout: 0,
            failure,
            peakInFlight: 10,
            rejected,
          },
        },
      };
    };
    const resolveStatus = (ingress: WebhookIngressMetricsSnapshot) =>
      subject.resolveStatus({
        failedEvents: 0,
        underTargetRatio: null,
        oldestUnprocessedLagSec: 0,
        p95ProcessingMs: null,
        p99ProcessingMs: null,
        ingress,
      });

    expect(resolveStatus(withBudgetOutcomes(0, 1))).toBe('healthy');
    expect(resolveStatus(withBudgetOutcomes(9_004, 996))).toBe('healthy');
    expect(resolveStatus(withBudgetOutcomes(17, 3))).toBe('warning');
    expect(resolveStatus(withBudgetOutcomes(7_004, 2_996))).toBe('warning');
    expect(resolveStatus(withBudgetOutcomes(35, 15))).toBe('critical');
    expect(resolveStatus(withDetachedOutcomes(17, 2, 1))).toBe('warning');
    expect(resolveStatus(withDetachedOutcomes(35, 10, 5))).toBe('critical');
    expect(subject.buildMembershipCacheSloSnapshot(withBudgetOutcomes(35, 15))).toMatchObject({
      status: 'critical',
      budgetTimeout: { sampled: 50, affected: 15, ratio: 0.3 },
      thresholds: {
        warning: { minimumSamples: 20, minimumAffected: 3, ratio: 0.1 },
        critical: { minimumSamples: 50, minimumAffected: 10, ratio: 0.3 },
      },
    });
    expect(subject.buildMembershipCacheSloSnapshot(withDetachedOutcomes(35, 10, 5))).toMatchObject({
      status: 'critical',
      detachedFailure: { sampled: 50, affected: 15, ratio: 0.3 },
    });
  });
});
