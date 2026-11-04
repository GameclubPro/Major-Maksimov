import { describe, expect, it } from 'vitest';
import { karavanMarketplaceSetupSchema } from '../src/karavan-marketplace.js';
import {
  karavanCommandStatusRequestSchema,
  karavanConnectionSnapshotSchema,
  karavanConnectionBindingOperationSchema,
} from '../src/karavan-marketplace-connection.js';

const id = 'a0d9b7ce-0040-4c85-a7ec-e3cf6da94c10';
describe('server-owned connection recovery', () => {
  it('keeps legacy setup identity unchanged without adding a revision default', () => {
    const input = {
      operationId: id,
      chatIds: ['-123'],
      existingMarketplaceId: id,
      expectedPolicyRevision: 1,
    };
    expect(karavanMarketplaceSetupSchema.parse(input)).toEqual(input);
    expect(
      karavanMarketplaceSetupSchema.parse({ ...input, expectedConnectionRevision: 0 }),
    ).toHaveProperty('expectedConnectionRevision', 0);
  });
  it('represents a conflict without disclosing another administrator operation', () => {
    expect(
      karavanConnectionSnapshotSchema.parse({
        version: 2,
        revision: 2,
        blocked: true,
        operation: null,
      }),
    ).toEqual({ version: 2, revision: 2, blocked: true, operation: null });
  });
  it('keeps supersession separate from a confirmed binding result', () => {
    expect(
      karavanConnectionBindingOperationSchema.parse({
        operationId: id,
        state: 'superseded',
        errorCode: 'KARAVAN_CONNECTION_SUPERSEDED',
        result: null,
        request: {
          commandId: id,
          marketplaceId: id,
          expectedBindingGeneration: 1,
          action: 'recover_chat',
        },
      }),
    ).toHaveProperty('state', 'superseded');
  });
  it('rejects an invented receipt scope or actor override field', () => {
    const input = {
      actorMaxUserId: '777',
      chatId: '-123',
      commandId: id,
      action: 'create_marketplace',
      marketplaceId: null,
    };
    expect(karavanCommandStatusRequestSchema.safeParse(input).success).toBe(true);
    expect(
      karavanCommandStatusRequestSchema.safeParse({ ...input, scope: 'operator' }).success,
    ).toBe(false);
    expect(
      karavanCommandStatusRequestSchema.safeParse({ ...input, marketplaceId: id }).success,
    ).toBe(false);
    expect(
      karavanCommandStatusRequestSchema.safeParse({ ...input, action: 'recover_chat' }).success,
    ).toBe(false);
  });
});
