// Versioned Karavan domain wire schemas; no shared database or runtime dependency.
import { z } from 'zod';
import { karavanMarketplaceCategories, karavanShopFormatSchema } from './karavan-marketplace.js';
const catalogTaxonomyCategoryIdSchema = z.enum(karavanMarketplaceCategories.map(([id]) => id));
const catalogTaxonomySubcategoryIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u)
  .max(100);

const id = /* @__PURE__ */ (() => z.string().uuid())();
const revision = /* @__PURE__ */ (() => z.number().int().positive())();
const instant = /* @__PURE__ */ (() => z.string().datetime())();
export const marketplacePageLimit = 48;
export const marketplaceBatchLimit = 50;
export const marketplacePermissionSchema = /* @__PURE__ */ (() =>
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
  ]))();
export const marketplaceRoleSchema = /* @__PURE__ */ (() =>
  z.enum(['manager', 'moderator', 'editor', 'viewer']))();
const marketplaceStatusSchema = z.enum(['draft', 'active', 'paused', 'archived']);
export const marketplaceReviewStateSchema = /* @__PURE__ */ (() =>
  z.enum(['not_submitted', 'pending', 'approved', 'changes_requested', 'rejected', 'suspended']))();
export const marketplaceApplicationStateSchema = /* @__PURE__ */ (() =>
  z.enum(['pending', 'approved', 'changes_requested', 'rejected', 'superseded', 'withdrawn']))();
export const marketplaceSellerStateSchema = /* @__PURE__ */ (() =>
  z.enum(['enabled', 'paused', 'withdrawn']))();
export const marketplacePublicationReasonSchema = /* @__PURE__ */ (() =>
  z.enum([
    'published',
    'marketplace_unavailable',
    'chat_unavailable',
    'store_unavailable',
    'awaiting_review',
    'changes_requested',
    'rejected',
    'suspended',
    'seller_paused',
    'withdrawn',
    'platform_review',
    'rules_acceptance_required',
    'category_not_allowed',
    'no_published_offers',
  ]))();
export const marketplaceApplicationPageQuerySchema = /* @__PURE__ */ (() =>
  z.object({
    applicationId: z.string().uuid().optional(),
    cursor: z.string().max(240).nullable().optional().default(null),
    limit: z.coerce.number().int().min(1).max(48).optional().default(24),
    state: z
      .enum([
        'pending',
        'approved',
        'changes_requested',
        'rejected',
        'superseded',
        'withdrawn',
        'all',
      ])
      .optional()
      .default('pending'),
  }))();
export const marketplaceCommandSchema = /* @__PURE__ */ (() =>
  z.object({ commandId: z.string().trim().min(8).max(120) }))();
export const marketplacePageQuerySchema = /* @__PURE__ */ (() =>
  z.object({
    cursor: z.string().max(240).nullable().optional().default(null),
    limit: z.coerce.number().int().min(1).max(marketplacePageLimit).optional().default(24),
  }))();
export const marketplaceListingQuerySchema = /* @__PURE__ */ (() =>
  marketplacePageQuerySchema
    .extend({
      cursor: z.string().max(512).nullable().optional().default(null),
      q: z.string().trim().max(120).optional().default(''),
      visibility: z.enum(['all', 'visible', 'hidden']).optional().default('all'),
      orderableOnly: z
        .union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')])
        .optional()
        .default(false),
      storeId: id.optional(),
    })
    .strict())();
export const marketplaceRulesInputSchema = /* @__PURE__ */ (() =>
  z.object({
    text: z.string().trim().min(1).max(12000),
    allowedCategoryIds: z.array(catalogTaxonomyCategoryIdSchema).min(1).max(40),
    allowedSubcategoryIds: z.array(catalogTaxonomySubcategoryIdSchema).max(1000),
    categoryOrder: z.array(catalogTaxonomyCategoryIdSchema).max(40).optional().default([]),
  }))();
