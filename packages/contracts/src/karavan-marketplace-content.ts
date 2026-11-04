import { z } from 'zod';
import {
  marketplaceCommandSchema,
  marketplacePageQuerySchema,
} from './karavan-marketplace-domain.js';

export const marketplaceAuditEntrySchema = /* @__PURE__ */ (() =>
  z.object({
    id: z.string().uuid(),
    actorName: z.string(),
    action: z.string(),
    summary: z.string(),
    createdAt: z.string().datetime(),
    details: z.object({
      reason: z.string().optional(),
      listingId: z.string().uuid().optional(),
      applicationId: z.string().uuid().optional(),
      bindingId: z.string().uuid().optional(),
      count: z.number().int().nonnegative().optional(),
      version: z.number().int().positive().optional(),
      effectiveAt: z.string().datetime().optional(),
    }),
  }))();
export const marketplaceAuditResponseSchema = /* @__PURE__ */ (() =>
  z.object({
    entries: z.array(marketplaceAuditEntrySchema).max(48),
    nextCursor: z.string().nullable(),
  }))();
export const marketplaceMetricsQuerySchema = /* @__PURE__ */ (() =>
  z.object({
    days: z.coerce
      .number()
      .pipe(z.union([z.literal(7), z.literal(30), z.literal(90)]))
      .optional()
      .default(30),
  }))();
export const marketplaceMetricsResponseSchema = /* @__PURE__ */ (() =>
  z.object({
    status: z.literal('unavailable'),
    periodStart: z.null(),
    periodEnd: z.null(),
    orders: z.null(),
    completedOrders: z.null(),
    serviceRequests: z.null(),
    newConversations: z.null(),
  }))();
export const marketplaceContentQuerySchema = /* @__PURE__ */ (() =>
  marketplacePageQuerySchema.extend({
    kind: z.enum(['product', 'property']).optional().default('product'),
  }))();
export const marketplaceContentRestrictionSchema = /* @__PURE__ */ (() =>
  z.object({
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    active: z.boolean(),
    reason: z.string(),
  }))();
export const marketplaceContentListResponseSchema = /* @__PURE__ */ (() =>
  z.object({
    items: z
      .array(
        z.object({
          id: z.string().uuid(),
          kind: z.enum(['product', 'property']),
          title: z.string(),
          imageUrl: z.string().url().nullable(),
          allowedCategory: z.boolean(),
          priceLabel: z.string().optional(),
          categoryLabel: z.string().optional(),
          restriction: marketplaceContentRestrictionSchema.nullable(),
        }),
      )
      .max(48),
    nextCursor: z.string().nullable(),
    storeId: z.string().uuid(),
  }))();
export const marketplaceContentRestrictionRequestSchema = /* @__PURE__ */ (() =>
  marketplaceCommandSchema
    .extend({
      storeId: z.string().uuid(),
      productId: z.string().uuid().nullable(),
      propertyId: z.string().uuid().nullable(),
      expectedRevision: z.number().int().positive().nullable(),
      active: z.boolean(),
      reason: z.string().trim().min(1).max(2000),
    })
    .strict()
    .superRefine((value, context) => {
      if (Boolean(value.productId) === Boolean(value.propertyId))
        context.addIssue({
          code: 'custom',
          path: ['productId'],
          message: 'Выберите одно предложение',
        });
    }))();
export const marketplaceContentRestrictionResponseSchema = /* @__PURE__ */ (() =>
  z.object({
    restriction: marketplaceContentRestrictionSchema,
    visibilityRevision: z.number().int().positive(),
  }))();
export type MarketplaceAuditResponse = z.infer<typeof marketplaceAuditResponseSchema>;
export type MarketplaceMetricsResponse = z.infer<typeof marketplaceMetricsResponseSchema>;
export type MarketplaceContentListResponse = z.infer<typeof marketplaceContentListResponseSchema>;
export type MarketplaceContentRestrictionRequest = z.infer<
  typeof marketplaceContentRestrictionRequestSchema
>;
