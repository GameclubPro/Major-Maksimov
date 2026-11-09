import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { fingerprintModerationSettings } from './message-limits-delete-guard.service';
import { ModerationRuleSanctionGuardService } from './moderation-rule-sanction-guard.service';

function fixture() {
  const sourceAt = new Date(Date.now() - 1_000);
  const settings = {
    maxMessageLengthEnabled: true,
    maxMessageLength: 10,
    messageLimitsBanEnabled: true,
    nightModeTimezone: 'UTC',
    chat: { entityType: 'CHAT', admins: [] as unknown[] },
  };
  const input = {
    chatId: '-123',
    messageId: 'm1',
    userId: 'user-1',
    botId: 'peer-2',
    reasonKey: 'length',
    ruleCode: 'MESSAGE_TOO_LONG_DELETE',
    policySha256: fingerprintModerationSettings(settings, 'MESSAGE_TOO_LONG'),
    deadlineAtMs: sourceAt.getTime() + 300_000,
  };
  const prisma = {
    chatSettings: { findUnique: jest.fn(async () => settings) },
    moderationDeleteIntent: {
      findUnique: jest.fn(
        async () =>
          ({
            id: 'intent-1',
            status: 'SUCCEEDED',
            subjectUserId: 'user-1',
            sourceMessageAt: sourceAt,
          }) as unknown,
      ),
    },
    moderationDeleteIntentReason: {
      findUnique: jest.fn(
        async () =>
          ({
            ruleCode: 'MESSAGE_TOO_LONG_DELETE',
            userId: 'user-1',
            metadata: { moderationDeleteVerified: true },
          }) as unknown,
      ),
    },
  };
  const max = {
    getChatMemberAccess: jest.fn(async () => ({
      userId: 'user-1',
      isAdmin: false,
      isOwner: false,
    })),
  };
  const immunity = { consumeForMessage: jest.fn(async () => 'not_granted') };
  const service = new ModerationRuleSanctionGuardService(
    prisma as never,
    max as never,
    { isKnownBotUserId: () => false } as never,
    immunity as never,
    new ConfigService(),
  );
  return { service, settings, input, prisma, max, immunity };
}
describe('own-rule sanction authorization', () => {
  it('requires the same admitted-quota policy on the verified reason and follow-up', async () => {
    const s = fixture();
    Object.assign(s.settings, {
      messageCountLimitEnabled: true,
      messageCountLimitMessages: 2,
      messageCountLimitWindowHours: 6,
    });
    s.input.ruleCode = 'MESSAGE_COUNT_LIMIT_DELETE';
    s.input.policySha256 = fingerprintModerationSettings(s.settings, s.input.ruleCode);
    const reason = {
      ruleCode: s.input.ruleCode,
      userId: s.input.userId,
      metadata: { moderationDeleteVerified: true, messageLimitPolicySha256: s.input.policySha256 },
    };
    s.prisma.moderationDeleteIntentReason.findUnique.mockResolvedValue(reason);
    await expect(s.service.assertAllowed(s.input)).resolves.toBeUndefined();
    s.prisma.moderationDeleteIntentReason.findUnique.mockResolvedValue({
      ...reason,
      metadata: { ...reason.metadata, messageLimitPolicySha256: '0'.repeat(64) },
    });
    await expect(s.service.assertAllowed(s.input)).rejects.toMatchObject({
      code: 'moderation_rule_sanction_no_longer_authorized',
    });
  });
  it('rejects pre-upgrade length classification even with a confirmed old DELETE receipt', async () => {
    const s = fixture();
    const row = s.settings as Record<string, unknown>;
    const oldEntries = [
      'maxMessageLengthEnabled',
      'maxMessageLength',
      'messageLimitsBotMessageEnabled',
      'messageLimitsWarnEnabled',
      'messageLimitsMuteEnabled',
      'messageLimitsBanEnabled',
      'messageLimitsMuteDurationHours',
    ]
      .sort()
      .map((key) => [key, row[key] ?? null]);
    s.input.policySha256 = createHash('sha256').update(JSON.stringify(oldEntries)).digest('hex');
    await expect(s.service.assertAllowed(s.input)).rejects.toMatchObject({
      code: 'moderation_rule_sanction_no_longer_authorized',
    });
    expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
  });
  it('binds phone followups to the visible limits actions and revokes a changed switch', async () => {
    const s = fixture();
    Object.assign(s.settings, { phoneNumbersEnabled: false, messageLimitsBotMessageEnabled: true });
    s.input.ruleCode = 'PHONE_NUMBER_BLOCKED_DELETE';
    s.input.policySha256 = fingerprintModerationSettings(s.settings, s.input.ruleCode);
    s.prisma.moderationDeleteIntentReason.findUnique.mockResolvedValue({
      ruleCode: s.input.ruleCode,
      userId: s.input.userId,
      metadata: { moderationDeleteVerified: true },
    });
    await expect(s.service.assertAllowed(s.input)).resolves.toBeUndefined();
    Object.assign(s.settings, { messageLimitsBotMessageEnabled: false });
    await expect(s.service.assertAllowed(s.input)).rejects.toMatchObject({
      code: 'moderation_rule_sanction_no_longer_authorized',
    });
  });
  it('requires exact verified reason receipt and current selected-peer author access', async () => {
    const s = fixture();
    await expect(s.service.assertAllowed(s.input)).resolves.toBeUndefined();
    expect(s.prisma.moderationDeleteIntent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chatId_messageId: { chatId: '-123', messageId: 'm1' } },
        select: { id: true, status: true, subjectUserId: true, sourceMessageAt: true },
      }),
    );
    expect(s.prisma.moderationDeleteIntentReason.findUnique).toHaveBeenCalledWith({
      where: { intentId_reasonKey: { intentId: 'intent-1', reasonKey: 'length' } },
      select: { ruleCode: true, userId: true, metadata: true },
    });
    expect(s.max.getChatMemberAccess).toHaveBeenCalledWith(
      '-123',
      'user-1',
      expect.objectContaining({ botId: 'peer-2', bypassCache: true }),
    );
  });
  it.each([
    'independent-delete',
    'foreign-reason',
    'unverified-reason',
    'extended-deadline',
    'policy-off',
    'raised',
    'sanction-off',
    'admin',
    'immunity',
    'expired',
  ])('prevents stale strike or member mutation after %s', async (change) => {
    const s = fixture();
    if (change === 'independent-delete')
      s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue(null);
    if (change === 'foreign-reason')
      s.prisma.moderationDeleteIntentReason.findUnique.mockResolvedValue({
        ruleCode: 'PHONE_NUMBER_BLOCKED_DELETE',
        userId: 'user-1',
        metadata: { moderationDeleteVerified: true },
      });
    if (change === 'unverified-reason')
      s.prisma.moderationDeleteIntentReason.findUnique.mockResolvedValue({
        ruleCode: 'MESSAGE_TOO_LONG_DELETE',
        userId: 'user-1',
        metadata: {},
      });
    if (change === 'extended-deadline') s.input.deadlineAtMs += 1;
    if (change === 'policy-off') s.settings.maxMessageLengthEnabled = false;
    if (change === 'raised') s.settings.maxMessageLength = 100;
    if (change === 'sanction-off') s.settings.messageLimitsBanEnabled = false;
    if (change === 'admin')
      s.max.getChatMemberAccess.mockResolvedValue({
        userId: 'user-1',
        isAdmin: true,
        isOwner: false,
      });
    if (change === 'immunity') s.immunity.consumeForMessage.mockResolvedValue('granted');
    if (change === 'expired') s.input.deadlineAtMs = Date.now() - 1;
    await expect(s.service.assertAllowed(s.input)).rejects.toMatchObject({
      code: 'moderation_rule_sanction_no_longer_authorized',
    });
  });
});
