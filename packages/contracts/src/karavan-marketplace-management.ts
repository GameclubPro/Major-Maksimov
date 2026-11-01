import {
  marketplaceAdminImageSchema,
  marketplaceAdminImageResponseSchema,
  marketplaceAppearanceResponseSchema,
  marketplaceAppearanceSaveSchema,
  marketplaceAppearancePublishSchema,
  marketplacePinsResponseSchema,
  marketplacePinsSaveSchema,
  marketplaceCatalogQuerySchema,
  marketplaceCatalogResponseSchema,
} from './karavan-marketplace-design.js';
import { z } from 'zod';
import {
  karavanAdministrationStoreSchema,
  karavanShopFormatSchema,
} from './karavan-marketplace.js';
import {
  marketplaceDetailResponseSchema,
  marketplaceListingQuerySchema,
  marketplaceListingListResponseSchema,
  marketplaceApplicationPageQuerySchema,
  marketplaceApplicationListResponseSchema,
  marketplaceApplicationDecisionRequestSchema,
  marketplaceListingMutationResponseSchema,
  marketplaceListingModerationRequestSchema,
  marketplaceReorderRequestSchema,
  marketplaceReorderResponseSchema,
  marketplaceRulesPreviewRequestSchema,
  marketplaceRulesImpactSchema,
  marketplaceRulesUpdateRequestSchema,
  marketplaceRulesMutationResponseSchema,
  marketplaceSettingsRequestSchema,
  marketplaceMutationResponseSchema,
  marketplaceInvitationCreateRequestSchema,
  marketplaceInvitationResponseSchema,
  marketplaceInvitationListResponseSchema,
  marketplacePageQuerySchema,
  marketplaceStatusRequestSchema,
  marketplaceRulesCancelRequestSchema,
  marketplaceSummarySchema,
} from './karavan-marketplace-domain.js';
import {
  marketplaceContentQuerySchema,
  marketplaceContentListResponseSchema,
  marketplaceContentRestrictionRequestSchema,
  marketplaceContentRestrictionResponseSchema,
} from './karavan-marketplace-content.js';

export const marketplaceFormatPreviewRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    format: karavanShopFormatSchema,
    administrationStoreId: z.string().uuid().nullable().optional(),
  })
  .strict();
export const marketplaceFormatImpactSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedRevision: z.number().int().positive(),
  format: karavanShopFormatSchema,
  administrationStoreId: z.string().uuid().nullable(),
  affectedStores: z.number().int().nonnegative(),
  affectedChats: z.number().int().nonnegative(),
  pendingApplications: z.number().int().nonnegative(),
});
export const marketplaceFormatUpdateRequestSchema = marketplaceFormatPreviewRequestSchema
  .extend({
    commandId: z.string().regex(/^[A-Za-z0-9._:-]{8,120}$/u),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export const marketplaceAdministrationStoreResponseSchema = z.object({
  store: karavanAdministrationStoreSchema.nullable(),
  buyerUrl: z.string().url().nullable(),
  sellerUrl: z.string().url().nullable(),
  permissions: z.array(
    z.enum(['manage_store', 'manage_products', 'manage_orders', 'manage_conversations']),
  ),
});

// Bounded domain operations. Paths, actor identity and permissions are never supplied by the browser.
export const marketplaceManagementOperationSchema = /* @__PURE__ */ (() =>
  z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('administration_store') }).strict(),
    z
      .object({
        operation: z.literal('format_preview'),
        input: marketplaceFormatPreviewRequestSchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal('format_update'),
        input: marketplaceFormatUpdateRequestSchema,
      })
      .strict(),
    z.object({ operation: z.literal('appearance') }).strict(),
    z
      .object({ operation: z.literal('appearance_apply'), input: marketplaceAppearanceSaveSchema })
      .strict(),
    z
      .object({ operation: z.literal('appearance_save'), input: marketplaceAppearanceSaveSchema })
      .strict(),
    z
      .object({
        operation: z.literal('appearance_publish'),
        input: marketplaceAppearancePublishSchema,
      })
      .strict(),
    z.object({ operation: z.literal('pins') }).strict(),
    z.object({ operation: z.literal('pins_save'), input: marketplacePinsSaveSchema }).strict(),
    z.object({ operation: z.literal('catalog'), input: marketplaceCatalogQuerySchema }).strict(),
    z
      .object({
        operation: z.literal('invitation_create'),
        input: marketplaceInvitationCreateRequestSchema,
      })
      .strict(),
    z.object({ operation: z.literal('invitations'), input: marketplacePageQuerySchema }).strict(),
    z
      .object({
        operation: z.literal('invitation_revoke'),
        input: z.object({ commandId: z.string().uuid(), invitationId: z.string().uuid() }).strict(),
      })
      .strict(),
    z.object({ operation: z.literal('image'), input: marketplaceAdminImageSchema }).strict(),
    z
      .object({ operation: z.literal('rules_cancel'), input: marketplaceRulesCancelRequestSchema })
      .strict(),
    z.object({ operation: z.literal('detail') }).strict(),
    z.object({ operation: z.literal('listings'), input: marketplaceListingQuerySchema }).strict(),
    z
      .object({
        operation: z.literal('applications'),
        input: marketplaceApplicationPageQuerySchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal('content'),
        listingId: z.string().uuid(),
        input: marketplaceContentQuerySchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal('decide'),
        applicationId: z.string().uuid(),
        input: marketplaceApplicationDecisionRequestSchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal('moderate_listing'),
        listingId: z.string().uuid(),
        input: marketplaceListingModerationRequestSchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal('moderate_content'),
        input: marketplaceContentRestrictionRequestSchema,
      })
      .strict(),
    z
      .object({ operation: z.literal('reorder_listings'), input: marketplaceReorderRequestSchema })
      .strict(),
    z
      .object({
        operation: z.literal('rules_preview'),
        input: marketplaceRulesPreviewRequestSchema,
      })
      .strict(),
    z
      .object({ operation: z.literal('rules_update'), input: marketplaceRulesUpdateRequestSchema })
      .strict(),
    z
      .object({ operation: z.literal('settings'), input: marketplaceSettingsRequestSchema })
      .strict(),
    z.object({ operation: z.literal('status'), input: marketplaceStatusRequestSchema }).strict(),
  ]))();
