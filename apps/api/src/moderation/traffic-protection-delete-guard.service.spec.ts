import type { AutomaticDeleteAuthorAccessService } from '../max/automatic-delete-author-access.service';
import { ConfigService } from '@nestjs/config';
import { TrafficProtectionDetector } from './traffic-protection.detector';
import {
  TrafficProtectionDeleteGuardService,
  TrafficProtectionGuardRejectedError,
} from './traffic-protection-delete-guard.service';

async function harness(authorAccess?: Pick<AutomaticDeleteAuthorAccessService, 'resolve'>) {
  const settings = {
    slowModeEnabled: true,
    slowModeIntervalSeconds: 30,
    mediaMessageCooldownEnabled: false,
    mediaMessageCooldownSeconds: 30,
    stickerMessagesEnabled: true,
    trafficPolicyRevision: 3,
    trafficPolicyEffectiveAt: new Date(Date.now() - 1000),
    nightModeTimezone: 'Europe/Moscow',
    chat: { entityType: 'CHAT', admins: [] as { userId: string }[] },
  };
  const detector = new TrafficProtectionDetector({
    claimEventCooldown: jest.fn().mockResolvedValue('blocked'),
  } as never);
  const hit = await detector.detect({
    chatId: 'chat-1',
    userId: 'user-1',
    messageId: 'message-1',
    eventTimestampMs: Date.now(),
    eventType: 'message_created',
    text: 'Hello',
    media: {},
    settings,
  });
  const reasons = [{ ruleCode: 'SLOW_MODE_DELETE', metadata: hit!.metadata! }];
  const prisma = {
    chatSettings: { findUnique: jest.fn().mockImplementation(async () => settings) },
    moderationDeleteIntentReason: { findMany: jest.fn().mockResolvedValue(reasons) },
  };
  const message = (text = 'Hello') => ({
    body: { mid: 'message-1', text },
    sender: { user_id: 'user-1' },
    recipient: { chat_id: 'chat-1', chat_type: 'chat' },
    timestamp: Date.now(),
  });
  const max = {
    getExactMessageRow: jest.fn().mockResolvedValue(message()),
    getChatMemberAccess: jest
      .fn()
      .mockResolvedValue({ userId: 'user-1', isAdmin: false, isOwner: false }),
  };
  const bots = { isKnownBotUserId: jest.fn().mockReturnValue(false) };
  const immunity = { consumeForMessage: jest.fn().mockResolvedValue('not_granted') };
  const guard = new TrafficProtectionDeleteGuardService(
    prisma as never,
    max as never,
    bots as never,
    immunity as never,
    new ConfigService(),
    authorAccess as AutomaticDeleteAuthorAccessService | undefined,
  );
  const input = {
    intentId: 'intent',
    chatId: 'chat-1',
    messageId: 'message-1',
    subjectUserId: 'user-1',
  };
  return { settings, reasons, prisma, max, bots, immunity, guard, input, message };
}

