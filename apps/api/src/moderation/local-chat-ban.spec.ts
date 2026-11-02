import type { MaxUpdate } from '@maxim/contracts';
import type { MaxClientService } from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import { usesMaxFinalAuthorityCheckpoint } from '../max/max-action-pre-dispatch-guard';
import {
  enforceLocalChatBan,
  LOCAL_CHAT_BAN_MODE,
  readActiveLocalChatBan,
  readLatestChatSanctionState,
} from './local-chat-ban';
import { ModerationSanctionStateLockLeaseLostError } from './moderation-sanction-state-lock.service';

type Context = Parameters<typeof enforceLocalChatBan>[2];
type SanctionState = NonNullable<Awaited<ReturnType<typeof readLatestChatSanctionState>>>;
type Event = SanctionState;

function fixture(kind: 'join' | 'message' = 'join') {
  const at = Date.now() - 1_000;
  let current: Event | null = {
    id: 'ban-1',
    ruleCode: 'MANUAL_BAN',
    action: 'BAN',
    operator: 'ADMIN',
    createdAt: new Date(at - 1_000),
    metadata: { mode: LOCAL_CHAT_BAN_MODE, initiatedByUserId: 'admin-1' },
  };
  const update: MaxUpdate = {
    updateId: 'receipt-1',
    type: kind === 'join' ? 'user_added' : 'message_created',
    message: {
      chatId: 'chat-1',
      messageId: 'source-1',
      senderId: 'user-1',
      createdAt: new Date(at).toISOString(),
      text: 'hello',
      entityType: 'chat',
    },
    ...(kind === 'join'
      ? { membership: { action: 'added' as const, memberUserIds: ['user-1'] } }
      : {}),
  };
  const chat = { entityType: 'CHAT', admins: [] as { userId: string }[] };
  const prisma = {
    $queryRaw: jest
      .fn<Promise<SanctionState[]>, Parameters<PrismaService['$queryRaw']>>()
      .mockImplementation(async () => (current ? [current] : [])),
    chat: { findUnique: jest.fn(async () => chat) },
  };
  const target = {
    userId: 'user-1',
    isAdmin: false,
    isOwner: false,
    isBot: false,
    permissions: [] as string[],
  };
  const max = {
    getChatMemberAccess: jest
      .fn<
        ReturnType<MaxClientService['getChatMemberAccess']>,
        Parameters<MaxClientService['getChatMemberAccess']>
      >()
      .mockResolvedValue(target),
    getCurrentChatMemberAccess: jest
      .fn<
        ReturnType<MaxClientService['getCurrentChatMemberAccess']>,
        Parameters<MaxClientService['getCurrentChatMemberAccess']>
      >()
      .mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        isBot: true,
        permissions: ['add_remove_members'],
      }),
    getExactMessageRow: jest
      .fn<
        ReturnType<MaxClientService['getExactMessageRow']>,
        Parameters<MaxClientService['getExactMessageRow']>
      >()
      .mockResolvedValue({
        sender: { user_id: 'user-1', is_bot: false },
        recipient: { chat_id: 'chat-1', chat_type: 'chat' },
        timestamp: at,
        body: { mid: 'source-1', text: 'hello' },
      }),
    clearTerminalBanStateAfterConfirmedUnban: jest
      .fn<
        ReturnType<MaxClientService['clearTerminalBanStateAfterConfirmedUnban']>,
        Parameters<MaxClientService['clearTerminalBanStateAfterConfirmedUnban']>
      >()
      .mockResolvedValue(undefined),
  };
  const fence = { isSanctionEventInvalidated: jest.fn(async () => false) };
  const lease = { assertOwned: jest.fn(async () => {}) };
  const sanctionLock: Context['sanctionLock'] = {
    runExclusive: async (_subject, operation) => operation(lease),
  };
  const legacyHolds = {
    isMessageHeld: jest.fn(async () => false),
    isMemberHeld: jest.fn(async () => false),
    isGlobalUserHeld: jest.fn(async () => false),
  };
  const checkpoint = jest.fn(async () => {});
  const mutations: { key: string | null | undefined; botId: string }[] = [];
  const kick = jest
    .fn<ReturnType<Context['kick']>, Parameters<Context['kick']>>()
    .mockImplementation(async (_chatId, _userId, optionsForBot) => {
      const options = await optionsForBot('bot-1');
      expect(usesMaxFinalAuthorityCheckpoint(options.beforeImmediateMemberMutation)).toBe(true);
      await options.beforeImmediateMemberMutation!(checkpoint);
      mutations.push({ key: options.idempotencyKey, botId: 'bot-1' });
      return true;
    });
  const context: Context = {
    prisma: prisma as unknown as Context['prisma'],
    fence,
    sanctionLock,
    max,
    legacyHolds,
    isKnownBotUserId: (id) => id === 'runtime-bot',
    kick,
  };
  return {
    at,
    update,
    chat,
    target,
    prisma,
    max,
    fence,
    lease,
    legacyHolds,
    checkpoint,
    mutations,
    context,
    kick,
    get current() {
      return current;
    },
    replace(event: Partial<Event> | null) {
      current = event === null ? null : { ...current!, ...event };
    },
    enforce: () => enforceLocalChatBan(update, 'user-1', context),
    read: () => readActiveLocalChatBan(context.prisma, context.fence, 'chat-1', 'user-1'),
  };
}

