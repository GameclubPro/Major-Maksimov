import '../src/styles.css';
import React from 'react';
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
  type KaravanMarketplaceModule,
} from '@maxim/contracts/karavan-marketplace';
import type { MarketplaceManagementResponse } from '@maxim/contracts/karavan-marketplace-management';
import '../src/pages/settings-page';
import '../src/styles/moderation-workspace.css';
const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') ?? '';
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
let formatConnected = !scenario.startsWith('format_setup');
let sellerTermsAccepted = scenario !== 'format_setup_terms';
const market: NonNullable<KaravanMarketplaceModule['marketplace']> =
  providerModule?.marketplace ?? {
    id,
    networkId: second,
    publicSlug: 'synthetic-shop',
    name: 'Магазин соседей',
    description: null,
    kind: 'chat',
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
if (scenario.startsWith('format_storefront')) {
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
const state = window as Window & {
  __shopRequests: Array<{ path: string; body: any }>;
  __shopOpened: string[];
  __shopPublished: typeof appearance;
  __shopMarket: typeof market;
  WebApp: unknown;
  __shopSaves: unknown[];
  __shopClipboard: string[];
  __finishShopImage?: () => void;
  __dropShopInvitationUrl?: boolean;
  __setShopResponseError?: () => void;
  __deferShopClipboard?: boolean;
  __finishShopClipboard?: () => void;
  __loseShopManage?: () => Promise<void>;
  __shopNextFailure?: { operation: string; status: number; code?: string; message?: string };
  __shopReactRoot?: Root;
  __acceptShopSellerTerms?: () => void;
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
    if (path.includes('/available')) return { marketplaces: [], nextCursor: null };
    if (path.endsWith('/preview'))
      return {
        target: body.marketplaceId
          ? { marketplace: market, rules, permissions, counts, bindings: [binding] }
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
          `https://max.ru/${body.destination === 'storefront' ? 'synthetic_seller_bot' : 'synthetic_buyer_bot'}?startapp=mh_` +
          'x'.repeat(43),
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      };
    }
    if (path.endsWith('/setup')) {
      formatConnected = true;
      market.status = 'draft';
      market.format = body.create.format;
      market.administrationStoreId =
        body.create.format === 'storefront'
          ? (body.create.administrationStoreId ?? administrationStoreId)
          : null;
      market.formatRevision = 1;
      if (administrationStore) administrationStore = { ...administrationStore, status: 'DRAFT' };
      return {
        operationId: body.operationId,
        state: 'complete',
        request: body,
        checkpoints: {
          marketplaceId: market.id,
          bindings: [
            {
              chatId: fixtureChatId,
              state: 'connected',
              bindingId: binding.id,
              generation: binding.generation,
            },
          ],
        },
      };
    }
    if (path.endsWith('/setup-options'))
      return {
        chatTitle: 'Соседи',
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
      if (operation === 'format_preview') {
        data = {
          fingerprint: 'a'.repeat(64),
          expectedRevision: input.expectedRevision,
          format: input.format,
          administrationStoreId: input.administrationStoreId ?? null,
          affectedStores: 2,
          affectedChats: 1,
          pendingApplications: 1,
        };
      } else if (operation === 'format_update') {
        const receipt = formatReceipts.get(input.commandId);
        if (receipt) return { operation, data: receipt };
        if (market.status === 'active') market.status = 'paused';
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
          bindings: [binding],
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
          items: [{ id: offerId, kind, title, imageUrl, allowedCategory, restriction }],
          nextCursor: null,
          storeId: second,
        };
      } else if (operation === 'settings') {
        if (admissionFailure) {
          admissionFailure = false;
          throw new Error('Offline');
        }
        market.admissionPolicy = input.admissionPolicy;
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
          applications: pendingApplication
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
            publicationReason: 'published',
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
          listings:
            params.get('scenario') === 'daily_reorder'
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
          affectedChats: 1,
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
        enabled: true,
        actorMaxUserId: '777',
        sellerBotUrl: 'https://max.ru/synthetic_seller_bot',
        marketplace: params.get('scenario') === 'unbound' || !formatConnected ? null : market,
        binding: params.get('scenario') === 'unbound' || !formatConnected ? null : binding,
        administrationStore: market.format === 'storefront' ? administrationStore : null,
        currentChatTitle: 'Соседи',
        permissions,
        counts,
        canManage: true,
        buyerUrl:
          market.format === 'storefront'
            ? market.status === 'active' && administrationStore?.status === 'ACTIVE'
              ? 'https://max.ru/synthetic_buyer_bot?startapp=store_administration-store'
              : null
            : 'https://max.ru/synthetic_buyer_bot?startapp=m_synthetic-shop',
        previewUrl: 'https://max.ru/synthetic_buyer_bot?startapp=mp_synthetic-shop',
        bindings: params.get('scenario') === 'unbound' || !formatConnected ? [] : [binding],
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
        setupOperation: null,
      };
    throw new Error('Unexpected request: ' + path);
  },
  requestKeepalive: () => {},
};
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
