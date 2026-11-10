import '../src/styles.css';
import React from 'react';
import { z } from 'zod';
import { runNativeBackHandlers } from '../src/lib/native-back';
import { ApiRequestError } from '../src/lib/api-request-error';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui/toast';
import { SettingsStorefrontSection } from '../src/pages/settings/settings-storefront-section';
import { SharedChatSettingsSection } from '../src/pages/settings/shared-chat-settings-section';
import { createChatSettingsFieldAdapter } from '../src/features/network-settings/settings-field-bindings';
import { chatSettingsSchema } from '@maxim/contracts/settings';
import {
  karavanMarketplaceCategories,
  karavanMarketplaceModuleSchema,
  karavanMarketplaceOperationSchema,
  karavanMarketplaceSetupSchema,
  karavanMarketplaceSummarySchema,
  karavanMarketplaceBindingSchema,
  type KaravanMarketplaceModule,
} from '@maxim/contracts/karavan-marketplace';
import type {
  MarketplaceApplication,
  MarketplaceManagementResponse,
} from '@maxim/contracts/karavan-marketplace-management';
import { karavanConnectionSnapshotSchema } from '@maxim/contracts/karavan-marketplace-connection';
import '../src/pages/settings-page';
import '../src/styles/moderation-workspace.css';
const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') ?? '';
const simple = scenario.startsWith('simple_');
const providerResponse = (window as Window & { __shopProviderModule?: unknown })
  .__shopProviderModule;
const providerModule = providerResponse
  ? karavanMarketplaceModuleSchema.parse(providerResponse)
  : null;
const fixtureChatId = providerModule?.binding?.chatId ?? '-123';
document.documentElement.dataset.maxTheme = params.get('theme') ?? 'light';
document.body.dataset.miniappProfile = 'moderation';
document.body.classList.add('settings-home-page-open');
const id = 'a0d9b7ce-0040-4c85-a7ec-e3cf6da94c10';
const second = 'bb669048-0279-4a35-987c-60f94593163e';
const administrationStoreId = 'cc669048-0279-4a35-987c-60f94593163e';
let formatConnected = !scenario.startsWith('format_setup') && !scenario.startsWith('simple_setup');
let sellerTermsAccepted = scenario !== 'format_setup_terms';
const market: NonNullable<KaravanMarketplaceModule['marketplace']> =
  providerModule?.marketplace ?? {
    id,
    networkId: second,
    publicSlug: 'synthetic-shop',
    name: 'Магазин соседей',
    description: null,
    kind: 'chat',
    format: 'community',
    formatRevision: 1,
    status: ['draft', 'draft_empty', 'daily_appearance_closed'].includes(
      params.get('scenario') ?? '',
    )
      ? 'draft'
      : 'active',
    admissionPolicy: ['invitation_paged', 'daily_paged'].includes(params.get('scenario') ?? '')
      ? 'invitation'
      : 'applications',
    logoImageUrl: null,
    coverImageUrl: null,
    editRevision: 1,
    policyRevision: 1,
    orderRevision: 1,
    visibilityRevision: 1,
  };
if (scenario.startsWith('format_storefront') || scenario.startsWith('simple_admin')) {
  market.format = 'storefront';
  market.administrationStoreId = administrationStoreId;
  market.formatRevision = 1;
  if (['format_storefront_closed', 'format_storefront_ready'].includes(scenario))
    market.status = 'draft';
}
let administrationStore: KaravanMarketplaceModule['administrationStore'] =
  providerModule?.administrationStore ?? {
    id: administrationStoreId,
    slug: 'administration-store',
    name: 'Витрина администрации соседей',
    status: scenario === 'format_storefront_closed' ? 'DRAFT' : 'ACTIVE',
    editRevision: 1,
  };
let administrationStores =
  simple && scenario.startsWith('simple_admin')
    ? scenario.includes('_0')
      ? []
      : scenario.includes('_many')
        ? [
            administrationStore!,
            { ...administrationStore!, id: second, slug: 'second-store', name: 'Вторая витрина' },
          ]
        : [administrationStore!]
    : [];
if (scenario === 'simple_admin_paused') market.status = 'paused';
if (simple)
  market.admissionMode = scenario.includes('_selected')
    ? 'selected'
    : scenario.includes('_open')
      ? 'open'
      : 'applications';