export const marketplaceRulesVersionSchema = /* @__PURE__ */ (() =>
  marketplaceRulesInputSchema.extend({
    id,
    version: revision,
    effectiveAt: instant,
    createdAt: instant,
    requiresAcceptance: z.boolean(),
  }))();
export const marketplaceSummarySchema = /* @__PURE__ */ (() =>
  z.object({
    id,
    networkId: id,
    publicSlug: z.string().min(3).max(100),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).nullable(),
    kind: z.enum(['chat', 'legacy']),
    format: karavanShopFormatSchema.optional(),
    administrationStoreId: id.nullable().optional(),
    formatRevision: revision.optional(),
    status: marketplaceStatusSchema,
    admissionPolicy: z.enum(['applications', 'invitation']),
    logoImageUrl: z.string().url().nullable(),
    coverImageUrl: z.string().url().nullable(),
    editRevision: revision,
    policyRevision: revision,
    orderRevision: revision,
    visibilityRevision: revision,
  }))();
export const marketplacePublicResponseSchema = /* @__PURE__ */ (() =>
  z.object({
    marketplace: marketplaceSummarySchema,
    rules: marketplaceRulesVersionSchema,
    scheduledRules: marketplaceRulesVersionSchema.nullable(),
  }))();
export const marketplaceWorkspaceResponseSchema = /* @__PURE__ */ (() =>
  z.object({
    marketplaces: z
      .array(
        z.object({
          marketplace: marketplaceSummarySchema,
          permissions: z.array(marketplacePermissionSchema),
        }),
      )
      .max(48),
    nextCursor: z.string().nullable(),
  }))();
export const marketplaceChatBindingSchema = /* @__PURE__ */ (() =>
  z.object({
    id,
    chatId: z
      .string()
      .regex(/^-?\d+$/u)
      .max(100),
    chatTitle: z.string().max(300),
    state: z.enum(['pending', 'verified', 'disconnected', 'revoked']),
    generation: z.number().int().positive(),
    revision,
    verifiedAt: instant.nullable(),
  }))();
export const marketplaceDetailResponseSchema = /* @__PURE__ */ (() =>
  marketplacePublicResponseSchema.extend({
    permissions: z.array(marketplacePermissionSchema),
    counts: z.object({
      approvedListings: z.number().int().nonnegative().optional(),
      listings: z.number().int().nonnegative(),
      readyListings: z.number().int().nonnegative().optional(),
      pendingApplications: z.number().int().nonnegative(),
      chats: z.number().int().nonnegative(),
    }),
    bindings: z.array(marketplaceChatBindingSchema).max(48),
  }))();
export const marketplaceCreateRequestSchema = /* @__PURE__ */ (() =>
  marketplaceCommandSchema
    .extend({
      networkId: id.nullable().optional().default(null),
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(2000).nullable().optional().default(null),
      admissionPolicy: z.enum(['applications', 'invitation']).optional().default('applications'),
      rules: marketplaceRulesInputSchema,
    })
    .strict())();
export const marketplaceSettingsRequestSchema = /* @__PURE__ */ (() =>
  marketplaceCommandSchema
    .extend({
      expectedRevision: revision,
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().trim().max(2000).nullable().optional(),
      logoImageUrl: z.string().url().max(2048).nullable().optional(),
      coverImageUrl: z.string().url().max(2048).nullable().optional(),
      admissionPolicy: z.enum(['applications', 'invitation']).optional(),
    })
    .strict())();
export const marketplaceStatusRequestSchema = /* @__PURE__ */ (() =>
  marketplaceCommandSchema
    .extend({
      expectedRevision: revision,
      status: marketplaceStatusSchema,
      allowEmpty: z.boolean().optional().default(false),
    })
    .strict())();
export const marketplaceRulesPreviewRequestSchema = /* @__PURE__ */ (() =>
  z
    .object({
      expectedPolicyRevision: revision,
      rules: marketplaceRulesInputSchema,
      effectiveAt: instant,
      requiresAcceptance: z.boolean().optional().default(true),
    })
    .strict())();
