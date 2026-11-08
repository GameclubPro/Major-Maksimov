import type { AutomaticDeleteAuthorAccessService } from '../max/automatic-delete-author-access.service';
import { bindStateVoiceSource } from './state-voice-delete-source';
import { ConfigService } from '@nestjs/config';
import { ClosedChatDeleteGuardService } from './closed-chat-delete-guard.service';

const now = Date.parse('2026-10-05T00:04:00Z');
const sourceAt = new Date(now - 60_000);
const nightReason = {
  ruleCode: 'NIGHT_MODE_DELETE',
  reasonKey: 'night',
  metadata: { nightModeTimezone: 'UTC', nightModeStartTime: '23:00', nightModeEndTime: '08:00' },
};
const input = {
  chatId: '-123',
  messageId: 'm1',
  subjectUserId: 'u1',
  sourceMessageAt: sourceAt,
  botId: 'reserve-last',
  reasons: [nightReason],
};

function fixture(authorAccess?: Pick<AutomaticDeleteAuthorAccessService, 'resolve'>) {
  const settings = {
    nightModeEnabled: true,
    nightModeStartTimeMinutes: 1380,
    nightModeEndTimeMinutes: 480,
    nightModeTimezone: 'UTC',
    nightModeForceCloseEnabled: false,
    nightModeForceCloseForever: false,
    nightModeForceCloseUntil: '',
    chat: {
      entityType: 'CHAT',
      admins: [] as { userId: string }[],
      chatControlOrderAt: null as Date | null,
    },
  };
  const row = {
    sender: { user_id: 'u1' },
    recipient: { chat_id: '-123', chat_type: 'chat' },
    timestamp: sourceAt.getTime(),
    body: { mid: 'm1', text: 'hello' },
  };
  const prisma = { chatSettings: { findUnique: jest.fn(async () => settings) } };
  const max = {
    getChatMemberAccess: jest.fn(async () => ({ userId: 'u1', isAdmin: false, isOwner: false })),
    getExactMessageRow: jest.fn(async () => row as unknown),
  };
  const bots = { isKnownBotUserId: jest.fn(() => false) };
  const immunity = { consumeForMessage: jest.fn(async () => 'not_granted') };
  const guard = new ClosedChatDeleteGuardService(
    prisma as never,
    max as never,
    bots as never,
    immunity as never,
    new ConfigService(),
    authorAccess as AutomaticDeleteAuthorAccessService | undefined,
  );
  return { settings, row, prisma, max, bots, immunity, guard };
}

