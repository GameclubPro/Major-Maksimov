import type { AutomaticDeleteAuthorAccessService } from '../max/automatic-delete-author-access.service';
import { ConfigService } from '@nestjs/config';
import { stopWordsPolicySchema } from '@maxim/contracts/settings';
import {
  MessageLimitsDeleteGuardService,
  bindMessageLimitEvidence,
  fingerprintModerationSettings,
} from './message-limits-delete-guard.service';

const input = {
  chatId: '-123',
  messageId: 'message-1',
  subjectUserId: 'user-1',
  botId: 'executor-b',
  reasons: [{ ruleCode: 'MESSAGE_TOO_LONG_DELETE', reasonKey: 'length' }],
};

function fixture(authorAccess?: Pick<AutomaticDeleteAuthorAccessService, 'resolve'>) {
  const settings = {
    maxMessageLengthEnabled: true,
    maxMessageLength: 10,
    phoneNumbersEnabled: true,
    photoMessagesEnabled: true,
    videoMessagesEnabled: true,
    fileMessagesEnabled: true,
    voiceMessagesEnabled: true,
    forwardedMessagesEnabled: true,
    nightModeTimezone: 'UTC',
    chat: { entityType: 'CHAT', admins: [] as { userId: string }[] },
  };
  const message = {
    sender: { user_id: 'user-1' },
    recipient: { chat_id: '-123', chat_type: 'chat' },
    timestamp: Date.now(),
    body: { mid: 'message-1', text: '12345678901' },
  };
  const prisma = {
    chatSettings: { findUnique: jest.fn(async () => settings) },
    moderationVoiceSource: { findUnique: jest.fn<Promise<unknown>, [unknown]>(async () => null) },
  };
  const max = {
    getChatMemberAccess: jest.fn(async () => ({
      userId: 'user-1',
      isAdmin: false,
      isOwner: false,
    })),
    getExactMessageRow: jest.fn(async () => message as unknown),
  };
  const bots = { isKnownBotUserId: jest.fn(() => false) };
  const immunity = { consumeForMessage: jest.fn(async () => 'not_granted') };
  const service = new MessageLimitsDeleteGuardService(
    prisma as never,
    max as never,
    bots as never,
    immunity as never,
    new ConfigService(),
    authorAccess as AutomaticDeleteAuthorAccessService | undefined,
  );
  return { service, max, settings, message, immunity, prisma, bots };
}

describe('saved role protection with independent membership evidence', () => {
  it.each([false, true])('retains current-member eligibility, absent=%s', async (absent) => {
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
    const h = fixture({ resolve });
    if (absent) {
      await expect(h.service.authorize(input)).rejects.toMatchObject({
        code: 'message_limits_delete_no_longer_authorized',
      });
      expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
      expect(h.immunity.consumeForMessage).not.toHaveBeenCalled();
    } else {
      await expect(h.service.authorize(input)).resolves.toEqual({ reasonKeys: ['length'] });
    }
    expect(h.max.getChatMemberAccess).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith(
      '-123',
      'user-1',
      expect.objectContaining({ botId: 'executor-b' }),
      { requireMembership: true, module: 'messageLimits' },
    );
  });
});

