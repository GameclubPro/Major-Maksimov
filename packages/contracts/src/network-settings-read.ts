import { z } from 'zod';
import { navigationAllowlistKindSchema } from './settings-utils.js';
import { applySettingsSectionSchema } from './settings-sections.js';
import { managedEntityFavoriteTypeSchema } from './managed-entity-favorite-type.js';
import { managedEntityTypeSchema } from './managed-entity-type.js';
export { applySettingsSectionSchema, type ApplySettingsSection } from './settings-sections.js';

export const networkSettingsTargetSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('category'), favoriteType: managedEntityFavoriteTypeSchema }).strict(),
  z
    .object({
      mode: z.literal('selected'),
      entityIds: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(500)
        .transform((ids) => [...new Set(ids)]),
    })
    .strict(),
]);
export type NetworkSettingsTarget = z.infer<typeof networkSettingsTargetSchema>;

export const networkChatSettingsSectionSchema = z.enum([
  'speechStyle',
  'rules',
  'messageRetention',
  'advertising',
]);
export const networkChannelSettingsSectionSchema = z.enum([
  'quickButtons',
  'comments',
  'postSignature',
  'postSuggestions',
]);
export const networkSettingsSectionSchema = z.union([
  applySettingsSectionSchema,
  networkChatSettingsSectionSchema,
  networkChannelSettingsSectionSchema,
]);
export type NetworkSettingsSection = z.infer<typeof networkSettingsSectionSchema>;

export const NETWORK_ALLOWLIST_PLAN_ROW_LIMIT = 1024;
export const NETWORK_SETTINGS_OPERATION_READER_VERSION = 4;
export const NETWORK_ALLOWLIST_ACTION_LIMIT = 128;
export const NETWORK_ALLOWLIST_REPLACEMENT_LIMIT = 300;
export const networkNavigationAllowlistTargetSchema = z
  .object({ value: z.string().trim().min(1).max(2048), kind: navigationAllowlistKindSchema })
  .strict();
const expirySchema = z.string().datetime().nullable();
export const networkNavigationAllowlistIntentSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('edit'),
      actions: z
        .array(
          z.discriminatedUnion('op', [
            z
              .object({
                op: z.literal('add'),
                target: networkNavigationAllowlistTargetSchema,
                removeAfterAt: expirySchema.optional(),
              })
              .strict(),
            z
              .object({ op: z.literal('remove'), target: networkNavigationAllowlistTargetSchema })
              .strict(),
            z
              .object({
                op: z.literal('setExpiry'),
                target: networkNavigationAllowlistTargetSchema,
                removeAfterAt: expirySchema,
              })
              .strict(),
          ]),
        )
        .min(1)
        .max(NETWORK_ALLOWLIST_ACTION_LIMIT),
    })
    .strict(),
  z
    .object({
      mode: z.literal('replace'),
      entries: z
        .array(networkNavigationAllowlistTargetSchema.extend({ removeAfterAt: expirySchema }))
        .max(NETWORK_ALLOWLIST_REPLACEMENT_LIMIT),
    })
    .strict(),
]);
export type NetworkNavigationAllowlistIntent = z.infer<
  typeof networkNavigationAllowlistIntentSchema
>;
export const networkNavigationAllowlistWitnessSchema = z
  .object({
    revision: z.string().regex(/^[0-9]+$/),
    observedAt: z.string().datetime(),
    nextExpiryAt: expirySchema,
  })
  .strict();
export type NetworkNavigationAllowlistWitness = z.infer<
  typeof networkNavigationAllowlistWitnessSchema
>;
export const networkNavigationAllowlistImpactSchema = z
  .object({
    entityId: z.string(),
    before: z.number().int().nonnegative(),
    after: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    expiryChanged: z.number().int().nonnegative(),
    noops: z.number().int().nonnegative(),
  })
  .strict();
export type NetworkNavigationAllowlistImpact = z.infer<
  typeof networkNavigationAllowlistImpactSchema
>;

const revisionSchema = z.union([z.string().datetime(), z.number().int().nonnegative()]);
export const networkSettingsRecipientSchema = z
  .object({
    entityId: z.string().min(1),
    title: z.string(),
    revision: revisionSchema,
    stopWordsRevision: z.number().int().nonnegative().optional(),
    rulesRevision: z.string().datetime().nullable().optional(),
    rulesContextDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    messageRetentionRevision: z.number().int().nonnegative().optional(),
    advertisingRevision: z.number().int().nonnegative().optional(),
    navigationAllowlistWitness: networkNavigationAllowlistWitnessSchema.optional(),
  })
  .strict();
export type NetworkSettingsRecipient = z.infer<typeof networkSettingsRecipientSchema>;

export const networkSettingsReadRequestSchema = z
  .object({
    entityType: managedEntityTypeSchema,
    target: networkSettingsTargetSchema,
    section: networkSettingsSectionSchema,
    cursor: z.string().max(4096).optional(),
  })
  .strict();
export type NetworkSettingsReadRequest = z.infer<typeof networkSettingsReadRequestSchema>;

export const networkSettingsFieldSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('common'), value: z.unknown() }).strict(),
  z.object({ kind: z.literal('mixed') }).strict(),
]);
export type NetworkSettingsField = z.infer<typeof networkSettingsFieldSchema>;

export const networkSettingsReadResponseSchema = z
  .object({
    entityType: managedEntityTypeSchema,
    target: networkSettingsTargetSchema,
    section: networkSettingsSectionSchema,
    compositionVersion: z.string(),
    recipients: z.array(networkSettingsRecipientSchema),
    fields: z.record(z.string(), networkSettingsFieldSchema),
    recipientCount: z.number().int().nonnegative(),
    complete: z.boolean(),
    commercialAiModerationMode: z.enum(['OFF', 'OBSERVE', 'DELETE_ONLY']).optional(),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type NetworkSettingsReadResponse = z.infer<typeof networkSettingsReadResponseSchema>;

export const networkSettingsMetadataScopeSchema = networkSettingsReadRequestSchema
  .omit({ cursor: true })
  .extend({ compositionVersion: z.string().min(1), requestId: z.string().uuid() })
  .strict();
export const networkNavigationAllowlistReadRequestSchema = networkSettingsMetadataScopeSchema
  .extend({
    entityId: z.string().min(1),
    cursor: z.string().max(2048).optional(),
    includeEntries: z.boolean().optional(),
  })
  .strict();
export const networkNavigationAllowlistReadResponseSchema = z
  .object({
    entityId: z.string(),
    compositionVersion: z.string(),
    witness: networkNavigationAllowlistWitnessSchema,
    entries: z.array(
      z
        .object({
          value: z.string(),
          kind: navigationAllowlistKindSchema,
          removeAfterAt: expirySchema,
        })
        .strict(),
    ),
    totalEntries: z.number().int().nonnegative(),
    complete: z.boolean(),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const networkSettingsOperationStatusSchema = z.enum([
  'PREVIEWING',
  'PREPARED',
  'AUTHORIZING',
  'RUNNING',
  'COMPLETE',
  'PARTIAL',
  'FAILED',
]);