const formatReceipts = new Map<string, { marketplace: typeof market }>();
let lostFormatResponse = false;
let handoffFailed = false;
const rules = {
  id: second,
  text: 'Правила магазина',
  allowedCategoryIds: ['services', 'grocery'],
  allowedSubcategoryIds: ['services.repair', 'grocery.bread'],
  categoryOrder: ['services', 'grocery'],
  version: 1,
  effectiveAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  requiresAcceptance: true,
};
if (scenario === 'daily_full_categories') {
  rules.allowedCategoryIds = ['real_estate'];
  rules.allowedSubcategoryIds = [];
  rules.categoryOrder = [];
}
if (scenario === 'daily_category_legacy_order') rules.categoryOrder = [];
if (scenario === 'daily_property_legacy') {
  rules.allowedCategoryIds.push('real_estate');
  rules.allowedSubcategoryIds.push('real_estate.room');
  rules.categoryOrder.push('real_estate');
}
const binding = providerModule?.binding ?? {
  id: second,
  chatId: '-123',
  chatTitle: 'Соседи',
  state: 'verified',
  generation: 1,
  revision: 1,
  verifiedAt: new Date().toISOString(),
};
const permissions = providerModule?.permissions ?? [
  'manage_marketplace',
  'review_listing',
  'arrange_listings',
  'bind_chat',
];
if (params.get('scenario') === 'daily_no_arrange')
  permissions.splice(permissions.indexOf('arrange_listings'), 1);
if (params.get('scenario') === 'daily_arrange_only')
  permissions.splice(0, permissions.length, 'arrange_listings', 'bind_chat');
const counts = providerModule?.counts ?? {
  listings: ['draft', 'draft_empty'].includes(params.get('scenario') ?? '') ? 0 : 2,
  readyListings: params.get('scenario') === 'draft' ? 2 : 0,
  approvedListings: params.get('scenario') === 'draft_empty' ? 0 : 2,
  pendingApplications: ['draft', 'draft_empty'].includes(params.get('scenario') ?? '') ? 0 : 1,
  chats: 1,
};
if (scenario === 'format_storefront_ready')
  Object.assign(counts, {
    listings: 0,
    readyListings: 1,
    approvedListings: 0,
    pendingApplications: 2,
  });
if (simple) {
  counts.pendingApplications = scenario.includes('_pending') ? 2 : 0;
  if (
    scenario.includes('_empty') ||
    scenario.startsWith('simple_setup') ||
    scenario.includes('admin_0')
  )
    Object.assign(counts, { listings: 0, readyListings: 0, approvedListings: 0 });
}
const network = scenario.includes('_network');
if (network) counts.chats = scenario.includes('_100') ? 100 : 2;
const connectedChats =
  network && !scenario.includes('_incomplete')
    ? Array.from({ length: counts.chats }, (_, index) =>
        index === 0
          ? binding
          : {
              ...binding,
              id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
              chatId: String(-456 - index),
              chatTitle: index === 1 ? 'Соседи второго дома' : `Соседи дома ${index + 1}`,
            },
      )
    : [binding];
const bindings = connectedChats.slice(0, 48);
const detailCounts =
  (window as Window & { __shopProviderDetailCounts?: typeof counts }).__shopProviderDetailCounts ??
  counts;
const offer = {
  id,
  storeId: second,
  kind: 'product',
  title: 'Ремонт стиральной машины с выездом на дом',
  storeName: 'Мастерская соседей',
  imageUrl: null,
  available: true,
  allowedCategory: true,
  restriction: null,
};
const appearance = {
  name: market.name,
  description: null,
  logoImageUrl: null,
  coverImageUrl: null,
  accent: 'blue',
  blocks: [
    { id: 'categories', visible: true },
    { id: 'pinned', visible: true },
    { id: 'sellers', visible: true },
  ],
};
let design = { draft: appearance, published: appearance, revision: 1, hasChanges: false };
let pins = { revision: 1, offers: [] as (typeof offer)[] };
const allowedUsers = Array.from({ length: 102 }, (_, index) => ({
  id: `allow-${index}`,
  userId: String(1000 + index),
  displayName:
    index === 101
      ? 'Александра Константинопольская-Рождественская — представитель районного сообщества'
      : `Участник ${index + 1}`,
  expiresAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}));
let catalogReads = 0;
let detailReads = 0;
let pendingApplication = true;
const simpleApplications: MarketplaceApplication[] =
  simple && scenario.includes('_pending')
    ? [id, administrationStoreId].map((applicationId, index) => ({
        id: applicationId,
        listingId: index ? administrationStoreId : second,
        marketplaceId: id,
        storeId: index ? administrationStoreId : second,
        storeName: index ? 'Цветы у дома' : 'Мастерская',
        revision: 1,
        attempt: 1,
        state: 'pending',
        profileVersionId: applicationId,
        profile: {
          name: index ? 'Цветы у дома' : 'Мастерская',
          description: index ? 'Букеты на заказ' : 'Ремонт техники',
          logoImageUrl: null,
          coverImageUrl: null,
        },
        publishedProfile: null,
        rulesVersion: rules,
        submittedAt: new Date().toISOString(),
        decidedAt: null,
        reason: null,
        canReview: !(scenario.includes('_self') && index === 0),
        sellerName: index ? 'Анна Цветкова' : 'Иван Петров',
        categoryLabel: index ? 'Цветы' : 'Услуги',
      }))
    : [];
let grant:
  | Extract<MarketplaceManagementResponse, { operation: 'seller_grant_create' }>['data']
  | null = null;
