import { settleBotAutoDeleteReceipt } from './moderation-delete-auto-receipt';
import { randomUUID } from 'node:crypto';
import type { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { from } from 'rxjs';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import { MaxClientService } from '../max/max-client.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { MaxBotContextService } from '../max/max-bot-context.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const integration = databaseUrl && redisUrl ? describe : describe.skip;

integration('Documented bot auto-delete receipts with the real MAX client', () => {
  let prisma: PrismaClient;
  const chats: string[] = [];
  const clients: MaxClientService[] = [];
  const originalRole = process.env.APP_ROLE;
  beforeAll(async () => {
    const pg = new URL(databaseUrl);
    const cache = new URL(redisUrl);
    if (
      !['localhost', '127.0.0.1'].includes(pg.hostname) ||
      !pg.pathname.includes('race_test') ||
      !['localhost', '127.0.0.1'].includes(cache.hostname)
    )
      throw new Error('Disposable local stores required');
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
    process.env.APP_ROLE = 'action';
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.onModuleDestroy();
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma?.chat.deleteMany({ where: { id: { in: chats } } });
    await prisma?.$disconnect();
    if (originalRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = originalRole;
  });

  async function fixture() {
    const chatId = `-${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`)}`;
    const botId = `auto-receipt-${randomUUID()}`;
    chats.push(chatId);
    await prisma.chat.create({ data: { id: chatId, title: 'Synthetic receipt regression' } });
    const acknowledgedAt = new Date(Date.now() - 120_000);
    const intent = await prisma.moderationDeleteIntent.create({
      data: {
        id: randomUUID(),
        chatId,
        messageId: 'exact-message',
        subjectUserId: 'synthetic-bot-user',
        entityType: 'CHAT',
        messageAuthorKind: 'bot',
        routingPolicy: 'origin_only',
        originBotId: botId,
        status: 'IN_PROGRESS',
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
        executeAt: new Date(acknowledgedAt.getTime() - 1000),
        nextAttemptAt: acknowledgedAt,
        retryUntilAt: new Date(Date.now() - 60_000),
        attemptCount: 44,
        remoteDeleteSucceededAt: acknowledgedAt,
        remoteDeleteSucceededBotId: botId,
        reasons: {
          create: {
            id: randomUUID(),
            reasonKey: 'BOT_MESSAGE_AUTO_DELETE',
            ruleCode: 'BOT_MESSAGE_AUTO_DELETE',
            createdAt: new Date(acknowledgedAt.getTime() - 1000),
            eventType: 'MESSAGE',
            userId: 'synthetic-bot-user',
          },
        },
      },
    });
    const config = new ConfigService({
      MAX_API_BASE_URL: 'https://platform-api2.max.ru',
      REDIS_URL: redisUrl,
      MAX_BOT_ID: botId,
      MAX_BOT_TOKEN: `synthetic-${botId}`,
      MAX_WEBHOOK_SECRET_PATH: 'synthetic',
      MAX_WEBHOOK_HEADER_SECRET: 'synthetic',
      MODERATION_DELETE_INTENT_MODE: 'on',
      APP_SERVICE_NAME: 'test-auto-receipt',
    });
    const http = jest.fn(async (request: { method: string; url: string }) => {
      if (request.method === 'delete') return { status: 200, data: { success: true } };
      if (request.method === 'get' && request.url === 'https://platform-api2.max.ru/messages')
        return { status: 200, data: { messages: [] } };
      throw { response: { status: 404, data: { code: 'message.not.found' } } };
    });
    const max = new MaxClientService(
      { request: (r: Parameters<typeof http>[0]) => from(http(r)) } as unknown as HttpService,
      config,
      { recordSuccessForLane: jest.fn(), recordFailureForLane: jest.fn() } as never,
      new MaxBotRegistryService(config),
      new MaxBotContextService(),
    );
    clients.push(max);
    const route = jest.fn<
      ReturnType<MaxBotLinkService['resolveDeleteMessageBotRoute']>,
      Parameters<MaxBotLinkService['resolveDeleteMessageBotRoute']>
    >(async () => ({
      purpose: 'moderation_action',
      action: 'delete_message',
      chatId,
      entityType: 'CHAT',
      routingState: 'READY',
      routingVersion: 1,
      primaryBotId: botId,
      botId,
      candidateBotIds: [botId],
      reason: 'primary_confirmed',
      capabilityState: 'confirmed_capable',
      capabilityReason: 'confirmed',
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      candidateCapabilities: [
        {
          botId,
          state: 'confirmed_capable',
          reason: 'confirmed',
          checkedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          routeEligible: true,
        },
      ],
    }));
    const service = new ModerationDeleteIntentService(
      prisma as never,
      max,
      { resolveDeleteMessageBotRoute: route, recordBotAccessProbe: jest.fn() } as never,
      {} as never,
      config,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, intent, max, http, route, botId };
  }

  it('persists a fresh documented HTTP success and completes the public execution path once', async () => {
    const f = await fixture();
    await prisma.moderationDeleteIntent.update({
      where: { id: f.intent.id },
      data: {
        remoteDeleteSucceededAt: null,
        remoteDeleteSucceededBotId: null,
        attemptCount: 1,
        retryUntilAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(
      f.service.executeLeasedIntent(f.intent.id, f.intent.leaseToken!),
    ).resolves.toMatchObject({ status: 'SUCCEEDED' });
    await expect(
      f.service.executeLeasedIntent(f.intent.id, f.intent.leaseToken!),
    ).resolves.toMatchObject({ status: 'SUCCEEDED' });
    expect(f.http).toHaveBeenCalledTimes(1);
    expect(f.http.mock.calls[0]![0]).toMatchObject({ method: 'delete' });
    const current = await prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: { id: f.intent.id },
    });
    expect(current.remoteDeleteSucceededBotId).toBe(f.botId);
    expect(current.absenceVerifiedAt).toBeNull();
    expect(f.service.getDueSweepRuntimeSnapshot().autoDeleteReceipts).toEqual({
      freshSettled: 1,
      savedSettled: 0,
      refused: 0,
      errors: 0,
    });
  });

  it('settles an exact acknowledged DELETE without the impossible absence read or a second DELETE', async () => {
    const f = await fixture();
    await expect(
      f.max.getExactMessagePresence(f.intent.chatId, f.intent.messageId, { botId: f.botId }),
    ).rejects.toMatchObject({ response: { status: 404 } });
    f.http.mockClear();
    await expect(
      f.service.executeLeasedIntent(f.intent.id, f.intent.leaseToken!),
    ).resolves.toMatchObject({ kind: 'confirmed', status: 'SUCCEEDED' });
    expect(f.http).not.toHaveBeenCalled();
    expect(f.route).not.toHaveBeenCalled();
    const actual = await prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: { id: f.intent.id },
    });
    expect(actual.absenceVerifiedAt).toBeNull();
    expect(actual.remoteDeleteSucceededAt).toEqual(f.intent.remoteDeleteSucceededAt);
    expect(actual.retryUntilAt).toEqual(f.intent.retryUntilAt);
    expect(actual.leaseToken).toBeNull();
    expect(f.service.getDueSweepRuntimeSnapshot().autoDeleteReceipts).toEqual({
      freshSettled: 0,
      savedSettled: 1,
      refused: 0,
      errors: 0,
    });
  });
  it.each([
    'missing-time',
    'missing-bot',
    'wrong-bot',
    'future-time',
    'active-dispatch',
    'independent-reason',
    'newer-reason',
    'lost-lease',
    'retention',
  ])('preserves unsafe receipt: %s', async (change) => {
    const f = await fixture();
    const changes = {
      'wrong-bot': { remoteDeleteSucceededBotId: 'other-bot' },
      'future-time': { remoteDeleteSucceededAt: new Date(Date.now() + 60_000) },
      'active-dispatch': {
        deleteDispatchStartedAt: new Date(),
        deleteDispatchStartedBotId: f.botId,
      },
      'lost-lease': { leaseToken: 'other-owner' },
      retention: { retentionOwned: true },
    };
    if (change in changes)
      await prisma.moderationDeleteIntent.update({
        where: { id: f.intent.id },
        data: changes[change as keyof typeof changes],
      });
    if (change === 'independent-reason')
      await prisma.moderationDeleteIntentReason.create({
        data: {
          id: randomUUID(),
          intentId: f.intent.id,
          reasonKey: 'independent',
          ruleCode: 'MESSAGE_TOO_LONG_DELETE',
        },
      });
    if (change === 'newer-reason')
      await prisma.moderationDeleteIntentReason.updateMany({
        where: { intentId: f.intent.id },
        data: { createdAt: new Date() },
      });
    const current = await prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: { id: f.intent.id },
    });
    const materialize = jest.fn();
    await expect(
      settleBotAutoDeleteReceipt(
        prisma,
        {
          ...current,
          ...(change === 'missing-time' ? { remoteDeleteSucceededAt: null } : {}),
          ...(change === 'missing-bot' ? { remoteDeleteSucceededBotId: null } : {}),
        },
        f.intent.leaseToken!,
        materialize,
      ),
    ).resolves.toBe(false);
    expect(materialize).not.toHaveBeenCalled();
    expect(
      await prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: f.intent.id } }),
    ).toEqual(current);
    expect(f.http).not.toHaveBeenCalled();
  });

  it('rolls back settlement on event persistence failure and resumes once', async () => {
    const f = await fixture();
    await expect(
      settleBotAutoDeleteReceipt(prisma, f.intent, f.intent.leaseToken!, async () => {
        throw new Error('synthetic persistence failure');
      }),
    ).rejects.toThrow('synthetic persistence');
    expect(
      (await prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: f.intent.id } }))
        .status,
    ).toBe('IN_PROGRESS');
    await expect(
      f.service.executeLeasedIntent(f.intent.id, f.intent.leaseToken!),
    ).resolves.toMatchObject({ status: 'SUCCEEDED' });
    await expect(
      f.service.executeLeasedIntent(f.intent.id, f.intent.leaseToken!),
    ).resolves.toMatchObject({ status: 'SUCCEEDED' });
    const events = await prisma.moderationEvent.findMany({ where: { chatId: f.intent.chatId } });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({
      botAutoDeleteConfirmation: { version: 1, kind: 'documented_delete_success', botId: f.botId },
    });
    expect(f.http).not.toHaveBeenCalled();
  });

  it('rechecks a reason committed while waiting for the parent lock', async () => {
    const f = await fixture();
    let locked!: () => void, release!: () => void, trying!: () => void;
    const ready = new Promise<void>((r) => (locked = r));
    const unblock = new Promise<void>((r) => (release = r));
    const attempted = new Promise<void>((r) => (trying = r));
    const writer = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM moderation_delete_intents WHERE id = ${f.intent.id} FOR UPDATE`;
      await tx.moderationDeleteIntentReason.create({
        data: {
          id: randomUUID(),
          intentId: f.intent.id,
          reasonKey: 'concurrent',
          ruleCode: 'MESSAGE_TOO_LONG_DELETE',
        },
      });
      locked();
      await unblock;
    });
    await ready;
    const wrapped = {
      $transaction: (
        callback: (
          tx: import('../prisma/prisma-client').Prisma.TransactionClient,
        ) => Promise<boolean>,
        options: {
          isolationLevel: import('../prisma/prisma-client').Prisma.TransactionIsolationLevel;
        },
      ) =>
        prisma.$transaction(
          (tx) =>
            callback(
              new Proxy(tx, {
                get(target, key) {
                  if (key === '$queryRaw')
                    return (...args: Parameters<typeof tx.$queryRaw>) => {
                      trying();
                      return tx.$queryRaw(...args);
                    };
                  return Reflect.get(target, key);
                },
              }),
            ),
          options,
        ),
    } as Pick<PrismaClient, '$transaction'>;
    const materialize = jest.fn();
    const settlement = settleBotAutoDeleteReceipt(
      wrapped,
      f.intent,
      f.intent.leaseToken!,
      materialize,
    );
    try {
      await attempted;
    } finally {
      release();
    }
    await writer;
    await expect(settlement).resolves.toBe(false);
    expect(materialize).not.toHaveBeenCalled();
    expect(
      (await prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: f.intent.id } }))
        .status,
    ).toBe('IN_PROGRESS');
  });
});
