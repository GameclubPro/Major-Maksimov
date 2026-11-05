import { ModerationService } from './moderation.service';
import {
  createSettings,
  createUpdate,
  createBotAuthoredUpdate,
} from './moderation.service.spec-support';
import { Logger } from '@nestjs/common';
import type { MaxActionLedgerService } from '../max/max-action-ledger.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import type { NightModeTransitionEventService } from './night-mode-transition-event.service';
import { NightModeOpenNoticeCleanupGuardService } from './night-mode-open-notice-cleanup-guard.service';
import {
  NIGHT_MODE_OPEN_NOTICE_CLEANUP_RULE_CODE,
  type NightModeOpenNoticeCleanupBinding,
  type NightModeOpenNoticeCleanupSettings,
} from './night-mode-open-notice-cleanup-binding';
import { NightModeOpenNoticeCleanupService } from './night-mode-open-notice-cleanup.service';

const now = new Date('2026-11-05T09:00:00.000Z');
const sentAt = new Date(now.getTime() - 10_000);
const settings: NightModeOpenNoticeCleanupSettings = {
  chatId: 'chat',
  nightModeEnabled: true,
  nightModeStartTimeMinutes: 1380,
  nightModeEndTimeMinutes: 480,
  nightModeTimezone: 'UTC',
  nightModeOpenMessageEnabled: true,
  nightModeOpenMessageDeleteOnFirstMessageEnabled: true,
  nightModeForceCloseEnabled: false,
  nightModeForceCloseForever: false,
  nightModeForceCloseUntil: '',
};
const message = {
  type: 'message_created',
  messageId: 'human-message',
  userId: 'human',
  createdAt: new Date(now.getTime() - 1_000).toISOString(),
  isBot: false,
};

function fixture() {
  const ledger = {
    inspectCompletedNightModeOpenNoticeDispatch: jest
      .fn<
        ReturnType<MaxActionLedgerService['inspectCompletedNightModeOpenNoticeDispatch']>,
        Parameters<MaxActionLedgerService['inspectCompletedNightModeOpenNoticeDispatch']>
      >()
      .mockResolvedValue({
        kind: 'completed',
        jobId: 'opening',
        remoteMessageId: 'opening-message',
        dispatchBotId: 'origin-bot',
        completedAt: sentAt,
        routeHalfOpenProbe: false,
        stickyRouteHalfOpenProbe: false,
      }),
  } satisfies Pick<MaxActionLedgerService, 'inspectCompletedNightModeOpenNoticeDispatch'>;
  const events = {
    ensureTransitionEvent: jest
      .fn<
        ReturnType<NightModeTransitionEventService['ensureTransitionEvent']>,
        Parameters<NightModeTransitionEventService['ensureTransitionEvent']>
      >()
      .mockResolvedValue({ id: 'opening-event' }),
  } satisfies Pick<NightModeTransitionEventService, 'ensureTransitionEvent'>;
  const deletes = {
    rearmNightModeOpenNoticeCleanup: jest
      .fn<
        ReturnType<ModerationDeleteIntentService['rearmNightModeOpenNoticeCleanup']>,
        Parameters<ModerationDeleteIntentService['rearmNightModeOpenNoticeCleanup']>
      >()
      .mockResolvedValue(undefined),
    ensureIntent: jest
      .fn<
        ReturnType<ModerationDeleteIntentService['ensureIntent']>,
        Parameters<ModerationDeleteIntentService['ensureIntent']>
      >()
      .mockResolvedValue({ intentId: 'cleanup', rollout: 'execute', status: 'PENDING' }),
  } satisfies Pick<
    ModerationDeleteIntentService,
    'ensureIntent' | 'rearmNightModeOpenNoticeCleanup'
  >;
  const prisma = { moderationDeleteIntent: { findUnique: jest.fn().mockResolvedValue(null) } };
  const service = new NightModeOpenNoticeCleanupService(
    prisma as unknown as PrismaService,
    ledger as unknown as MaxActionLedgerService,
    events as unknown as NightModeTransitionEventService,
    deletes as unknown as ModerationDeleteIntentService,
  );
  return { service, prisma, ledger, events, deletes };
}