let applicationRevision = 1;
let rulesConflict = !params.get('scenario')?.startsWith('daily_');
let admissionFailure = true;
let statusFailure = params.get('scenario') === 'draft_empty';
let invitation:
  | Extract<MarketplaceManagementResponse, { operation: 'invitation_create' }>['data']
  | null = null;
const invitationHistory = ['invitation_paged', 'daily_paged'].includes(params.get('scenario') ?? '')
  ? Array.from({ length: 25 }, (_, index) => ({
      id: `a0d9b7ce-0040-4c85-a7ec-${String(index + 1).padStart(12, '0')}`,
      expiresAt: new Date(Date.now() + 2 * 86400000).toISOString(),
      maxUses: 1000,
      usedCount: index + 1,
      revoked: false,
    }))
  : [];
const backendSchema = z.object({
  connection: karavanConnectionSnapshotSchema,
  setups: z.array(karavanMarketplaceOperationSchema),
  marketplace: karavanMarketplaceSummarySchema,
  binding: karavanMarketplaceBindingSchema,
  connected: z.boolean(),
  administrationStore: karavanMarketplaceModuleSchema.shape.administrationStore,
  administrationStores: karavanMarketplaceModuleSchema.shape.administrationStores,
});
// FLAG: This private fixture key models backend receipts across UI reloads; no
// product recovery code reads it. Each browser scenario owns a separate backend.
const backendKey = `shop-fixture-backend:v2:${scenario}:${params.get('scenarioRun') ?? params.get('run') ?? ''}`;
const savedBackend = sessionStorage.getItem(backendKey);
const backend = backendSchema.parse(
  savedBackend
    ? JSON.parse(savedBackend)
    : {
        connection: { version: 2, revision: 0, blocked: false, operation: null },
        setups: [],
        marketplace: market,
        binding,
        connected: formatConnected,
        administrationStore,
        administrationStores,
      },
);
Object.assign(market, backend.marketplace);
Object.assign(binding, backend.binding);
formatConnected = backend.connected;
administrationStore = backend.administrationStore ?? null;
administrationStores = backend.administrationStores ?? [];
function persistBackend() {
  sessionStorage.setItem(
    backendKey,
    JSON.stringify(
      backendSchema.parse({
        ...backend,
        marketplace: market,
        binding,
        connected: formatConnected,
        administrationStore,
        administrationStores,
      }),
    ),
  );
}
function conflict(code: string): never {
  throw new ApiRequestError(409, JSON.stringify({ code }), 'Изменилось подключение магазина.');
}
function sameRequest(original: unknown, input: unknown) {
  if (JSON.stringify(original) !== JSON.stringify(input))
    conflict('KARAVAN_COMMAND_SCOPE_CONFLICT');
}
function checkConnectionRevision(revision: number | undefined) {
  if (revision !== backend.connection.revision) conflict('KARAVAN_CONNECTION_REVISION_CONFLICT');
  if (backend.connection.blocked) conflict('KARAVAN_CONNECTION_OPERATION_PENDING');
}
const state = window as Window & {
  __shopRequests: Array<{ path: string; body: any }>;
  __shopOpened: string[];
  __shopPublished: typeof appearance;
  __shopMarket: typeof market;
  WebApp: unknown;
  __shopSaves: unknown[];
  __shopClipboard: string[];
  __setAdministrationStores?: (count: number) => Promise<unknown>;
  __setShopStatus?: (status: 'active' | 'paused') => Promise<unknown>;
  __finishShopImage?: () => void;
  __dropShopInvitationUrl?: boolean;
  __setShopResponseError?: () => void;
  __deferShopClipboard?: boolean;
  __finishShopClipboard?: () => void;
  __loseShopManage?: () => Promise<void>;
  __shopNextFailure?: { operation: string; status: number; code?: string; message?: string };
  __shopReactRoot?: Root;
  __acceptShopSellerTerms?: () => void;
  __readShopConnection?: () => Promise<unknown>;
  __readShopSetup?: (operationId: string) => Promise<unknown>;
};
state.__shopRequests = [];
state.__shopOpened = [];
state.__shopPublished = appearance;
state.__acceptShopSellerTerms = () => {
  sellerTermsAccepted = true;
};
state.__shopMarket = market;
state.__shopSaves = [];
state.__shopClipboard = [];
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      state.__shopClipboard.push(text);
      if (state.__deferShopClipboard) {
        state.__deferShopClipboard = false;
        await new Promise<void>((resolve) => {
          state.__finishShopClipboard = resolve;
        });
      }
    },
  },
});
const bridge = (window as any).MAX?.WebApp ?? {};
Object.assign(bridge, {
  openMaxLink: (url: string) => state.__shopOpened.push(url),
  close: () => {},
});
state.WebApp = bridge;
bridge.BackButton?.onClick(runNativeBackHandlers);
document.documentElement.dataset.maxPlatform = bridge.platform ?? 'android';
const api = {
  request: async (path: string, init: { body?: string; method?: string } = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    state.__shopRequests.push({ path, body });
    if (path.endsWith('/connection')) return structuredClone(backend.connection);
    const setupStatus = path.match(/\/operations\/([^/]+)$/u);
    if (setupStatus) {
      const operation = backend.setups.find((item) => item.operationId === setupStatus[1]);
      if (!operation) throw new ApiRequestError(404, '{}', 'Подключение не найдено.');
      return structuredClone(operation);
    }
    if (path.includes('/karavan-storefront/allowlist')) {
      if (init.method === 'DELETE') {
        const index = allowedUsers.findIndex((user) => path.endsWith('/' + user.id));
        if (index >= 0) allowedUsers.splice(index, 1);
        return { revoked: true };
      }
      const cursor = new URL(path, location.origin).searchParams.get('cursor');
      return {
        items: cursor ? allowedUsers.slice(100) : allowedUsers.slice(0, 100),
        hasMore: !cursor,
        nextCursor: cursor ? null : 'page2',
      };
    }
    if (path.includes('/members?'))
      return {
        items: [
          {
            userId: '888',
            userDisplayName: 'Анна Цветкова',
            username: 'anna',
            isBot: false,
            role: 'member',
          },
        ],
        hasMore: false,
        nextCursor: null,
      };
    if (path.includes('/available')) return { marketplaces: [], nextCursor: null };
    if (path.endsWith('/preview'))
      return {
        target: body.marketplaceId
          ? { marketplace: market, rules, permissions, counts, bindings }
          : null,
        chats: body.chatIds.map((chatId: string) => ({
          chatId,
          title: 'Соседи',
          binding: params.get('scenario') === 'unbound' || !formatConnected ? null : binding,
          marketplace: params.get('scenario') === 'unbound' || !formatConnected ? null : market,
        })),
      };
    if (path.endsWith('/handoffs')) {
      if (scenario === 'format_storefront_handoff_error' && !handoffFailed) {
        handoffFailed = true;
        throw new Error('Offline');
      }
      return {
        url:
          `https://max.ru/${['storefront', 'placement'].includes(body.destination) ? 'synthetic_seller_bot' : 'synthetic_buyer_bot'}?startapp=mh_` +
          'x'.repeat(43),
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      };
    }
    if (path.endsWith('/setup')) {
      const request = karavanMarketplaceSetupSchema.parse(body);
      const prior = backend.setups.find((item) => item.operationId === request.operationId);
      if (prior) {
        sameRequest(prior.request, request);
        return structuredClone(prior);
      }
      checkConnectionRevision(request.expectedConnectionRevision);
      if (!request.chatIds.includes(fixtureChatId)) conflict('MARKETPLACE_BINDING_CHANGED');
      if (request.existingMarketplaceId && request.existingMarketplaceId !== market.id)
        conflict('MARKETPLACE_BINDING_CHANGED');
      const operation = karavanMarketplaceOperationSchema.parse({
        operationId: request.operationId,
        state: 'pending',
        request,
        checkpoints: { marketplaceId: null, bindings: [] },
      });
      backend.setups.push(operation);
      backend.connection.operation = { kind: 'setup', operation };
      backend.connection.blocked = true;
      backend.connection.revision++;
      persistBackend();
      formatConnected = true;
      if (request.create) {
        market.status = request.create.setupVersion === 2 ? 'active' : 'draft';
        market.name = request.create.name;
        market.admissionMode = request.create.admissionPolicy;
        market.format = request.create.format;
        market.administrationStoreId =
          request.create.format === 'storefront'
            ? (request.create.administrationStoreId ?? administrationStoreId)
            : null;
        market.formatRevision = 1;
        if (request.create.setupVersion === 2) {
          market.administrationStoreId = null;
          administrationStores = [];
        }
      }
      if (administrationStore) administrationStore = { ...administrationStore, status: 'DRAFT' };
      operation.state = 'complete';
      operation.checkpoints = {
        marketplaceId: market.id,
        bindings: request.chatIds.map((chatId) => ({
          chatId,
          state: 'connected',
          bindingId: binding.id,
          generation: binding.generation,
        })),
      };
      backend.connection.blocked = false;
      backend.connection.revision++;
      persistBackend();
      return structuredClone(operation);
    }
    if (path.endsWith('/setup-options'))
      return {
        chatTitle: 'Соседи',
        ...(simple ? { chatShopFlowVersion: 2 } : {}),
        ...(scenario === 'format_setup_legacy'
          ? {}
          : {
              sellerTermsAccepted,
              administrationStores: administrationStore ? [administrationStore] : [],
            }),
        categories: ['daily_full_categories', 'format_setup_full_categories'].includes(scenario)
          ? karavanMarketplaceCategories.map(([categoryId, label]) => ({
              id: categoryId,
              label,
              subcategories:
                categoryId === 'real_estate'
                  ? [
                      { id: 'real_estate.apartment', label: 'Квартиры' },
                      { id: 'real_estate.room', label: 'Комнаты' },
                      { id: 'real_estate.house', label: 'Дома' },
                      { id: 'real_estate.land', label: 'Участки' },
                    ]
                  : [{ id: `${categoryId}.example`, label: `Направление: ${label}` }],
            }))
          : [
              {
                id: 'services',
                label: 'Услуги',
                subcategories: [
                  { id: 'services.repair', label: 'Ремонт' },
                  { id: 'services.beauty', label: 'Красота' },
                ],
              },
              {
                id: 'grocery',
                label: 'Продукты',
                subcategories: [{ id: 'grocery.bread', label: 'Хлеб' }],
              },
            ],
      };
    if (path.endsWith('/manage')) {
      const { operation, input } = body.command;
      if (state.__shopNextFailure?.operation === operation) {
        const failure = state.__shopNextFailure;
        state.__shopNextFailure = undefined;
        if (failure.code === 'MARKETPLACE_REVISION_CONFLICT') applicationRevision++;
        throw new ApiRequestError(
          failure.status,
          JSON.stringify({ code: failure.code }),
          failure.message ?? 'Не удалось выполнить действие.',
        );
      }
      let data;
      if (operation === 'seller_grant_target') {
        data = {
          target: scenario.includes('_new_seller')
            ? null
            : { maxUserId: input.targetMaxUserId, name: 'Анна Цветкова', username: 'anna' },
          stores: scenario.includes('_new_seller') ? [] : [administrationStore],
        };
      } else if (operation === 'seller_grants')
        data = { grants: grant ? [grant.grant] : [], nextCursor: null };
      else if (operation === 'seller_grant_create') {
        const previous = scenario.includes('_unknown')
          ? sessionStorage.getItem(`grant-receipt:${input.commandId}`)
          : null;
        if (previous) {
          grant = JSON.parse(previous);
          return { operation, data: grant };
        }
        grant = {
          grant: {
            id: crypto.randomUUID(),
            marketplaceId: id,
            targetMaxUserId: input.targetMaxUserId,
            storeId: input.storeId,
            revision: 1,
            expiresAt: input.expiresAt,
            revokedAt: null,
            claimedAt: input.storeId ? new Date().toISOString() : null,
          },
          url: 'https://max.ru/synthetic_seller_bot?startapp=placement_recipient_grant',
        };
        data = grant;
        if (scenario.includes('_unknown')) {
          sessionStorage.setItem(`grant-receipt:${input.commandId}`, JSON.stringify(grant));
          throw new Error('Ответ потерян');
        }
      } else if (operation === 'seller_grant_revoke') {
        if (grant) grant.grant.revokedAt = new Date().toISOString();
        data = { revoked: true };
      } else if (operation === 'format_preview') {
        data = {
          fingerprint: 'a'.repeat(64),
          expectedRevision: input.expectedRevision,
          format: input.format,
          administrationStoreId: input.administrationStoreId ?? null,
          affectedStores: 2,
          affectedChats: counts.chats,
          pendingApplications: 1,
        };
      } else if (operation === 'format_update') {
        const receipt = formatReceipts.get(input.commandId);
        if (receipt) return { operation, data: receipt };
        if (market.status === 'active' && input.setupVersion !== 2) market.status = 'paused';
        market.format = input.format;
        market.administrationStoreId =
          input.format === 'storefront'
            ? (input.administrationStoreId ?? administrationStoreId)
            : null;
        market.editRevision++;
        market.formatRevision = (market.formatRevision ?? 0) + 1;
        data = { marketplace: structuredClone(market) };
        formatReceipts.set(input.commandId, data);
        if (scenario === 'format_switch_unknown' && !lostFormatResponse) {
          lostFormatResponse = true;
          throw new Error('Ответ потерян');
        }
      } else if (operation === 'detail') {
        if (params.get('scenario') === 'detail_error' && detailReads++ === 0)
          throw new Error('Offline');
        data = {
          marketplace: market,
          rules,
          scheduledRules: null,
          permissions,
          counts: detailCounts,
          bindings,
        };
      } else if (operation === 'catalog') {
        if (
          params.get('scenario') === 'error' &&
          input.kind === 'product' &&
          input.limit > 1 &&
          catalogReads++ === 0
        )
          throw new Error('Offline');
        data = {
          items:
            params.get('scenario') === 'empty' ||
            (input.q && !offer.title.toLowerCase().includes(input.q.toLowerCase()))
              ? []
              : input.kind === 'property'
                ? params.get('scenario') === 'daily_existing_property'
                  ? [
                      {
                        ...offer,
                        kind: 'property',
                        title: 'Квартира у школы',
                        allowedCategory: false,
                        available: false,
                      },
                    ]
                  : []
                : input.cursor
                  ? [{ ...offer, id: second, title: 'Доставка продуктов' }]
                  : [offer],
          nextCursor:
            params.get('scenario') === 'daily_paged' && !input.cursor && input.limit > 1
              ? 'page2'
              : null,
        };
      } else if (operation === 'content') {
        const { id: offerId, kind, title, imageUrl, allowedCategory, restriction } = offer;
        data = {
          items:
            scenario === 'daily_content_pages'
              ? Array.from({ length: 24 }, (_, index) => ({
                  id: `a0d9b7ce-0040-4c85-a7ec-${String(Number(input.cursor ?? 0) * 24 + index + 1).padStart(12, '0')}`,
                  kind: input.kind,
                  title: `${input.kind === 'product' ? 'Товар' : 'Объект'} ${Number(input.cursor ?? 0) * 24 + index + 1}`,
                  imageUrl,
                  allowedCategory,
                  restriction,
                }))
              : simple
                ? input.kind === 'property'
                  ? []
                  : [
                      {
                        id: offerId,
                        kind,
                        title,
                        imageUrl,
                        allowedCategory,
                        restriction,
                        priceLabel: 'от 1 500 ₽',
                        categoryLabel: 'Ремонт',
                      },
                    ]
                : [{ id: offerId, kind, title, imageUrl, allowedCategory, restriction }],
          nextCursor:
            scenario === 'daily_content_pages' && Number(input.cursor ?? 0) < 2
              ? String(Number(input.cursor ?? 0) + 1)
              : null,
          storeId: second,
        };
      } else if (operation === 'settings') {
        if (admissionFailure && !simple) {
          admissionFailure = false;
          throw new Error('Offline');
        }
        market.admissionMode = input.admissionPolicy;
        market.admissionPolicy = ['invitation', 'selected'].includes(input.admissionPolicy)
          ? 'invitation'
          : 'applications';
        market.editRevision++;
        data = { marketplace: market };
      } else if (operation === 'status') {
        if (statusFailure) {
          statusFailure = false;
          throw new Error('Offline');
        }
        market.status = input.status;
        market.editRevision++;
        data = { marketplace: market };
      } else if (operation === 'invitations') {
        const items = [
          ...(invitation ? [(({ code: _code, url: _url, ...item }) => item)(invitation)] : []),
          ...invitationHistory,
        ];
        data = {
          invitations: input.cursor ? items.slice(24) : items.slice(0, 24),
          nextCursor: !input.cursor && items.length > 24 ? 'page2' : null,
        };
      } else if (operation === 'invitation_create') {
        invitation = {
          id,
          expiresAt: input.expiresAt,
          maxUses: input.maxUses,
          usedCount: 0,
          code: 'synthetic-invitation-code',
          revoked: false,
          url: state.__dropShopInvitationUrl
            ? null
            : 'https://max.ru/synthetic_seller_bot?startapp=invite_synthetic',
        };
        state.__dropShopInvitationUrl = false;
        data = invitation;
      } else if (operation === 'invitation_revoke') {
        if (invitation) invitation.revoked = true;
        data = { revoked: true };
      } else if (operation === 'pins') data = pins;
      else if (operation === 'pins_save') {
        pins = {
          revision: pins.revision + 1,
          offers: input.offers.map((row: typeof offer) =>
            row.id === second ? { ...offer, id: second, title: 'Доставка продуктов' } : offer,
          ),
        };
        data = pins;
      } else if (operation === 'moderate_content') {
        offer.restriction = {
          id,
          revision: 1,
          active: input.active,
          reason: input.reason,
        } as never;
        offer.available = !input.active;
        data = { restriction: { id, ...offer.restriction! }, visibilityRevision: 2 };
      } else if (operation === 'image') {
        data = await new Promise<{ url: string }>((resolve) => {
          state.__finishShopImage = () => resolve({ url: `${location.origin}/app/favicon.png` });
        });
      } else if (operation === 'appearance') data = design;
      else if (operation === 'appearance_save') {
        design = {
          ...design,
          draft: input.appearance,
          hasChanges: true,
          revision: design.revision + 1,
        };
        data = design;
      } else if (operation === 'appearance_apply') {
        design = {
          draft: input.appearance,
          published: input.appearance,
          hasChanges: false,
          revision: design.revision + 1,
        };
        Object.assign(market, input.appearance, {
          editRevision: market.editRevision + 1,
          visibilityRevision: market.visibilityRevision + 1,
        });
        state.__shopPublished = design.published;
        data = design;
      } else if (operation === 'appearance_publish') {
        design = {
          ...design,
          published: design.draft,
          hasChanges: false,
          revision: design.revision + 1,
        };
        state.__shopPublished = design.published;
        data = design;
      } else if (operation === 'applications')
        data = {
          applications: simple
            ? simpleApplications.filter(
                (application) => input.state === 'all' || application.state === input.state,
              )
            : pendingApplication
              ? [
                  {
                    id,
                    listingId: second,
                    marketplaceId: id,
                    storeId: second,
                    storeName: 'Мастерская',
                    revision: applicationRevision,
                    attempt: 1,
                    state: 'pending',
                    profileVersionId: id,
                    profile: {
                      name: 'Мастерская',
                      description: 'Ремонт техники',
                      logoImageUrl: null,
                      coverImageUrl: null,
                    },
                    publishedProfile: null,
                    rulesVersion: rules,
                    submittedAt: new Date().toISOString(),
                    decidedAt: null,
                    reason: null,
                    canReview: !['daily_self_review', 'own_profile'].includes(
                      params.get('scenario') ?? '',
                    ),
                    canPublishOwn: params.get('scenario') === 'own_profile',
                  },
                ]
              : [],
          nextCursor: null,
        };
      else if (operation === 'decide') {
        pendingApplication = false;
        counts.pendingApplications = 0;
        if (simple) {
          const decided = simpleApplications.find(
            (application) => application.id === body.command.applicationId,
          )!;
          decided.state =
            input.decision === 'approve'
              ? 'approved'
              : input.decision === 'reject'
                ? 'rejected'
                : 'changes_requested';
          decided.reason = input.reason;
          decided.decidedAt = new Date().toISOString();
          decided.canReview = false;
          counts.pendingApplications = simpleApplications.filter(
            (application) => application.state === 'pending',
          ).length;
        }
        data = {
          listing: {
            id: second,
            marketplaceId: id,
            storeId: second,
            storeName: 'Мастерская',
            marketplaceName: market.name,
            revision: 2,
            reviewState:
              input.decision === 'approve'
                ? 'approved'
                : input.decision === 'changes_requested'
                  ? 'changes_requested'
                  : 'rejected',
            sellerState: 'enabled',
            publicationReason:
              simple && scenario.includes('_not_ready') ? 'no_published_offers' : 'published',
            rank: '1',
            approvedProfileVersionId: id,
            pendingApplicationId: null,
            acceptedRulesVersion: 1,
            requiredRulesVersion: 1,
            decisionReason: null,
          },
        };
      } else if (operation === 'listings')
        data = {
          listings: ['daily_reorder', 'daily_content_pages'].includes(scenario)
            ? [id, second].map((listingId, index) => ({
                id: listingId,
                marketplaceId: id,
                storeId: second,
                storeName: `Продавец ${index + 1}`,
                marketplaceName: market.name,
                revision: 1,
                reviewState: 'approved',
                sellerState: 'enabled',
                publicationReason: 'published',
                rank: String(index + 1),
                position: index + 1,
                approvedProfileVersionId: id,
                pendingApplicationId: null,
                acceptedRulesVersion: 1,
                requiredRulesVersion: 1,
                decisionReason: null,
              }))
            : [],
          nextCursor: null,
          orderRevision: market.orderRevision,
          total: 2,
          orderableTotal: 2,
        };
      else if (operation === 'reorder_listings') data = { orderRevision: ++market.orderRevision };
      else if (operation === 'rules_preview')
        data = {
          fingerprint: 'a'.repeat(64),
          calculatedAt: new Date().toISOString(),
          hiddenOffers: ['daily_safe_categories', 'daily_property_legacy'].includes(scenario)
            ? 0
            : 1,
          affectedStores: ['daily_safe_categories', 'daily_property_legacy'].includes(scenario)
            ? 0
            : 1,
          emptiedStores: 0,
          affectedChats: counts.chats,
          stores: [],
          hasMoreStores: false,
        };
      else if (operation === 'rules_update') {
        if (rulesConflict) {
          rulesConflict = false;
          market.policyRevision++;
          throw new ApiRequestError(409, '{}', 'Правила изменились. Обновите данные.');
        }
        Object.assign(rules, input.rules);
        market.policyRevision++;
        data = {
          rules: { ...rules, version: market.policyRevision, effectiveAt: input.effectiveAt },
          policyRevision: market.policyRevision,
        };
      } else throw new Error('Unexpected operation: ' + operation);
      return { operation, data };
    }
    if (path.endsWith('/karavan-marketplace'))
      return {
        ...providerModule,
        ...(simple
          ? {
              chatShopFlowVersion: 2,
              administrationStores,
              administrationStoreCount: administrationStores.length,
            }
          : {}),
        enabled: true,
        // FLAG: Raw commerce exports receive the Major envelope here; older provider
        // fields do not imply an older Major connection capability.
        ...(scenario === 'format_setup_unsupported'
          ? {}
          : { connection: structuredClone(backend.connection) }),
        actorMaxUserId: '777',
        sellerBotUrl: 'https://max.ru/synthetic_seller_bot',
        marketplace: params.get('scenario') === 'unbound' || !formatConnected ? null : market,
        binding: params.get('scenario') === 'unbound' || !formatConnected ? null : binding,
        administrationStore:
          market.format === 'storefront'
            ? simple
              ? (administrationStores[0] ?? null)
              : administrationStore
            : null,
        access: { reason: !formatConnected ? 'unbound' : 'allowed', canRecover: false },
        currentChatTitle: 'Соседи',
        permissions,
        counts,
        canManage: true,
        buyerUrl: simple
          ? 'https://max.ru/synthetic_buyer_bot?startapp=m_synthetic-shop'
          : market.format === 'storefront'
            ? market.status === 'active' && administrationStore?.status === 'ACTIVE'
              ? 'https://max.ru/synthetic_buyer_bot?startapp=store_administration-store'
              : null
            : 'https://max.ru/synthetic_buyer_bot?startapp=m_synthetic-shop',
        previewUrl: 'https://max.ru/synthetic_buyer_bot?startapp=mp_synthetic-shop',
        bindings: params.get('scenario') === 'unbound' || !formatConnected ? [] : bindings,
        connectedChats:
          params.get('scenario') === 'unbound' || !formatConnected ? [] : connectedChats,
        publicationChoices:
          scenario === 'format_storefront'
            ? [
                {
                  id: second,
                  marketplaceId: market.id,
                  marketplaceName: market.name,
                  chatId: fixtureChatId,
                  expiresAt: new Date(Date.now() + 900000).toISOString(),
                  stores: [{ id: second, name: 'Личная витрина из прошлого формата' }],
                },
              ]
            : [],
        publicationPreview:
          market.status === 'active'
            ? market.format === 'storefront'
              ? { mode: 'administration_storefront' }
              : { mode: 'chat_marketplace' }
            : { mode: 'unavailable', reason: 'closed', format: market.format ?? 'community' },
        setupOperation:
          backend.connection.operation?.kind === 'setup'
            ? structuredClone(backend.connection.operation.operation)
            : null,
      };
    throw new Error('Unexpected request: ' + path);
  },
  requestKeepalive: () => {},
};
state.__readShopConnection = () =>
  api.request(`/chats/${fixtureChatId}/karavan-marketplace/connection`);
