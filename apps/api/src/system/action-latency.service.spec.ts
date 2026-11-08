import type { Prisma } from '../prisma/prisma-client';
import { ActionLatencyService } from './action-latency.service';

describe('ActionLatencyService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports terminal latency without fabricating enqueue or dispatch timestamps', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    const actionRows = [
      {
        metadataState: 'ABSENT',
        actionType: 'DELETE_MESSAGE',
        status: 'SUCCEEDED',
        sourceTag: 'moderation',
        botId: 'bot-2',
        trafficClass: 'critical',
        enqueuedAt: new Date('2026-08-15T11:59:58.000Z'),
        lastAttemptAt: new Date('2026-08-15T11:59:58.100Z'),
        completedAt: new Date('2026-08-15T11:59:58.350Z'),
      },
      {
        metadataState: 'ABSENT',
        actionType: 'SEND_MESSAGE',
        status: 'FAILED_TERMINAL',
        sourceTag: null,
        botId: 'bot-1',
        trafficClass: 'interactive',
        enqueuedAt: null,
        lastAttemptAt: new Date('2026-08-15T11:59:59.300Z'),
        completedAt: new Date('2026-08-15T11:59:59.900Z'),
      },
      {
        metadataState: 'ABSENT',
        actionType: 'SEND_MESSAGE',
        status: 'AMBIGUOUS',
        sourceTag: 'manual',
        botId: null,
        trafficClass: null,
        enqueuedAt: new Date('2026-08-15T11:59:56.000Z'),
        lastAttemptAt: new Date('2026-08-15T11:59:55.000Z'),
        completedAt: new Date('2026-08-15T11:59:59.000Z'),
      },
    ];
    const deleteRows = [
      {
        status: 'SUCCEEDED',
        sourceMessageAt: new Date('2026-08-15T11:59:57.000Z'),
        firstAttemptAt: new Date('2026-08-15T11:59:57.250Z'),
        completedAt: new Date('2026-08-15T11:59:57.400Z'),
      },
      {
        status: 'EXPIRED',
        sourceMessageAt: new Date('2026-08-15T11:59:58.000Z'),
        firstAttemptAt: null,
        completedAt: new Date('2026-08-15T11:59:58.500Z'),
      },
      {
        status: 'FAILED_TERMINAL',
        sourceMessageAt: null,
        firstAttemptAt: new Date('2026-08-15T11:59:58.600Z'),
        completedAt: new Date('2026-08-15T11:59:59.000Z'),
      },
    ];
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue(actionRows),
      moderationDeleteIntent: { findMany: jest.fn().mockResolvedValue(deleteRows) },
    };
    const service = new ActionLatencyService(
      prisma as never,
      {
        get: jest.fn((key: string) =>
          key === 'SYSTEM_WEBHOOK_SLO_SAMPLE_LIMIT'
            ? 3
            : key === 'SYSTEM_WEBHOOK_SLO_WINDOW_SEC'
              ? 900
              : undefined,
        ),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      basis: 'terminal_outcomes',
      windowBasis: 'completed_at',
      actionStartBasis: 'max_enqueued_at_scheduled_for',
      windowSec: 900,
      windowStartedAt: '2026-08-15T11:45:00.000Z',
      sampleLimit: 3,
      actionSampleCount: 3,
      actionSampleTruncated: false,
      actionSampledFrom: '2026-08-15T11:59:58.350Z',
      overall: {
        effectiveReadyToLastAttempt: {
          sampleCount: 1,
          p50Ms: 100,
          p95Ms: 100,
          p99Ms: 100,
        },
        lastAttemptToTerminal: {
          sampleCount: 3,
          p50Ms: 600,
          p95Ms: 4_000,
          p99Ms: 4_000,
        },
        effectiveReadyToTerminal: {
          sampleCount: 2,
          p50Ms: 350,
          p95Ms: 3_000,
          p99Ms: 3_000,
        },
      },
      byAction: [
        expect.objectContaining({ key: 'DELETE_MESSAGE', rowCount: 1 }),
        expect.objectContaining({ key: 'SEND_MESSAGE', rowCount: 2 }),
      ],
      byOutcome: [
        expect.objectContaining({ key: 'AMBIGUOUS', rowCount: 1 }),
        expect.objectContaining({ key: 'FAILED_TERMINAL', rowCount: 1 }),
        expect.objectContaining({ key: 'SUCCEEDED', rowCount: 1 }),
      ],
      bySource: [
        expect.objectContaining({ key: '(none)' }),
        expect.objectContaining({ key: 'manual' }),
        expect.objectContaining({ key: 'moderation' }),
      ],
      moderationDelete: {
        sampleCount: 3,
        sampleTruncated: false,
        sampledFrom: '2026-08-15T11:59:57.400Z',
        overall: {
          messageToFirstAttempt: { sampleCount: 1, p50Ms: 250, p95Ms: 250, p99Ms: 250 },
          firstAttemptToTerminal: {
            sampleCount: 2,
            p50Ms: 150,
            p95Ms: 400,
            p99Ms: 400,
          },
          messageToTerminal: { sampleCount: 2, p50Ms: 400, p95Ms: 500, p99Ms: 500 },
        },
        byOutcome: [
          expect.objectContaining({ key: 'EXPIRED', rowCount: 1 }),
          expect.objectContaining({ key: 'FAILED_TERMINAL', rowCount: 1 }),
          expect.objectContaining({ key: 'SUCCEEDED', rowCount: 1 }),
        ],
      },
      generatedAt: '2026-08-15T12:00:00.000Z',
    });

    const query = prisma.$queryRaw.mock.calls[0]![0] as Prisma.Sql;
    expect(query.sql).toMatch(/WITH heads AS MATERIALIZED/);
    expect(query.sql).toMatch(/ORDER BY completed_at DESC, id DESC LIMIT \?/);
    expect(query.sql).toContain('WHERE id=heads.id OFFSET 0');
    expect(query.values).toEqual([
      new Date('2026-08-15T11:45:00.000Z'),
      new Date('2026-08-15T12:00:00.000Z'),
      4,
    ]);
    expect(prisma.moderationDeleteIntent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          completedAt: {
            gte: new Date('2026-08-15T11:45:00.000Z'),
            lte: new Date('2026-08-15T12:00:00.000Z'),
          },
          OR: [
            {
              reasons: {
                none: {
                  ruleCode: {
                    in: ['BOT_MESSAGE_AUTO_DELETE', 'COMMERCIAL_OCR_DELETE'],
                  },
                },
              },
            },
            {
              reasons: {
                some: {
                  ruleCode: {
                    notIn: ['BOT_MESSAGE_AUTO_DELETE', 'COMMERCIAL_OCR_DELETE'],
                  },
                },
              },
            },
            {
              reasons: {
                some: {
                  ruleCode: 'COMMERCIAL_OCR_DELETE',
                  metadata: { path: ['source'], equals: 'image_text_ocr' },
                },
              },
            },
          ],
        }),
        orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
        take: 4,
      }),
    );
  });

  it('retains independently authorized deletes while excluding delayed-only outcomes', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      moderationDeleteIntent: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new ActionLatencyService(prisma as never, { get: jest.fn() } as never);

    await service.getSnapshot();

    expect(prisma.moderationDeleteIntent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            {
              reasons: {
                none: {
                  ruleCode: {
                    in: ['BOT_MESSAGE_AUTO_DELETE', 'COMMERCIAL_OCR_DELETE'],
                  },
                },
              },
            },
            {
              reasons: {
                some: {
                  ruleCode: {
                    notIn: ['BOT_MESSAGE_AUTO_DELETE', 'COMMERCIAL_OCR_DELETE'],
                  },
                },
              },
            },
            {
              reasons: {
                some: {
                  ruleCode: 'COMMERCIAL_OCR_DELETE',
                  metadata: { path: ['source'], equals: 'image_text_ocr' },
                },
              },
            },
          ],
        }),
      }),
    );
  });

  it('measures delayed action reaction from its effective ready time', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          actionType: 'UNBAN_MEMBER',
          status: 'SUCCEEDED',
          sourceTag: 'moderation',
          botId: 'bot-1',
          trafficClass: 'background',
          metadataState: 'BOUNDED_SCHEDULE',
          legacyScheduledFor: '2026-08-15T11:59:59.500Z',
          enqueuedAt: new Date('2026-08-15T11:00:00.000Z'),
          lastAttemptAt: new Date('2026-08-15T11:59:59.600Z'),
          completedAt: new Date('2026-08-15T11:59:59.700Z'),
        },
      ]),
      moderationDeleteIntent: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new ActionLatencyService(prisma as never, { get: jest.fn() } as never);

    await expect(service.getSnapshot()).resolves.toMatchObject({
      actionStartBasis: 'max_enqueued_at_scheduled_for',
      overall: {
        effectiveReadyToLastAttempt: {
          sampleCount: 1,
          p50Ms: 100,
          p95Ms: 100,
          p99Ms: 100,
        },
        effectiveReadyToTerminal: {
          sampleCount: 1,
          p50Ms: 200,
          p95Ms: 200,
          p99Ms: 200,
        },
      },
    });
    const query = prisma.$queryRaw.mock.calls[0]![0] as Prisma.Sql;
    expect(query.sql).toContain('COMPRESSED_NOT_INSPECTED');
    expect(query.sql).toContain('pg_column_size(details.metadata) <= 8192');
    expect(query.sql).not.toMatch(/metadata AS/);
  });

  it.each([
    {
      metadataState: 'SCALAR_VALID',
      scheduledForAt: new Date('2026-08-15T11:59:59.500Z'),
      legacyScheduledFor: 'invalid',
      state: 'KNOWN',
      measured: 1,
    },
    { metadataState: 'SCALAR_UNSCHEDULED', state: 'KNOWN', measured: 1 },
    { metadataState: 'SCALAR_INVALID', state: 'INVALID_SCHEDULE', measured: 0 },
    { metadataState: 'COMPRESSED_NOT_INSPECTED', state: 'UNKNOWN_METADATA', measured: 0 },
    { metadataState: 'OVERSIZED_NOT_INSPECTED', state: 'UNKNOWN_METADATA', measured: 0 },
    { metadataState: 'INVALID_SCALAR_CLOCK', state: 'INVALID_READY_CLOCK', measured: 0 },
    {
      metadataState: 'BOUNDED_SCHEDULE',
      legacyScheduledFor: '2026-02-30T00:00:00.000Z',
      state: 'INVALID_SCHEDULE',
      measured: 0,
    },
    {
      metadataState: 'BOUNDED_SCHEDULE',
      legacyScheduledFor: '2026-08-15T11:59:59+01:00',
      state: 'INVALID_SCHEDULE',
      measured: 0,
    },
    {
      metadataState: 'SCALAR_VALID',
      scheduledForAt: new Date('2026-08-15T11:59:59.500Z'),
      enqueuedAt: null,
      state: 'MISSING_READY_CLOCK',
      measured: 0,
    },
    {
      metadataState: 'SCALAR_UNSCHEDULED',
      invalidEnqueuedAt: true,
      state: 'INVALID_READY_CLOCK',
      measured: 0,
    },
  ])(
    'reports honest readiness coverage for $metadataState / $state',
    async ({ state, measured, ...overrides }) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
      const row = {
        actionType: 'SEND_MESSAGE',
        status: 'SUCCEEDED',
        sourceTag: 'managed_broadcast',
        botId: 'bot-1',
        trafficClass: 'interactive',
        scheduledForAt: null,
        legacyScheduledFor: null,
        invalidEnqueuedAt: false,
        enqueuedAt: new Date('2026-08-15T11:59:59.000Z'),
        lastAttemptAt: new Date('2026-08-15T11:59:59.600Z'),
        completedAt: new Date('2026-08-15T11:59:59.700Z'),
        ...overrides,
      };
      const service = new ActionLatencyService(
        {
          $queryRaw: jest.fn().mockResolvedValue([row]),
          moderationDeleteIntent: { findMany: jest.fn().mockResolvedValue([]) },
        } as never,
        { get: jest.fn() } as never,
      );
      const result = await service.getSnapshot();
      expect(result.readiness).toContainEqual({ state, count: 1 });
      expect(result.overall.effectiveReadyToTerminal).toMatchObject({
        sampleCount: measured,
        excludedCount: 1 - measured,
      });
      expect(result.overall.lastAttemptToTerminal).toMatchObject({
        sampleCount: 1,
        excludedCount: 0,
      });
      expect(result.bySource[0]?.effectiveReadyToTerminal.excludedCount).toBe(1 - measured);
    },
  );

  it('excludes attempt clocks after completion while retaining a valid readiness total', async () => {
    const service = new ActionLatencyService(
      {
        $queryRaw: jest.fn().mockResolvedValue([
          {
            actionType: 'SEND_MESSAGE',
            status: 'SUCCEEDED',
            sourceTag: null,
            botId: null,
            trafficClass: null,
            metadataState: 'SCALAR_UNSCHEDULED',
            invalidEnqueuedAt: false,
            scheduledForAt: null,
            legacyScheduledFor: null,
            enqueuedAt: new Date(1000),
            lastAttemptAt: new Date(3000),
            completedAt: new Date(2000),
          },
        ]),
        moderationDeleteIntent: { findMany: jest.fn().mockResolvedValue([]) },
      } as never,
      { get: jest.fn() } as never,
    );
    const { overall } = await service.getSnapshot();
    expect(overall.effectiveReadyToLastAttempt.sampleCount).toBe(0);
    expect(overall.lastAttemptToTerminal.sampleCount).toBe(0);
    expect(overall.effectiveReadyToTerminal.sampleCount).toBe(1);
  });

  it('marks only an actual over-limit sample as truncated', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    const actionRows = Array.from({ length: 4 }, (_, index) => ({
      metadataState: 'ABSENT',
      actionType: 'SEND_MESSAGE',
      status: 'SUCCEEDED',
      sourceTag: 'moderation',
      botId: 'bot-1',
      trafficClass: 'critical',
      enqueuedAt: new Date(1_000 + index),
      lastAttemptAt: new Date(1_100 + index),
      completedAt: new Date(1_200 + index),
    }));
    const deleteRows = actionRows.map((row) => ({
      status: 'ALREADY_ABSENT',
      sourceMessageAt: row.enqueuedAt,
      firstAttemptAt: row.lastAttemptAt,
      completedAt: row.completedAt,
    }));
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue(actionRows),
      moderationDeleteIntent: { findMany: jest.fn().mockResolvedValue(deleteRows) },
    };
    const service = new ActionLatencyService(
      prisma as never,
      {
        get: jest.fn((key: string) => (key === 'SYSTEM_WEBHOOK_SLO_SAMPLE_LIMIT' ? 3 : undefined)),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      actionSampleCount: 3,
      actionSampleTruncated: true,
      moderationDelete: { sampleCount: 3, sampleTruncated: true },
    });
  });

  it('caps configuration, caches snapshots, and leaves missing intervals empty', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      moderationDeleteIntent: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new ActionLatencyService(
      prisma as never,
      {
        get: jest.fn((key: string) =>
          key === 'SYSTEM_WEBHOOK_SLO_SAMPLE_LIMIT' ? 50_000 : undefined,
        ),
      } as never,
    );

    const firstRequest = service.getSnapshot();
    const concurrentRequest = service.getSnapshot();

    expect(concurrentRequest).toBe(firstRequest);
    const first = await firstRequest;
    const second = await service.getSnapshot();

    expect(second).toBe(first);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.moderationDeleteIntent.findMany).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      sampleLimit: 5_000,
      actionSampleCount: 0,
      actionSampleTruncated: false,
      actionSampledFrom: null,
      overall: {
        effectiveReadyToLastAttempt: {
          sampleCount: 0,
          p50Ms: null,
          p95Ms: null,
          p99Ms: null,
        },
        lastAttemptToTerminal: { sampleCount: 0, p50Ms: null, p95Ms: null, p99Ms: null },
        effectiveReadyToTerminal: {
          sampleCount: 0,
          p50Ms: null,
          p95Ms: null,
          p99Ms: null,
        },
      },
      byAction: [],
      byOutcome: [],
      bySource: [],
      byBot: [],
      byTrafficClass: [],
      moderationDelete: {
        sampleCount: 0,
        sampleTruncated: false,
        sampledFrom: null,
        overall: {
          messageToFirstAttempt: { sampleCount: 0, p50Ms: null, p95Ms: null, p99Ms: null },
        },
        byOutcome: [],
      },
    });
  });

  it('clears a failed in-flight query so the next snapshot can recover', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockRejectedValueOnce(new Error('database unavailable'))
        .mockResolvedValueOnce([]),
      moderationDeleteIntent: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new ActionLatencyService(prisma as never, { get: jest.fn() } as never);

    await expect(service.getSnapshot()).rejects.toThrow('database unavailable');
    await expect(service.getSnapshot()).resolves.toMatchObject({ actionSampleCount: 0 });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