describe('opening notice cleanup admission', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  it('hands off only the exact accepted opening notice after the first human message', async () => {
    const f = fixture();
    await f.service.observeHumanMessage(settings, message);
    expect(f.deletes.ensureIntent).toHaveBeenCalledWith({
      chatId: 'chat',
      messageId: 'opening-message',
      reasonKey: NIGHT_MODE_OPEN_NOTICE_CLEANUP_RULE_CODE,
      ruleCode: NIGHT_MODE_OPEN_NOTICE_CLEANUP_RULE_CODE,
      entityType: 'CHAT',
      messageAuthorKind: 'bot',
      originBotId: 'origin-bot',
      routingPolicy: 'origin_only',
      retryUntilAt: new Date(Date.parse(message.createdAt) + 86_400_000),
      event: {
        eventType: 'SYSTEM',
        metadata: {
          nightModeOpenNoticeCleanup: expect.objectContaining({
            eventId: 'opening-event',
            messageId: 'opening-message',
            botId: 'origin-bot',
            sendCompletedAt: sentAt.toISOString(),
            trigger: {
              messageId: 'human-message',
              userId: 'human',
              createdAt: message.createdAt,
            },
          }),
        },
      },
    });
  });

  it.each([
    { name: 'disabled option', config: { nightModeOpenMessageDeleteOnFirstMessageEnabled: false } },
    { name: 'disabled opening notice', config: { nightModeOpenMessageEnabled: false } },
    { name: 'disabled schedule', config: { nightModeEnabled: false } },
    {
      name: 'manual closure',
      config: { nightModeForceCloseEnabled: true, nightModeForceCloseForever: true },
    },
    {
      name: 'closed scheduled chat',
      config: { nightModeStartTimeMinutes: 480, nightModeEndTimeMinutes: 600 },
    },
  ])('does no storage work for $name', async ({ config }) => {
    const f = fixture();
    await f.service.observeHumanMessage({ ...settings, ...config }, message);
    expect(f.ledger.inspectCompletedNightModeOpenNoticeDispatch).not.toHaveBeenCalled();
    expect(f.deletes.ensureIntent).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'bot', source: { isBot: true } },
    { name: 'edit', source: { type: 'message_edited' } },
    { name: 'callback', source: { type: 'message_callback' } },
    { name: 'missing event kind', source: { type: null } },
    {
      name: 'stale source',
      source: { createdAt: new Date(now.getTime() - 300_001).toISOString() },
    },
    { name: 'future source', source: { createdAt: new Date(now.getTime() + 1).toISOString() } },
    { name: 'missing identity', source: { userId: '' } },
    { name: 'null sender identity', source: { userId: null } },
  ])('ignores $name without a receipt query', async ({ source }) => {
    const f = fixture();
    await f.service.observeHumanMessage(settings, { ...message, ...source });
    expect(f.ledger.inspectCompletedNightModeOpenNoticeDispatch).not.toHaveBeenCalled();
    expect(f.events.ensureTransitionEvent).not.toHaveBeenCalled();
  });

  it.each(['missing', 'mismatch'] as const)('refuses %s SEND evidence', async (kind) => {
    const f = fixture();
    f.ledger.inspectCompletedNightModeOpenNoticeDispatch.mockResolvedValue({
      kind,
      jobId: 'opening',
    });
    await f.service.observeHumanMessage(settings, message);
    expect(f.deletes.ensureIntent).not.toHaveBeenCalled();
  });

  it('ignores a delayed pre-opening source and a message concurrent with SEND completion', async () => {
    const f = fixture();
    for (const offset of [-1, 0])
      await f.service.observeHumanMessage(settings, {
        ...message,
        createdAt: new Date(sentAt.getTime() + offset).toISOString(),
      });
    expect(f.events.ensureTransitionEvent).not.toHaveBeenCalled();
    expect(f.deletes.ensureIntent).not.toHaveBeenCalled();
  });

  it('keeps the original durable handoff on later messages and after a service restart', async () => {
    const f = fixture();
    f.prisma.moderationDeleteIntent.findUnique.mockResolvedValue({ reasons: [{ id: 'reason' }] });
    await f.service.observeHumanMessage(settings, message);
    expect(f.events.ensureTransitionEvent).not.toHaveBeenCalled();
    expect(f.deletes.ensureIntent).not.toHaveBeenCalled();
  });

  it('rearms only a stale policy refusal from a fresh eligible human source', async () => {
    const f = fixture();
    f.prisma.moderationDeleteIntent.findUnique.mockResolvedValue({
      id: 'cleanup',
      status: 'FAILED_TERMINAL',
      lastErrorCode: 'night_mode_open_notice_cleanup_stale',
      reasons: [{ id: 'reason' }],
    });
    await f.service.observeHumanMessage(settings, message);
    expect(f.deletes.rearmNightModeOpenNoticeCleanup).toHaveBeenCalledWith('cleanup');
    expect(f.deletes.ensureIntent).not.toHaveBeenCalled();
  });

  it('keeps participant moderation available when cleanup persistence is unavailable', async () => {
    const f = fixture();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    f.deletes.ensureIntent.mockRejectedValue(new Error('disposable store unavailable'));
    await expect(f.service.observeHumanMessage(settings, message)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat' }),
      expect.any(String),
    );
    warn.mockRestore();
  });
});