state.__readShopSetup = (operationId) =>
  api.request(`/chats/${fixtureChatId}/karavan-marketplace/operations/${operationId}`);
const initial = chatSettingsSchema.parse({
  karavanStorefrontEnabled: true,
  karavanStorefrontAdminsOnly: false,
  karavanStorefrontMessageText: '',
  karavanStorefrontOpenButtonText: '',
  karavanStorefrontCatalogButtonText: '',
  karavanStorefrontCreateButtonText: '',
});
function Harness() {
  const [open, setOpen] = React.useState(false),
    [draft, setDraft] = React.useState(initial),
    [saved, setSaved] = React.useState(initial);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  state.__setShopResponseError = () =>
    setFieldErrors({ karavanStorefrontMessageText: 'Проверьте текст ответа.' });
  const change = (key: string, value: unknown) => setDraft((old) => ({ ...old, [key]: value }));
  const fields = createChatSettingsFieldAdapter({
    settings: draft,
    baseline: saved,
    onChange: setDraft,
    errors: fieldErrors,
    onError: (path, error) =>
      setFieldErrors((current) => {
        const next = { ...current };
        if (error) next[path] = error;
        else delete next[path];
        return next;
      }),
  });
  return (
    <SettingsStorefrontSection
      sharedContent={
        <SharedChatSettingsSection
          section="storefront"
          fields={fields}
          context={{ mode: 'single', api }}
        />
      }
      api={api}
      chatId={fixtureChatId}
      draft={draft}
      expanded={open}
      summary=""
      status=""
      hasChanges={JSON.stringify(draft) !== JSON.stringify(saved)}
      onToggleSection={() => setOpen(!open)}
      onDiscardChanges={() => setDraft(saved)}
      onFieldChange={(value) => change('karavanStorefrontEnabled', value)}
      onAdminsOnlyChange={(value) => change('karavanStorefrontAdminsOnly', value)}
      onTextChange={change}
      footer={
        <button
          type="button"
          className="button button--accent"
          onClick={() => {
            state.__shopSaves.push(draft);
            setSaved(draft);
          }}
        >
          Сохранить
        </button>
      }
    />
  );
}
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
state.__setAdministrationStores = async (count) => {
  administrationStores = Array.from({ length: count }, (_, index) => ({
    ...administrationStore!,
    id: index ? second : administrationStoreId,
    name: index ? 'Вторая витрина' : 'Первая витрина',
  }));
  await queryClient.invalidateQueries({ queryKey: ['karavan-marketplace', fixtureChatId] });
};
state.__setShopStatus = async (status) => {
  market.status = status;
  market.editRevision++;
  await queryClient.invalidateQueries({ queryKey: ['karavan-marketplace', fixtureChatId] });
};
state.__loseShopManage = () => {
  permissions.splice(0, permissions.length, 'bind_chat');
  return queryClient.invalidateQueries({ queryKey: ['karavan-marketplace', fixtureChatId] });
};
(state.__shopReactRoot ??= createRoot(document.getElementById('root')!)).render(
  <QueryClientProvider client={queryClient}>
    <ToastProvider>
      <Harness />
    </ToastProvider>
  </QueryClientProvider>,
);