export const marketplaceManagementRequestSchema = /* @__PURE__ */ (() =>
  z
    .object({
      commandId: z.string().regex(/^[A-Za-z0-9._:-]{8,120}$/u),
      chatId: z.string().regex(/^-?\d{1,24}$/u),
      marketplaceId: z.string().uuid(),
      expectedBindingGeneration: z.number().int().positive(),
      command: marketplaceManagementOperationSchema,
    })
    .strict()
    .refine(
      (value) =>
        !('input' in value.command && 'commandId' in value.command.input) ||
        value.command.input.commandId === value.commandId,
      { message: 'Команда изменилась. Повторите действие', path: ['commandId'] },
    ))();
export const marketplaceManagementResponseSchema = /* @__PURE__ */ (() =>
  z.discriminatedUnion('operation', [
    z.object({
      operation: z.literal('administration_store'),
      data: marketplaceAdministrationStoreResponseSchema,
    }),
    z.object({ operation: z.literal('format_preview'), data: marketplaceFormatImpactSchema }),
    z.object({
      operation: z.literal('format_update'),
      data: z.object({ marketplace: marketplaceSummarySchema }),
    }),
    z.object({ operation: z.literal('appearance'), data: marketplaceAppearanceResponseSchema }),
    z.object({
      operation: z.literal('appearance_apply'),
      data: marketplaceAppearanceResponseSchema,
    }),
    z.object({
      operation: z.literal('appearance_save'),
      data: marketplaceAppearanceResponseSchema,
    }),
    z.object({
      operation: z.literal('appearance_publish'),
      data: marketplaceAppearanceResponseSchema,
    }),
    z.object({ operation: z.literal('pins'), data: marketplacePinsResponseSchema }),
    z.object({ operation: z.literal('pins_save'), data: marketplacePinsResponseSchema }),
    z.object({ operation: z.literal('catalog'), data: marketplaceCatalogResponseSchema }),
    z.object({
      operation: z.literal('invitation_create'),
      data: marketplaceInvitationResponseSchema.extend({ url: z.string().url().nullable() }),
    }),
    z.object({
      operation: z.literal('invitations'),
      data: marketplaceInvitationListResponseSchema,
    }),
    z.object({
      operation: z.literal('invitation_revoke'),
      data: z.object({ revoked: z.boolean() }),
    }),
    z.object({ operation: z.literal('image'), data: marketplaceAdminImageResponseSchema }),
    z.object({
      operation: z.literal('rules_cancel'),
      data: z.object({ policyRevision: z.number().int().positive() }),
    }),
    z.object({ operation: z.literal('detail'), data: marketplaceDetailResponseSchema }),
    z.object({ operation: z.literal('listings'), data: marketplaceListingListResponseSchema }),
    z.object({
      operation: z.literal('applications'),
      data: marketplaceApplicationListResponseSchema,
    }),
    z.object({ operation: z.literal('content'), data: marketplaceContentListResponseSchema }),
    z.object({ operation: z.literal('decide'), data: marketplaceListingMutationResponseSchema }),
    z.object({
      operation: z.literal('moderate_listing'),
      data: marketplaceListingMutationResponseSchema,
    }),
    z.object({
      operation: z.literal('moderate_content'),
      data: marketplaceContentRestrictionResponseSchema,
    }),
    z.object({ operation: z.literal('reorder_listings'), data: marketplaceReorderResponseSchema }),
    z.object({ operation: z.literal('rules_preview'), data: marketplaceRulesImpactSchema }),
    z.object({
      operation: z.literal('rules_update'),
      data: marketplaceRulesMutationResponseSchema,
    }),
    z.object({ operation: z.literal('settings'), data: marketplaceMutationResponseSchema }),
    z.object({ operation: z.literal('status'), data: marketplaceMutationResponseSchema }),
  ]))();
export type MarketplaceManagementOperation = z.infer<typeof marketplaceManagementOperationSchema>;
export type MarketplaceManagementRequest = z.infer<typeof marketplaceManagementRequestSchema>;
export type MarketplaceManagementResponse = z.infer<typeof marketplaceManagementResponseSchema>;

export {
  marketplaceAppearanceSchema,
  type MarketplaceAppearance,
  type MarketplaceOfferCard,
} from './karavan-marketplace-design.js';
export type {
  MarketplaceDetailResponse,
  MarketplaceListing,
  MarketplaceApplication,
} from './karavan-marketplace-domain.js';
