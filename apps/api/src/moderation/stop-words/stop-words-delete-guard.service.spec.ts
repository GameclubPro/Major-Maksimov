import type { AutomaticDeleteAuthorAccessService } from '../../max/automatic-delete-author-access.service';
import { ConfigService } from '@nestjs/config';
import { stopWordsPolicySchema } from '@maxim/contracts/settings';
import { StopWordsDeleteGuardService } from './stop-words-delete-guard.service';
import { detectLegacyStopWordsViolations, detectStopWordsViolations } from './stop-words.detection';

function harness(authorAccess?: Pick<AutomaticDeleteAuthorAccessService, 'resolve'>) {
  const policy = stopWordsPolicySchema.parse({
    enabled: true,
    rules: [{ id: 'casino', kind: 'WORD', value: 'casino' }],
    sanctions: { warnEnabled: true, muteEnabled: true },
  });
  const settings = {
    stopWordsPolicy: policy,
    stopWordsRevision: 3,
    messageLimitsBlockedWords: [],
    messageLimitsBlockedDomains: [],
    nightModeTimezone: 'Europe/Moscow',
    chat: {
      entityType: 'CHAT',
      admins: [] as { userId: string }[],
      domains: [] as { domain: string }[],
    },
  };
  const metadata = detectStopWordsViolations({ text: 'casino', settings })[0]!.metadata;
  const reasons = [{ ruleCode: 'MESSAGE_BLOCKED_WORD_DELETE', metadata }];
  const prisma = {
    chatSettings: { findUnique: jest.fn().mockImplementation(async () => settings) },
    moderationDeleteIntentReason: { findMany: jest.fn().mockResolvedValue(reasons) },
    moderationDeleteIntent: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const message = (text: string) => ({
    body: { mid: 'message-1', text },
    sender: { user_id: 'user-1' },
    recipient: { chat_id: 'chat-1', chat_type: 'chat' },
    timestamp: Date.now(),
  });
  const max = {
    getExactMessageRow: jest.fn().mockResolvedValue(message('casino')),
    getChatMemberAccess: jest
      .fn()
      .mockResolvedValue({ userId: 'user-1', isAdmin: false, isOwner: false }),
  };
  const bots = { isKnownBotUserId: jest.fn().mockReturnValue(false) };
  const immunity = { consumeForMessage: jest.fn().mockResolvedValue('not_granted') };
  const guard = new StopWordsDeleteGuardService(
    prisma as never,
    max as never,
    bots as never,
    immunity as never,
    new ConfigService(),
    authorAccess as AutomaticDeleteAuthorAccessService | undefined,
  );
  const input = {
    intentId: 'intent-1',
    chatId: 'chat-1',
    messageId: 'message-1',
    subjectUserId: 'user-1',
  };
  return { settings, metadata, reasons, prisma, max, bots, immunity, guard, input, message };
}

describe('StopWordsDeleteGuardService', () => {
  it('uses saved DELETE immunity without allowing that proof to authorize a sanction', async () => {
    const resolve = jest
      .fn<
        ReturnType<AutomaticDeleteAuthorAccessService['resolve']>,
        Parameters<AutomaticDeleteAuthorAccessService['resolve']>
      >()
      .mockResolvedValue({
        initialized: true,
        revision: '1',
        isAdmin: false,
        member: { userId: 'user-1', isAdmin: true, isOwner: false, permissions: [] },
      });
    const h = harness({ resolve });
    h.max.getChatMemberAccess.mockResolvedValue({
      userId: 'user-1',
      isAdmin: true,
      isOwner: false,
    });
    await expect(h.guard.assertIntentStillActionable(h.input)).resolves.toBe('allowed');
    expect(h.max.getChatMemberAccess).not.toHaveBeenCalled();
    await expect(
      h.guard.assertSanctionStillActionable({
        ...h.input,
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        metadata: h.metadata,
        action: 'MUTE',
      }),
    ).rejects.toMatchObject({ rejectionReason: 'author_protected' });
    expect(h.max.getChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('preserves absent-member rejection even when the saved roster excludes the author', async () => {
    const resolve = jest
      .fn<
        ReturnType<AutomaticDeleteAuthorAccessService['resolve']>,
        Parameters<AutomaticDeleteAuthorAccessService['resolve']>
      >()
      .mockResolvedValue({ initialized: true, revision: '1', isAdmin: false, member: null });
    const h = harness({ resolve });
    await expect(h.guard.assertIntentStillActionable(h.input)).rejects.toMatchObject({
      rejectionReason: 'author_absent',
    });
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
    expect(h.immunity.consumeForMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['ставка', 'ставки'],
    ['казино', 'kазино'],
    ['casino', 'CASINO'],
  ])('retains legacy %s semantics at the fresh source boundary', async (word, text) => {
    const h = harness();
    const settings = { ...h.settings, stopWordsPolicy: null, messageLimitsBlockedWords: [word] };
    h.prisma.chatSettings.findUnique.mockResolvedValue(settings);
    h.reasons[0]!.metadata = detectLegacyStopWordsViolations({ text, settings })[0]!.metadata;
    h.max.getExactMessageRow.mockResolvedValue(h.message(text));
    await expect(h.guard.assertIntentStillActionable(h.input)).resolves.toBe('allowed');
    expect(h.max.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
      expect.objectContaining({ bypassCache: true }),
    );
    expect(h.prisma.chatSettings.findUnique).toHaveBeenCalledTimes(3);
  });

  it('does not substitute another legacy rule for the originally owned reason', async () => {
    const h = harness();
    const settings = {
      ...h.settings,
      stopWordsPolicy: null,
      messageLimitsBlockedWords: ['ставка', 'казино'],
    };
    h.prisma.chatSettings.findUnique.mockResolvedValue(settings);
    h.reasons[0]!.metadata = { blockedWord: 'ставка', matchKind: 'inflection' };
    h.max.getExactMessageRow.mockResolvedValue(h.message('казино'));
    await expect(h.guard.assertIntentStillActionable(h.input)).rejects.toMatchObject({
      rejectionReason: 'rule_unmatched',
    });
    expect(h.immunity.consumeForMessage).not.toHaveBeenCalled();
  });

  it.each(['paragraph', 'forward'])(
    'rejects a historical legacy reason synthesized across a %s boundary',
    async (boundary) => {
      const h = harness();
      h.prisma.chatSettings.findUnique.mockResolvedValue({
        ...h.settings,
        stopWordsPolicy: null,
        messageLimitsBlockedWords: ['доходбезвложений'],
      });
      h.reasons[0]!.metadata = { blockedWord: 'доходбезвложений', matchKind: 'pattern' };
      h.max.getExactMessageRow.mockResolvedValue(
        boundary === 'paragraph'
          ? h.message('доход\n\nбез вложений')
          : { ...h.message('доход'), link: { type: 'forward', message: { text: 'без вложений' } } },
      );
      await expect(h.guard.assertIntentStillActionable(h.input)).rejects.toMatchObject({
        rejectionReason: 'rule_unmatched',
      });
      expect(h.immunity.consumeForMessage).not.toHaveBeenCalled();
    },
  );

  it('uses the same supported caption source for initial and final detection', async () => {
    const h = harness();
    h.max.getExactMessageRow.mockResolvedValue({
      ...h.message(''),
      body: { mid: 'message-1' },
      payload: { caption: 'casino' },
    });
    await expect(h.guard.assertIntentStillActionable(h.input)).resolves.toBe('allowed');
  });

  it('keeps transport uncertainty retryable without consuming immunity', async () => {
    const h = harness();
    const error = new Error('Exact source temporarily unavailable');
    h.max.getExactMessageRow.mockRejectedValue(error);
    await expect(h.guard.assertIntentStillActionable(h.input)).rejects.toBe(error);
    expect(h.immunity.consumeForMessage).not.toHaveBeenCalled();
  });
  it('keeps legacy sanctions on their existing path only before policy activation', async () => {
    const h = harness();
    h.prisma.chatSettings.findUnique.mockResolvedValue({ ...h.settings, stopWordsPolicy: null });
    await expect(
      h.guard.assertSanctionStillActionable({
        ...h.input,
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        metadata: {},
        action: 'MUTE',
      }),
    ).resolves.toBeUndefined();
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });
  it('rechecks exact source, rule identity and settings before deletion', async () => {
    const h = harness();
    await expect(h.guard.assertIntentStillActionable(h.input)).resolves.toBe('allowed');
    expect(h.prisma.chatSettings.findUnique).toHaveBeenCalledTimes(3);
    expect(h.max.getExactMessageRow).toHaveBeenCalledTimes(1);
  });

  it('does not consume participant protection when policy is revoked during a MAX source read', async () => {
    const h = harness();
    h.max.getExactMessageRow.mockImplementation(async () => {
      h.prisma.chatSettings.findUnique.mockResolvedValue({
        ...h.settings,
        stopWordsPolicy: { ...h.settings.stopWordsPolicy, enabled: false },
      });
      return h.message('casino');
    });
    h.immunity.consumeForMessage.mockResolvedValue('granted');
    await expect(h.guard.assertIntentStillActionable(h.input)).rejects.toMatchObject({
      rejectionReason: 'policy_disabled',
    });
    expect(h.immunity.consumeForMessage).not.toHaveBeenCalled();
  });
  it.each([
    ['enabled', 'policy_disabled'],
    ['rule', 'rule_unmatched'],
    ['revision', 'policy_changed'],
    ['admin', 'author_protected'],
    ['bot', 'author_protected'],
    ['immunity', 'participant_immune'],
    ['edited', 'source_changed'],
  ])('rejects %s changes with a fixed diagnostic reason', async (change, rejectionReason) => {
    const h = harness();
    if (change === 'enabled') h.settings.stopWordsPolicy.enabled = false;
    if (change === 'rule') h.settings.stopWordsPolicy.rules[0]!.enabled = false;
    if (change === 'revision') h.settings.stopWordsRevision += 1;
    if (change === 'admin')
      h.max.getChatMemberAccess.mockResolvedValue({
        userId: 'user-1',
        isAdmin: true,
        isOwner: false,
      });
    if (change === 'bot') h.bots.isKnownBotUserId.mockReturnValue(true);
    if (change === 'immunity') h.immunity.consumeForMessage.mockResolvedValue('granted');
    if (change === 'edited') h.max.getExactMessageRow.mockResolvedValue(h.message('Спасибо'));
    await expect(h.guard.assertIntentStillActionable(h.input)).rejects.toMatchObject({
      code: 'stop_words_delete_no_longer_authorized',
      rejectionReason,
    });
  });
  it('rejects a settings change after remote verification', async () => {
    const h = harness();
    h.prisma.chatSettings.findUnique
      .mockResolvedValueOnce(h.settings)
      .mockResolvedValueOnce({ ...h.settings, stopWordsRevision: 4 });
    await expect(h.guard.assertIntentStillActionable(h.input)).rejects.toMatchObject({
      code: 'stop_words_delete_no_longer_authorized',
    });
  });
  it('does not cancel independent reasons when the stop-list is disabled', async () => {
    const h = harness();
    h.settings.stopWordsPolicy.enabled = false;
    h.reasons.push({ ruleCode: 'NIGHT_MODE_DELETE', metadata: {} });
    await expect(h.guard.assertIntentStillActionable(h.input)).resolves.toBe('not_applicable');
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });
  it('handles exact absence without assuming it authorizes a participant sanction', async () => {
    const h = harness();
    h.max.getExactMessageRow.mockResolvedValue(null);
    await expect(h.guard.assertIntentStillActionable(h.input)).resolves.toBe('absent');
    await expect(
      h.guard.assertSanctionStillActionable({
        ...h.input,
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        metadata: h.metadata,
        action: 'MUTE',
      }),
    ).rejects.toMatchObject({ code: 'stop_words_delete_no_longer_authorized' });
  });
  it('allows a configured sanction after this exact guarded deletion succeeded', async () => {
    const h = harness();
    h.max.getExactMessageRow.mockResolvedValue(null);
    h.prisma.moderationDeleteIntent.findFirst.mockResolvedValue({ id: 'intent-1' });
    await expect(
      h.guard.assertSanctionStillActionable({
        ...h.input,
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        metadata: h.metadata,
        action: 'MUTE',
      }),
    ).resolves.toBeUndefined();
  });

  it('does not consume protection for a revoked sanction after its own successful deletion', async () => {
    const h = harness();
    h.max.getExactMessageRow.mockImplementation(async () => {
      h.prisma.chatSettings.findUnique.mockResolvedValue({
        ...h.settings,
        stopWordsPolicy: { ...h.settings.stopWordsPolicy, enabled: false },
      });
      return null;
    });
    h.prisma.moderationDeleteIntent.findFirst.mockResolvedValue({ id: 'intent-1' });
    h.immunity.consumeForMessage.mockResolvedValue('granted');
    await expect(
      h.guard.assertSanctionStillActionable({
        ...h.input,
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        metadata: h.metadata,
        action: 'MUTE',
      }),
    ).rejects.toMatchObject({ rejectionReason: 'policy_disabled' });
    expect(h.immunity.consumeForMessage).not.toHaveBeenCalled();
  });
  it('does not permit a disabled sanction or a stronger action', async () => {
    const h = harness();
    await expect(
      h.guard.assertSanctionStillActionable({
        ...h.input,
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        metadata: h.metadata,
        action: 'BAN',
      }),
    ).rejects.toMatchObject({ code: 'stop_words_delete_no_longer_authorized' });
  });
});