describe('closed-chat final delete authority', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(now);
  });
  afterEach(() => jest.useRealTimers());

  it.each([false, true])(
    'uses saved roles but retains the closed-chat member requirement, absent=%s',
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
          member: absent ? null : { userId: 'u1', isAdmin: true, isOwner: false, permissions: [] },
        });
      const h = fixture({ resolve });
      if (absent) {
        await expect(h.guard.authorize(input)).rejects.toMatchObject({
          code: 'closed_chat_delete_no_longer_authorized',
        });
        expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
        expect(h.immunity.consumeForMessage).not.toHaveBeenCalled();
      } else {
        await expect(h.guard.authorize(input)).resolves.toMatchObject({ reasonKeys: ['night'] });
      }
      expect(h.max.getChatMemberAccess).not.toHaveBeenCalled();
    },
  );

  function voiceFixture() {
    const h = fixture();
    const stored = {
      userId: 'u1',
      sourceAt,
      deadlineAt: new Date(sourceAt.getTime() + 300_000),
      receiptId: 'authenticated-receipt',
      invalidatedAt: null as Date | null,
    };
    const read = jest.fn(async () => stored as typeof stored | null);
    Object.assign(h.prisma, { moderationVoiceSource: { findUnique: read } });
    const bound = bindStateVoiceSource(
      {
        ...input,
        ruleCode: 'NIGHT_MODE_DELETE',
        reasonKey: 'night',
        event: { metadata: nightReason.metadata },
      },
      {
        kind: 'created',
        chatId: input.chatId,
        messageId: input.messageId,
        userId: input.subjectUserId,
        sourceAtMs: sourceAt.getTime(),
        deadlineAtMs: stored.deadlineAt.getTime(),
      },
    );
    h.max.getExactMessageRow.mockRejectedValue(new Error('Voice unavailable through GET'));
    return {
      ...h,
      stored,
      read,
      voiceInput: { ...input, reasons: [{ ...nightReason, metadata: bound.event!.metadata }] },
    };
  }
  it('deletes voice using authenticated source and the current night session', async () => {
    const h = voiceFixture();
    await expect(h.guard.authorize(h.voiceInput)).resolves.toMatchObject({ reasonKeys: ['night'] });
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });
  it.each([
    'missing',
    'edited',
    'author',
    'time',
    'receipt',
    'deadline',
    'admin',
    'immunity',
    'opened',
  ])('refuses native voice after %s', async (change) => {
    const h = voiceFixture();
    if (change === 'missing') h.read.mockResolvedValue(null);
    if (change === 'edited') h.stored.invalidatedAt = new Date();
    if (change === 'author') h.stored.userId = 'other';
    if (change === 'time') h.stored.sourceAt = new Date(0);
    if (change === 'receipt') h.stored.receiptId = '';
    if (change === 'deadline') h.stored.deadlineAt = new Date(now + 500_000);
    if (change === 'admin')
      h.max.getChatMemberAccess.mockResolvedValue({ userId: 'u1', isAdmin: true, isOwner: false });
    if (change === 'immunity') h.immunity.consumeForMessage.mockResolvedValue('granted');
    if (change === 'opened') h.settings.nightModeEnabled = false;
    await expect(h.guard.authorize(h.voiceInput)).rejects.toMatchObject({
      code: 'closed_chat_delete_no_longer_authorized',
    });
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });
  it.each(['edit', 'open', 'reclose'])(
    'rechecks voice and closure after awaited immunity: %s',
    async (change) => {
      const h = voiceFixture();
      h.immunity.consumeForMessage.mockImplementation(async () => {
        if (change === 'edit') h.stored.invalidatedAt = new Date();
        if (change === 'open') h.settings.nightModeEnabled = false;
        if (change === 'reclose') h.settings.chat.chatControlOrderAt = new Date(now);
        return 'not_granted';
      });
      await expect(h.guard.authorize(h.voiceInput)).rejects.toMatchObject({
        code: 'closed_chat_delete_no_longer_authorized',
      });
    },
  );

  it('reads the exact author/message through the replacement executor', async () => {
    const h = fixture();
    await expect(h.guard.authorize(input)).resolves.toEqual({
      reasonKeys: ['night'],
      deadlineAtMs: sourceAt.getTime() + 300_000,
      reasonDeadlines: [{ reasonKey: 'night', deadlineAtMs: sourceAt.getTime() + 300_000 }],
    });
    expect(h.max.getChatMemberAccess).toHaveBeenCalledWith(
      '-123',
      'u1',
      expect.objectContaining({ botId: 'reserve-last', bypassCache: true }),
    );
    expect(h.max.getExactMessageRow).toHaveBeenCalledWith(
      '-123',
      'm1',
      expect.objectContaining({ botId: 'reserve-last' }),
    );
  });

  it.each([
    'disabled',
    'opened',
    'new-session',
    'schedule',
    'future',
    'deadline',
    'reclosed',
  ] as const)('rejects a saved night reason after %s', async (change) => {
    const h = fixture();
    let source = sourceAt;
    if (change === 'disabled') h.settings.nightModeEnabled = false;
    if (change === 'opened') jest.setSystemTime(Date.parse('2026-10-05T08:00:00Z'));
    if (change === 'new-session') jest.setSystemTime(now + 24 * 60 * 60_000);
    if (change === 'schedule') h.settings.nightModeStartTimeMinutes = 22 * 60;
    if (change === 'future') source = new Date(now + 60_001);
    if (change === 'deadline') source = new Date(now - 300_000);
    if (change === 'reclosed') h.settings.chat.chatControlOrderAt = new Date(now - 30_000);
    await expect(h.guard.authorize({ ...input, sourceMessageAt: source })).rejects.toMatchObject({
      code: 'closed_chat_delete_no_longer_authorized',
    });
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it.each([
    'admin',
    'local-admin',
    'bot',
    'immunity',
    'wrong-author',
    'channel',
    'changed-source',
  ] as const)('protects %s at dispatch', async (change) => {
    const h = fixture();
    if (change === 'admin')
      h.max.getChatMemberAccess.mockResolvedValue({ userId: 'u1', isAdmin: true, isOwner: false });
    if (change === 'local-admin') h.settings.chat.admins.push({ userId: 'u1' });
    if (change === 'bot') h.bots.isKnownBotUserId.mockReturnValue(true);
    if (change === 'immunity') h.immunity.consumeForMessage.mockResolvedValue('granted');
    if (change === 'wrong-author') h.row.sender.user_id = 'another';
    if (change === 'channel') h.row.recipient.chat_type = 'channel';
    if (change === 'changed-source') h.row.timestamp += 1;
    await expect(h.guard.authorize(input)).rejects.toMatchObject({
      code: 'closed_chat_delete_no_longer_authorized',
    });
  });

  it('checks the policy again after remote work and immunity', async () => {
    const h = fixture();
    h.immunity.consumeForMessage.mockImplementation(async () => {
      h.settings.nightModeEnabled = false;
      return 'not_granted';
    });
    await expect(h.guard.authorize(input)).rejects.toMatchObject({
      code: 'closed_chat_delete_no_longer_authorized',
    });
  });

  it('cannot interpret unavailable author or message evidence as a policy rejection', async () => {
    const h = fixture();
    h.max.getChatMemberAccess.mockResolvedValue({
      userId: 'wrong',
      isAdmin: false,
      isOwner: false,
    });
    await expect(h.guard.authorize(input)).rejects.toThrow('Closed chat author access unavailable');
    h.max.getChatMemberAccess.mockResolvedValue({ userId: 'u1', isAdmin: false, isOwner: false });
    const error = new Error('MAX unavailable');
    h.max.getExactMessageRow.mockRejectedValue(error);
    await expect(h.guard.authorize(input)).rejects.toBe(error);
  });

  it('reports exact absence and ignores independently owned reasons', async () => {
    const h = fixture();
    h.max.getExactMessageRow.mockResolvedValue(null);
    await expect(h.guard.authorize(input)).resolves.toBe('absent');
    await expect(
      h.guard.authorize({
        ...input,
        reasons: [{ ruleCode: 'MESSAGE_TOO_LONG_DELETE', reasonKey: 'length', metadata: {} }],
      }),
    ).resolves.toBe('not_applicable');
  });

  it('expires timed manual closure at its absolute end and rejects a changed closure', async () => {
    const h = fixture();
    h.settings.nightModeForceCloseEnabled = true;
    h.settings.nightModeForceCloseUntil = new Date(now + 30_000).toISOString();
    const reason = {
      ruleCode: 'MANUAL_GROUP_CLOSE_DELETE',
      reasonKey: 'manual',
      metadata: { closeMode: 'timed', closeUntil: h.settings.nightModeForceCloseUntil },
    };
    await expect(h.guard.authorize({ ...input, reasons: [reason] })).resolves.toEqual({
      reasonKeys: ['manual'],
      deadlineAtMs: now + 30_000,
      reasonDeadlines: [{ reasonKey: 'manual', deadlineAtMs: now + 30_000 }],
    });
    h.settings.nightModeForceCloseUntil = new Date(now + 90_000).toISOString();
    await expect(h.guard.authorize({ ...input, reasons: [reason] })).rejects.toMatchObject({
      code: 'closed_chat_delete_no_longer_authorized',
    });
    h.settings.nightModeForceCloseUntil = reason.metadata.closeUntil;
    jest.setSystemTime(now + 30_000);
    await expect(h.guard.authorize({ ...input, reasons: [reason] })).rejects.toMatchObject({
      code: 'closed_chat_delete_no_longer_authorized',
    });
  });

  it('bounds night authorization by the opening boundary', async () => {
    const h = fixture();
    const boundaryNow = Date.parse('2026-10-05T07:59:30Z');
    jest.setSystemTime(boundaryNow);
    const source = new Date(boundaryNow - 60_000);
    h.row.timestamp = source.getTime();
    await expect(h.guard.authorize({ ...input, sourceMessageAt: source })).resolves.toEqual({
      reasonKeys: ['night'],
      deadlineAtMs: boundaryNow + 30_000,
      reasonDeadlines: [{ reasonKey: 'night', deadlineAtMs: boundaryNow + 30_000 }],
    });
  });

  it('keeps deletion authorized through a repeated hour and caps it at the union opening', async () => {
    const h = fixture();
    Object.assign(h.settings, {
      nightModeTimezone: 'Europe/Berlin',
      nightModeStartTimeMinutes: 150,
      nightModeEndTimeMinutes: 480,
    });
    const repeatedNow = Date.parse('2026-10-25T01:15:00Z');
    jest.setSystemTime(repeatedNow);
    const source = new Date(repeatedNow - 60_000);
    h.row.timestamp = source.getTime();
    const reasons = [
      {
        ...nightReason,
        metadata: {
          nightModeTimezone: 'Europe/Berlin',
          nightModeStartTime: '02:30',
          nightModeEndTime: '08:00',
        },
      },
    ];
    await expect(
      h.guard.authorize({ ...input, sourceMessageAt: source, reasons }),
    ).resolves.toMatchObject({ reasonKeys: ['night'] });
    Object.assign(h.settings, { nightModeStartTimeMinutes: 180, nightModeEndTimeMinutes: 150 });
    const unionNow = Date.parse('2026-03-30T00:29:30Z');
    jest.setSystemTime(unionNow);
    const unionSource = new Date(unionNow - 60_000);
    h.row.timestamp = unionSource.getTime();
    const unionReasons = [
      {
        ...nightReason,
        metadata: {
          nightModeTimezone: 'Europe/Berlin',
          nightModeStartTime: '03:00',
          nightModeEndTime: '02:30',
        },
      },
    ];
    await expect(
      h.guard.authorize({ ...input, sourceMessageAt: unionSource, reasons: unionReasons }),
    ).resolves.toMatchObject({ deadlineAtMs: unionNow + 30_000 });
    jest.setSystemTime(unionNow + 30_000);
    await expect(
      h.guard.authorize({ ...input, sourceMessageAt: unionSource, reasons: unionReasons }),
    ).rejects.toMatchObject({ code: 'closed_chat_delete_no_longer_authorized' });
  });

  it('keeps the timed manual end independent of the longer night authorization', async () => {
    const h = fixture();
    h.settings.nightModeForceCloseEnabled = true;
    h.settings.nightModeForceCloseUntil = new Date(now + 30_000).toISOString();
    const manual = {
      ruleCode: 'MANUAL_GROUP_CLOSE_DELETE',
      reasonKey: 'manual',
      metadata: { closeMode: 'timed', closeUntil: h.settings.nightModeForceCloseUntil },
    };
    await expect(h.guard.authorize({ ...input, reasons: [manual, nightReason] })).resolves.toEqual({
      reasonKeys: ['manual', 'night'],
      deadlineAtMs: sourceAt.getTime() + 300_000,
      reasonDeadlines: [
        { reasonKey: 'manual', deadlineAtMs: now + 30_000 },
        { reasonKey: 'night', deadlineAtMs: sourceAt.getTime() + 300_000 },
      ],
    });
    jest.setSystemTime(now + 30_000);
    await expect(h.guard.authorize({ ...input, reasons: [manual, nightReason] })).resolves.toEqual({
      reasonKeys: ['night'],
      deadlineAtMs: sourceAt.getTime() + 300_000,
      reasonDeadlines: [{ reasonKey: 'night', deadlineAtMs: sourceAt.getTime() + 300_000 }],
    });
  });
});
