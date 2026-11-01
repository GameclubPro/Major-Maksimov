import { randomUUID, createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, createPrismaAdapter } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { KaravanMarketplaceAuthorityService } from './karavan-marketplace-authority.service';
import { KaravanMarketplaceResolverService } from './karavan-marketplace-resolver.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
postgres('Private Karavan publication choice persistence', () => {
  let db: PrismaClient;
  let resolver: KaravanMarketplaceResolverService;
  let originalFetch: typeof fetch;
  let input: {
    actorMaxUserId: string;
    chatId: string;
    botId: string;
    subjectMaxUserId: string;
    sourceMessageId: string;
  };
  let generation: number;
  let format: 'storefront' | undefined;
  const marketplaceId = randomUUID();
  const storeId = randomUUID();
  const otherStoreId = randomUUID();
  const config = new ConfigService({
    KARAVAN_MARKETPLACE_ENABLED: true,
    KARAVAN_MARKETPLACE_API_BASE_URL: 'https://karavan.invalid',
    KARAVAN_MARKETPLACE_COMMAND_TOKEN: 'synthetic',
    KARAVAN_STOREFRONT_CATALOG_URL: 'https://max.ru/test_bot',
  });
  const authority = { assertEnabled: jest.fn(), issuePublication: jest.fn() };
  const makeResolver = () =>
    new KaravanMarketplaceResolverService(
      config,
      authority as unknown as KaravanMarketplaceAuthorityService,
      db as PrismaService,
    );
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 4, statement_timeout: 10000 }),
    });
    await db.$connect();
  });
  beforeEach(() => {
    originalFetch = global.fetch;
    generation = 1;
    format = undefined;
    input = {
      actorMaxUserId: '777',
      chatId: `-${Date.now()}${Math.floor(Math.random() * 1000)}`,
      botId: 'synthetic',
      subjectMaxUserId: '777',
      sourceMessageId: 'message-1',
    };
    resolver = makeResolver();
    authority.issuePublication.mockReset().mockImplementation(async (scope, source) => ({
      authority: scope,
      sourceFingerprint: createHash('sha256').update(source.sourceMessageId).digest('hex'),
    }));
    global.fetch = jest.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      if (
        request.authority.expectedBindingGeneration &&
        request.authority.expectedBindingGeneration !== generation
      )
        return new Response('{}', { status: 409 });
      const selected = format === 'storefront' ? storeId : request.payload.storeId;
      return new Response(
        JSON.stringify({
          status: selected ? 'published' : 'choose_store',
          marketplace: {
            id: marketplaceId,
            networkId: randomUUID(),
            publicSlug: 'synthetic',
            name: 'Соседи',
            description: null,
            kind: 'chat',
            ...(format ? { format, administrationStoreId: storeId, formatRevision: 2 } : {}),
            status: 'active',
            admissionPolicy: 'applications',
            logoImageUrl: null,
            coverImageUrl: null,
            editRevision: 1,
            policyRevision: 1,
            orderRevision: 1,
            visibilityRevision: 1,
          },
          binding: { id: randomUUID(), generation },
          stores: (selected ? [selected] : [storeId, otherStoreId]).map((id) => ({
            id,
            slug: id,
            name: 'Витрина',
            url: `https://max.ru/test_bot?startapp=m_synthetic__s_${id}`,
            inviteUrl: `https://max.ru/test_bot?startapp=m_synthetic__s_${id}`,
          })),
        }),
        { status: 200 },
      );
    }) as typeof fetch;
  });
  afterEach(async () => {
    await db.karavanMarketplaceChatEnrollment.deleteMany({ where: { chatId: input.chatId } });
    global.fetch = originalFetch;
    await db.karavanMarketplacePublicationChoice.deleteMany({ where: { chatId: input.chatId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  it('uses durable enrollment for both response preview and relay even without a current binding', async () => {
    expect(await resolver.shouldUseScopedRelay(input.chatId)).toBe(false);
    await db.karavanMarketplaceChatEnrollment.create({
      data: {
        chatId: input.chatId,
        actorMaxUserId: input.actorMaxUserId,
        requestedCommandId: randomUUID(),
        marketplaceId,
      },
    });
    expect(await resolver.shouldUseScopedRelay(input.chatId)).toBe(true);
    resolver = makeResolver();
    expect(await resolver.shouldUseScopedRelay(input.chatId)).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(authority.issuePublication).not.toHaveBeenCalled();
  });
  const prompt = async () => {
    expect((await resolver.resolve(input)).publication).toBeNull();
    return (await resolver.listChoices({ actorMaxUserId: input.actorMaxUserId })).choices.find(
      (choice) => choice.chatId === input.chatId,
    )!;
  };
  it('persists an actor-specific choice across resolver restart and applies it only to a fresh request', async () => {
    const choice = await prompt();
    expect((await resolver.listChoices({ actorMaxUserId: '999' })).choices).toEqual([]);
    expect(
      await resolver.saveChoice({
        actorMaxUserId: input.actorMaxUserId,
        choiceId: choice.id,
        storeId,
      }),
    ).toEqual({ saved: true, storeId });
    resolver = makeResolver();
    expect(
      await resolver.saveChoice({
        actorMaxUserId: input.actorMaxUserId,
        choiceId: choice.id,
        storeId,
      }),
    ).toEqual({ saved: true, storeId });
    const next = await resolver.resolve({ ...input, sourceMessageId: 'message-2' });
    expect(next.publication?.storeId).toBe(storeId);
    expect((await resolver.listChoices({ actorMaxUserId: input.actorMaxUserId })).choices).toEqual(
      [],
    );
    const stranger = await resolver.resolve({
      ...input,
      actorMaxUserId: '999',
      sourceMessageId: 'message-3',
    });
    expect(stranger.publication).toBeNull();
  });
  it('rejects another actor, expired prompt and changed generation', async () => {
    const choice = await prompt();
    await expect(
      resolver.saveChoice({ actorMaxUserId: '999', choiceId: choice.id, storeId }),
    ).rejects.toThrow();
    generation = 2;
    await expect(
      resolver.saveChoice({ actorMaxUserId: input.actorMaxUserId, choiceId: choice.id, storeId }),
    ).rejects.toThrow();
    generation = 1;
    await db.karavanMarketplacePublicationChoice.updateMany({
      where: { chatId: input.chatId },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await expect(
      resolver.saveChoice({ actorMaxUserId: input.actorMaxUserId, choiceId: choice.id, storeId }),
    ).rejects.toThrow();
    await resolver.pruneExpiredChoices();
    expect(
      await db.karavanMarketplacePublicationChoice.count({ where: { chatId: input.chatId } }),
    ).toBe(0);
  });
  it('invalidates saved preference when binding generation or subject changes', async () => {
    const choice = await prompt();
    await resolver.saveChoice({
      actorMaxUserId: input.actorMaxUserId,
      choiceId: choice.id,
      storeId,
    });
    generation = 2;
    expect(
      (await resolver.resolve({ ...input, sourceMessageId: 'new-generation' })).publication,
    ).toBeNull();
    const replacement = await prompt();
    await resolver.saveChoice({
      actorMaxUserId: input.actorMaxUserId,
      choiceId: replacement.id,
      storeId,
    });
    expect(
      (await resolver.resolve({ ...input, subjectMaxUserId: '888', sourceMessageId: 'forward' }))
        .publication,
    ).toBeNull();
  });
  it('uses the common administration storefront instead of a previously saved personal choice', async () => {
    const choice = await prompt();
    await resolver.saveChoice({
      actorMaxUserId: input.actorMaxUserId,
      choiceId: choice.id,
      storeId: otherStoreId,
    });
    format = 'storefront';
    resolver = makeResolver();
    const publication = (await resolver.resolve({ ...input, sourceMessageId: 'official-store' }))
      .publication;
    expect(publication).toMatchObject({ storeId, format: 'storefront', formatRevision: 2 });
    const previous = await db.karavanMarketplacePublicationChoice.findUnique({
      where: {
        actorMaxUserId_chatId: { actorMaxUserId: input.actorMaxUserId, chatId: input.chatId },
      },
    });
    expect(previous?.selectedStoreId).toBe(otherStoreId);
    expect((await resolver.listChoices({ actorMaxUserId: input.actorMaxUserId })).choices).toEqual(
      [],
    );
  });
  it('rejects changed source and fences a newer prompt during remote selection', async () => {
    const choice = await prompt();
    authority.issuePublication.mockImplementationOnce(async (scope) => ({
      authority: scope,
      sourceFingerprint: 'f'.repeat(64),
    }));
    await expect(
      resolver.saveChoice({ actorMaxUserId: input.actorMaxUserId, choiceId: choice.id, storeId }),
    ).rejects.toThrow('Витрина больше недоступна');
    const fetchBefore = global.fetch;
    global.fetch = jest.fn(async (...args: Parameters<typeof fetch>) => {
      await db.karavanMarketplacePublicationChoice.updateMany({
        where: { chatId: input.chatId },
        data: { promptId: randomUUID() },
      });
      return fetchBefore(...args);
    }) as typeof fetch;
    await expect(
      resolver.saveChoice({ actorMaxUserId: input.actorMaxUserId, choiceId: choice.id, storeId }),
    ).rejects.toThrow('Запрос изменился');
  });
});
