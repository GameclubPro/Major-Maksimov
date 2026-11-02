import { randomUUID } from 'node:crypto';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import { buildBotAccessSnapshotPersistence } from './bot-access-snapshot.util';
import { probeManagedEntityActor } from './managed-entity-actor-probe';
import { ManagedEntityAccessRefreshService } from '../admin/managed-entity-access-refresh.service';
import type { MaxChatMemberAccess, MaxClientService } from './max-client.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;
native('managed access demand on native PostgreSQL', () => {
  let prisma: PrismaClient;
  let chatId: string;
  const botId = 'demand-major';
  const userId = 'demand-user';
  const old = new Date('2020-01-01T00:00:00Z');
  const proof = () =>
    buildBotAccessSnapshotPersistence(
      {
        isAdmin: true,
        isOwner: false,
        permissionsKnown: true,
        permissions: ['read_all_messages', 'write'],
      },
      { source: 'explicit_start', now: old },
    );
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local PostgreSQL required');
    prisma = createPrismaClient(databaseUrl, { max: 3 });
  });
  beforeEach(async () => {
    chatId = `-demand-${randomUUID()}`;
    await prisma.chat.create({
      data: { id: chatId, title: 'Personal demand fixture', entityType: 'CHAT' },
    });
    await prisma.chatBotMembership.create({
      data: { chatId, botId, role: 'PRIMARY', status: 'ACTIVE', ...proof() },
    });
    await prisma.managedEntityAccessEdge.create({
      data: {
        chatId,
        userId,
        botId,
        state: 'GRANTED',
        userRole: 'ADMIN',
        botRole: 'ADMIN',
        checkedAt: old,
      },
    });
  });
  afterEach(async () => {
    await prisma.chat.delete({ where: { id: chatId } });
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('preserves grants on ambiguous human role evidence and revokes them on explicit denial', async () => {
    await prisma.chatAdminAllowlist.create({ data: { chatId, userId } });
    await prisma.managedEntityAccessEdge.create({
      data: {
        chatId,
        userId,
        botId: 'peer',
        state: 'GRANTED',
        userRole: 'ADMIN',
        botRole: 'ADMIN',
        checkedAt: old,
      },
    });
    const cache = { applyAdminAccessEpochMutation: jest.fn() };
    const member: MaxChatMemberAccess = {
      userId,
      isBot: false,
      isAdmin: false,
      isOwner: false,
      permissions: [],
      explicitPrivilegeEvidence: false,
      explicitNonPrivilegeEvidence: false,
    };
    const maxClient: Pick<MaxClientService, 'getChatMembersAccess'> = {
      getChatMembersAccess: async () => new Map([[userId, member]]),
    };
    const probe = () =>
      probeManagedEntityActor({
        prisma: prisma as never,
        cache: cache as never,
        maxClient: maxClient as MaxClientService,
        chatId,
        botId,
        userId,
        requiredCheckedAfter: new Date(Date.now() - 10),
      });

    await expect(probe()).rejects.toThrow('role evidence is incomplete');
    const preserved = await prisma.managedEntityAccessEdge.findMany({
      where: { chatId, userId },
    });
    expect(preserved).toHaveLength(2);
    expect(preserved.every((edge) => edge.state === 'GRANTED')).toBe(true);
    expect(preserved.every((edge) => edge.checkedAt.getTime() === old.getTime())).toBe(true);
    expect(
      await prisma.chatAdminAllowlist.findUnique({ where: { chatId_userId: { chatId, userId } } }),
    ).not.toBeNull();
    expect(cache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();

    member.explicitNonPrivilegeEvidence = true;
    await expect(probe()).resolves.toBe(true);
    const denied = await prisma.managedEntityAccessEdge.findMany({ where: { chatId, userId } });
    expect(denied).toHaveLength(2);
    expect(denied.every((edge) => edge.state === 'USER_DENIED')).toBe(true);
    expect(
      await prisma.chatAdminAllowlist.findUnique({ where: { chatId_userId: { chatId, userId } } }),
    ).toBeNull();
    expect(cache.applyAdminAccessEpochMutation).toHaveBeenCalledWith(
      expect.objectContaining({ chatId, userId, state: 'user_denied' }),
    );
  });

  it('remembers a former administrator through revocation without turning history into a grant', async () => {
    const where = { chatId_userId_botId: { chatId, userId, botId } };
    expect(
      (await prisma.managedEntityAccessEdge.findUniqueOrThrow({ where })).lastAdminConfirmedAt,
    ).toEqual(old);
    await prisma.managedEntityAccessEdge.update({
      where,
      data: { state: 'USER_DENIED', checkedAt: new Date(), lastAdminConfirmedAt: null },
    });
    const row = await prisma.managedEntityAccessEdge.findUniqueOrThrow({ where });
    expect(row.lastAdminConfirmedAt).toEqual(old);
    expect(row.state).toBe('USER_DENIED');
    const roster = { scheduleActorProbe: jest.fn().mockResolvedValue(true) };
    const service = new ManagedEntityAccessRefreshService(
      prisma as never,
      {
        getDiscoveryBots: () => [{ id: botId }],
        getPublisherBotDescriptor: () => ({ id: 'publik' }),
      } as never,
      roster as never,
      { enqueue: jest.fn() } as never,
    );
    const user = { userId, username: null, displayName: null, accessCheckedAfter: Date.now() + 1 };
    expect(await service.pending(user, 'moderation', 'chat')).toBe(true);
    await prisma.chatBotMembership.update({
      where: { chatId_botId: { chatId, botId } },
      data: {
        permissionsSnapshot: {
          isAdmin: true,
          permissionsKnown: true,
          permissions: ['read_all_messages'],
        },
      },
    });
    expect(await service.pending(user, 'moderation', 'chat')).toBe(false);

    await prisma.chatBotMembership.update({
      where: { chatId_botId: { chatId, botId } },
      data: {
        botAccessSource: null,
        permissionsSnapshot: {
          isAdmin: true,
          permissionsKnown: true,
          permissions: [' READ-ALL-MESSAGES ', 'CAN WRITE'],
        },
      },
    });
    expect(await service.pending(user, 'moderation', 'chat')).toBe(false);
    await prisma.chatBotMembership.update({
      where: { chatId_botId: { chatId, botId } },
      data: { botAccessSource: 'explicit_start' },
    });
    expect(await service.pending(user, 'moderation', 'chat')).toBe(true);

    // A healthy peer cannot make a denied exact-bot edge wait forever.
    await prisma.chatBotMembership.update({
      where: { chatId_botId: { chatId, botId } },
      data: { botAccessState: 'DENIED' },
    });
    await prisma.chatBotMembership.create({
      data: { chatId, botId: 'peer', role: 'STANDBY', status: 'ACTIVE', ...proof() },
    });
    expect(await service.pending(user, 'moderation', 'chat')).toBe(false);
    await service.onModuleDestroy();
  });

  it('rejects a delayed human grant after a committed bot demotion', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cache = { applyAdminAccessEpochMutation: jest.fn() };
    const work = probeManagedEntityActor({
      prisma: prisma as never,
      cache: cache as never,
      chatId,
      botId,
      userId,
      requiredCheckedAfter: new Date(Date.now() - 10),
      maxClient: {
        getChatMembersAccess: async () => {
          entered();
          await gate;
          return new Map([
            [
              userId,
              {
                userId,
                isBot: false,
                isAdmin: true,
                isOwner: false,
                explicitPrivilegeEvidence: true,
              },
            ],
          ]);
        },
      } as never,
    });
    await started;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM chats WHERE id = ${chatId} FOR UPDATE`;
      await tx.chatBotMembership.update({
        where: { chatId_botId: { chatId, botId } },
        data: { botAccessState: 'DENIED', botAccessCheckedAt: new Date() },
      });
    });
    release();
    await expect(work).rejects.toThrow('superseded');
    expect(
      (
        await prisma.managedEntityAccessEdge.findUniqueOrThrow({
          where: { chatId_userId_botId: { chatId, userId, botId } },
        })
      ).checkedAt,
    ).toEqual(old);
    expect(cache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
  });

  it('starts after entry, commits the human proof, and retains bot authority without expiry', async () => {
    const boundary = Date.now() - 5;
    const cache = { applyAdminAccessEpochMutation: jest.fn() };
    await probeManagedEntityActor({
      prisma: prisma as never,
      cache: cache as never,
      chatId,
      botId,
      userId,
      requiredCheckedAfter: new Date(boundary),
      maxClient: {
        getChatMembersAccess: async () =>
          new Map([
            [
              userId,
              {
                userId,
                isBot: false,
                isAdmin: true,
                isOwner: false,
                explicitPrivilegeEvidence: true,
              },
            ],
          ]),
      } as never,
    });
    const membership = await prisma.chatBotMembership.findUniqueOrThrow({
      where: { chatId_botId: { chatId, botId } },
    });
    expect(membership.botAccessCheckedAt).toEqual(old);
    expect(membership.botAccessExpiresAt).toBeNull();
    const service = new ManagedEntityAccessRefreshService(
      prisma as never,
      {
        getDiscoveryBots: () => [{ id: botId }],
        getPublisherBotDescriptor: () => ({ id: 'publik' }),
      } as never,
      { scheduleActorProbe: jest.fn() } as never,
      { enqueue: jest.fn() } as never,
    );
    const result = await service.listPersonal(
      { userId, username: null, displayName: null, accessCheckedAfter: boundary },
      'chat',
    );
    expect(result.items.map((item) => item.id)).toEqual([chatId]);
    expect(result.refresh?.complete).toBe(true);
    await service.onModuleDestroy();
  });

  it('pages one user through an index despite 25000 unrelated fleet edges', async () => {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO managed_entity_access_edges (chat_id, user_id, bot_id, state, user_role, bot_role, checked_at, updated_at)
      SELECT ${chatId}, 'unrelated-' || n, ${botId}, 'GRANTED', 'ADMIN', 'ADMIN', ${old}, CURRENT_TIMESTAMP
      FROM generate_series(1, 25000) n`);
    await prisma.$executeRawUnsafe('ANALYZE managed_entity_access_edges');
    const plan = await prisma.$queryRawUnsafe<any[]>(
      `EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT chat_id, bot_id FROM managed_entity_access_edges WHERE user_id = $1
      ORDER BY chat_id, bot_id LIMIT 25`,
      userId,
    );
    const root = plan[0]['QUERY PLAN'][0].Plan;
    expect(JSON.stringify(root)).toMatch(/Index (Only )?Scan/);
    expect(root['Actual Rows']).toBe(1);
    const walk = (node: any): number =>
      (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 1) +
      (node.Plans ?? []).reduce((sum: number, child: any) => sum + walk(child), 0);
    expect(walk(root)).toBeLessThan(20);
  }, 30_000);
});
