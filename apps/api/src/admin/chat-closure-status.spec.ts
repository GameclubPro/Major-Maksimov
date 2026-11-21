import { DEFAULT_CHAT_SETTINGS } from './admin.service.support';
import { readChatClosureStatus, readChatClosureSummary } from './chat-closure-status';
import { ServiceUnavailableException } from '@nestjs/common';
import { buildNightModeNoticeIdempotencyKey } from '../max/max-action-idempotency.util';
import type { NightModeNoticeDiagnosticLedgerRow } from '../moderation/night-mode-notice-diagnostics';
import { buildNightModeTransitionScheduleFingerprint } from '../moderation/night-mode-transition-generation.util';
import {
  buildNightModeTransitionJobId,
  buildNightModeTransitionRecoveryJobId,
  type NightModeTransitionRecoveryObligation,
} from '../moderation/night-mode-transition.queue';
import type { NightModeTransitionScheduledJob, Prisma } from '../prisma/prisma-client';

const sessionKey = 'v1:Europe/Moscow:23:00:08:00:2026-10-13';
function ledger(
  transition: 'close' | 'open',
  patch: Partial<NightModeNoticeDiagnosticLedgerRow> = {},
): NightModeNoticeDiagnosticLedgerRow {
  return {
    jobId: buildNightModeNoticeIdempotencyKey(transition, 'chat', sessionKey),
    chatId: 'chat',
    actionType: 'SEND_MESSAGE',
    sourceTag: 'night_mode_transition',
    status: 'ENQUEUED',
    terminal: false,
    ambiguous: false,
    attemptCount: 0,
    firstAttemptAt: null,
    lastAttemptAt: null,
    dispatchToken: null,
    dispatchStartedAt: null,
    dispatchBotId: null,
    remoteMessageId: null,
    completedAt: null,
    lastStatusCode: null,
    lastErrorCode: null,
    ...patch,
  };
}
function receipt(transition: 'close' | 'open'): NightModeNoticeDiagnosticLedgerRow {
  return ledger(transition, {
    status: 'SUCCEEDED',
    terminal: true,
    attemptCount: 1,
    dispatchBotId: 'original-bot',
    remoteMessageId: `receipt-${transition}`,
    completedAt: new Date(transition === 'close' ? '2026-10-13T20:00:01Z' : '2026-10-14T05:00:01Z'),
  });
}

