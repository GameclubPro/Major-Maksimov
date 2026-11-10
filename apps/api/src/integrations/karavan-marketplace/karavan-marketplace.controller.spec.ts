import type { KaravanMarketplaceResolverService } from './karavan-marketplace-resolver.service';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import type { KaravanMarketplaceModule } from '@maxim/contracts/karavan-marketplace';
import { KaravanMarketplaceController } from './karavan-marketplace.controller';
import type { KaravanMarketplaceAuthorityService } from './karavan-marketplace-authority.service';
import type { KaravanMarketplaceProxyService } from './karavan-marketplace-proxy.service';
import type { KaravanMarketplaceHandoffService } from './karavan-marketplace-handoff.service';
import type { KaravanMarketplaceConnectionsService } from './karavan-marketplace-connections.service';

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
      {
        snapshot: jest
          .fn()
          .mockResolvedValue({ version: 2, revision: 0, blocked: false, operation: null }),
      } satisfies Pick<
        KaravanMarketplaceConnectionsService,
        'snapshot'
      > as unknown as KaravanMarketplaceConnectionsService,
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

  it('retires appearance preview and opens the buyer view only for an active shop', async () => {
    const { state, invoke, handoffs } = fixture();
    await expect(invoke('preview')).rejects.toThrow('Предпросмотр');
    await expect(invoke('view')).rejects.toThrow('недоступен');
    state.marketplace!.status = 'active';
    await expect(invoke('view')).resolves.toHaveProperty('url');
    await expect(invoke('preview')).rejects.toThrow('Предпросмотр');
    state.permissions = [];
    await expect(invoke('view')).rejects.toThrow('недоступно');
    expect(handoffs.issue).toHaveBeenCalledTimes(1);
  });
  it('does not expose a destination after marketplace membership was revoked', async () => {
    const { state, invoke, handoffs } = fixture();
    state.permissions = [];
    await expect(invoke('manage')).rejects.toThrow('недоступно');
    expect(handoffs.issue).not.toHaveBeenCalled();
  });
  it('opens own placement with a current chat binding without granting administration of seller stores', async () => {
    const { state, invoke, handoffs } = fixture();
    state.marketplace!.format = 'community';
    state.access = { reason: 'allowed', canRecover: false };
    await expect(invoke('placement')).resolves.toHaveProperty('url');
    state.marketplace!.format = 'storefront';
    await expect(invoke('placement')).rejects.toThrow('Размещение');
    state.marketplace!.format = 'community';
    state.marketplace!.status = 'archived';
    await expect(invoke('placement')).rejects.toThrow('Размещение');
    state.marketplace!.status = 'active';
    state.binding!.state = 'disconnected';
    await expect(invoke('placement')).rejects.toThrow('недоступно');
    expect(handoffs.issue).toHaveBeenCalledTimes(1);
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

  it('allows a current administrator to configure v2 storefronts before attaching one', async () => {
    const { state, invoke, handoffs } = fixture();
    state.chatShopFlowVersion = 2;
    state.permissions = ['manage_marketplace'];
    state.access = { reason: 'allowed', canRecover: false };
    state.marketplace!.format = 'storefront';
    state.administrationStores = [];
    state.administrationStoreCount = 0;
    await expect(invoke('storefront')).resolves.toHaveProperty('url');
    state.access.reason = 'not_admin';
    await expect(invoke('storefront')).rejects.toThrow('Общая витрина');
    state.access.reason = 'allowed';
    state.binding!.state = 'disconnected';
    await expect(invoke('storefront')).rejects.toThrow('недоступно');
    expect(handoffs.issue).toHaveBeenCalledTimes(1);
  });

  it('uses connected v2 storefront count for the publication route and requires a published store', async () => {
    const { state, invokeModule } = fixture();
    state.chatShopFlowVersion = 2;
    state.marketplace!.format = 'storefront';
    state.marketplace!.status = 'active';
    state.access = { reason: 'allowed', canRecover: false };
    state.buyerUrl = 'https://max.ru/test_bot?startapp=m_synthetic';
    state.administrationStores = [];
    state.administrationStoreCount = 0;
    await expect(invokeModule()).resolves.toMatchObject({
      publicationPreview: { mode: 'unavailable', reason: 'closed' },
    });
    state.administrationStores.push({
      id: randomUUID(),
      slug: 'first',
      name: 'Первая',
      status: 'ACTIVE',
      editRevision: 1,
      publicationReason: 'no_published_offers',
    });
    state.administrationStoreCount = 1;
    await expect(invokeModule()).resolves.toMatchObject({
      publicationPreview: { mode: 'unavailable', reason: 'closed' },
    });
    state.administrationStores[0].publicationReason = 'published';
    await expect(invokeModule()).resolves.toMatchObject({
      publicationPreview: { mode: 'unavailable', reason: 'closed' },
    });
    state.counts.readyListings = 1;
    await expect(invokeModule()).resolves.toMatchObject({
      publicationPreview: { mode: 'administration_shop' },
    });
    // The other connected store may be hidden or still being completed.
    state.administrationStoreCount = 2;
    await expect(invokeModule()).resolves.toMatchObject({
      publicationPreview: { mode: 'administration_shop' },
    });
    state.administrationStores[0].status = 'BLOCKED';
    await expect(invokeModule()).resolves.toMatchObject({
      publicationPreview: { mode: 'unavailable', reason: 'closed' },
    });
  });
});