describe('native voice authority without MAX message GET', () => {
  function voiceFixture() {
    const s = fixture();
    s.settings.voiceMessagesEnabled = false;
    const sourceMessageAt = new Date();
    const deadlineAtMs = sourceMessageAt.getTime() + 5 * 60_000;
    const source = {
      userId: 'user-1',
      receiptId: 'receipt',
      sourceAt: sourceMessageAt,
      deadlineAt: new Date(deadlineAtMs),
      invalidatedAt: null as Date | null,
    };
    s.prisma.moderationVoiceSource.findUnique.mockResolvedValue(source);
    s.max.getExactMessageRow.mockRejectedValue(new Error('MAX voice GET unavailable'));
    const request = {
      ...input,
      sourceMessageAt,
      reasons: [
        {
          reasonKey: 'voice',
          ruleCode: 'VOICE_BLOCKED_DELETE',
          metadata: {
            voiceSourceEvidenceVersion: 1,
            voiceSourceAtMs: sourceMessageAt.getTime(),
            voiceSourceDeadlineAtMs: deadlineAtMs,
            voiceSourcePolicySha256: fingerprintModerationSettings(
              s.settings,
              'VOICE_BLOCKED_DELETE',
            ),
          },
        },
      ],
    };
    return { ...s, source, request, deadlineAtMs };
  }
  it('authorizes exactly voice, including on retry, under its immutable deadline', async () => {
    const s = voiceFixture();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        s.service.authorize({ ...s.request, reasons: [...s.request.reasons, ...input.reasons] }),
      ).resolves.toEqual({
        reasonKeys: ['voice'],
        deadlineAtMs: s.deadlineAtMs,
        reasonDeadlines: [{ reasonKey: 'voice', deadlineAtMs: s.deadlineAtMs }],
      });
    }
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    expect(s.max.getChatMemberAccess).toHaveBeenCalledTimes(2);
  });
  it.each([
    'missing',
    'invalidated',
    'expired',
    'wrong-author',
    'wrong-time',
    'wrong-policy',
    'enabled',
    'admin',
    'immunity',
    'late-edit',
    'late-policy',
  ])('denies %s source without substituting an empty GET for deletion proof', async (kind) => {
    const s = voiceFixture();
    if (kind === 'missing') s.prisma.moderationVoiceSource.findUnique.mockResolvedValue(null);
    if (kind === 'invalidated') s.source.invalidatedAt = new Date();
    if (kind === 'wrong-author') s.source.userId = 'other';
    if (kind === 'wrong-time') s.request.sourceMessageAt = new Date(0);
    if (kind === 'wrong-policy') s.request.reasons[0]!.metadata.voiceSourcePolicySha256 = 'invalid';
    if (kind === 'expired') {
      s.source.sourceAt = new Date(Date.now() - 300001);
      s.source.deadlineAt = new Date(Date.now() - 1);
    }
    if (kind === 'enabled') s.settings.voiceMessagesEnabled = true;
    if (kind === 'admin')
      s.max.getChatMemberAccess.mockResolvedValue({
        userId: 'user-1',
        isAdmin: true,
        isOwner: false,
      });
    if (kind === 'immunity') s.immunity.consumeForMessage.mockResolvedValue('granted');
    if (kind === 'late-edit' || kind === 'late-policy')
      s.immunity.consumeForMessage.mockImplementation(async () => {
        if (kind === 'late-edit') s.source.invalidatedAt = new Date();
        else s.settings.voiceMessagesEnabled = true;
        return 'not_granted';
      });
    await expect(s.service.authorize(s.request)).rejects.toMatchObject({
      code: 'message_limits_delete_no_longer_authorized',
    });
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
  });
  it('does not convert missing author rights into permission', async () => {
    const s = voiceFixture();
    const failure = new Error('members unavailable');
    s.max.getChatMemberAccess.mockRejectedValue(failure);
    await expect(s.service.authorize(s.request)).rejects.toBe(failure);
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
  });
});