export const marketplaceRulesImpactSchema = /* @__PURE__ */ (() =>
  z.object({
    fingerprint: z.string().length(64),
    calculatedAt: instant,
    hiddenOffers: z.number().int().nonnegative(),
    affectedStores: z.number().int().nonnegative(),
    emptiedStores: z.number().int().nonnegative(),
    affectedChats: z.number().int().nonnegative(),
    stores: z
      .array(
        z.object({
          storeId: id,
          name: z.string(),
          hiddenOffers: z.number().int().nonnegative(),
          empty: z.boolean(),
        }),
      )
      .max(48),
    hasMoreStores: z.boolean(),
  }))();
export const marketplaceRulesCancelRequestSchema = /* @__PURE__ */ (() =>
  marketplaceCommandSchema
    .extend({ expectedPolicyRevision: revision, rulesVersionId: id })
    .strict())();
export const marketplaceRulesMutationResponseSchema = /* @__PURE__ */ (() =>
  z.object({ rules: marketplaceRulesVersionSchema, policyRevision: revision }))();
export const marketplaceRulesUpdateRequestSchema = /* @__PURE__ */ (() =>
  marketplaceRulesPreviewRequestSchema
    .extend({
      commandId: z.string().trim().min(8).max(120),
      fingerprint: z.string().length(64),
    })
    .strict())();
export const storePublicProfileSchema = /* @__PURE__ */ (() =>
  z.object({
    name: z.string(),
    description: z.string().nullable(),
    coverImageUrl: z.string().nullable(),
    logoImageUrl: z.string().nullable(),
  }))();
export const marketplaceListingSchema = /* @__PURE__ */ (() =>
  z.object({
    id,
    marketplaceId: id,
    storeId: id,
    storeName: z.string(),
    marketplaceName: z.string(),
    revision,
    reviewState: marketplaceReviewStateSchema,
    sellerState: marketplaceSellerStateSchema,
    publicationReason: marketplacePublicationReasonSchema,
    rank: z.string(),
    position: z.number().int().positive().nullable().optional(),
    approvedProfileVersionId: id.nullable(),
    pendingApplicationId: id.nullable(),
    acceptedRulesVersion: z.number().int().positive().nullable(),
    requiredRulesVersion: revision,
    decisionReason: z.string().nullable(),
    reapplyAvailableAt: z.string().datetime().nullable().optional(),
  }))();
export const marketplaceListingListResponseSchema = /* @__PURE__ */ (() =>
  z.object({
    listings: z.array(marketplaceListingSchema).max(48),
    nextCursor: z.string().nullable(),
    orderRevision: revision,
    total: z.number().int().nonnegative().optional(),
    orderableTotal: z.number().int().nonnegative().optional(),
  }))();
export const sellerPlacementListResponseSchema = /* @__PURE__ */ (() =>
  z.object({
    placements: z.array(marketplaceListingSchema).max(48),
    nextCursor: z.string().nullable(),
    effectivePermissions: z.array(z.enum(['manage_placements', 'publish_store_link'])).default([]),
    canManagePermissions: z.boolean().default(false),
  }))();
export const marketplaceApplicationSchema = /* @__PURE__ */ (() =>
  z.object({
    id,
    listingId: id,
    marketplaceId: id,
    storeId: id,
    storeName: z.string(),
    revision,
    attempt: revision,
    state: marketplaceApplicationStateSchema,
    profileVersionId: id,
    profile: storePublicProfileSchema,
    publishedProfile: storePublicProfileSchema.nullable(),
    rulesVersion: marketplaceRulesVersionSchema,
    submittedAt: instant,
    decidedAt: instant.nullable(),
    reason: z.string().nullable(),
    canReview: z.boolean(),
    canPublishOwn: z.boolean().optional(),
  }))();
export const marketplaceApplicationListResponseSchema = /* @__PURE__ */ (() =>
  z.object({
    applications: z.array(marketplaceApplicationSchema).max(48),
    nextCursor: z.string().nullable(),
  }))();