describe('opening notice final DELETE authority', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  async function guardFixture() {
    const f = fixture();
    await f.service.observeHumanMessage(settings, message);
    const input = f.deletes.ensureIntent.mock.calls[0]![0];
    const binding = (
      input.event!.metadata as { nightModeOpenNoticeCleanup: NightModeOpenNoticeCleanupBinding }
    ).nightModeOpenNoticeCleanup;
    const prisma = {
      maxActionLedgerEntry: {
        findUnique: jest.fn().mockResolvedValue({
          actionType: 'SEND_MESSAGE',
          chatId: 'chat',
          sourceTag: 'night_mode_transition',
          status: 'SUCCEEDED',
          ambiguous: false,
          terminal: true,
          completedAt: sentAt,
          dispatchBotId: 'origin-bot',
          remoteMessageId: 'opening-message',
          metadata: {},
        }),
      },
      moderationEvent: { findFirst: jest.fn().mockResolvedValue({ id: binding.eventId }) },
      chatSettings: {
        findUnique: jest.fn().mockResolvedValue({ ...settings, chat: { entityType: 'CHAT' } }),
      },
    };
    const guard = new NightModeOpenNoticeCleanupGuardService(prisma as unknown as PrismaService);
    const intent = {
      chatId: 'chat',
      messageId: 'opening-message',
      entityType: 'CHAT' as const,
      messageAuthorKind: 'bot',
      originBotId: 'origin-bot',
      routingPolicy: 'origin_only',
    };
    return { guard, prisma, intent, binding };
  }

  it('accepts the exact current receipt and event', async () => {
    const f = await guardFixture();
    await expect(f.guard.assertAllowed(f.intent, f.binding)).resolves.toBeUndefined();
  });

  it('keeps a pre-closure trigger valid after a later temporary manual closure expires', async () => {
    const f = await guardFixture();
    f.prisma.chatSettings.findUnique.mockResolvedValue({
      ...settings,
      nightModeForceCloseEnabled: true,
      nightModeForceCloseForever: false,
      nightModeForceCloseUntil: new Date(now.getTime() + 5 * 60_000).toISOString(),
      chat: { entityType: 'CHAT' },
    });
    jest.setSystemTime(new Date(now.getTime() + 2 * 60_000));
    await expect(f.guard.assertAllowed(f.intent, f.binding)).rejects.toMatchObject({
      code: 'night_mode_open_notice_cleanup_stale',
    });
    jest.setSystemTime(new Date(now.getTime() + 6 * 60_000));
    await expect(f.guard.assertAllowed(f.intent, f.binding)).resolves.toBeUndefined();
  });

  it.each([
    {
      name: 'option disabled',
      setting: { nightModeOpenMessageDeleteOnFirstMessageEnabled: false },
    },
    { name: 'rescheduled session', setting: { nightModeStartTimeMinutes: 1370 } },
    {
      name: 'new manual closure',
      setting: { nightModeForceCloseEnabled: true, nightModeForceCloseForever: true },
    },
  ])('refuses $name after handoff', async ({ setting }) => {
    const f = await guardFixture();
    f.prisma.chatSettings.findUnique.mockResolvedValue({
      ...settings,
      ...setting,
      chat: { entityType: 'CHAT' },
    });
    await expect(f.guard.assertAllowed(f.intent, f.binding)).rejects.toMatchObject({
      code: 'night_mode_open_notice_cleanup_stale',
    });
  });

  it('checks current policy after awaiting exact SEND and event evidence', async () => {
    const f = await guardFixture();
    f.prisma.moderationEvent.findFirst.mockImplementation(async () => {
      f.prisma.chatSettings.findUnique.mockResolvedValue({
        ...settings,
        nightModeOpenMessageDeleteOnFirstMessageEnabled: false,
        chat: { entityType: 'CHAT' },
      });
      return { id: f.binding.eventId };
    });
    await expect(f.guard.assertAllowed(f.intent, f.binding)).rejects.toMatchObject({
      code: 'night_mode_open_notice_cleanup_stale',
    });
  });

  it.each([
    { originBotId: 'different-bot' },
    { messageId: 'human-message' },
    { messageAuthorKind: 'user' },
    { routingPolicy: 'origin_first' },
  ])('rejects changed target authority: %j', async (change) => {
    const f = await guardFixture();
    await expect(
      f.guard.assertAllowed({ ...f.intent, ...change }, f.binding),
    ).rejects.toMatchObject({ code: 'night_mode_open_notice_cleanup_stale' });
    expect(f.prisma.maxActionLedgerEntry.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a missing event, ambiguous SEND and trigger from before SEND', async () => {
    const f = await guardFixture();
    f.prisma.moderationEvent.findFirst.mockResolvedValue(null);
    await expect(f.guard.assertAllowed(f.intent, f.binding)).rejects.toMatchObject({
      code: 'night_mode_open_notice_cleanup_stale',
    });
    f.prisma.maxActionLedgerEntry.findUnique.mockResolvedValue({
      status: 'FAILED_RETRYABLE',
      ambiguous: true,
    });
    await expect(f.guard.assertAllowed(f.intent, f.binding)).rejects.toMatchObject({
      code: 'night_mode_open_notice_cleanup_stale',
    });
    await expect(
      f.guard.assertAllowed(f.intent, {
        ...f.binding,
        trigger: { ...f.binding.trigger, createdAt: sentAt.toISOString() },
      }),
    ).rejects.toMatchObject({ code: 'night_mode_open_notice_cleanup_stale' });
  });
});

