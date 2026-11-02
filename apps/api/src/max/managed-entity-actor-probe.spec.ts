import { probeManagedEntityActor } from './managed-entity-actor-probe';
import type { MaxChatMemberAccess } from './max-client.service';

describe('personal human access probe', () => {
  function fixture() {
    const old = new Date('2020-01-01T00:00:00Z');
    const membership = {
      botId: 'major',
      status: 'ACTIVE',
      botAccessState: 'CONFIRMED_ADMIN',
      botAccessCheckedAt: old,
      botAccessExpiresAt: old,
      botAccessSource: 'explicit_start',
      lifecycleEventAt: old,
      permissionsSnapshot: {
        checkedAt: old.toISOString(),
        isAdmin: true,
        isOwner: false,
        permissionsKnown: true,
        permissions: ['read_all_messages', 'write'],
      },
      chat: { entityType: 'CHAT' },
    };
    const human: MaxChatMemberAccess = {
      userId: '123',
      isBot: false,
      isAdmin: true,
      isOwner: false,
      explicitPrivilegeEvidence: true,
      permissions: [],
    };
    const prisma = {
      chatBotMembership: { findUnique: jest.fn().mockResolvedValue(membership) },
      managedEntityAccessEdge: {
        findFirst: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
        updateMany: jest.fn(),
      },
      chatAdminAllowlist: { upsert: jest.fn(), deleteMany: jest.fn() },
      $queryRaw: jest
        .fn()
        .mockImplementation(async (q) => (q.sql.includes('FROM chats') ? [{ id: '-1' }] : [])),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn) => fn(prisma));
    const maxClient = {
      getChatMembersAccess: jest.fn().mockResolvedValue(new Map([['123', human]])),
      getChatAdminAccesses: jest.fn().mockResolvedValue([human]),
    };
    const cache = { applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true) };
    const run = () =>
      probeManagedEntityActor({
        prisma: prisma as never,
        maxClient: maxClient as never,
        cache: cache as never,
        chatId: '-1',
        botId: 'major',
        userId: 'id123',
        requiredCheckedAfter: new Date(Date.now() - 10),
      });
    return { run, prisma, maxClient, cache, membership, human };
  }
  it('checks only the human using durable bot proof and accepts MAX id aliases', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toBe(true);
    expect(f.maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      '-1',
      ['123'],
      expect.objectContaining({ botId: 'major', bypassCache: true }),
    );
    expect(f.maxClient.getChatAdminAccesses).not.toHaveBeenCalled();
    expect(f.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ state: 'GRANTED' }) }),
    );
    expect(f.cache.applyAdminAccessEpochMutation).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'granted' }),
    );
  });
  it.each([429, 500, 503])('preserves SQL and Redis evidence on MAX %s', async (status) => {
    const f = fixture();
    f.maxClient.getChatMembersAccess.mockRejectedValue({ response: { status } });
    await expect(f.run()).rejects.toEqual({ response: { status } });
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.cache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
  });
  it.each([
    { roster: [] },
    {
      roster: [
        {
          userId: '456',
          isBot: false,
          isAdmin: true,
          isOwner: false,
          explicitPrivilegeEvidence: true,
          permissions: [],
        },
      ],
    },
  ])(
    'preserves confirmed rights when a refused member lookup omits the actor from a roster (%j)',
    async ({ roster }) => {
      const f = fixture();
      const error = { response: { status: 403 } };
      f.maxClient.getChatMembersAccess.mockRejectedValue(error);
      f.maxClient.getChatAdminAccesses.mockResolvedValue(roster);
      await expect(f.run()).rejects.toBe(error);
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
      expect(f.cache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
      expect(f.membership.botAccessState).toBe('CONFIRMED_ADMIN');
    },
  );
  it('requires an exact member response before revoking human rights', async () => {
    const f = fixture();
    f.maxClient.getChatMembersAccess.mockResolvedValue(new Map());
    await expect(f.run()).rejects.toThrow('unavailable');
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    const member: MaxChatMemberAccess = {
      ...f.human,
      isAdmin: false,
      explicitPrivilegeEvidence: false,
      explicitNonPrivilegeEvidence: true,
    };
    f.maxClient.getChatMembersAccess.mockResolvedValue(new Map([['123', member]]));
    await f.run();
    expect(f.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ state: 'USER_DENIED' }) }),
    );
  });
  it('preserves confirmed human access when negative role evidence is incomplete', async () => {
    const f = fixture();
    const member: MaxChatMemberAccess = {
      ...f.human,
      isAdmin: false,
      explicitPrivilegeEvidence: false,
      explicitNonPrivilegeEvidence: false,
    };
    f.maxClient.getChatMembersAccess.mockResolvedValue(new Map([['123', member]]));
    await expect(f.run()).rejects.toThrow('role evidence is incomplete');
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.cache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
  });
  it('accepts an explicit bot identity as a denial of human access', async () => {
    const f = fixture();
    const bot: MaxChatMemberAccess = {
      ...f.human,
      isBot: true,
      isAdmin: false,
      explicitPrivilegeEvidence: false,
      explicitNonPrivilegeEvidence: false,
    };
    f.maxClient.getChatMembersAccess.mockResolvedValue(new Map([['123', bot]]));
    await expect(f.run()).resolves.toBe(true);
    expect(f.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ state: 'USER_DENIED' }) }),
    );
  });
  it('does not turn an incomplete positive result into a denial', async () => {
    const f = fixture();
    f.human.explicitPrivilegeEvidence = false;
    await expect(f.run()).rejects.toThrow('incomplete');
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('rejects a grant if a newer bot denial wins while MAX responds', async () => {
    const f = fixture();
    f.prisma.chatBotMembership.findUnique
      .mockResolvedValueOnce(f.membership)
      .mockResolvedValue({ ...f.membership, botAccessState: 'DENIED' });
    await expect(f.run()).rejects.toThrow('superseded');
    expect(f.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(f.cache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
  });
  it('does not overwrite a newer actor verdict or an in-flight membership event', async () => {
    const f = fixture();
    f.prisma.managedEntityAccessEdge.findFirst.mockResolvedValue({ userId: '123' });
    await expect(f.run()).rejects.toThrow('superseded');
    expect(f.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    f.prisma.managedEntityAccessEdge.findFirst.mockResolvedValue(null);
    f.prisma.$queryRaw.mockResolvedValue([{ id: '-1', userId: '123' }]);
    await expect(f.run()).rejects.toThrow('superseded');
    expect(f.cache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
  });
  it('publishes Redis only after a successful SQL commit', async () => {
    const f = fixture();
    f.prisma.$transaction.mockRejectedValue(new Error('commit failed'));
    await expect(f.run()).rejects.toThrow('commit failed');
    expect(f.cache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
  });
});
