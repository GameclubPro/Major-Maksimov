import { z } from 'zod';

export const karavanMarketplaceCommandIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{8,120}$/u);
export const karavanMarketplaceChatIdSchema = z.string().regex(/^-?\d{1,24}$/u);
export const karavanMarketplaceActorIdSchema = z.string().regex(/^\d{1,24}$/u);
export const karavanMarketplaceIdSchema = z.string().uuid();
export const karavanShopFormatSchema = z.enum(['storefront', 'community']);
export const karavanAdministrationStoreSchema = z.object({
  id: karavanMarketplaceIdSchema,
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(120),
  status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED', 'BLOCKED']),
  editRevision: z.number().int().positive(),
});
export const karavanMarketplaceActionSchema = z.enum([
  'manage_shop',
  'create_marketplace',
  'read_chat_module',
  'bind_chat',
  'unbind_chat',
  'transfer_chat',
  'recover_chat',
  'resolve_publication',
]);
export type KaravanMarketplaceAction = z.infer<typeof karavanMarketplaceActionSchema>;
export const karavanMarketplaceManagementActionSchema = karavanMarketplaceActionSchema.exclude([
  'resolve_publication',
]);

export const karavanMarketplaceAuthorityScopeSchema = z
  .object({
    actorMaxUserId: karavanMarketplaceActorIdSchema,
    chatId: karavanMarketplaceChatIdSchema,
    commandId: karavanMarketplaceCommandIdSchema,
    action: karavanMarketplaceActionSchema,
    marketplaceId: karavanMarketplaceIdSchema.nullable(),
    expectedBindingGeneration: z.number().int().positive().nullable(),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .superRefine((value, context) => {
    const unbound = ['create_marketplace', 'read_chat_module', 'resolve_publication'].includes(
      value.action,
    );
    if (!unbound && value.marketplaceId === null)
      context.addIssue({ code: 'custom', path: ['marketplaceId'], message: 'Укажите магазин.' });
    if (value.action === 'create_marketplace' && value.marketplaceId !== null)
      context.addIssue({
        code: 'custom',
        path: ['marketplaceId'],
        message: 'Новый магазин ещё не создан.',
      });
  });
export type KaravanMarketplaceAuthorityScope = z.infer<
  typeof karavanMarketplaceAuthorityScopeSchema
>;
export const karavanMarketplaceAuthorityRequestSchema =
  karavanMarketplaceAuthorityScopeSchema.safeExtend({
    proofId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  });
export type KaravanMarketplaceAuthorityRequest = z.infer<
  typeof karavanMarketplaceAuthorityRequestSchema
>;
export const karavanMarketplaceAuthorityEvidenceSchema =
  karavanMarketplaceAuthorityScopeSchema.safeExtend({
    provider: z.literal('maxim'),
    botId: z.string().min(1).max(128),
    entityType: z.literal('chat'),
    checkedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    authorityEpoch: z.string().regex(/^[a-f0-9]{64}$/u),
    chatTitle: z.string().max(300).optional(),
  });
export type KaravanMarketplaceAuthorityEvidence = z.infer<
  typeof karavanMarketplaceAuthorityEvidenceSchema
>;
export const karavanMarketplaceActorAccessRequestSchema = z
  .object({
    actorMaxUserId: karavanMarketplaceActorIdSchema,
    chatId: karavanMarketplaceChatIdSchema,
    botId: z.string().min(1).max(128),
    authorityEpoch: z.string().regex(/^[a-f0-9]{64}$/u),
    verifiedAt: z.string().datetime(),
    bindingGeneration: z.number().int().positive(),
  })
  .strict();
export type KaravanMarketplaceActorAccessRequest = z.infer<
  typeof karavanMarketplaceActorAccessRequestSchema
>;
export const karavanMarketplaceActorAccessResponseSchema =
  karavanMarketplaceActorAccessRequestSchema
    .extend({
      allowed: z.boolean(),
      reason: z.enum(['admin', 'not_admin', 'bot_unavailable', 'binding_changed']),
      checkedAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
    })
    .superRefine((value, context) => {
      const lifetime = Date.parse(value.expiresAt) - Date.parse(value.checkedAt);
      if (lifetime <= 0 || lifetime > 15_000)
        context.addIssue({
          code: 'custom',
          path: ['expiresAt'],
          message: 'Проверка прав устарела.',
        });
      if (value.allowed !== (value.reason === 'admin'))
        context.addIssue({ code: 'custom', path: ['allowed'], message: 'Несогласованный доступ.' });
    });
export type KaravanMarketplaceActorAccessResponse = z.infer<
  typeof karavanMarketplaceActorAccessResponseSchema
>;
export const karavanMarketplaceHandoffDestinationSchema = z.enum([
  'manage',
  'applications',
  'invite_sellers',
  'open_marketplace',
  'categories',
  'view',
  'preview',
  'storefront',
]);
export type KaravanMarketplaceHandoffDestination = z.infer<
  typeof karavanMarketplaceHandoffDestinationSchema
>;
export const karavanMarketplaceHandoffIssueSchema = z
  .object({
    commandId: karavanMarketplaceCommandIdSchema,
    marketplaceId: karavanMarketplaceIdSchema,
    destination: karavanMarketplaceHandoffDestinationSchema,
  })
  .strict();
export const karavanMarketplaceHandoffExchangeSchema = z
  .object({
    code: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    actorMaxUserId: karavanMarketplaceActorIdSchema,
    exchangeId: z.string().uuid(),
    audience: z.enum(['client', 'seller']).optional().default('seller'),
  })
  .strict();
export const karavanMarketplaceHandoffEvidenceSchema = z
  .object({
    provider: z.literal('maxim'),
    actorMaxUserId: karavanMarketplaceActorIdSchema,
    marketplaceId: karavanMarketplaceIdSchema,
    chatId: karavanMarketplaceChatIdSchema,
    botId: z.string().min(1).max(128),
    entityType: z.literal('chat'),
    destination: karavanMarketplaceHandoffDestinationSchema,
    checkedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    authorityEpoch: z.string().regex(/^[a-f0-9]{64}$/u),
    exchangeId: z.string().uuid(),
    returnUrl: z.string().url().nullable().optional(),
  })
  .strict();
export type KaravanMarketplaceHandoffEvidence = z.infer<
  typeof karavanMarketplaceHandoffEvidenceSchema
>;

/** JSON wire values only; consumers hash this exact recursively sorted representation. */
export function canonicalKaravanMarketplaceJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalKaravanMarketplaceJson).join(',')}]`;
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalKaravanMarketplaceJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  throw new TypeError('Marketplace payload must contain only JSON values.');
}

// Wire subset shared with Karavan. All command defaults are applied before hashing.
export const karavanMarketplaceSummarySchema = z.object({
  id: karavanMarketplaceIdSchema,
  networkId: karavanMarketplaceIdSchema,
  publicSlug: z.string().min(3).max(100),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable(),
  kind: z.enum(['chat', 'legacy']),
  format: karavanShopFormatSchema.optional(),
  administrationStoreId: karavanMarketplaceIdSchema.nullable().optional(),
  formatRevision: z.number().int().positive().optional(),
  status: z.enum(['draft', 'active', 'paused', 'archived']),
  admissionPolicy: z.enum(['applications', 'invitation']),
  logoImageUrl: z.string().url().nullable(),
  coverImageUrl: z.string().url().nullable(),
  editRevision: z.number().int().positive(),
  policyRevision: z.number().int().positive(),
  orderRevision: z.number().int().positive(),
  visibilityRevision: z.number().int().positive(),
});
export const karavanMarketplaceBindingSchema = z.object({
  id: karavanMarketplaceIdSchema,
  chatId: karavanMarketplaceChatIdSchema,
  chatTitle: z.string().max(300),
  state: z.enum(['pending', 'verified', 'disconnected', 'revoked']),
  generation: z.number().int().positive(),
  revision: z.number().int().positive(),
  verifiedAt: z.string().datetime().nullable(),
});
export const karavanPublicationPreviewSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('catalog') }),
  z.object({ mode: z.literal('chat_marketplace') }),
  z.object({ mode: z.literal('administration_storefront') }),
  z.object({
    mode: z.literal('unavailable'),
    reason: z.enum(['closed', 'connection', 'verification']),
    format: karavanShopFormatSchema.optional(),
  }),
]);
export type KaravanPublicationPreview = z.infer<typeof karavanPublicationPreviewSchema>;
export const karavanMarketplaceModuleSchema = z.object({
  marketplace: karavanMarketplaceSummarySchema.nullable(),
  binding: karavanMarketplaceBindingSchema.nullable(),
  permissions: z.array(
    z.enum([
      'manage_network',
      'manage_marketplace',
      'manage_marketplace_members',
      'bind_chat',
      'review_listing',
      'arrange_listings',
      'view_marketplace_audit',
      'view_marketplace_metrics',
      'curate_marketplace_links',
    ]),
  ),
  counts: z.object({
    listings: z.number().int().nonnegative(),
    readyListings: z.number().int().nonnegative().optional(),
    approvedListings: z.number().int().nonnegative().optional(),
    pendingApplications: z.number().int().nonnegative(),
    chats: z.number().int().nonnegative(),
  }),
  canManage: z.boolean(),
  access: z
    .object({
      reason: z.enum([
        'allowed',
        'unbound',
        'not_admin',
        'bot_unavailable',
        'binding_changed',
        'forbidden',
      ]),
      canRecover: z.boolean(),
    })
    .optional(),
  currentChatTitle: z.string().max(300).optional(),
  buyerUrl: z.string().url().nullable().optional(),
  previewUrl: z.string().url().nullable().optional(),
  publicationPreview: karavanPublicationPreviewSchema.optional(),
  administrationStore: karavanAdministrationStoreSchema.nullable().optional(),
  bindings: z.array(karavanMarketplaceBindingSchema).max(48).optional(),
});
export type KaravanMarketplaceModule = z.infer<typeof karavanMarketplaceModuleSchema>;
export const karavanMarketplaceCategories = [
  ['cafe_snacks', 'Кафе и перекусы'],
  ['flowers_gifts', 'Цветы и подарки'],
  ['clothing_shoes', 'Одежда и обувь'],
  ['beauty_care', 'Красота и уход'],
  ['auto_parts', 'Автотовары'],
  ['building_materials', 'Строительство'],
  ['meat_poultry', 'Мясо и птица'],
  ['vegetables_fruits', 'Овощи и фрукты'],
  ['home_household', 'Для дома'],
  ['home_appliances', 'Бытовая техника'],
  ['furniture', 'Мебель'],
  ['hobby', 'Хобби'],
  ['services', 'Услуги'],
  ['grocery', 'Продукты'],
  ['electronics', 'Электроника'],
  ['garden', 'Сад'],
  ['real_estate', 'Недвижимость'],
] as const;
const categoryIdSchema = z.enum(karavanMarketplaceCategories.map(([id]) => id));
export const karavanMarketplaceCreateSchema = z
  .object({
    commandId: karavanMarketplaceCommandIdSchema,
    networkId: karavanMarketplaceIdSchema.nullable().optional().default(null),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).nullable().optional().default(null),
    admissionPolicy: z.enum(['applications', 'invitation']).optional().default('applications'),
    // FLAG: Omitted format fields stay omitted so persisted pre-format command hashes remain valid.
    format: karavanShopFormatSchema.optional(),
    administrationStoreId: karavanMarketplaceIdSchema.nullable().optional(),
    rules: z.object({
      text: z.string().trim().min(1).max(12000),
      allowedCategoryIds: z.array(categoryIdSchema).min(1).max(40),
      allowedSubcategoryIds: z
        .array(
          z
            .string()
            .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u)
            .max(100),
        )
        .max(1000),
      categoryOrder: z.array(categoryIdSchema).max(40).optional().default([]),
    }),
  })
  .strict();
export const karavanMarketplaceSetupSchema = z
  .object({
    operationId: z.string().uuid(),
    chatIds: z
      .array(karavanMarketplaceChatIdSchema)
      .min(1)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, 'Выберите каждый чат один раз.'),
    create: karavanMarketplaceCreateSchema.omit({ commandId: true }).optional(),
    existingMarketplaceId: karavanMarketplaceIdSchema.optional(),
    expectedPolicyRevision: z.number().int().positive().optional(),
    bindingExpectations: z
      .array(
        z
          .object({
            chatId: karavanMarketplaceChatIdSchema,
            generation: z.number().int().positive().nullable(),
            action: z.enum(['bind_chat', 'recover_chat', 'transfer_chat']),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.create) === Boolean(value.existingMarketplaceId))
      context.addIssue({ code: 'custom', message: 'Выберите новый или существующий магазин.' });
    if (value.existingMarketplaceId && value.expectedPolicyRevision === undefined)
      context.addIssue({ code: 'custom', message: 'Проверьте правила выбранного магазина.' });
    if (
      value.bindingExpectations &&
      (value.bindingExpectations.length !== value.chatIds.length ||
        new Set(value.bindingExpectations.map((item) => item.chatId)).size !==
          value.chatIds.length ||
        value.bindingExpectations.some((item) => !value.chatIds.includes(item.chatId)))
    )
      context.addIssue({ code: 'custom', message: 'Проверьте подключения выбранных чатов.' });
  });
export type KaravanMarketplaceSetup = z.infer<typeof karavanMarketplaceSetupSchema>;
export const karavanMarketplaceSetupOptionsSchema = z.object({
  chatTitle: z.string().max(300),
  administrationStores: z.array(karavanAdministrationStoreSchema).max(50).optional(),
  sellerTermsAccepted: z.boolean().optional(),
  categories: z
    .array(
      z.object({
        id: categoryIdSchema,
        label: z.string().max(300),
        subcategories: z
          .array(z.object({ id: z.string().max(100), label: z.string().max(300) }))
          .max(1000),
      }),
    )
    .max(40),
});
export const karavanMarketplaceReviewSchema = z.object({
  marketplace: karavanMarketplaceSummarySchema,
  rules: karavanMarketplaceCreateSchema.shape.rules.extend({
    version: z.number().int().positive(),
  }),
  permissions: karavanMarketplaceModuleSchema.shape.permissions,
  counts: karavanMarketplaceModuleSchema.shape.counts,
  bindings: z.array(karavanMarketplaceBindingSchema).max(48),
});
export const karavanMarketplacePreviewInputSchema = z
  .object({
    chatIds: z
      .array(karavanMarketplaceChatIdSchema)
      .min(1)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length),
    marketplaceId: karavanMarketplaceIdSchema.nullable(),
  })
  .strict();
export const karavanMarketplacePreviewSchema = z.object({
  target: karavanMarketplaceReviewSchema.nullable(),
  chats: z
    .array(
      z.object({
        chatId: karavanMarketplaceChatIdSchema,
        title: z.string().max(300),
        binding: karavanMarketplaceBindingSchema.nullable(),
        marketplace: karavanMarketplaceSummarySchema.nullable(),
      }),
    )
    .max(20),
});
export const karavanMarketplaceBindingCommandSchema = z
  .object({
    commandId: karavanMarketplaceCommandIdSchema,
    chatId: karavanMarketplaceChatIdSchema,
    expectedBindingGeneration: z.number().int().positive().nullable(),
    expectedPolicyRevision: z.number().int().positive().optional(),
  })
  .strict();
export const karavanMarketplaceBindingActionSchema = karavanMarketplaceBindingCommandSchema
  .extend({
    action: z.enum(['unbind_chat', 'transfer_chat', 'recover_chat']),
  })
  .strict();
export const karavanMarketplaceBindingResultSchema = z.object({
  marketplace: karavanMarketplaceSummarySchema,
  bindingId: z.string().uuid(),
  generation: z.number().int().positive(),
});
export const karavanMarketplaceCheckpointSchema = z
  .object({
    marketplaceId: z.string().uuid().nullable(),
    bindings: z
      .array(
        z
          .object({
            chatId: karavanMarketplaceChatIdSchema,
            state: z.enum(['pending', 'connected', 'unknown', 'failed']),
            bindingId: z.string().uuid().nullable(),
            generation: z.number().int().positive().nullable(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export const karavanMarketplaceOperationSchema = z
  .object({
    operationId: z.string().uuid(),
    state: z.enum(['pending', 'partial', 'complete', 'unknown', 'rejected', 'cancelled']),
    request: karavanMarketplaceSetupSchema,
    checkpoints: karavanMarketplaceCheckpointSchema,
  })
  .strict();
export type KaravanMarketplaceOperation = z.infer<typeof karavanMarketplaceOperationSchema>;
export const karavanMarketplaceResolveSchema = z
  .object({
    commandId: karavanMarketplaceCommandIdSchema,
    chatId: karavanMarketplaceChatIdSchema,
    subjectMaxUserId: karavanMarketplaceActorIdSchema,
    sourceMessageId: z.string().min(1).max(200),
    storeId: z.string().uuid().nullable(),
  })
  .strict();
export const karavanMarketplaceResolveResultSchema = z
  .object({
    status: z.enum(['published', 'choose_store', 'no_listing', 'unbound']),
    marketplace: karavanMarketplaceSummarySchema.nullable(),
    binding: z
      .object({ id: z.string().uuid(), generation: z.number().int().positive() })
      .nullable(),
    stores: z
      .array(
        z.object({
          id: z.string().uuid(),
          slug: z.string(),
          name: z.string(),
          url: z.string().url(),
          inviteUrl: z.string().url(),
        }),
      )
      .max(5),
  })
  .strict();
export type KaravanMarketplaceResolve = z.infer<typeof karavanMarketplaceResolveSchema>;
export type KaravanMarketplaceResolveResult = z.infer<typeof karavanMarketplaceResolveResultSchema>;
export const karavanMarketplaceAvailableSchema = z.object({
  marketplaces: z
    .array(
      z.object({
        marketplace: karavanMarketplaceSummarySchema,
        permissions: karavanMarketplaceModuleSchema.shape.permissions,
      }),
    )
    .max(48),
  nextCursor: z.string().nullable(),
});

// Private actor-scoped prompts contain no message text or MAX credentials.
export const karavanPublicationChoiceListRequestSchema = z
  .object({
    actorMaxUserId: karavanMarketplaceActorIdSchema,
    chatId: karavanMarketplaceChatIdSchema.optional(),
  })
  .strict();
export const karavanPublicationChoiceSchema = z
  .object({
    id: z.string().uuid(),
    marketplaceId: z.string().uuid(),
    marketplaceName: z.string().max(120),
    chatId: karavanMarketplaceChatIdSchema,
    expiresAt: z.string().datetime(),
    stores: z.array(z.object({ id: z.string().uuid(), name: z.string().max(300) })).max(5),
  })
  .strict();
export const karavanPublicationChoicesSchema = z
  .object({ choices: z.array(karavanPublicationChoiceSchema).max(20) })
  .strict();
export const karavanPublicationChoiceSaveSchema = z
  .object({
    actorMaxUserId: karavanMarketplaceActorIdSchema,
    choiceId: z.string().uuid(),
    storeId: z.string().uuid(),
    chatId: karavanMarketplaceChatIdSchema.optional(),
  })
  .strict();
export const karavanPublicationChoiceSavedSchema = z
  .object({ saved: z.literal(true), storeId: z.string().uuid() })
  .strict();
