import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { KaravanMarketplaceResolveResult } from '@maxim/contracts/karavan-marketplace';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MaxActionJob } from '../../max/max-client.service';
import type { KaravanMarketplaceAuthorityService } from './karavan-marketplace-authority.service';
import {
  KaravanMarketplaceResolverService,
  type KaravanScopedPublication,
} from './karavan-marketplace-resolver.service';

describe('Chat shop publication format boundary', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });
  function fixture() {
    const input = {
      chatId: '-123',
      actorMaxUserId: '777',
      subjectMaxUserId: '888',
      sourceMessageId: 'message-1',
      botId: 'major',
    };
    const storeId = randomUUID();
    const url = 'https://max.ru/test_bot?startapp=m_synthetic__s_administration';
    const result: KaravanMarketplaceResolveResult = {
      status: 'published',
      marketplace: {
        id: randomUUID(),
        networkId: randomUUID(),
        publicSlug: 'synthetic',
        name: 'Соседи',
        description: null,
        kind: 'chat',
        status: 'active',
        admissionPolicy: 'applications',
        logoImageUrl: null,
        coverImageUrl: null,
        editRevision: 1,
        policyRevision: 1,
        orderRevision: 1,
        visibilityRevision: 1,
        format: 'storefront',
        administrationStoreId: storeId,
        formatRevision: 1,
      },
      binding: { id: randomUUID(), generation: 2 },
      stores: [{ id: storeId, slug: 'administration', name: 'Соседи', url, inviteUrl: url }],
    };
    const authority = {
      assertEnabled: jest.fn(),
      issuePublication: jest
        .fn<
          ReturnType<KaravanMarketplaceAuthorityService['issuePublication']>,
          Parameters<KaravanMarketplaceAuthorityService['issuePublication']>
        >()
        .mockImplementation(async (scope) => ({
          authority: { ...scope, proofId: 'x'.repeat(43) },
          sourceFingerprint: 'a'.repeat(64),
        })),
    } satisfies Pick<KaravanMarketplaceAuthorityService, 'assertEnabled' | 'issuePublication'>;
    const findChoice = jest.fn();
    const prisma = { karavanMarketplacePublicationChoice: { findUnique: findChoice } };
    global.fetch = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(async () => new Response(JSON.stringify(result), { status: 200 }));
    const resolver = new KaravanMarketplaceResolverService(
      new ConfigService({
        KARAVAN_MARKETPLACE_ENABLED: true,
        KARAVAN_STOREFRONT_RELAY_ENABLED: true,
        KARAVAN_MARKETPLACE_API_BASE_URL: 'https://karavan.invalid',
        KARAVAN_MARKETPLACE_COMMAND_TOKEN: 'synthetic',
        KARAVAN_STOREFRONT_CATALOG_URL: 'https://max.ru/test_bot',
      }),
      authority as unknown as KaravanMarketplaceAuthorityService,
      prisma as unknown as PrismaService,
    );
    const job = (publication: KaravanScopedPublication): MaxActionJob => ({
      actionType: 'SEND_MESSAGE',
      chatId: input.chatId,
      botId: input.botId,
      routing: { purpose: 'send_message', requiredBotId: input.botId },
      options: { buttons: [[{ type: 'link', text: 'Открыть витрину', url: publication.url }]] },
      ledgerContext: { karavanMarketplacePublication: publication },
      attempt: 1,
      idempotencyKey: 'synthetic',
      createdAt: new Date().toISOString(),
    });
    return { input, result, resolver, findChoice, job };
  }
  it('uses the fixed storefront for each permitted actor without a personal storefront choice', async () => {
    const { input, result, resolver, findChoice } = fixture();
    for (const actorMaxUserId of ['777', '999']) {
      const resolved = await resolver.resolve({ ...input, actorMaxUserId });
      expect(resolved.publication).toMatchObject({
        actorMaxUserId,
        storeId: result.marketplace!.administrationStoreId,
        format: 'storefront',
        formatRevision: 1,
      });
    }
    expect(findChoice).not.toHaveBeenCalled();
  });
  it('stays silent when the fixed storefront is unavailable and rejects a personal-choice response', async () => {
    const { input, result, resolver } = fixture();
    result.status = 'no_listing';
    result.stores = [];
    expect((await resolver.resolve(input)).publication).toBeNull();
    result.status = 'choose_store';
    await expect(resolver.resolve(input)).rejects.toThrow('Общая витрина');
  });
  it('rejects a mismatched fixed store and a foreign public URL', async () => {
    const { input, result, resolver } = fixture();
    const storeId = result.marketplace!.administrationStoreId;
    result.marketplace!.administrationStoreId = randomUUID();
    await expect(resolver.resolve(input)).rejects.toThrow('Общая витрина');
    result.marketplace!.administrationStoreId = storeId;
    result.stores[0].url = 'https://max.ru/test_bot?startapp=m_other';
    await expect(resolver.resolve(input)).rejects.toThrow('Адрес витрины');
  });
  it('keeps community no-listing catalog behavior compatible', async () => {
    const { input, result, resolver } = fixture();
    result.marketplace!.format = 'community';
    result.status = 'no_listing';
    result.stores = [];
    expect((await resolver.resolve(input)).publication).toMatchObject({
      format: 'community',
      storeId: null,
      url: 'https://max.ru/test_bot?startapp=m_synthetic',
    });
  });
  it('rejects queued buttons after a format round trip even when the final URL is unchanged', async () => {
    const { input, result, resolver, job } = fixture();
    const publication = (await resolver.resolve(input)).publication!;
    await expect(resolver.assertDispatch(job(publication), input.botId)).resolves.toBeUndefined();
    result.marketplace!.formatRevision = 3;
    await expect(resolver.assertDispatch(job(publication), input.botId)).rejects.toThrow(
      'Привязка или витрина',
    );
  });
  it('rejects an extra aggregate/create button in a queued administration reply', async () => {
    const { input, resolver, job } = fixture();
    const publication = (await resolver.resolve(input)).publication!;
    const queued = job(publication);
    queued.options!.buttons!.push([
      { type: 'link', text: 'Все витрины', url: 'https://max.ru/test_bot?startapp=m_synthetic' },
    ]);
    await expect(resolver.assertDispatch(queued, input.botId)).rejects.toThrow('Кнопка магазина');
  });
  it('does not retarget an old community catalog button into a newly available storefront', async () => {
    const { input, result, resolver, job } = fixture();
    result.marketplace!.format = 'community';
    const stores = result.stores;
    result.status = 'no_listing';
    result.stores = [];
    const publication = (await resolver.resolve(input)).publication!;
    result.status = 'published';
    result.stores = stores;
    await expect(resolver.assertDispatch(job(publication), input.botId)).rejects.toThrow(
      'Привязка или витрина',
    );
  });
});