describe('connection recovery authorization', () => {
  const user = { userId: '777', username: null, displayName: null };
  const request = {} as FastifyRequest;
  function fixture() {
    const principal = {
      source: 'session' as const,
      principalKey: 'a'.repeat(64),
      launchBotId: 'synthetic',
    };
    const authority = {
      principal: jest.fn().mockReturnValue(principal),
      assertPrincipal: jest.fn().mockResolvedValue(undefined),
    } satisfies Pick<KaravanMarketplaceAuthorityService, 'principal' | 'assertPrincipal'>;
    const proxy = {
      module: jest.fn(),
      inspectSetup: jest.fn().mockResolvedValue({ state: 'unknown' }),
      setup: jest.fn(),
    } satisfies Pick<KaravanMarketplaceProxyService, 'module' | 'inspectSetup' | 'setup'>;
    const connections = {
      settleBinding: jest.fn().mockResolvedValue(undefined),
      bind: jest.fn<
        ReturnType<KaravanMarketplaceConnectionsService['bind']>,
        Parameters<KaravanMarketplaceConnectionsService['bind']>
      >(),
      status: jest.fn<
        ReturnType<KaravanMarketplaceConnectionsService['status']>,
        Parameters<KaravanMarketplaceConnectionsService['status']>
      >(),
      resume: jest.fn<
        ReturnType<KaravanMarketplaceConnectionsService['resume']>,
        Parameters<KaravanMarketplaceConnectionsService['resume']>
      >(),
      legacyBind: jest.fn<
        ReturnType<KaravanMarketplaceConnectionsService['legacyBind']>,
        Parameters<KaravanMarketplaceConnectionsService['legacyBind']>
      >(),
    } satisfies Pick<
      KaravanMarketplaceConnectionsService,
      'settleBinding' | 'bind' | 'status' | 'resume' | 'legacyBind'
    >;
    const controller = new KaravanMarketplaceController(
      new ConfigService(),
      authority as unknown as KaravanMarketplaceAuthorityService,
      proxy as unknown as KaravanMarketplaceProxyService,
      {} as KaravanMarketplaceResolverService,
      {} as KaravanMarketplaceHandoffService,
      connections as unknown as KaravanMarketplaceConnectionsService,
    );
    return { controller, authority, proxy, connections, principal };
  }
  it('reads an owned setup result without depending on live marketplace authorization', async () => {
    const { controller, proxy, authority } = fixture();
    const id = randomUUID();
    await expect(controller.status('-123', id, user, request)).resolves.toEqual({
      state: 'unknown',
    });
    expect(authority.assertPrincipal).toHaveBeenCalled();
    expect(proxy.inspectSetup).toHaveBeenCalledWith(id, '777', '-123');
    expect(proxy.module).not.toHaveBeenCalled();
  });
  it('does not settle another operation for an expired principal', async () => {
    const { controller, authority, proxy, connections } = fixture();
    authority.assertPrincipal.mockRejectedValue(new Error('Session expired'));
    await expect(
      controller.setup(
        '-123',
        {
          operationId: randomUUID(),
          chatIds: ['-123'],
          existingMarketplaceId: randomUUID(),
          expectedPolicyRevision: 1,
        },
        user,
        request,
      ),
    ).rejects.toThrow();
    expect(authority.assertPrincipal).toHaveBeenCalled();
    expect(connections.settleBinding).not.toHaveBeenCalled();
    expect(proxy.setup).not.toHaveBeenCalled();
  });
  function bindingInput() {
    return {
      commandId: randomUUID(),
      marketplaceId: randomUUID(),
      action: 'recover_chat' as const,
      expectedBindingGeneration: 3,
      expectedConnectionRevision: 4,
    };
  }
  it('forwards a new binding with its original intent, route chat and authenticated principal', () => {
    const { controller, authority, connections, principal } = fixture();
    const input = bindingInput();
    controller.connectionBinding('-123', input, user, request);
    expect(authority.principal).toHaveBeenCalledWith(user, undefined);
    expect(connections.bind).toHaveBeenCalledWith('-123', '777', input, principal);
    expect(connections.bind).toHaveBeenCalledTimes(1);
  });
  it('imports the original binding only through the explicit import mode', () => {
    const { controller, connections, principal } = fixture();
    const input = bindingInput();
    controller.importBinding('-123', input, user, request);
    expect(connections.bind).toHaveBeenCalledWith('-123', '777', input, principal, true);
    expect(connections.bind).toHaveBeenCalledTimes(1);
  });
  it('keeps owned status inspection and explicit continuation on their distinct service methods', () => {
    const { controller, connections, principal } = fixture();
    const id = randomUUID();
    controller.connectionStatus('-123', id, user, request);
    expect(connections.status).toHaveBeenCalledWith('-123', '777', id, principal);
    expect(connections.resume).not.toHaveBeenCalled();
    controller.connectionResume('-123', id, user, request);
    expect(connections.resume).toHaveBeenCalledWith('-123', '777', id, principal);
    expect(connections.status).toHaveBeenCalledTimes(1);
    expect(connections.resume).toHaveBeenCalledTimes(1);
    expect(connections.bind).not.toHaveBeenCalled();
  });
  it('adapts an old binding route into the same owned journal with its original command ID', () => {
    const { controller, connections, principal } = fixture();
    const marketplaceId = randomUUID();
    const input = {
      commandId: randomUUID(),
      action: 'unbind_chat' as const,
      expectedBindingGeneration: 3,
    };
    controller.bind('-123', marketplaceId, input, user, request);
    expect(connections.legacyBind).toHaveBeenCalledWith(
      '-123',
      '777',
      { ...input, marketplaceId },
      principal,
    );
    expect(connections.legacyBind).toHaveBeenCalledTimes(1);
    expect(connections.bind).not.toHaveBeenCalled();
  });
  it('rejects invalid route chat IDs before any connection service call', () => {
    const { controller, connections } = fixture();
    const input = bindingInput();
    const legacy = {
      commandId: input.commandId,
      action: input.action,
      expectedBindingGeneration: input.expectedBindingGeneration,
    };
    const id = randomUUID();
    for (const invoke of [
      () => controller.connectionBinding('invalid', input, user, request),
      () => controller.importBinding('invalid', input, user, request),
      () => controller.connectionStatus('invalid', id, user, request),
      () => controller.connectionResume('invalid', id, user, request),
      () => controller.bind('invalid', input.marketplaceId, legacy, user, request),
    ])
      expect(invoke).toThrow();
    for (const method of Object.values(connections)) expect(method).not.toHaveBeenCalled();
  });
  it('rejects invalid operation and marketplace IDs before any connection service call', () => {
    const { controller, connections } = fixture();
    const input = bindingInput();
    const legacy = {
      commandId: input.commandId,
      action: input.action,
      expectedBindingGeneration: input.expectedBindingGeneration,
    };
    for (const invoke of [
      () => controller.connectionStatus('-123', 'invalid', user, request),
      () => controller.connectionResume('-123', 'invalid', user, request),
      () => controller.bind('-123', 'invalid', legacy, user, request),
    ])
      expect(invoke).toThrow();
    for (const method of Object.values(connections)) expect(method).not.toHaveBeenCalled();
  });
});
