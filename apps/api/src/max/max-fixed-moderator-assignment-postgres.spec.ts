import { ConfigService } from '@nestjs/config';
import { AdminStopWordsService } from '../admin/admin-stop-words.service';
import { randomUUID } from 'node:crypto';
import { createPrismaAdapter, PrismaClient } from '../prisma/prisma-client';
import { buildBotAccessSnapshotPersistence } from './bot-access-snapshot.util';
import {
  MaxFixedModeratorAssignmentService,
  type FixedModeratorAssignmentInput,
} from './max-fixed-moderator-assignment.service';
import { hasPersistedBoundMessage } from './max-bound-message';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const integration = databaseUrl ? describe : describe.skip;

integration('fixed moderator assignment with PostgreSQL', () => {
  let db: PrismaClient;
  let service: MaxFixedModeratorAssignmentService;
  let config: ConfigService;
  let chatId: string;
  const actor = `fixed-admin-${randomUUID()}`;
  const epoch = new Date(Date.now() - 1000);
  const access = buildBotAccessSnapshotPersistence(
    {
      isAdmin: true,
      isOwner: false,
      permissionsKnown: true,
      permissions: ['read_all_messages', 'write', 'add_remove_members'],
    },
    { source: 'seed', now: epoch },
  );
  const input = (
    botId = 'working-bot',
    operationId = randomUUID(),
  ): FixedModeratorAssignmentInput => ({
    operationId,
    chatId,
    entityType: 'CHAT',
    botId,
    expectedRoutingVersion: 4,
    expectedAccessEpoch: { checkedAt: epoch, source: 'seed' },
    actorProof: { userId: actor, checkedAt: new Date() },
  });

  beforeAll(() => {
    const url = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.includes('race_test'))
      throw new Error('Disposable PostgreSQL required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 5, statement_timeout: 10000 }),
    });
    config = new ConfigService();
    service = new MaxFixedModeratorAssignmentService(
      db as never,
      {
        getBotById: (id: string) =>
          ['working-bot', 'other-bot'].includes(id) ? { id, state: 'active' } : null,
      } as never,
      config,
    );
  });
  beforeEach(async () => {
    config.set('COMMERCIAL_LLM_ENFORCEMENT_ENABLED', false);
    chatId = `fixed-${randomUUID()}`;
    await db.chat.create({
      data: {
        id: chatId,
        title: 'Существующее сообщество',
        primaryBotId: 'working-bot',
        botId: 'working-bot',
        routingVersion: 4,
        routingState: 'READY',
        botMemberships: {
          create: ['working-bot', 'other-bot'].map((botId) => ({
            botId,
            role: botId === 'working-bot' ? 'PRIMARY' : 'STANDBY',
            ...access,
          })),
        },
      },
    });
  });
  afterEach(async () => {
    await db.maxActionLedgerEntry.deleteMany({ where: { chatId } });
    await db.chat.delete({ where: { id: chatId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  it('preserves the working bot and saves exactly one result for concurrent repeated requests', async () => {
    const request = { ...input(), preserveCurrent: true };
    const results = await Promise.all([service.assign(request), service.assign(request)]);
    expect(results[0]).toEqual(results[1]);
    expect(await db.chat.findUnique({ where: { id: chatId } })).toMatchObject({
      primaryBotId: 'working-bot',
      fixedModeratorBotId: 'working-bot',
      routingVersion: 5,
    });
    expect(await db.auditLog.count({ where: { chatId, action: 'MODERATOR_ASSIGNED' } })).toBe(1);
  });

  it('lets only one administrator decision win the same revision', async () => {
    const results = await Promise.allSettled([
      service.assign(input()),
      service.assign(input('other-bot')),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await db.managedModeratorAssignment.count({ where: { chatId } })).toBe(1);
  });

  it('refuses to redistribute an existing community during initial fixation', async () => {
    await expect(service.assign({ ...input('other-bot'), preserveCurrent: true })).rejects.toThrow(
      'Действующий бот',
    );
    expect(
      (await db.chat.findUniqueOrThrow({ where: { id: chatId } })).fixedModeratorBotId,
    ).toBeNull();
  });

  it('rejects changed bot access and an administrator revocation observed after the check', async () => {
    const request = input('other-bot');
    await db.chatBotMembership.update({
      where: { chatId_botId: { chatId, botId: 'other-bot' } },
      data: { botAccessCheckedAt: new Date() },
    });
    await expect(service.assign(request)).rejects.toThrow('не хватает прав');
    const current = input();
    await db.managedEntityAccessEdge.create({
      data: {
        chatId,
        userId: actor,
        botId: 'working-bot',
        state: 'USER_DENIED',
        checkedAt: new Date(current.actorProof.checkedAt.getTime() + 1),
      },
    });
    await expect(service.assign(current)).rejects.toThrow('Права администратора изменились');
    expect(await db.managedModeratorAssignment.count({ where: { chatId } })).toBe(0);
  });

  it('preserves old rules binding after a switch and rejects an unrelated message or author', async () => {
    await db.chatRules.create({
      data: { chatId, publishedMessageId: 'old-rules', publishedBotId: 'working-bot' },
    });
    await service.assign(input('other-bot'));
    const target = {
      chatId,
      messageId: 'old-rules',
      botId: 'working-bot',
      purpose: 'edit_message' as const,
    };
    expect(await hasPersistedBoundMessage(db, target)).toBe(true);
    expect(await hasPersistedBoundMessage(db, { ...target, botId: 'unrelated-bot' })).toBe(false);
    expect(await hasPersistedBoundMessage(db, { ...target, messageId: 'user-message' })).toBe(
      false,
    );
  });
  it('refuses a bot missing enabled member-management duties even if no peer proves them', async () => {
    await db.chatSettings.create({ data: { chatId, removeBotsFromGroupEnabled: true } });
    const withoutMemberAccess = buildBotAccessSnapshotPersistence(
      {
        isAdmin: true,
        isOwner: false,
        permissionsKnown: true,
        permissions: ['read_all_messages', 'write'],
      },
      { source: 'seed', now: epoch },
    );
    await db.chatBotMembership.updateMany({ where: { chatId }, data: withoutMemberAccess });
    await expect(service.assign(input('other-bot'))).rejects.toThrow('не хватает прав');
    expect(
      (await db.chat.findUniqueOrThrow({ where: { id: chatId } })).fixedModeratorBotId,
    ).toBeNull();
  });

  it.each([
    { commercialAiDeleteOnly: true, profanityBan: false, allowed: true },
    { commercialAiDeleteOnly: false, profanityBan: false, allowed: false },
    { commercialAiDeleteOnly: true, profanityBan: true, allowed: false },
  ])(
    'uses effective duties through assignment commit: %j',
    async ({ commercialAiDeleteOnly, profanityBan, allowed }) => {
      config.set('COMMERCIAL_LLM_ENFORCEMENT_ENABLED', commercialAiDeleteOnly);
      await db.chatSettings.create({
        data: {
          chatId,
          commercialAdsFilterEnabled: true,
          textFiltersBanEnabled: true,
          russianProfanityFilterEnabled: profanityBan,
          profanityBanEnabled: profanityBan,
        },
      });
      await db.chatBotMembership.updateMany({
        where: { chatId },
        data: buildBotAccessSnapshotPersistence(
          {
            isAdmin: true,
            isOwner: false,
            permissionsKnown: true,
            permissions: ['read_all_messages', 'write'],
          },
          { source: 'seed', now: epoch },
        ),
      });
      const assignment = service.assign(input('other-bot'));
      if (allowed) await expect(assignment).resolves.toMatchObject({ botId: 'other-bot' });
      else await expect(assignment).rejects.toThrow('не хватает прав');
      expect(await db.chat.findUniqueOrThrow({ where: { id: chatId } })).toMatchObject({
        fixedModeratorBotId: allowed ? 'other-bot' : null,
        routingVersion: allowed ? 5 : 4,
      });
      expect(await db.chatSettings.findUniqueOrThrow({ where: { chatId } })).toMatchObject({
        textFiltersBanEnabled: true,
        profanityBanEnabled: profanityBan,
      });
    },
  );

  it('rejects settings enabled after a preflight against a former moderator', async () => {
    await db.chatSettings.create({ data: { chatId } });
    const stopWords = new AdminStopWordsService(
      db as never,
      { assertChatAdminAccess: async () => undefined } as never,
      {} as never,
      {
        assertChatSettingsBotCapabilities: async () => {
          // The remote preflight began against the old moderator. Before its response
          // is used, that capability is revoked and another moderator is assigned.
          await db.chatBotMembership.updateMany({
            where: { chatId },
            data: buildBotAccessSnapshotPersistence(
              {
                isAdmin: true,
                isOwner: false,
                permissionsKnown: true,
                permissions: ['read_all_messages', 'write'],
              },
              { source: 'seed', now: epoch },
            ),
          });
          await service.assign(input('other-bot'));
        },
      } as never,
      { invalidate: async () => undefined } as never,
      new ConfigService(),
    );
    await expect(
      stopWords.update(chatId, { userId: actor } as never, {
        expectedRevision: 0,
        policy: { enabled: true, sanctions: { banEnabled: true } },
      }),
    ).rejects.toThrow('Права выбранного бота изменились');
    expect(await db.chatSettings.findUnique({ where: { chatId } })).toMatchObject({
      stopWordsRevision: 0,
    });
    expect(await db.auditLog.count({ where: { chatId, action: 'UPDATE_STOP_WORDS' } })).toBe(0);
    expect(await db.chat.findUnique({ where: { id: chatId } })).toMatchObject({
      fixedModeratorBotId: 'other-bot',
    });
  });

  it('allows cleanup only of the exact confirmed SEND result with its original executor', async () => {
    const jobId = `send-${randomUUID()}`;
    await db.maxActionLedgerEntry.create({
      data: {
        jobId,
        chatId,
        actionType: 'SEND_MESSAGE',
        status: 'SUCCEEDED',
        terminal: true,
        remoteMessageId: 'old-notice',
        dispatchBotId: 'working-bot',
      },
    });
    await service.assign(input('other-bot'));
    const target = {
      chatId,
      messageId: 'old-notice',
      botId: 'working-bot',
      purpose: 'delete_message' as const,
      object: { kind: 'send' as const, id: jobId },
    };
    expect(await hasPersistedBoundMessage(db, target)).toBe(true);
    expect(await hasPersistedBoundMessage(db, { ...target, purpose: 'edit_message' })).toBe(false);
    expect(await hasPersistedBoundMessage(db, { ...target, messageId: 'user-message' })).toBe(
      false,
    );
    expect(await hasPersistedBoundMessage(db, { ...target, botId: 'other-bot' })).toBe(false);
    await db.maxActionLedgerEntry.update({ where: { jobId }, data: { status: 'AMBIGUOUS' } });
    expect(await hasPersistedBoundMessage(db, target)).toBe(false);
  });
});