export const sellerPlacementApplyRequestSchema = /* @__PURE__ */ (() =>
  marketplaceCommandSchema
    .extend({
      marketplaceId: id,
      rulesVersionId: id,
      invitationCode: z.string().min(20).max(240).nullable().optional().default(null),
      expectedStoreRevision: revision,
    })
    .strict())();
export const sellerPlacementActionRequestSchema = /* @__PURE__ */ (() =>
  marketplaceCommandSchema
    .extend({
      expectedRevision: revision,
      action: z.enum(['pause', 'resume', 'leave', 'withdraw_application', 'accept_rules']),
      rulesVersionId: id.nullable().optional().default(null),
    })
    .strict())();
export const marketplaceApplicationDecisionRequestSchema = /* @__PURE__ */ (() =>
  marketplaceCommandSchema
    .extend({
      expectedRevision: revision,
      decision: z.enum(['approve', 'changes_requested', 'reject']),
      reason: z.string().trim().max(2000).nullable().optional().default(null),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.decision !== 'approve' && !value.reason)
        context.addIssue({ code: 'custom', path: ['reason'], message: 'Укажите причину решения' });
    }))();
export const marketplaceListingModerationRequestSchema = /* @__PURE__ */ (() =>
  marketplaceCommandSchema
    .extend({
      expectedRevision: revision,
      action: z.enum(['suspend', 'resume']),
      reason: z.string().trim().min(1).max(2000),
    })
    .strict())();
export const marketplaceReorderRequestSchema = /* @__PURE__ */ (() =>
  marketplaceCommandSchema
    .extend({
      expectedOrderRevision: revision,
      moves: z
        .array(
          z.union([
            z.object({ listingId: id, beforeListingId: id.nullable() }).strict(),
            z.object({ listingId: id, position: z.number().int().min(1).max(1000000) }).strict(),
          ]),
        )
        .min(1)
        .max(marketplaceBatchLimit),
    })
    .strict())();
export const marketplaceReorderResponseSchema = /* @__PURE__ */ (() =>
  z.object({ orderRevision: revision }))();
export const marketplaceMemberSchema = /* @__PURE__ */ (() =>
  z.object({
    userId: id,
    name: z.string(),
    role: marketplaceRoleSchema,
    permissions: z.array(marketplacePermissionSchema),
    revision,
  }))();
export const marketplaceMemberListResponseSchema = /* @__PURE__ */ (() =>
  z.object({
    members: z.array(marketplaceMemberSchema).max(48),
    nextCursor: z.string().nullable(),
  }))();
export const marketplaceMemberUpdateResponseSchema = /* @__PURE__ */ (() =>
  z.object({ revision }))();
export const marketplaceMemberUpdateRequestSchema = /* @__PURE__ */ (() =>
  marketplaceCommandSchema
    .extend({
      userId: id,
      expectedRevision: revision.nullable(),
      role: marketplaceRoleSchema,
      permissions: z.array(marketplacePermissionSchema).max(9),
      active: z.boolean(),
    })
    .strict())();
export const marketplaceInvitationCreateRequestSchema = /* @__PURE__ */ (() =>
  marketplaceCommandSchema
    .extend({
      expiresAt: instant,
      maxUses: z.number().int().min(1).max(1000),
      targetMaxUserId: z.string().regex(/^\d+$/u).nullable().optional().default(null),
    })
    .strict())();
export const marketplaceInvitationResponseSchema = /* @__PURE__ */ (() =>
  z.object({
    id,
    expiresAt: instant,
    maxUses: z.number().int().positive(),
    usedCount: z.number().int().nonnegative(),
    code: z.string().nullable(),
    revoked: z.boolean(),
  }))();
export const marketplaceInvitationListResponseSchema = /* @__PURE__ */ (() =>
  z.object({
    invitations: z.array(marketplaceInvitationResponseSchema.omit({ code: true })).max(48),
    nextCursor: z.string().nullable(),
  }))();
