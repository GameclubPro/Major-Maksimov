import { SafetyDeskRetentionService } from './safety-desk-retention.service';
import type { SafetyDeskRetentionRuntimeResponse } from '@maxim/contracts/safety-desk';
import type { EraserControlService } from '../message-retention/eraser-control.service';
import type { LegacyRuntimeBatch, RetentionRuntimePageRow } from './safety-desk-retention-queries';
import type { PrismaService } from '../prisma/prisma.service';

function setup() {
  const query: jest.MockedFunction<PrismaService['$queryRaw']> = jest
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ diagnostics: [], quotas: [] } satisfies LegacyRuntimeBatch]);
  const prisma = {
    $queryRaw: query,
    messageRetentionPolicy: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    messageRetentionQuota: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const store = {
    allows: jest.fn().mockReturnValue(true),
    mode: 'off',
    reopenTerminalCandidate: jest.fn().mockResolvedValue(true),
  };
  const capabilities = { assertChatSettingsBotCapabilities: jest.fn() };
  const service = new SafetyDeskRetentionService(
    prisma as never,
    store as never,
    capabilities as never,
  );
  const body = {
    messageId: 'mid',
    activationId: 'activation',
    expectedRevision: 5,
    intentId: 'intent',
    expectedIntentUpdatedAt: '2026-10-01T10:00:00.000Z',
    expectedAttemptCount: 3,
  };
  return { service, prisma, store, capabilities, body };
}
describe('closed retention operator boundary', () => {
  it('preserves native diagnostic flags while redacting an unknown upstream error', async () => {
    const runtime: SafetyDeskRetentionRuntimeResponse = {
      generatedAt: '2026-10-28T10:00:00.000Z',
      mode: 'on',
      nextAfter: null,
      quotas: [],
      items: [
        {
          chatId: '-123',
          chatTitle: '',
          enabled: true,
          hours: 48,
          revision: 1,
          activationId: 'activation-1',
          pendingCount: 0,
          deletedCount: 0,
          skippedCount: 0,
          status: 'delayed',
          oldestDueAt: null,
          nextRunAt: null,
          hasTerminalReview: false,
          hasUnresolvedReceipt: true,
          historyStatus: 'blocked',
          diagnostics: {
            lastError: null,
            historyBoundaryBlocked: false,
            awaitingCurrentProtection: false,
            awaitingHistoricalProtection: true,
          },
        },
      ],
    };
    const eraser: jest.Mocked<Pick<EraserControlService, 'enabled' | 'request'>> = {
      enabled: true,
      request: jest.fn().mockResolvedValue({
        ...runtime,
        items: runtime.items.map((item) => ({
          ...item,
          diagnostics: { ...item.diagnostics, lastError: 'private-upstream-detail' },
        })),
      }),
    };
    const { prisma, store, capabilities } = setup();
    prisma.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([
        { chatId: '-123', chatTitle: 'Чат', source: 'eraser' } satisfies RetentionRuntimePageRow,
      ])
      .mockResolvedValueOnce([{ diagnostics: [], quotas: [] } satisfies LegacyRuntimeBatch]);
    const service = new SafetyDeskRetentionService(
      prisma as unknown as PrismaService,
      store as never,
      capabilities as never,
      eraser as unknown as EraserControlService,
    );

    const result = await service.runtime();

    expect(result.items[0]).toMatchObject({
      chatTitle: 'Чат',
      hasUnresolvedReceipt: true,
      historyStatus: 'blocked',
      diagnostics: { ...runtime.items[0]!.diagnostics, lastError: 'unknown' },
    });
    expect(JSON.stringify(result)).not.toContain('private-upstream-detail');
    expect(result).not.toHaveProperty('incomplete');
    expect(eraser.request).toHaveBeenCalledWith('/runtime?chatIds=-123');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: 'unknown remote', remote: undefined, legacy: undefined, expected: undefined },
    { name: 'complete remote', remote: false, legacy: undefined, expected: false },
    { name: 'incomplete remote', remote: true, legacy: undefined, expected: true },
    {
      name: 'unknown remote with complete legacy',
      remote: undefined,
      legacy: false,
      expected: undefined,
    },
    {
      name: 'unknown remote with incomplete legacy',
      remote: undefined,
      legacy: true,
      expected: true,
    },
    { name: 'complete remote with incomplete legacy', remote: false, legacy: true, expected: true },
    { name: 'incomplete remote with complete legacy', remote: true, legacy: false, expected: true },
  ])('preserves completeness for $name', async ({ remote, legacy, expected }) => {
    const { prisma, store, capabilities } = setup();
    const owned: RetentionRuntimePageRow = { chatId: '-123', chatTitle: 'Owned', source: 'eraser' };
    const legacyRow: RetentionRuntimePageRow = {
      chatId: '-456',
      chatTitle: 'Legacy',
      source: 'legacy',
      enabled: true,
      hours: 48,
      revision: 1,
      activationId: 'legacy',
      pendingCount: 0,
      deletedCount: 0,
      skippedCount: 0,
      nextRunAt: null,
      captureAfter: null,
      pausedAt: null,
      updatedAt: new Date('2026-10-28T10:00:00Z'),
      lastStatus: 'off',
    };
    const diagnostic: LegacyRuntimeBatch['diagnostics'][number] = {
      chatId: '-456',
      oldestSourceMs: null,
      incomplete: legacy ?? false,
      hasTerminalReview: false,
      hasWorkerError: false,
      hasWaitingAccess: false,
      hasUnresolvedReceipt: false,
      hasDeferred: false,
      hasLegacyRetry: false,
    };
    const snapshot: SafetyDeskRetentionRuntimeResponse = {
      generatedAt: '2026-10-28T10:00:00Z',
      mode: 'on',
      nextAfter: null,
      quotas: [],
      ...(remote === undefined ? {} : { incomplete: remote }),
      items: [
        {
          chatId: '-123',
          chatTitle: 'Owned',
          enabled: true,
          hours: 48,
          revision: 1,
          activationId: 'owned',
          pendingCount: 0,
          deletedCount: 0,
          skippedCount: 0,
          status: 'delayed',
          oldestDueAt: null,
          nextRunAt: null,
          hasTerminalReview: false,
          hasUnresolvedReceipt: false,
        },
      ],
    };
    const eraser: jest.Mocked<Pick<EraserControlService, 'enabled' | 'request'>> = {
      enabled: true,
      request: jest.fn().mockResolvedValue(snapshot),
    };
    prisma.$queryRaw
      .mockReset()
      .mockResolvedValueOnce(legacy === undefined ? [owned] : [owned, legacyRow])
      .mockResolvedValueOnce([
        {
          diagnostics: legacy === undefined ? [] : [diagnostic],
          quotas: [],
        } satisfies LegacyRuntimeBatch,
      ]);
    const service = new SafetyDeskRetentionService(
      prisma as unknown as PrismaService,
      store as never,
      capabilities as never,
      eraser as unknown as EraserControlService,
    );

    const result = await service.runtime();

    if (expected === undefined) expect(result).not.toHaveProperty('incomplete');
    else expect(result.incomplete).toBe(expected);
    expect(result.items).toHaveLength(legacy === undefined ? 1 : 2);
    expect(result.unavailableSources).toEqual([]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(capabilities.assertChatSettingsBotCapabilities).not.toHaveBeenCalled();
  });

  it('forwards opaque Lastik review cursors and exact microsecond retry versions', async () => {
    const { prisma, store, capabilities, body } = setup();
    const preview = {
      chatId: '-1',
      revision: 5,
      activationId: 'activation',
      source: 'eraser',
      sourceStatus: 'available',
      items: [],
      nextAfter: null,
    };
    const eraser: jest.Mocked<
      Pick<EraserControlService, 'enabled' | 'owns' | 'request' | 'protectionReport'>
    > = {
      enabled: false,
      owns: jest.fn().mockResolvedValue(true),
      request: jest.fn().mockResolvedValue(preview),
      protectionReport: jest.fn().mockResolvedValue({ status: 'unavailable' }),
    };
    const service = new SafetyDeskRetentionService(
      prisma as unknown as PrismaService,
      store as never,
      capabilities as never,
      eraser as unknown as EraserControlService,
    );
    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        source: 'eraser',
        chatId: '-1',
        revision: 5,
        activationId: 'activation',
        messageId: 'mid',
      }),
    ).toString('base64url');
    await service.preview('-1', cursor);
    expect(eraser.request).toHaveBeenCalledWith(`/chats/-1/review?after=${cursor}`);
    await service.retry('-1', 'operator', {
      ...body,
      expectedIntentUpdatedAt: '2026-10-29T10:01:02.123456Z',
    });
    expect(eraser.request).toHaveBeenLastCalledWith(
      '/chats/-1/retry',
      'POST',
      expect.objectContaining({
        expectedIntentUpdatedAt: '2026-10-29T10:01:02.123456Z',
        actorUserId: 'operator',
      }),
    );
    expect(store.reopenTerminalCandidate).not.toHaveBeenCalled();
  });

  it('keeps unowned legacy retries on their saved source even with the Lastik flag enabled', async () => {
    const { prisma, store, capabilities, body } = setup();
    const eraser: jest.Mocked<Pick<EraserControlService, 'enabled' | 'owns' | 'request'>> = {
      enabled: true,
      owns: jest.fn().mockResolvedValue(false),
      request: jest.fn(),
    };
    const service = new SafetyDeskRetentionService(
      prisma as unknown as PrismaService,
      store as never,
      capabilities as never,
      eraser as unknown as EraserControlService,
    );
    jest
      .spyOn(service, 'preview')
      .mockResolvedValue({ chatId: '-1', revision: 5, activationId: 'activation', items: [] });
    await service.retry('-1', 'operator', body);
    expect(store.reopenTerminalCandidate).toHaveBeenCalledTimes(1);
    expect(eraser.request).not.toHaveBeenCalled();
  });

  it('uses two bounded queries for an empty legacy page', async () => {
    const { service, prisma } = setup();
    await expect(service.runtime('-123')).resolves.toMatchObject({
      items: [],
      nextAfter: null,
      mode: 'off',
      incomplete: false,
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('refuses invalid identifiers and unknown input before reads or access probes', async () => {
    const { service, store, capabilities, body, prisma } = setup();
    await expect(service.runtime('bad')).rejects.toMatchObject({ status: 400 });
    await expect(service.retry('-1', 'owner', { ...body, force: true })).rejects.toMatchObject({
      status: 400,
    });
    expect(store.reopenTerminalCandidate).not.toHaveBeenCalled();
    expect(capabilities.assertChatSettingsBotCapabilities).not.toHaveBeenCalled();
    expect(prisma.messageRetentionPolicy.findMany).not.toHaveBeenCalled();
  });
  it('does not reopen outside current execution authority', async () => {
    const { service, store, capabilities, body } = setup();
    store.allows.mockReturnValue(false);
    await expect(service.retry('-1', 'owner', body)).rejects.toMatchObject({ status: 400 });
    expect(capabilities.assertChatSettingsBotCapabilities).not.toHaveBeenCalled();
    expect(store.reopenTerminalCandidate).not.toHaveBeenCalled();
  });
  it('forces fresh capability checks and delegates exact versions to the atomic store', async () => {
    const { service, store, capabilities, body } = setup();
    jest
      .spyOn(service, 'preview')
      .mockResolvedValue({ chatId: '-1', revision: 5, activationId: 'activation', items: [] });
    await service.retry('-1', 'owner', body);
    expect(capabilities.assertChatSettingsBotCapabilities).toHaveBeenCalledWith(
      '-1',
      expect.any(Array),
      { forceLive: true },
    );
    expect(store.reopenTerminalCandidate).toHaveBeenCalledWith({
      ...body,
      chatId: '-1',
      expectedIntentUpdatedAt: new Date(body.expectedIntentUpdatedAt),
      actorUserId: 'owner',
    });
  });
  it('preserves a conflict and does not publish a success snapshot when CAS fails', async () => {
    const { service, store, body } = setup();
    const preview = jest.spyOn(service, 'preview');
    store.reopenTerminalCandidate.mockResolvedValue(false);
    await expect(service.retry('-1', 'owner', body)).rejects.toMatchObject({ status: 409 });
    expect(preview).not.toHaveBeenCalled();
  });
});