describe('opening cleanup human handler composition', () => {
  it.each(['human', 'bot'] as const)(
    'passes only a %s source to cleanup before admin bypass',
    async (kind) => {
      const cleanup = {
        observeHumanMessage: jest.fn().mockResolvedValue(undefined),
      } satisfies Pick<NightModeOpenNoticeCleanupService, 'observeHumanMessage'>;
      const config = createSettings({ nightModeOpenMessageDeleteOnFirstMessageEnabled: true });
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat',
            settings: config,
            domains: [],
            admins: [],
          }),
        },
        moderationEvent: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const service = new ModerationService(
        prisma as never,
        { detect: jest.fn() } as never,
        {} as never,
        {} as never,
      );
      Object.assign(service, {
        nightModeOpenNoticeCleanup: cleanup,
        resolveSenderChatAdminCheck: jest
          .fn()
          .mockResolvedValue({ isAdmin: true, source: 'local' }),
        handleChatAdminModerationBypass: jest.fn().mockResolvedValue(undefined),
      });
      const update = kind === 'human' ? createUpdate() : createBotAuthoredUpdate();
      await service.handleUpdate(update);
      if (kind === 'human')
        expect(cleanup.observeHumanMessage).toHaveBeenCalledWith(config, {
          isBot: false,
          type: 'message_created',
          messageId: update.message!.messageId,
          userId: update.message!.senderId,
          createdAt: update.message!.createdAt,
        });
      else expect(cleanup.observeHumanMessage).not.toHaveBeenCalled();
    },
  );
});
