import type { KaravanMarketplaceResolverService } from './karavan-marketplace-resolver.service';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import type { KaravanMarketplaceModule } from '@maxim/contracts/karavan-marketplace';
import { KaravanMarketplaceController } from './karavan-marketplace.controller';
import type { KaravanMarketplaceAuthorityService } from './karavan-marketplace-authority.service';
import type { KaravanMarketplaceProxyService } from './karavan-marketplace-proxy.service';
import type { KaravanMarketplaceHandoffService } from './karavan-marketplace-handoff.service';

describe('Karavan module destination permissions', () => {
  function fixture() {
    const marketplaceId = randomUUID();
    const state: KaravanMarketplaceModule = {
      marketplace: {
        id: marketplaceId,
        networkId: randomUUID(),
        publicSlug: 'synthetic',
        name: 'Synthetic',
        description: null,
        kind: 'chat',
        status: 'draft',
        admissionPolicy: 'applications',
        logoImageUrl: null,
        coverImageUrl: null,
        editRevision: 1,
        policyRevision: 1,
        orderRevision: 1,
        visibilityRevision: 1,
      },
      binding: {
        id: randomUUID(),
        chatId: '-123',
        chatTitle: 'Synthetic',
        state: 'verified',
        generation: 1,
        revision: 1,
        verifiedAt: new Date().toISOString(),
      },
      permissions: ['review_listing'],
      counts: { listings: 0, pendingApplications: 3, chats: 1 },
      canManage: false,
    };
    const proxy = {
      module: jest.fn().mockResolvedValue(state),
      activeSetup: jest.fn().mockResolvedValue(null),
    } satisfies Pick<KaravanMarketplaceProxyService, 'module' | 'activeSetup'>;
    const authority = {
      principal: jest.fn().mockReturnValue({
        source: 'session',
        principalKey: 'a'.repeat(64),
        launchBotId: 'synthetic',
      }),
    } satisfies Pick<KaravanMarketplaceAuthorityService, 'principal'>;
    const handoffs = {
      issue: jest.fn().mockResolvedValue({
        url: 'https://max.ru/synthetic?startapp=example',
        expiresAt: new Date().toISOString(),
      }),
    } satisfies Pick<KaravanMarketplaceHandoffService, 'issue'>;
    const resolver = {
      listChoices: jest.fn().mockResolvedValue({ choices: [] }),
      shouldUseScopedRelay: jest.fn().mockResolvedValue(true),
    } satisfies Pick<KaravanMarketplaceResolverService, 'listChoices' | 'shouldUseScopedRelay'>;
    const controller = new KaravanMarketplaceController(
      new ConfigService({
        KARAVAN_MARKETPLACE_ENABLED: true,
        KARAVAN_SELLER_BOT_USERNAME: 'seller',
      }),
      authority as unknown as KaravanMarketplaceAuthorityService,
      proxy as unknown as KaravanMarketplaceProxyService,
      resolver as unknown as KaravanMarketplaceResolverService,
      handoffs as unknown as KaravanMarketplaceHandoffService,
    );
    const invoke = (destination: string) =>
      controller.handoff(
        '-123',
        { commandId: randomUUID(), marketplaceId, destination },
        { userId: '777', username: null, displayName: null },
        {} as FastifyRequest,
      );
    const invokeModule = () =>
      controller.module(
        '-123',
        { userId: '777', username: null, displayName: null },
        {} as FastifyRequest,
      );
    return { state, invoke, handoffs, invokeModule, resolver, proxy };
  }
  it('lets a delegated reviewer open applications without granting marketplace settings', async () => {
    const { invoke, handoffs } = fixture();
    await expect(invoke('applications')).resolves.toHaveProperty('url');
    await expect(invoke('categories')).rejects.toThrow('недоступно');
    await expect(invoke('open_marketplace')).rejects.toThrow('недоступно');
    await expect(invoke('invite_sellers')).rejects.toThrow('недоступно');
    expect(handoffs.issue).toHaveBeenCalledTimes(1);
  });
  it('does not mint handoff for disconnected binding even with management permission', async () => {
    const { state, invoke, handoffs } = fixture();
    state.permissions = ['manage_marketplace'];
    state.canManage = true;
    state.binding!.state = 'disconnected';
    await expect(invoke('manage')).rejects.toThrow('недоступно');
    expect(handoffs.issue).not.toHaveBeenCalled();
  });

  it('opens private preview for a reviewer and live buyer view only for an active shop', async () => {
    const { state, invoke, handoffs } = fixture();
    await expect(invoke('preview')).resolves.toHaveProperty('url');
    await expect(invoke('view')).rejects.toThrow('недоступен');
    state.marketplace!.status = 'active';
    await expect(invoke('view')).resolves.toHaveProperty('url');
    await expect(invoke('preview')).resolves.toHaveProperty('url');
    state.permissions = [];
    await expect(invoke('view')).rejects.toThrow('недоступно');
    expect(handoffs.issue).toHaveBeenCalledTimes(3);
  });
  it('does not expose a destination after marketplace membership was revoked', async () => {
    const { state, invoke, handoffs } = fixture();
    state.permissions = [];
    await expect(invoke('manage')).rejects.toThrow('недоступно');
    expect(handoffs.issue).not.toHaveBeenCalled();
  });
  it('previews the same route as the relay and never substitutes a general catalog after enrollment', async () => {
    const { state, invokeModule, resolver } = fixture();
    state.marketplace!.status = 'active';
    state.access = { reason: 'allowed', canRecover: false };
    await expect(invokeModule()).resolves.toMatchObject({
      publicationPreview: { mode: 'chat_marketplace' },
    });
    state.marketplace!.status = 'paused';
    await expect(invokeModule()).resolves.toMatchObject({
      publicationPreview: { mode: 'unavailable', reason: 'closed' },
    });
    state.binding = null;
    await expect(invokeModule()).resolves.toMatchObject({
      publicationPreview: { mode: 'unavailable', reason: 'connection' },
    });
    resolver.shouldUseScopedRelay.mockResolvedValue(false);
    await expect(invokeModule()).resolves.toMatchObject({
      publicationPreview: { mode: 'catalog' },
    });
  });
  it('does not invent a preview for an unverified module or read enrollment before authorization', async () => {
    const { state, invokeModule, resolver, proxy } = fixture();
    state.marketplace!.status = 'active';
    await expect(invokeModule()).resolves.toMatchObject({
      publicationPreview: { mode: 'unavailable', reason: 'verification' },
    });
    resolver.shouldUseScopedRelay.mockClear();
    proxy.module.mockRejectedValue(new Error('denied'));
    await expect(invokeModule()).rejects.toThrow('denied');
    expect(resolver.shouldUseScopedRelay).not.toHaveBeenCalled();
  });
  it('previews one fixed administration storefront only while it is available to buyers', async () => {
    const { state, invokeModule, resolver } = fixture();
    const storeId = randomUUID();
    state.marketplace = {
      ...state.marketplace!,
      status: 'active',
      format: 'storefront',
      administrationStoreId: storeId,
      formatRevision: 1,
    };
    state.access = { reason: 'allowed', canRecover: false };
    state.administrationStore = {
      id: storeId,
      slug: 'administration',
      name: 'Соседи',
      status: 'ACTIVE',
      editRevision: 1,
    };
    state.buyerUrl = 'https://max.ru/test_bot?startapp=m_synthetic__s_administration';
    await expect(invokeModule()).resolves.toMatchObject({
      publicationPreview: { mode: 'administration_storefront' },
    });
    state.administrationStore.status = 'BLOCKED';
    await expect(invokeModule()).resolves.toMatchObject({
      publicationPreview: { mode: 'unavailable', reason: 'closed' },
    });
    state.administrationStore.status = 'ACTIVE';
    state.buyerUrl = null;
    await expect(invokeModule()).resolves.toMatchObject({
      publicationPreview: { mode: 'unavailable', reason: 'closed' },
    });
    resolver.shouldUseScopedRelay.mockResolvedValue(false);
    await expect(invokeModule()).resolves.toMatchObject({
      publicationPreview: { mode: 'unavailable', reason: 'connection' },
    });
  });
  it('issues administration management handoff only for the verified fixed storefront', async () => {
    const { state, invoke, handoffs } = fixture();
    state.permissions = ['manage_marketplace'];
    state.access = { reason: 'allowed', canRecover: false };
    await expect(invoke('storefront')).rejects.toThrow('Общая витрина');
    const storeId = randomUUID();
    state.marketplace = {
      ...state.marketplace!,
      format: 'storefront',
      administrationStoreId: storeId,
      formatRevision: 1,
    };
    state.administrationStore = {
      id: storeId,
      slug: 'administration',
      name: 'Соседи',
      status: 'DRAFT',
      editRevision: 1,
    };
    await expect(invoke('storefront')).resolves.toHaveProperty('url');
    state.administrationStore.id = randomUUID();
    await expect(invoke('storefront')).rejects.toThrow('Общая витрина');
    expect(handoffs.issue).toHaveBeenCalledTimes(1);
  });
});