describe('saved closure diagnostics', () => {
  const now = new Date('2026-10-13T21:30:00Z');
  const settings = {
    ...DEFAULT_CHAT_SETTINGS,
    nightModeEnabled: true,
    nightModeBotMessageEnabled: true,
    nightModeStartTimeMinutes: 23 * 60,
    nightModeEndTimeMinutes: 8 * 60,
    nightModeTimezone: 'Europe/Moscow',
  };
  function harness(permissions = ['read_all_messages', 'write'], entityType = 'CHAT') {
    return {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'chat',
          entityType,
          routingState: 'READY',
          routingVersion: 1,
          primaryBotId: 'bot',
          fixedModeratorBotId: null,
          botMemberships: [
            {
              botId: 'bot',
              status: 'ACTIVE',
              botAccessState: 'CONFIRMED_ADMIN',
              botAccessCheckedAt: new Date('2020-01-01'),
              botAccessExpiresAt: null,
              botAccessSource: 'handshake_start',
              sendRouteFailureCount: 0,
              sendRouteQuarantinedUntil: null,
              sendRouteLastFailureCode: null,
              permissionsSnapshot: {
                isAdmin: true,
                isOwner: false,
                permissionsKnown: true,
                permissions,
                checkedAt: '2020-01-01T00:00:00.000Z',
              },
            },
          ],
        }),
      },
      nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
      maxActionLedgerEntry: {
        findMany: jest
          .fn<
            Promise<NightModeNoticeDiagnosticLedgerRow[]>,
            [Prisma.MaxActionLedgerEntryFindManyArgs]
          >()
          .mockResolvedValue([]),
      },
      nightModeTransitionScheduledJob: {
        findMany: jest
          .fn<
            Promise<NightModeTransitionScheduledJob[]>,
            [Prisma.NightModeTransitionScheduledJobFindManyArgs]
          >()
          .mockResolvedValue([]),
      },
    };
  }
  it('refreshes overlapping manual and scheduled restrictions with one scoped read and no delivery history', async () => {
    const prisma = harness();
    const route = await prisma.chat.findUnique();
    prisma.chat.findUnique.mockReset().mockResolvedValue({
      ...route,
      settings: {
        ...settings,
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: false,
        nightModeForceCloseUntil: '2026-10-14T00:00:00.000Z',
      },
    });
    const summary = await readChatClosureSummary(prisma as never, 'chat', ['bot'], now);
    expect(summary).toEqual({
      observedAt: now.toISOString(),
      scheduleEnabled: true,
      restriction: 'manual',
      nightActive: true,
      manualMode: 'timed',
      timezone: 'Europe/Moscow',
      opensAt: '2026-10-14T05:00:00.000Z',
      nextTransitionAt: '2026-10-14T00:00:00.000Z',
      deleteRoute: 'available',
      notificationsEnabled: true,
      sendRoute: 'available',
    });
    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.chat.findUnique).toHaveBeenCalledWith({
      where: { id: 'chat' },
      select: expect.objectContaining({
        settings: {
          select: {
            nightModeEnabled: true,
            nightModeStartTimeMinutes: true,
            nightModeEndTimeMinutes: true,
            nightModeTimezone: true,
            nightModeForceCloseEnabled: true,
            nightModeForceCloseForever: true,
            nightModeForceCloseUntil: true,
            nightModeBotMessageEnabled: true,
            nightModeOpenMessageEnabled: true,
          },
        },
        botMemberships: expect.objectContaining({ where: { botId: { in: ['bot'] } } }),
      }),
    });
    expect(prisma.maxActionLedgerEntry.findMany).not.toHaveBeenCalled();
    expect(prisma.nightModeTransitionScheduledJob.findMany).not.toHaveBeenCalled();
    expect(prisma.nightModeTransitionReconcileRequest.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['UNKNOWN', null, 'unknown'],
    ['STALE', { isAdmin: true, permissionsKnown: false }, 'unknown'],
    ['DENIED', null, 'unavailable'],
    ['CONFIRMED_ADMIN', { isAdmin: true, permissionsKnown: true, permissions: [] }, 'unavailable'],
  ] as const)(
    'distinguishes %s deletion rights from a confirmed restriction',
    async (access, permissions, expected) => {
      const prisma = harness();
      const chat = await prisma.chat.findUnique();
      prisma.chat.findUnique.mockResolvedValue({
        ...chat,
        settings,
        fixedModeratorBotId: 'bot',
        botMemberships: [
          { ...chat.botMemberships[0], botAccessState: access, permissionsSnapshot: permissions },
        ],
      });
      expect(
        (await readChatClosureSummary(prisma as never, 'chat', ['bot'], now)).deleteRoute,
      ).toBe(expected);
    },
  );

  it('reports unavailable fixed routes independently of valid settings and an opening-only notice', async () => {
    const prisma = harness();
    prisma.chat.findUnique.mockResolvedValue({
      ...(await prisma.chat.findUnique()),
      fixedModeratorBotId: 'absent-fixed-bot',
      settings: {
        ...settings,
        nightModeBotMessageEnabled: false,
        nightModeOpenMessageEnabled: true,
      },
    });
    await expect(
      readChatClosureSummary(prisma as never, 'chat', ['bot'], now),
    ).resolves.toMatchObject({
      restriction: 'night',
      manualMode: null,
      notificationsEnabled: true,
      sendRoute: 'unavailable',
      deleteRoute: 'unavailable',
    });
  });

  it.each([null, { entityType: 'CHAT', settings: null }, { entityType: 'CHANNEL', settings }])(
    'refuses an unavailable group summary instead of guessing the chat is open',
    async (row) => {
      const prisma = harness();
      prisma.chat.findUnique.mockResolvedValue(row);
      await expect(
        readChatClosureSummary(prisma as never, 'chat', ['bot'], now),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    },
  );

  it('keeps chat deletion available with durable write access without a notice receipt', async () => {
    expect(
      await readChatClosureStatus(harness() as never, 'chat', settings, ['bot'], now),
    ).toMatchObject({
      restriction: 'night',
      scheduleEnabled: true,
      deleteRoute: 'available',
      notice: 'not_recorded',
      opensAt: '2026-10-14T05:00:00.000Z',
    });
  });
  it('does not mistake channel send permission for delete authority', async () => {
    expect(
      (
        await readChatClosureStatus(
          harness(['read_all_messages', 'write'], 'CHANNEL') as never,
          'chat',
          settings,
          ['bot'],
          now,
        )
      ).deleteRoute,
    ).toBe('unavailable');
  });
  it.each(['SUCCEEDED', 'AMBIGUOUS', 'ENQUEUED'] as const)(
    'shows the distinct %s notice result',
    async (state) => {
      const prisma = harness();
      prisma.maxActionLedgerEntry.findMany.mockResolvedValue([
        ledger('close', {
          status: state,
          terminal: state === 'SUCCEEDED',
          ambiguous: state === 'AMBIGUOUS',
          attemptCount: state === 'ENQUEUED' ? 0 : 1,
          remoteMessageId: state === 'SUCCEEDED' ? 'receipt' : null,
          dispatchBotId: state === 'SUCCEEDED' ? 'bot' : null,
          completedAt: state === 'SUCCEEDED' ? now : null,
        }),
      ]);
      expect(
        (await readChatClosureStatus(prisma as never, 'chat', settings, ['bot'], now)).notice,
      ).toBe(state === 'SUCCEEDED' ? 'delivered' : state === 'AMBIGUOUS' ? 'unknown' : 'pending');
    },
  );
  it('keeps manual closure active until an overlapping night interval ends', async () => {
    const manual = {
      ...settings,
      nightModeForceCloseEnabled: true,
      nightModeForceCloseForever: false,
      nightModeForceCloseUntil: '2026-10-14T00:00:00Z',
    };
    expect(
      await readChatClosureStatus(harness() as never, 'chat', manual, ['bot'], now),
    ).toMatchObject({ restriction: 'manual', opensAt: '2026-10-14T05:00:00.000Z' });
  });
  it('preserves the legacy all-day restriction without inventing an opening time', async () => {
    expect(
      await readChatClosureStatus(
        harness() as never,
        'chat',
        { ...settings, nightModeEndTimeMinutes: settings.nightModeStartTimeMinutes },
        ['bot'],
        now,
      ),
    ).toMatchObject({ restriction: 'night', opensAt: null, notice: 'unknown' });
  });
  it('does not show a stale manual block for a newer recovery generation', async () => {
    const prisma = harness();
    prisma.nightModeTransitionReconcileRequest.findUnique.mockResolvedValue({
      firstRequestedAt: now,
      manualBlockedAt: now,
      generation: 2n,
      manualBlockedGeneration: 1n,
    });
    expect(
      (await readChatClosureStatus(prisma as never, 'chat', settings, ['bot'], now)).recovery,
    ).toBe('waiting');
  });
  it('keeps the saved restriction visible when all diagnostics stores fail', async () => {
    const prisma = harness();
    prisma.chat.findUnique.mockRejectedValue(new Error('database unavailable'));
    prisma.nightModeTransitionReconcileRequest.findUnique.mockRejectedValue(
      new Error('database unavailable'),
    );
    prisma.maxActionLedgerEntry.findMany.mockRejectedValue(new Error('database unavailable'));
    prisma.nightModeTransitionScheduledJob.findMany.mockRejectedValue(
      new Error('database unavailable'),
    );
    expect(
      await readChatClosureStatus(prisma as never, 'chat', settings, ['bot'], now),
    ).toMatchObject({
      restriction: 'night',
      deleteRoute: 'unknown',
      notice: 'unknown',
      recovery: 'unknown',
      notices: {
        recovery: { observation: 'unavailable' },
        close: { latest: { delivery: { reason: 'ledger_unavailable' } } },
      },
    });
  });

  const daytime = new Date('2026-10-14T12:00:00Z');
  function registry(
    transition: 'close' | 'open',
    recovery: NightModeTransitionRecoveryObligation | null = null,
  ): NightModeTransitionScheduledJob {
    const scheduledFor = new Date(
      transition === 'close' ? '2026-10-13T20:00:00Z' : '2026-10-14T05:00:00Z',
    );
    return {
      chatId: 'chat',
      sessionKey,
      transition,
      scheduledFor,
      jobId: recovery
        ? buildNightModeTransitionRecoveryJobId('chat', recovery)
        : buildNightModeTransitionJobId('chat', transition, scheduledFor.toISOString(), sessionKey),
      scheduleFingerprint: buildNightModeTransitionScheduleFingerprint(settings),
      runtimeVersion: 4,
      recoveryPayload: recovery as Prisma.JsonValue | null,
      createdAt: scheduledFor,
      updatedAt: scheduledFor,
    };
  }
  it('retains both receipts all day after switches are disabled and current access is lost', async () => {
    const prisma = harness();
    prisma.maxActionLedgerEntry.findMany.mockResolvedValue([receipt('close'), receipt('open')]);
    prisma.chat.findUnique.mockResolvedValue(null);
    const status = await readChatClosureStatus(
      prisma as never,
      'chat',
      {
        ...settings,
        nightModeEnabled: false,
        nightModeBotMessageEnabled: false,
        nightModeOpenMessageEnabled: false,
      },
      ['bot'],
      daytime,
    );
    expect(status).toMatchObject({
      scheduleEnabled: false,
      restriction: 'open',
      nextTransitionAt: null,
      notices: {
        boundary: 'daily',
        expectationBasis: 'current_schedule',
        sendRouteNow: 'unavailable',
        close: { enabledNow: false, latest: { delivery: { outcome: 'sent' } } },
        open: {
          enabledNow: false,
          latest: { catchUp: { state: 'expired' }, delivery: { outcome: 'sent' } },
        },
      },
    });
    expect(prisma.maxActionLedgerEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jobId: { in: [receipt('close').jobId, receipt('open').jobId] } },
      }),
    );
  });
  it('shows the elapsed opening window without inventing a missed SEND or historical switch', async () => {
    const status = await readChatClosureStatus(
      harness() as never,
      'chat',
      settings,
      ['bot'],
      daytime,
    );
    expect(status).toMatchObject({
      notice: 'not_expected',
      nextTransitionAt: '2026-10-14T20:00:00.000Z',
      notices: {
        open: {
          enabledNow: false,
          latest: {
            scheduledFor: '2026-10-14T05:00:00.000Z',
            catchUp: { state: 'expired', endsAt: '2026-10-14T07:00:00.000Z' },
            delivery: { outcome: 'not_recorded', reason: 'ledger_missing' },
          },
        },
      },
    });
  });
  it('does not treat a durable ordinary job as proof of enabled notification or SEND', async () => {
    const prisma = harness();
    prisma.nightModeTransitionScheduledJob.findMany.mockResolvedValue([registry('open')]);
    const status = await readChatClosureStatus(prisma as never, 'chat', settings, ['bot'], daytime);
    expect(status.notices?.open).toMatchObject({
      enabledNow: false,
      latest: {
        scheduling: 'recorded',
        delivery: { outcome: 'not_recorded' },
      },
    });
  });
  it('returns unknown for malformed success in both old and additive status', async () => {
    const prisma = harness();
    prisma.maxActionLedgerEntry.findMany.mockResolvedValue([
      { ...receipt('close'), remoteMessageId: null },
    ]);
    const status = await readChatClosureStatus(prisma as never, 'chat', settings, ['bot'], now);
    expect(status).toMatchObject({
      notice: 'unknown',
      notices: {
        close: {
          latest: {
            delivery: {
              outcome: 'unknown',
              reason: 'incomplete_success',
            },
          },
        },
      },
    });
  });
  it('does not rewrite the earlier opening receipt because the chat is manually closed now', async () => {
    const prisma = harness();
    prisma.maxActionLedgerEntry.findMany.mockResolvedValue([receipt('open')]);
    const status = await readChatClosureStatus(
      prisma as never,
      'chat',
      {
        ...settings,
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: true,
      },
      ['bot'],
      daytime,
    );
    expect(status).toMatchObject({
      restriction: 'manual',
      opensAt: null,
      notices: { open: { latest: { delivery: { outcome: 'sent' } } } },
    });
  });
  it('publishes manual expiry for refetch even when night closure continues afterwards', async () => {
    const status = await readChatClosureStatus(
      harness() as never,
      'chat',
      {
        ...settings,
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: false,
        nightModeForceCloseUntil: '2026-10-14T00:00:00Z',
      },
      ['bot'],
      now,
    );
    expect(status).toMatchObject({
      nextTransitionAt: '2026-10-14T00:00:00.000Z',
      opensAt: '2026-10-14T05:00:00.000Z',
    });
  });
  it.each([true, false])(
    'explains equal times without rewriting the saved schedule enabled=%s',
    async (enabled) => {
      const saved = {
        ...settings,
        nightModeEnabled: enabled,
        nightModeEndTimeMinutes: settings.nightModeStartTimeMinutes,
      };
      const status = await readChatClosureStatus(harness() as never, 'chat', saved, ['bot'], now);
      expect(status).toMatchObject({
        restriction: enabled ? 'night' : 'open',
        nextTransitionAt: null,
        notices: { boundary: 'continuous', close: { latest: null }, open: { latest: null } },
      });
      expect(saved.nightModeEndTimeMinutes).toBe(saved.nightModeStartTimeMinutes);
    },
  );
  it('respects a fixed moderator when reporting current send and delete access', async () => {
    const prisma = harness();
    const chat = await prisma.chat.findUnique();
    prisma.chat.findUnique.mockResolvedValue({ ...chat, fixedModeratorBotId: 'missing-fixed-bot' });
    expect(
      await readChatClosureStatus(prisma as never, 'chat', settings, ['bot'], now),
    ).toMatchObject({
      deleteRoute: 'unavailable',
      notices: { sendRouteNow: 'unavailable' },
    });
  });
  it('does not let a fenced cleanup downgrade a confirmed opening receipt', async () => {
    const prisma = harness();
    const cleanup: NightModeTransitionRecoveryObligation = {
      kind: 'close_notice_cleanup',
      version: 1,
      sessionKey,
      timezone: settings.nightModeTimezone,
      startMinutes: settings.nightModeStartTimeMinutes,
      endMinutes: settings.nightModeEndTimeMinutes,
      openScheduledFor: '2026-10-14T05:00:00.000Z',
      scheduleFingerprint: buildNightModeTransitionScheduleFingerprint(settings),
      sideEffectFingerprint: `sha256:${'a'.repeat(64)}`,
    };
    const task = registry('open', cleanup);
    prisma.maxActionLedgerEntry.findMany.mockResolvedValue([receipt('open')]);
    prisma.nightModeTransitionScheduledJob.findMany.mockResolvedValue([task]);
    prisma.nightModeTransitionReconcileRequest.findUnique.mockResolvedValue({
      firstRequestedAt: daytime,
      manualBlockedAt: daytime,
      generation: 1n,
      manualBlockedGeneration: 1n,
      manualBlockedCategory: 'unsafe_prior_provenance',
      manualBlockedJobId: task.jobId,
      manualBlockedSessionKey: sessionKey,
      manualBlockedFingerprint: task.scheduleFingerprint,
      manualAcknowledgedAt: null,
    });
    const status = await readChatClosureStatus(prisma as never, 'chat', settings, ['bot'], daytime);
    expect(status).toMatchObject({
      recovery: 'action_required',
      notices: {
        open: { latest: { delivery: { outcome: 'sent' } } },
        recovery: {
          observation: 'complete',
          obligations: [{ kind: 'close_notice_cleanup', state: 'action_required' }],
        },
      },
    });
  });
  it('reports a bounded recovery prefix as partial when retained rows exceed the cap', async () => {
    const prisma = harness();
    prisma.nightModeTransitionScheduledJob.findMany.mockImplementation(async (query) =>
      query.take
        ? Array.from({ length: 33 }, (_, index) => ({
            ...registry('open'),
            jobId: `other-${index}`,
          }))
        : [],
    );
    const status = await readChatClosureStatus(prisma as never, 'chat', settings, ['bot'], daytime);
    expect(status.notices?.recovery).toMatchObject({ observation: 'partial', obligations: [] });
    expect(prisma.nightModeTransitionScheduledJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chatId: 'chat' },
        orderBy: [{ scheduledFor: 'desc' }, { jobId: 'desc' }],
        take: 33,
      }),
    );
  });
  it('keeps receipt evidence when registry reads fail', async () => {
    const prisma = harness();
    prisma.maxActionLedgerEntry.findMany.mockResolvedValue([receipt('open')]);
    prisma.nightModeTransitionScheduledJob.findMany.mockRejectedValue(
      new Error('registry unavailable'),
    );
    const status = await readChatClosureStatus(prisma as never, 'chat', settings, ['bot'], daytime);
    expect(status.notices).toMatchObject({
      open: { latest: { scheduling: 'unknown', delivery: { outcome: 'sent' } } },
      recovery: { observation: 'unavailable' },
    });
  });
});
