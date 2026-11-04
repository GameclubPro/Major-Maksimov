import { z } from 'zod';
import {
  marketplaceManagementRequestSchema,
  marketplaceManagementResponseSchema,
} from './karavan-marketplace-management.js';
import {
  karavanMarketplaceActorIdSchema,
  karavanMarketplaceChatIdSchema,
  karavanMarketplaceCommandIdSchema,
  karavanMarketplaceIdSchema,
  karavanMarketplaceOperationSchema,
  karavanMarketplaceBindingResultSchema,
  karavanMarketplaceSummarySchema,
} from './karavan-marketplace.js';

export const karavanConnectionBindingInputSchema = z
  .object({
    marketplaceId: karavanMarketplaceIdSchema,
    commandId: z.string().uuid(),
    expectedBindingGeneration: z.number().int().positive().nullable(),
    action: z.enum(['bind_chat', 'unbind_chat', 'recover_chat', 'transfer_chat']),
    expectedConnectionRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type KaravanConnectionBindingInput = z.infer<typeof karavanConnectionBindingInputSchema>;

export const karavanConnectionBindingOperationSchema = z
  .object({
    operationId: z.string().uuid(),
    state: z.enum(['pending', 'unknown', 'complete', 'rejected', 'cancelled', 'superseded']),
    request: karavanConnectionBindingInputSchema,
    result: z
      .object({ bindingId: z.string().uuid(), generation: z.number().int().positive() })
      .nullable(),
    errorCode: z.string().max(100).nullable(),
  })
  .strict();
export type KaravanConnectionBindingOperation = z.infer<
  typeof karavanConnectionBindingOperationSchema
>;

export const karavanConnectionSnapshotSchema = z
  .object({
    version: z.literal(2),
    revision: z.number().int().nonnegative(),
    blocked: z.boolean(),
    operation: z
      .discriminatedUnion('kind', [
        z
          .object({ kind: z.literal('setup'), operation: karavanMarketplaceOperationSchema })
          .strict(),
        z
          .object({
            kind: z.literal('binding'),
            operation: karavanConnectionBindingOperationSchema,
          })
          .strict(),
      ])
      .nullable(),
  })
  .strict();
export type KaravanConnectionSnapshot = z.infer<typeof karavanConnectionSnapshotSchema>;

// FLAG: This service-only receipt lookup never authorizes execution. not_found
// cannot prove that an earlier HTTP request was not dispatched or is no longer running.
export const karavanCommandStatusRequestSchema = z
  .object({
    actorMaxUserId: karavanMarketplaceActorIdSchema,
    chatId: karavanMarketplaceChatIdSchema,
    commandId: karavanMarketplaceCommandIdSchema,
    action: z.enum([
      'create_marketplace',
      'bind_chat',
      'unbind_chat',
      'transfer_chat',
      'recover_chat',
      'manage_shop',
    ]),
    managementRequest: marketplaceManagementRequestSchema.optional(),
    marketplaceId: karavanMarketplaceIdSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === 'manage_shop') {
      const request = value.managementRequest;
      if (
        !request ||
        request.chatId !== value.chatId ||
        request.commandId !== value.commandId ||
        request.marketplaceId !== value.marketplaceId
      )
        ctx.addIssue({
          code: 'custom',
          path: ['managementRequest'],
          message: 'Неверная область изменения магазина.',
        });
    } else if (value.managementRequest !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['managementRequest'],
        message: 'Неверный тип команды.',
      });
    }
    if ((value.action === 'create_marketplace') !== (value.marketplaceId === null))
      ctx.addIssue({
        code: 'custom',
        path: ['marketplaceId'],
        message: 'Неверная область команды.',
      });
  });
export type KaravanCommandStatusRequest = z.infer<typeof karavanCommandStatusRequestSchema>;
export const karavanCommandStatusResponseSchema = z.discriminatedUnion('status', [
  z
    .object({ status: z.literal('not_found'), commandId: karavanMarketplaceCommandIdSchema })
    .strict(),
  z
    .object({
      status: z.literal('found'),
      commandId: karavanMarketplaceCommandIdSchema,
      requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
      managementRequestHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .optional(),
      response: z.union([
        karavanMarketplaceBindingResultSchema.strict(),
        marketplaceManagementResponseSchema,
        z
          .object({
            operation: z.literal('administration_store_change'),
            confirmed: z.literal(true),
            selectedStoreId: z.string().uuid().optional(),
          })
          .strict(),
        z.object({ marketplace: karavanMarketplaceSummarySchema }).strict(),
      ]),
    })
    .strict(),
]);