describe('TrafficProtectionDeleteGuardService', () => {
  it.each([false, true])(
    'retains current traffic-author membership after a saved role decision, absent=%s',
    async (absent) => {
      const resolve = jest
        .fn<
          ReturnType<AutomaticDeleteAuthorAccessService['resolve']>,
          Parameters<AutomaticDeleteAuthorAccessService['resolve']>
        >()
        .mockResolvedValue({
          initialized: true,
          revision: '1',
          isAdmin: false,
          member: absent
            ? null
            : { userId: 'user-1', isAdmin: true, isOwner: false, permissions: [] },
        });
      const h = await harness({ resolve });
      if (absent) {
        await expect(h.guard.assertIntentStillActionable(h.input)).rejects.toBeInstanceOf(
          TrafficProtectionGuardRejectedError,
        );
        expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
        expect(h.immunity.consumeForMessage).not.toHaveBeenCalled();
      } else {
        await expect(h.guard.assertIntentStillActionable(h.input)).resolves.toBe('allowed');
      }
      expect(h.max.getChatMemberAccess).not.toHaveBeenCalled();
    },
  );

  it('checks current source, exact author, immunity and final policy', async () => {
    const h = await harness();
    await expect(h.guard.assertIntentStillActionable(h.input)).resolves.toBe('allowed');
    expect(h.prisma.chatSettings.findUnique).toHaveBeenCalledTimes(2);
    expect(h.max.getExactMessageRow).toHaveBeenCalledTimes(1);
  });
  it('carries the original deadline when checking traffic inside a mixed reason set', async () => {
    const h = await harness();
    const deadlineAtMs = h.reasons[0].metadata.trafficDeadlineAtMs;
    h.reasons.push({ ruleCode: 'MESSAGE_TOO_LONG_DELETE', metadata: {} });
    await expect(
      h.guard.assertIntentStillActionable({
        ...h.input,
        botId: 'healthy-executor',
        ownedReasonsOnly: true,
        includeDeadlinePermit: true,
      }),
    ).resolves.toEqual({ deadlineAtMs });
    expect(h.max.getExactMessageRow).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'healthy-executor' }),
    );
    expect(h.reasons[0].metadata.trafficDeadlineAtMs).toBe(deadlineAtMs);
  });
  it('rejects a deadline consumed by remote author/source checks', async () => {
    const h = await harness();
    const deadlineAtMs = h.reasons[0].metadata.trafficDeadlineAtMs as number;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(deadlineAtMs - 1);
    try {
      h.immunity.consumeForMessage.mockImplementation(async () => {
        clock.mockReturnValue(deadlineAtMs);
        return 'not_granted';
      });
      await expect(
        h.guard.assertIntentStillActionable({ ...h.input, includeDeadlinePermit: true }),
      ).rejects.toBeInstanceOf(TrafficProtectionGuardRejectedError);
    } finally {
      clock.mockRestore();
    }
  });
  it.each([
    'disabled',
    'interval',
    'revision',
    'activation',
    'admin',
    'owner',
    'bot',
    'immunity',
    'edit',
    'expired',
    'malformed',
  ])('rejects %s before deletion', async (change) => {
    const h = await harness();
    if (change === 'disabled') h.settings.slowModeEnabled = false;
    if (change === 'interval') h.settings.slowModeIntervalSeconds = 60;
    if (change === 'revision') h.settings.trafficPolicyRevision++;
    if (change === 'activation') h.settings.trafficPolicyEffectiveAt = new Date(Date.now() + 1000);
    if (change === 'admin') h.settings.chat.admins.push({ userId: 'user-1' });
    if (change === 'owner')
      h.max.getChatMemberAccess.mockResolvedValue({ userId: 'user-1', isOwner: true });
    if (change === 'bot') h.bots.isKnownBotUserId.mockReturnValue(true);
    if (change === 'immunity') h.immunity.consumeForMessage.mockResolvedValue('granted');
    if (change === 'edit') h.max.getExactMessageRow.mockResolvedValue(h.message('Edited'));
    if (change === 'expired') h.reasons[0].metadata.trafficDeadlineAtMs = Date.now() - 1;
    if (change === 'malformed') h.reasons[0].metadata = {};
    await expect(h.guard.assertIntentStillActionable(h.input)).rejects.toBeInstanceOf(
      TrafficProtectionGuardRejectedError,
    );
  });
  it('rechecks policy after remote work and immunity resolution', async () => {
    const h = await harness();
    h.immunity.consumeForMessage.mockImplementation(async () => {
      h.settings.slowModeEnabled = false;
      return 'not_granted';
    });
    await expect(h.guard.assertIntentStillActionable(h.input)).rejects.toBeInstanceOf(
      TrafficProtectionGuardRejectedError,
    );
  });
  it('never accepts an author or chat mismatch', async () => {
    const h = await harness();
    h.max.getExactMessageRow.mockResolvedValue({
      ...h.message(),
      sender: { user_id: 'other-user' },
    });
    await expect(h.guard.assertIntentStillActionable(h.input)).rejects.toBeInstanceOf(
      TrafficProtectionGuardRejectedError,
    );
  });
  it('keeps independently owned reasons on their own guard path', async () => {
    const h = await harness();
    h.reasons.push({ ruleCode: 'MESSAGE_BLOCKED_WORD_DELETE', metadata: {} });
    h.settings.slowModeEnabled = false;
    await expect(h.guard.assertIntentStillActionable(h.input)).resolves.toBe('not_applicable');
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });
  it('reports exact absence but propagates transport failure', async () => {
    const h = await harness();
    h.max.getExactMessageRow.mockResolvedValue(null);
    await expect(h.guard.assertIntentStillActionable(h.input)).resolves.toBe('absent');
    h.max.getExactMessageRow.mockRejectedValue(new Error('MAX unavailable'));
    await expect(h.guard.assertIntentStillActionable(h.input)).rejects.toThrow('MAX unavailable');
  });
});