describe('current message limit deletion authorization', () => {
  it.each(['', null])(
    'rejects a cleared current body (%j) even when a stale alias is long',
    async (text) => {
      const s = fixture();
      Object.assign(s.message.body, { text });
      Object.assign(s.message, { text: 'old content'.repeat(100) });
      await expect(s.service.authorize(input)).rejects.toMatchObject({
        code: 'message_limits_delete_no_longer_authorized',
      });
    },
  );
  it.each([9, 10, 11])(
    'rechecks %i visible characters at the actual DELETE boundary',
    async (length) => {
      const s = fixture();
      s.message.body.text = '👨‍👩‍👧‍👦'.repeat(length);
      if (length > 10)
        await expect(s.service.authorize(input)).resolves.toEqual({ reasonKeys: ['length'] });
      else
        await expect(s.service.authorize(input)).rejects.toMatchObject({
          code: 'message_limits_delete_no_longer_authorized',
        });
    },
  );

  it.each(['forward', 'reply'])(
    'rejects an old length reason caused by %s metadata/quoted text',
    async (type) => {
      const s = fixture();
      s.message.body.text = type === 'reply' ? 'Да' : '';
      Object.assign(s.message, {
        link: {
          type,
          message: {
            text: type === 'reply' ? 'x'.repeat(100) : 'Привет',
            mid: 'x'.repeat(100),
            attachments: [{ type: 'photo', payload: { token: 'x'.repeat(100) } }],
          },
        },
      });
      await expect(s.service.authorize(input)).rejects.toMatchObject({
        code: 'message_limits_delete_no_longer_authorized',
      });
    },
  );
  it('normalizes full settings and a semantic DTO and ignores unrelated UI changes', () => {
    const subset = {
      maxMessageLengthEnabled: true,
      maxMessageLength: 10,
      messageLimitsWarnEnabled: true,
    };
    const full = {
      ...subset,
      id: 'row',
      updatedAt: new Date(),
      greetingEnabled: true,
      publisherAutoReplyEnabled: true,
    };
    expect(fingerprintModerationSettings(full, 'MESSAGE_TOO_LONG_DELETE')).toBe(
      fingerprintModerationSettings(subset, 'MESSAGE_TOO_LONG'),
    );
    expect(
      fingerprintModerationSettings(
        { ...full, greetingEnabled: false, updatedAt: new Date(0) },
        'MESSAGE_TOO_LONG',
      ),
    ).toBe(fingerprintModerationSettings(full, 'MESSAGE_TOO_LONG'));
    expect(
      fingerprintModerationSettings({ ...full, maxMessageLength: 20 }, 'MESSAGE_TOO_LONG'),
    ).not.toBe(fingerprintModerationSettings(full, 'MESSAGE_TOO_LONG'));
  });

  it('rejects attempts-based count evidence after the admitted-publication policy upgrade', async () => {
    const s = fixture();
    Object.assign(s.settings, {
      messageCountLimitEnabled: true,
      messageCountLimitMessages: 2,
      messageCountLimitWindowHours: 1,
      messageLimitsBotMessageEnabled: true,
      messageLimitsWarnEnabled: true,
      messageLimitsMuteEnabled: false,
      messageLimitsBanEnabled: true,
      messageLimitsMuteDurationHours: 6,
    });
    const legacyPolicy = 'aa83147a83850e30f5bcc1e25692a5f17215c7515ec77a0c469ef81ab35a0a4c';
    const metadata = bindMessageLimitEvidence(
      s.settings as never,
      Date.now(),
      'MESSAGE_COUNT_LIMIT',
    );
    expect(metadata.messageLimitPolicySha256).not.toBe(legacyPolicy);
    const reason = { ruleCode: 'MESSAGE_COUNT_LIMIT_DELETE', reasonKey: 'count', metadata };
    await expect(s.service.authorize({ ...input, reasons: [reason] })).resolves.toMatchObject({
      reasonKeys: ['count'],
    });
    await expect(
      s.service.authorize({
        ...input,
        reasons: [{ ...reason, metadata: { ...metadata, messageLimitPolicySha256: legacyPolicy } }],
      }),
    ).rejects.toMatchObject({ code: 'message_limits_delete_no_longer_authorized' });
  });

  it.each(['MESSAGE_BLOCKED_WORD', 'MESSAGE_BLOCKED_DOMAIN'])(
    'binds %s sanctions to the settings actually used by legacy and configured policies',
    (rule) => {
      const legacy = {
        stopWordsPolicy: null,
        stopWordsRevision: 0,
        messageLimitsBlockedWords: ['casino'],
        messageLimitsBlockedDomains: ['spam.test'],
        textFiltersWarnEnabled: true,
        textFiltersMuteEnabled: true,
        textFiltersBanEnabled: true,
        textFiltersMuteDurationHours: 1,
        messageLimitsWarnEnabled: true,
        messageLimitsMuteEnabled: true,
        messageLimitsBanEnabled: true,
        messageLimitsMuteDurationHours: 1,
      };
      const original = fingerprintModerationSettings(legacy, rule);
      for (const patch of [
        { messageLimitsWarnEnabled: false },
        { messageLimitsMuteEnabled: false },
        { messageLimitsBanEnabled: false },
        { messageLimitsMuteDurationHours: 2 },
      ])
        expect(fingerprintModerationSettings({ ...legacy, ...patch }, rule)).not.toBe(original);
      for (const patch of [
        { textFiltersWarnEnabled: false },
        { textFiltersMuteEnabled: false },
        { textFiltersBanEnabled: false },
        { textFiltersMuteDurationHours: 2 },
      ])
        expect(fingerprintModerationSettings({ ...legacy, ...patch }, rule)).toBe(original);
      const stopWordsPolicy = stopWordsPolicySchema.parse({
        enabled: true,
        rules: [{ id: 'casino', kind: 'WORD', value: 'casino' }],
        sanctions: { warnEnabled: true },
      });
      const configured = { ...legacy, stopWordsPolicy };
      expect(
        fingerprintModerationSettings({ ...configured, textFiltersWarnEnabled: false }, rule),
      ).toBe(fingerprintModerationSettings(configured, rule));
      expect(
        fingerprintModerationSettings({ ...configured, messageLimitsBanEnabled: false }, rule),
      ).toBe(fingerprintModerationSettings(configured, rule));
      expect(
        fingerprintModerationSettings(
          {
            ...configured,
            stopWordsPolicy: {
              ...stopWordsPolicy,
              sanctions: { ...stopWordsPolicy.sanctions, warnEnabled: false },
            },
          },
          rule,
        ),
      ).not.toBe(fingerprintModerationSettings(configured, rule));
    },
  );

  it.each(['MESSAGE_RATE_LIMIT', 'MESSAGE_COUNT_LIMIT', 'PHOTO_RATE_LIMIT', 'STICKER_RATE_LIMIT'])(
    'requires unchanged bounded evidence for %s without counting a retry',
    async (rule) => {
      const s = fixture();
      Object.assign(s.settings, {
        antiSpamEnabled: true,
        messageCountLimitEnabled: true,
        messageCountLimitMessages: 2,
        messageCountLimitWindowHours: 1,
        photoMessageCooldownEnabled: true,
        photoMessageCooldownHours: 1,
        stickerMessageCooldownEnabled: true,
        stickerMessageCooldownMinutes: 5,
      });
      if (rule === 'PHOTO_RATE_LIMIT')
        Object.assign(s.message.body, {
          attachments: [{ type: 'image', payload: { photo_id: 'p1' } }],
        });
      if (rule === 'STICKER_RATE_LIMIT')
        Object.assign(s.message.body, {
          attachments: [{ type: 'sticker', payload: { code: 's1' } }],
        });
      const metadata = bindMessageLimitEvidence(s.settings as never, Date.now(), rule);
      const reasons = [{ reasonKey: 'rate', ruleCode: `${rule}_DELETE`, metadata }];
      await expect(s.service.authorize({ ...input, reasons })).resolves.toEqual({
        reasonKeys: ['rate'],
        deadlineAtMs: metadata.messageLimitDeadlineAtMs,
        reasonDeadlines: [{ reasonKey: 'rate', deadlineAtMs: metadata.messageLimitDeadlineAtMs }],
      });
      await expect(s.service.authorize({ ...input, reasons })).resolves.toEqual({
        reasonKeys: ['rate'],
        deadlineAtMs: metadata.messageLimitDeadlineAtMs,
        reasonDeadlines: [{ reasonKey: 'rate', deadlineAtMs: metadata.messageLimitDeadlineAtMs }],
      });
      Object.assign(
        s.settings,
        rule === 'MESSAGE_RATE_LIMIT'
          ? { antiSpamEnabled: false }
          : rule === 'MESSAGE_COUNT_LIMIT'
            ? { messageCountLimitMessages: 5 }
            : rule === 'PHOTO_RATE_LIMIT'
              ? { photoMessageCooldownEnabled: false }
              : { stickerMessageCooldownEnabled: false },
      );
      await expect(s.service.authorize({ ...input, reasons })).rejects.toMatchObject({
        code: 'message_limits_delete_no_longer_authorized',
      });
    },
  );

  it('retains a rate reason deadline when current content independently authorizes deletion', async () => {
    const s = fixture();
    Object.assign(s.settings, { antiSpamEnabled: true });
    const metadata = bindMessageLimitEvidence(
      s.settings as never,
      Date.now(),
      'MESSAGE_RATE_LIMIT',
    );
    const reasons = [
      ...input.reasons,
      { ruleCode: 'MESSAGE_RATE_LIMIT_DELETE', reasonKey: 'rate', metadata },
    ];
    await expect(s.service.authorize({ ...input, reasons })).resolves.toEqual({
      reasonKeys: ['length', 'rate'],
      reasonDeadlines: [{ reasonKey: 'rate', deadlineAtMs: metadata.messageLimitDeadlineAtMs }],
    });
    s.settings.maxMessageLengthEnabled = false;
    await expect(s.service.authorize({ ...input, reasons })).resolves.toEqual({
      reasonKeys: ['rate'],
      deadlineAtMs: metadata.messageLimitDeadlineAtMs,
      reasonDeadlines: [{ reasonKey: 'rate', deadlineAtMs: metadata.messageLimitDeadlineAtMs }],
    });
  });

  it('rejects historical frequency reasons without evidence and expired evidence', async () => {
    const s = fixture();
    Object.assign(s.settings, { antiSpamEnabled: true });
    const reason = { ruleCode: 'MESSAGE_RATE_LIMIT_DELETE', reasonKey: 'burst' };
    await expect(s.service.authorize({ ...input, reasons: [reason] })).rejects.toMatchObject({
      code: 'message_limits_delete_no_longer_authorized',
    });
    const metadata = bindMessageLimitEvidence(
      s.settings as never,
      Date.now() - 5 * 60_000,
      'MESSAGE_RATE_LIMIT',
    );
    await expect(
      s.service.authorize({ ...input, reasons: [{ ...reason, metadata }] }),
    ).rejects.toMatchObject({ code: 'message_limits_delete_no_longer_authorized' });
  });

  it.each(['MESSAGE_RATE_LIMIT', 'MESSAGE_COUNT_LIMIT', 'PHOTO_RATE_LIMIT', 'STICKER_RATE_LIMIT'])(
    'rejects expired %s authority before unavailable MAX reads',
    async (rule) => {
      const s = fixture();
      Object.assign(s.settings, {
        antiSpamEnabled: true,
        messageCountLimitEnabled: true,
        messageCountLimitMessages: 2,
        messageCountLimitWindowHours: 1,
        photoMessageCooldownEnabled: true,
        photoMessageCooldownHours: 1,
        stickerMessageCooldownEnabled: true,
        stickerMessageCooldownMinutes: 5,
      });
      const metadata = bindMessageLimitEvidence(s.settings as never, Date.now() - 360_000, rule);
      s.max.getChatMemberAccess.mockRejectedValue(new Error('MAX author unavailable'));
      s.max.getExactMessageRow.mockRejectedValue(new Error('MAX source unavailable'));
      await expect(
        s.service.authorize({
          ...input,
          reasons: [{ ruleCode: `${rule}_DELETE`, reasonKey: 'expired', metadata }],
        }),
      ).rejects.toMatchObject({ code: 'message_limits_delete_no_longer_authorized' });
      expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
      expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    },
  );

  it('preserves current content and live stateful reasons beside expired authority', async () => {
    const s = fixture();
    Object.assign(s.settings, { antiSpamEnabled: true });
    const expired = bindMessageLimitEvidence(
      s.settings as never,
      Date.now() - 360_000,
      'MESSAGE_RATE_LIMIT',
    );
    const live = bindMessageLimitEvidence(s.settings as never, Date.now(), 'MESSAGE_RATE_LIMIT');
    const expiredReason = {
      ruleCode: 'MESSAGE_RATE_LIMIT_DELETE',
      reasonKey: 'expired',
      metadata: expired,
    };
    await expect(
      s.service.authorize({ ...input, reasons: [expiredReason, ...input.reasons] }),
    ).resolves.toEqual({ reasonKeys: ['length'] });
    await expect(
      s.service.authorize({
        ...input,
        reasons: [
          expiredReason,
          { ruleCode: 'MESSAGE_RATE_LIMIT_DELETE', reasonKey: 'live', metadata: live },
        ],
      }),
    ).resolves.toEqual({
      reasonKeys: ['live'],
      deadlineAtMs: live.messageLimitDeadlineAtMs,
      reasonDeadlines: [{ reasonKey: 'live', deadlineAtMs: live.messageLimitDeadlineAtMs }],
    });
    expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(2);
  });

  it('rechecks the original stateful deadline after preparation', async () => {
    const s = fixture();
    Object.assign(s.settings, { antiSpamEnabled: true });
    const metadata = bindMessageLimitEvidence(
      s.settings as never,
      Date.now(),
      'MESSAGE_RATE_LIMIT',
    );
    const clock = jest.spyOn(Date, 'now');
    s.immunity.consumeForMessage.mockImplementation(async () => {
      clock.mockReturnValue(metadata.messageLimitDeadlineAtMs);
      return 'not_granted';
    });
    try {
      await expect(
        s.service.authorize({
          ...input,
          reasons: [{ ruleCode: 'MESSAGE_RATE_LIMIT_DELETE', reasonKey: 'rate', metadata }],
        }),
      ).rejects.toMatchObject({ code: 'message_limits_delete_no_longer_authorized' });
      expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['malformed', 'changed-policy', 'future-event'] as const)(
    'preserves unavailable-source handling for %s evidence',
    async (kind) => {
      const s = fixture();
      Object.assign(s.settings, { antiSpamEnabled: true });
      const metadata = bindMessageLimitEvidence(
        s.settings as never,
        Date.now() + (kind === 'future-event' ? 60_000 : -360_000),
        'MESSAGE_RATE_LIMIT',
      );
      if (kind === 'malformed') metadata.messageLimitDeadlineAtMs += 1;
      if (kind === 'changed-policy') metadata.messageLimitPolicySha256 = 'different-policy';
      const unavailable = new Error('MAX source unavailable');
      s.max.getExactMessageRow.mockRejectedValue(unavailable);
      await expect(
        s.service.authorize({
          ...input,
          reasons: [{ ruleCode: 'MESSAGE_RATE_LIMIT_DELETE', reasonKey: 'rate', metadata }],
        }),
      ).rejects.toBe(unavailable);
      expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(1);
    },
  );

  it.each([1, 4, 9, 13])('uses the selected executor for %s receiving bots', async (count) => {
    const s = fixture();
    for (let receiver = 0; receiver < count; receiver++) {
      expect(await s.service.authorize(input)).toEqual({ reasonKeys: ['length'] });
    }
    expect(s.max.getExactMessageRow.mock.calls).toHaveLength(count);
    expect(s.max.getExactMessageRow).toHaveBeenCalledWith(
      '-123',
      'message-1',
      expect.objectContaining({ botId: 'executor-b', bypassCache: true }),
    );
  });

  it.each(['edit', 'disabled', 'raised', 'changed-during-check'] as const)(
    'cancels a delayed length reason after %s',
    async (change) => {
      const s = fixture();
      if (change === 'edit') s.message.body.text = 'short';
      if (change === 'disabled') s.settings.maxMessageLengthEnabled = false;
      if (change === 'raised') s.settings.maxMessageLength = 50;
      if (change === 'changed-during-check')
        s.immunity.consumeForMessage.mockImplementation(async () => {
          s.settings.maxMessageLengthEnabled = false;
          return 'not_granted';
        });
      await expect(s.service.authorize(input)).rejects.toMatchObject({
        code: 'message_limits_delete_no_longer_authorized',
      });
    },
  );

  it('includes nested forwarded text in the current effective length', async () => {
    const s = fixture();
    s.message.body.text = '';
    Object.assign(s.message, {
      link: { type: 'forward', message: { body: { text: '12345678901' } } },
    });
    await expect(s.service.authorize(input)).resolves.toEqual({ reasonKeys: ['length'] });
  });

  it.each(['admin', 'local-admin', 'bot', 'immunity', 'wrong-author', 'channel'] as const)(
    'rejects protected or mismatched %s',
    async (kind) => {
      const s = fixture();
      if (kind === 'admin')
        s.max.getChatMemberAccess.mockResolvedValue({
          userId: 'user-1',
          isAdmin: true,
          isOwner: false,
        });
      if (kind === 'local-admin') s.settings.chat.admins.push({ userId: 'user-1' });
      if (kind === 'bot') s.bots.isKnownBotUserId.mockReturnValue(true);
      if (kind === 'immunity') s.immunity.consumeForMessage.mockResolvedValue('granted');
      if (kind === 'wrong-author') s.message.sender.user_id = 'other';
      if (kind === 'channel') s.message.recipient.chat_type = 'channel';
      await expect(s.service.authorize(input)).rejects.toMatchObject({
        code: 'message_limits_delete_no_longer_authorized',
      });
    },
  );

  it('never reclassifies unavailable remote evidence as a stale reason', async () => {
    const s = fixture();
    const error = Object.assign(new Error('unavailable'), { response: { status: 503 } });
    s.max.getExactMessageRow.mockRejectedValue(error);
    await expect(s.service.authorize(input)).rejects.toBe(error);
  });

  it.each([
    { userId: null, isAdmin: false, isOwner: false },
    { userId: 'other', isAdmin: false, isOwner: false },
    { userId: 'user-1', isAdmin: undefined, isOwner: false },
    { userId: 'user-1', isAdmin: false, isOwner: undefined },
  ])('stops all deletion reasons when fresh author access is incomplete: %p', async (access) => {
    const s = fixture();
    s.max.getChatMemberAccess.mockResolvedValue(access as never);
    await expect(s.service.authorize(input)).rejects.toThrow(
      'Message limits author access unavailable',
    );
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it.each([' ', '\n'])('authorizes adjacent current phones separated by %j', async (separator) => {
    const s = fixture();
    s.settings.phoneNumbersEnabled = false;
    s.message.body.text = `8 (999) 123-45-67${separator}8 (999) 111-22-33`;
    await expect(
      s.service.authorize({
        ...input,
        reasons: [{ ruleCode: 'PHONE_NUMBER_BLOCKED_DELETE', reasonKey: 'phone' }],
      }),
    ).resolves.toEqual({ reasonKeys: ['phone'] });
  });

  it.each([
    'https://example.com/orders/79991234567',
    'https://example.com/orders/(79991234567)',
    'tel:+79991234567',
    'sms:+79991234567',
    'https://wa.me/79991234567',
    'ИНН 9991234567',
    'Артикул 89991234567',
    'ИНН 1234 5678 9012',
    'Артикул 8 (999) 123-45-67',
  ])('revokes a stale phone reason after the current source becomes %s', async (text) => {
    const s = fixture();
    s.settings.phoneNumbersEnabled = false;
    const request = {
      ...input,
      reasons: [{ ruleCode: 'PHONE_NUMBER_BLOCKED_DELETE', reasonKey: 'phone' }],
    };
    s.message.body.text = '8 (999) 123-45-67';
    await expect(s.service.authorize(request)).resolves.toEqual({ reasonKeys: ['phone'] });
    s.message.body.text = text;
    await expect(s.service.authorize(request)).rejects.toMatchObject({
      code: 'message_limits_delete_no_longer_authorized',
    });
    s.message.body.text += ' 8 (999) 111-22-33';
    await expect(s.service.authorize(request)).resolves.toEqual({ reasonKeys: ['phone'] });
  });

  it.each(['enabled', 'admin'])('revokes genuine phone authority when %s changes', async (kind) => {
    const s = fixture();
    s.settings.phoneNumbersEnabled = false;
    s.message.body.text = '8 (999) 123-45-67';
    const request = {
      ...input,
      reasons: [{ ruleCode: 'PHONE_NUMBER_BLOCKED_DELETE', reasonKey: 'phone' }],
    };
    await expect(s.service.authorize(request)).resolves.toEqual({ reasonKeys: ['phone'] });
    if (kind === 'enabled') s.settings.phoneNumbersEnabled = true;
    else
      s.max.getChatMemberAccess.mockResolvedValue({
        userId: 'user-1',
        isAdmin: true,
        isOwner: false,
      });
    await expect(s.service.authorize(request)).rejects.toMatchObject({
      code: 'message_limits_delete_no_longer_authorized',
    });
  });

  it('retains only the independent length reason when the current phone is exempt', async () => {
    const s = fixture();
    s.settings.phoneNumbersEnabled = false;
    s.message.body.text = 'Артикул 89991234567';
    await expect(
      s.service.authorize({
        ...input,
        reasons: [
          ...input.reasons,
          { ruleCode: 'PHONE_NUMBER_BLOCKED_DELETE', reasonKey: 'phone' },
        ],
      }),
    ).resolves.toEqual({ reasonKeys: ['length'] });
  });

  it('checks phones and attachment reasons independently against current settings', async () => {
    const s = fixture();
    s.settings.maxMessageLengthEnabled = false;
    s.settings.phoneNumbersEnabled = false;
    s.message.body.text = 'Телефон +7 999 123-45-67';
    const reasons = [
      ...input.reasons,
      { ruleCode: 'PHONE_NUMBER_BLOCKED_DELETE', reasonKey: 'phone' },
    ];
    await expect(s.service.authorize({ ...input, reasons })).resolves.toEqual({
      reasonKeys: ['phone'],
    });
    s.message.body.text = '';
    s.settings.photoMessagesEnabled = false;
    Object.assign(s.message.body, {
      attachments: [{ type: 'image', payload: { photo_id: 'photo' } }],
    });
    await expect(
      s.service.authorize({
        ...input,
        reasons: [{ ruleCode: 'PHOTO_BLOCKED_DELETE', reasonKey: 'photo' }],
      }),
    ).resolves.toEqual({ reasonKeys: ['photo'] });
    s.settings.photoMessagesEnabled = true;
    await expect(
      s.service.authorize({
        ...input,
        reasons: [{ ruleCode: 'PHOTO_BLOCKED_DELETE', reasonKey: 'photo' }],
      }),
    ).rejects.toMatchObject({ code: 'message_limits_delete_no_longer_authorized' });
  });
});