describe('local chat ban on return', () => {
  it('recognizes only the latest explicit local admin ban', async () => {
    const s = fixture();
    await expect(s.read()).resolves.toEqual({
      id: 'ban-1',
      createdAt: new Date(s.at - 1_000),
      initiatedByUserId: 'admin-1',
    });
    const [sql, ...parameters] = s.prisma.$queryRaw.mock.calls[0]!;
    expect(Array.isArray(sql)).toBe(true);
    expect(parameters).toEqual(['chat-1', 'user-1']);
  });

  it.each([
    { action: 'MUTE' },
    { ruleCode: 'MANUAL_UNBAN', action: 'NONE' },
    { ruleCode: 'MANUAL_UNMUTE', action: 'NONE' },
    { operator: 'BOT' },
    { metadata: { mode: 'MAX_BLOCK' } },
    { metadata: { mode: 'MAX_REMOVE_ONLY' } },
    { metadata: { mode: LOCAL_CHAT_BAN_MODE, sanctionApplied: false } },
  ] satisfies Partial<Event>[])(
    'does not reinterpret released/replaced/native state as a local ban: %j',
    async (change) => {
      const s = fixture();
      s.replace(change);
      await expect(s.enforce()).resolves.toBe(false);
      expect(s.context.kick).not.toHaveBeenCalled();
      expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
    },
  );

  it('removes a joined member through the exact selected bot without a native BAN', async () => {
    const s = fixture();
    await expect(s.enforce()).resolves.toBe(true);
    expect(s.mutations).toHaveLength(1);
    expect(s.max.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
      expect.objectContaining({ botId: 'bot-1', bypassCache: true }),
    );
    expect(s.max.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ botId: 'bot-1', bypassCache: true }),
    );
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    expect(s.checkpoint).toHaveBeenCalledTimes(1);
  });

  it('uses stable mirrored-source keys and a new key for the next real join', async () => {
    const s = fixture();
    await s.enforce();
    s.update.botId = 'mirror-bot';
    s.update.updateId = 'mirror-receipt';
    await s.enforce();
    expect(s.mutations[1]!.key).toBe(s.mutations[0]!.key);
    s.update.message!.messageId = 'next-join';
    await s.enforce();
    expect(s.mutations[2]!.key).not.toBe(s.mutations[0]!.key);
  });

  it('reconciles older native BAN success from a fresh selected-bot probe before dispatch', async () => {
    const s = fixture();
    const startedAt = Date.now();
    await expect(s.enforce()).resolves.toBe(true);
    expect(s.max.getChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(s.max.clearTerminalBanStateAfterConfirmedUnban).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
      expect.any(Date),
    );
    const cutoff = s.max.clearTerminalBanStateAfterConfirmedUnban.mock.calls[0]![2]!;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(startedAt);
    expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now());
    expect(s.max.getChatMemberAccess.mock.invocationCallOrder[0]).toBeLessThan(
      s.max.clearTerminalBanStateAfterConfirmedUnban.mock.invocationCallOrder[0]!,
    );
    expect(s.max.clearTerminalBanStateAfterConfirmedUnban.mock.invocationCallOrder[0]).toBeLessThan(
      s.max.getChatMemberAccess.mock.invocationCallOrder[1]!,
    );
  });

  it('retains native evidence when the lease is lost during the selected-bot probe', async () => {
    const s = fixture();
    const error = new ModerationSanctionStateLockLeaseLostError({
      chatId: 'chat-1',
      userId: 'user-1',
    });
    s.max.getChatMemberAccess.mockImplementation(async () => {
      s.lease.assertOwned.mockRejectedValue(error);
      return s.target;
    });
    await expect(s.enforce()).rejects.toBe(error);
    expect(s.max.clearTerminalBanStateAfterConfirmedUnban).not.toHaveBeenCalled();
    expect(s.mutations).toEqual([]);
  });

  it('uses a fresh exact message as a fallback when the join event was missed', async () => {
    const s = fixture('message');
    await expect(s.enforce()).resolves.toBe(true);
    expect(s.max.getExactMessageRow).toHaveBeenCalledWith(
      'chat-1',
      'source-1',
      expect.objectContaining({ botId: 'bot-1', bypassCache: true }),
    );
  });

  it.each([
    null,
    {
      sender: { user_id: 'someone-else' },
      recipient: { chat_id: 'chat-1' },
      body: { mid: 'source-1', text: 'hello' },
    },
  ])('refuses message fallback without the exact original author/source', async (row) => {
    const s = fixture('message');
    s.max.getExactMessageRow.mockResolvedValue(row);
    await expect(s.enforce()).resolves.toBe(false);
    expect(s.mutations).toEqual([]);
  });

  it.each([{ isAdmin: true }, { isOwner: true }, { isBot: true }, { isBot: undefined }])(
    'protects privileged or unverified targets at dispatch: %j',
    async (change) => {
      const s = fixture();
      s.max.getChatMemberAccess.mockResolvedValue({ ...s.target, ...change });
      await expect(s.enforce()).resolves.toBe(false);
      expect(s.mutations).toEqual([]);
    },
  );

  it('does not treat a member lookup timeout as presence or as a successful removal', async () => {
    const s = fixture();
    const error = new Error('membership timeout');
    s.max.getChatMemberAccess.mockRejectedValue(error);
    await expect(s.enforce()).rejects.toBe(error);
    expect(s.mutations).toEqual([]);
  });

  it('keeps configured bots outside the lookup and dispatch paths', async () => {
    const s = fixture();
    await expect(enforceLocalChatBan(s.update, 'runtime-bot', s.context)).resolves.toBe(false);
    expect(s.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(s.context.kick).not.toHaveBeenCalled();
  });

  it.each(['absent', 'no-rights', 'local-admin', 'channel'])(
    'declines a %s target/chat without a mutation',
    async (state) => {
      const s = fixture();
      if (state === 'absent') s.max.getChatMemberAccess.mockResolvedValue(null);
      if (state === 'no-rights')
        s.max.getCurrentChatMemberAccess.mockResolvedValue({
          userId: 'bot-1',
          isAdmin: true,
          isOwner: false,
          permissions: [],
        });
      if (state === 'local-admin') s.chat.admins.push({ userId: 'user-1' });
      if (state === 'channel') s.chat.entityType = 'CHANNEL';
      await expect(s.enforce()).resolves.toBe(false);
      expect(s.mutations).toEqual([]);
    },
  );

  it.each(['source', 'member', 'global-user'])(
    'preserves a held %s at the final dispatch checkpoint',
    async (scope) => {
      const s = fixture();
      s.checkpoint.mockImplementation(async () => {
        if (scope === 'source') s.legacyHolds.isMessageHeld.mockResolvedValue(true);
        if (scope === 'member') s.legacyHolds.isMemberHeld.mockResolvedValue(true);
        if (scope === 'global-user') s.legacyHolds.isGlobalUserHeld.mockResolvedValue(true);
      });
      await expect(s.enforce()).resolves.toBe(false);
      expect(s.mutations).toEqual([]);
    },
  );

  it.each(['release', 'replacement', 'fence'])(
    'rechecks a %s after route/remote waits',
    async (state) => {
      const s = fixture();
      s.checkpoint.mockImplementation(async () => {
        if (state === 'release')
          s.replace({ action: 'NONE', ruleCode: 'MANUAL_UNBAN', id: 'release' });
        if (state === 'replacement') s.replace({ action: 'MUTE', id: 'mute' });
        if (state === 'fence') s.fence.isSanctionEventInvalidated.mockResolvedValue(true);
      });
      await expect(s.enforce()).resolves.toBe(false);
      expect(s.mutations).toEqual([]);
    },
  );

  it('refuses a lease lost during final authority preparation', async () => {
    const s = fixture();
    const error = new ModerationSanctionStateLockLeaseLostError({
      chatId: 'chat-1',
      userId: 'user-1',
    });
    s.checkpoint.mockImplementation(async () => {
      s.lease.assertOwned.mockRejectedValue(error);
    });
    await expect(s.enforce()).rejects.toBe(error);
    expect(s.mutations).toEqual([]);
  });

  it.each(['expired', 'future', 'before-sanction', 'edit', 'removed'])(
    'does not acquire effect authority from an %s source',
    async (state) => {
      const s = fixture();
      if (state === 'expired')
        s.update.message!.createdAt = new Date(Date.now() - 300_001).toISOString();
      if (state === 'future')
        s.update.message!.createdAt = new Date(Date.now() + 60_000).toISOString();
      if (state === 'before-sanction')
        s.update.message!.createdAt = new Date(s.at - 2_000).toISOString();
      if (state === 'edit') {
        s.update.type = 'message_edited';
        delete s.update.membership;
      }
      if (state === 'removed') s.update.membership!.action = 'removed';
      await expect(s.enforce()).resolves.toBe(false);
      expect(s.context.kick).not.toHaveBeenCalled();
    },
  );

  it('does not turn an ambiguous remote effect into success or retry it', async () => {
    const s = fixture();
    const error = Object.assign(new Error('unknown KICK outcome'), { ambiguous: true });
    s.kick.mockRejectedValue(error);
    await expect(s.enforce()).rejects.toBe(error);
    expect(s.context.kick).toHaveBeenCalledTimes(1);
  });
});
