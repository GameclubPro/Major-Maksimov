import { randomUUID } from 'node:crypto';
import { createPrismaAdapter, PrismaClient } from '../prisma/prisma-client';
import {
  normalizeRequiredSubscriptionTargetLink,
  readRequiredSubscriptionTargetLink,
  rememberRequiredSubscriptionTargetLink,
} from './required-subscription-target-link';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const integration = databaseUrl ? describe : describe.skip;

describe('subscription button destinations', () => {
  it.each([
    'javascript:alert(1)',
    'https://example.org/join',
    'https://max.ru/',
    'https://user:secret@max.ru/join/token',
    'https://max.ru:8443/join/token',
    null,
  ])('rejects an unusable saved destination %s', (link) => {
    expect(normalizeRequiredSubscriptionTargetLink(link)).toBeNull();
  });
});

integration('durable subscription button links', () => {
  let db: PrismaClient;
  const botId = `subscription-links-${randomUUID()}`;
  const chatId = `subscription-target-${randomUUID()}`;
  const observedAt = new Date();
  const input = {
    botId,
    chatId,
    entityType: 'CHANNEL' as const,
    link: 'https://max.ru/subscription',
    observedAt,
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.includes('race_test'))
      throw new Error('Disposable PostgreSQL required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 3, statement_timeout: 5000 }),
    });
    await db.$connect();
  });
  afterEach(async () => {
    await db.managedBotChatCatalog.deleteMany({ where: { botId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  it('retains a link without creating a chat, membership or active catalog connection', async () => {
    await rememberRequiredSubscriptionTargetLink(db, input);
    expect(await readRequiredSubscriptionTargetLink(db, chatId)).toBe(input.link);
    const row = await db.managedBotChatCatalog.findUniqueOrThrow({
      where: { botId_chatId: { botId, chatId } },
    });
    expect(row).toMatchObject({
      status: 'PRESENTATION',
      source: 'required_subscription',
      metadataObservedAt: observedAt,
    });
    expect(await db.chat.findUnique({ where: { id: chatId } })).toBeNull();
    expect(await db.chatBotMembership.count({ where: { chatId } })).toBe(0);
    expect(await readRequiredSubscriptionTargetLink(db, `${chatId}-unrelated`)).toBeNull();
  });

  it('preserves newer metadata, activation state and presence clocks on stale writes', async () => {
    const later = new Date(observedAt.getTime() + 1000);
    const existing = await db.managedBotChatCatalog.create({
      data: {
        botId,
        chatId,
        entityType: 'CHANNEL',
        status: 'ACTIVE',
        source: 'explicit_activation',
        link: 'https://max.ru/new-link',
        metadataObservedAt: later,
      },
    });
    await rememberRequiredSubscriptionTargetLink(db, input);
    expect(
      await db.managedBotChatCatalog.findUnique({ where: { botId_chatId: { botId, chatId } } }),
    ).toEqual(existing);
  });

  it('updates only the link observation of an existing active target', async () => {
    const before = new Date(observedAt.getTime() - 1000);
    const existing = await db.managedBotChatCatalog.create({
      data: {
        botId,
        chatId,
        status: 'ACTIVE',
        source: 'explicit_activation',
        title: 'Saved title',
        lastSeenAt: before,
        updatedAt: before,
        metadataObservedAt: before,
      },
    });
    await rememberRequiredSubscriptionTargetLink(db, input);
    const row = await db.managedBotChatCatalog.findUniqueOrThrow({
      where: { botId_chatId: { botId, chatId } },
    });
    expect(row).toMatchObject({
      link: input.link,
      metadataObservedAt: observedAt,
      status: existing.status,
      source: existing.source,
      title: existing.title,
      lastSeenAt: existing.lastSeenAt,
    });
  });

  it('does not revive a removed target or use its link as an active catalog fallback', async () => {
    const row = await db.managedBotChatCatalog.create({
      data: {
        botId,
        chatId,
        status: 'REMOVED',
        link: 'https://max.ru/removed',
      },
    });
    await rememberRequiredSubscriptionTargetLink(db, input);
    expect(
      await db.managedBotChatCatalog.findUnique({ where: { botId_chatId: { botId, chatId } } }),
    ).toEqual(row);
    expect(await readRequiredSubscriptionTargetLink(db, chatId)).toBeNull();
  });

  it('keeps one inert catalog row when two resolvers save the same verified target', async () => {
    await Promise.all([
      rememberRequiredSubscriptionTargetLink(db, input),
      rememberRequiredSubscriptionTargetLink(db, input),
    ]);
    expect(await db.managedBotChatCatalog.count({ where: { botId, chatId } })).toBe(1);
    expect(await readRequiredSubscriptionTargetLink(db, chatId)).toBe(input.link);
  });
});