export const sellerPlacementTargetRequestSchema = /* @__PURE__ */ (() =>
  z
    .object({
      marketplaceId: id,
      invitationCode: z.string().min(20).max(240).nullable().optional().default(null),
    })
    .strict())();
export const marketplaceMutationResponseSchema = /* @__PURE__ */ (() =>
  z.object({ marketplace: marketplaceSummarySchema }))();
export const marketplaceListingMutationResponseSchema = /* @__PURE__ */ (() =>
  z.object({ listing: marketplaceListingSchema }))();
export const marketplaceInvitationRevokeRequestSchema = /* @__PURE__ */ (() =>
  marketplaceCommandSchema.strict())();

export type MarketplacePermission = z.infer<typeof marketplacePermissionSchema>;
export type MarketplaceRole = z.infer<typeof marketplaceRoleSchema>;
export type MarketplaceSummary = z.infer<typeof marketplaceSummarySchema>;
export type MarketplaceRulesInput = z.infer<typeof marketplaceRulesInputSchema>;
export type MarketplaceRulesVersion = z.infer<typeof marketplaceRulesVersionSchema>;
export type MarketplacePublicResponse = z.infer<typeof marketplacePublicResponseSchema>;
export type MarketplaceDetailResponse = z.infer<typeof marketplaceDetailResponseSchema>;
export type MarketplaceWorkspaceResponse = z.infer<typeof marketplaceWorkspaceResponseSchema>;
export type MarketplaceCreateRequest = z.infer<typeof marketplaceCreateRequestSchema>;
export type MarketplaceSettingsRequest = z.infer<typeof marketplaceSettingsRequestSchema>;
export type MarketplaceStatusRequest = z.infer<typeof marketplaceStatusRequestSchema>;
export type MarketplaceRulesPreviewRequest = z.infer<typeof marketplaceRulesPreviewRequestSchema>;
export type MarketplaceRulesUpdateRequest = z.infer<typeof marketplaceRulesUpdateRequestSchema>;
export type MarketplaceRulesImpact = z.infer<typeof marketplaceRulesImpactSchema>;
export type MarketplaceListing = z.infer<typeof marketplaceListingSchema>;
export type MarketplaceListingListResponse = z.infer<typeof marketplaceListingListResponseSchema>;
export type SellerPlacementListResponse = z.infer<typeof sellerPlacementListResponseSchema>;
export type MarketplaceApplication = z.infer<typeof marketplaceApplicationSchema>;
export type MarketplaceApplicationListResponse = z.infer<
  typeof marketplaceApplicationListResponseSchema
>;
export type SellerPlacementApplyRequest = z.infer<typeof sellerPlacementApplyRequestSchema>;
export type SellerPlacementActionRequest = z.infer<typeof sellerPlacementActionRequestSchema>;
export type MarketplaceApplicationDecisionRequest = z.infer<
  typeof marketplaceApplicationDecisionRequestSchema
>;
export type MarketplaceListingModerationRequest = z.infer<
  typeof marketplaceListingModerationRequestSchema
>;
export type MarketplaceReorderRequest = z.infer<typeof marketplaceReorderRequestSchema>;
export type MarketplaceReorderResponse = z.infer<typeof marketplaceReorderResponseSchema>;
export type MarketplaceMemberUpdateRequest = z.infer<typeof marketplaceMemberUpdateRequestSchema>;
export type MarketplaceMemberListResponse = z.infer<typeof marketplaceMemberListResponseSchema>;
export type MarketplaceInvitationCreateRequest = z.infer<
  typeof marketplaceInvitationCreateRequestSchema
>;
export type MarketplaceInvitationResponse = z.infer<typeof marketplaceInvitationResponseSchema>;
export type MarketplacePageQuery = z.infer<typeof marketplacePageQuerySchema>;
export type MarketplaceMutationResponse = z.infer<typeof marketplaceMutationResponseSchema>;
export type MarketplaceListingMutationResponse = z.infer<
  typeof marketplaceListingMutationResponseSchema
>;
export type StorePublicProfile = z.infer<typeof storePublicProfileSchema>;
