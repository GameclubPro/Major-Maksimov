import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AdminParticipantsRuntime } from './admin-participants-runtime';
import type { AdminParticipantsRuntimeContext } from './admin-participants-runtime-context';

function harness() {
  const access = {
    userId: 'user-1',
    isAdmin: false,
    isOwner: false,
    isBot: false,
    permissions: [],
  };
  const prisma = {
    chatUserDisplayName: { findUnique: jest.fn().mockResolvedValue({ displayName: 'Local name' }) },
    chatSettings: {
      findUnique: jest.fn().mockResolvedValue({ nightModeTimezone: 'Europe/Moscow' }),
    },
    chatParticipantModerationImmunity: { findUnique: jest.fn().mockResolvedValue(null) },
    moderationEvent: {
      count: jest.fn().mockResolvedValue(3),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    chatMembershipActivityFeedItem: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const maxClient = {
    getChatMemberAccess: jest.fn().mockResolvedValue(access),
    getChatMemberProfiles: jest
      .fn()
      .mockResolvedValue(
        new Map([
          [
            'user-1',
            { displayName: 'Same name', username: null, avatarUrl: null, profileUrl: null },
          ],
        ]),
      ),
    getChatMembersPage: jest.fn(),
  };
  const context = {
    prisma,
    maxClient,
    assertReadOnlyChatAdmin: jest.fn().mockResolvedValue(undefined),
    ensureEntityType: jest.fn().mockResolvedValue(undefined),
    resolveBackgroundReadBotAssignment: jest.fn().mockResolvedValue('bot-1'),
    buildProfileMentionHandoffUrl: jest.fn(() => null),
    isKnownRuntimeBotUserId: jest.fn().mockReturnValue(false),
  };
  const runtime = new AdminParticipantsRuntime(
    context as unknown as AdminParticipantsRuntimeContext,
  );
  const user = { userId: 'admin-1', username: null, displayName: null, chatTitle: null };
  const load = (userId = 'user-1', query: unknown = {}) =>
    runtime.getChatParticipantDetails('chat-1', userId, user, query);
  return { context, prisma, maxClient, access, load };
}

describe('Participant details', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-03T12:00:00.000Z')));
  afterEach(() => jest.useRealTimers());
  it('loads exactly the event user without scanning or searching the roster', async () => {
    const { load, maxClient, prisma, context } = harness();
    await expect(load()).resolves.toMatchObject({
      userId: 'user-1',
      userDisplayName: 'Same name',
      role: 'member',
      membershipStatus: 'member',
      canManage: true,
      violationCount: 3,
      immunity: null,
    });
    expect(context.assertReadOnlyChatAdmin).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      'chat',
      undefined,
    );
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
      expect.objectContaining({ botId: 'bot-1', trafficClass: 'interactive' }),
    );
    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledWith(
      'chat-1',
      ['user-1'],
      expect.anything(),
    );
    expect(maxClient.getChatMembersPage).not.toHaveBeenCalled();
    expect(prisma.chatParticipantModerationImmunity.findUnique).toHaveBeenCalledWith({
      where: { chatId_userId: { chatId: 'chat-1', userId: 'user-1' } },
    });
    expect(prisma.moderationEvent.count).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        userId: { in: ['user-1'] },
        createdAt: {
          gte: new Date('2026-09-26T12:00:00.000Z'),
          lte: new Date('2026-10-03T12:00:00.000Z'),
        },
        action: { in: ['WARN', 'DELETE_MESSAGE', 'MUTE', 'KICK', 'BAN'] },
      },
    });
  });

  it('checks authorization before any participant lookup', async () => {
    const { load, context, maxClient, prisma } = harness();
    context.assertReadOnlyChatAdmin.mockRejectedValue(new ForbiddenException());
    await expect(load()).rejects.toBeInstanceOf(ForbiddenException);
    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(prisma.chatUserDisplayName.findUnique).not.toHaveBeenCalled();
  });

  it('retains local identity and protection for a former participant', async () => {
    const { load, maxClient, prisma } = harness();
    maxClient.getChatMemberAccess.mockResolvedValue(null);
    maxClient.getChatMemberProfiles.mockResolvedValue(new Map());
    prisma.chatMembershipActivityFeedItem.findFirst.mockResolvedValue({ canonicalKey: 'left-1' });
    prisma.chatParticipantModerationImmunity.findUnique.mockResolvedValue({
      expiresAt: null,
      dailyViolationLimit: null,
      dailyViolationUsage: 0,
      usageDateKey: null,
    });
    await expect(load()).resolves.toMatchObject({
      userDisplayName: 'Local name',
      role: null,
      membershipStatus: 'left',
      canManage: false,
      canMute: true,
      canBan: true,
      immunity: { mode: 'always' },
    });
  });

  it('does not offer sanctions for an absent person without history in this chat', async () => {
    const { load, maxClient } = harness();
    maxClient.getChatMemberAccess.mockResolvedValue(null);
    await expect(load()).resolves.toMatchObject({
      canManage: false,
      canMute: false,
      canBan: false,
    });
  });

  it('keeps runtime bots protected after leaving', async () => {
    const { load, maxClient, context } = harness();
    maxClient.getChatMemberAccess.mockResolvedValue(null);
    context.isKnownRuntimeBotUserId.mockReturnValue(true);
    await expect(load()).resolves.toMatchObject({
      canManage: false,
      canMute: false,
      canBan: false,
    });
  });

  it('does not treat a failed MAX lookup as absence', async () => {
    const { load, maxClient } = harness();
    maxClient.getChatMemberAccess.mockRejectedValue(new Error('timeout'));
    maxClient.getChatMemberProfiles.mockRejectedValue(new Error('timeout'));
    await expect(load()).resolves.toMatchObject({
      userDisplayName: 'Local name',
      membershipStatus: 'unknown',
      role: null,
      canManage: false,
    });
  });

  it.each([{ isAdmin: true }, { isOwner: true }, { isBot: true }, { isBot: undefined }])(
    'does not offer sanctions for protected or unverified targets: %j',
    async (extra) => {
      const { load, maxClient, access } = harness();
      maxClient.getChatMemberAccess.mockResolvedValue({ ...access, ...extra });
      expect((await load()).canManage).toBe(false);
    },
  );

  it('does not offer self moderation or revive expired immunity', async () => {
    const { load, prisma } = harness();
    prisma.chatParticipantModerationImmunity.findUnique.mockResolvedValue({
      expiresAt: new Date(0),
      dailyViolationLimit: 3,
      dailyViolationUsage: 0,
      usageDateKey: null,
    });
    await expect(load('admin-1')).resolves.toMatchObject({ canManage: false, immunity: null });
  });

  it.each([
    ['', {}],
    ['x'.repeat(201), {}],
    ['user-1', { range: 'forever' }],
  ])('rejects invalid input', async (userId, query) => {
    const { load, maxClient } = harness();
    await expect(load(userId as string, query)).rejects.toBeInstanceOf(BadRequestException);
    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalled();
  });

  it('propagates database failures instead of reporting no protection', async () => {
    const { load, prisma } = harness();
    prisma.chatParticipantModerationImmunity.findUnique.mockRejectedValue(
      new Error('database unavailable'),
    );
    await expect(load()).rejects.toThrow('database unavailable');
  });
});
