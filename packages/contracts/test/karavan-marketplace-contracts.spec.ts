import { describe, expect, it } from 'vitest';
import {
  canonicalKaravanMarketplaceJson,
  karavanMarketplaceActorAccessRequestSchema,
  karavanMarketplaceActorAccessResponseSchema,
  karavanMarketplaceAuthorityRequestSchema,
  karavanMarketplaceCreateSchema,
  karavanMarketplaceHandoffIssueSchema,
  karavanMarketplaceSetupSchema,
  karavanPublicationPreviewSchema,
} from '../src/karavan-marketplace.js';
import {
  marketplaceManagementRequestSchema,
  marketplaceManagementResponseSchema,
} from '../src/karavan-marketplace-management.js';

describe('Karavan command boundary', () => {
  it('keeps own-placement handoff scoped to a marketplace without browser-supplied store authority', () => {
    const input = {
      commandId: 'bc5f73aa-2e17-49a4-9ccd-8dc656150ff3',
      marketplaceId: '001b341a-d73f-4f87-827a-5d48dcce1260',
      destination: 'placement',
    };
    expect(karavanMarketplaceHandoffIssueSchema.parse(input)).toEqual(input);
    expect(karavanMarketplaceHandoffIssueSchema.safeParse({ ...input, storeId: input.marketplaceId }).success).toBe(false);
    expect(karavanMarketplaceHandoffIssueSchema.safeParse({ ...input, returnUrl: 'https://example.test' }).success).toBe(false);
  });
  const scope = {
    proofId: 'x'.repeat(43),
    actorMaxUserId: '123',
    chatId: '-9007199254740993',
    commandId: 'operation:create',
    action: 'create_marketplace',
    marketplaceId: null,
    expectedBindingGeneration: null,
    payloadHash: 'a'.repeat(64),
  };
  it('retains exact large chat IDs and rejects fabricated privilege fields', () => {
    expect(karavanMarketplaceAuthorityRequestSchema.parse(scope).chatId).toBe('-9007199254740993');
    expect(
      karavanMarketplaceAuthorityRequestSchema.safeParse({ ...scope, isAdmin: true }).success,
    ).toBe(false);
    expect(
      karavanMarketplaceAuthorityRequestSchema.safeParse({
        ...scope,
        chatId: Number('-9007199254740993'),
      }).success,
    ).toBe(false);
    expect(
      karavanMarketplaceAuthorityRequestSchema.safeParse({ ...scope, action: 'bind_chat' }).success,
    ).toBe(false);
  });
  it('hash input is recursive canonical JSON; undefined and custom prototypes cannot disappear', () => {
    expect(canonicalKaravanMarketplaceJson({ b: [{ z: 1, a: false }], a: null })).toBe(
      '{"a":null,"b":[{"a":false,"z":1}]}',
    );
    for (const input of [{ a: undefined }, { a: NaN }, new Date()])
      expect(() => canonicalKaravanMarketplaceJson(input)).toThrow();
  });
  it('applies the same create defaults before signing and prevents duplicate chat selections', () => {
    const create = {
      name: '  Магазин  ',
      rules: { text: 'Правила', allowedCategoryIds: ['services'], allowedSubcategoryIds: [] },
    };
    expect(
      karavanMarketplaceCreateSchema.parse({ ...create, commandId: 'operation:create' }),
    ).toMatchObject({
      name: 'Магазин',
      networkId: null,
      description: null,
      admissionPolicy: 'applications',
      rules: { categoryOrder: [] },
    });
    expect(
      karavanMarketplaceSetupSchema.safeParse({
        operationId: 'f07ca391-24bb-4f3b-b64e-e49ed0fdbed6',
        chatIds: ['-1', '-1'],
        create,
      }).success,
    ).toBe(false);
  });

  it('keeps pre-format create hashes unchanged and signs an explicitly selected fixed storefront', () => {
    const input = {
      commandId: 'operation:create',
      name: 'Соседи',
      rules: { text: 'Правила', allowedCategoryIds: ['services'], allowedSubcategoryIds: [] },
    };
    const previous = karavanMarketplaceCreateSchema.parse(input);
    expect(previous).not.toHaveProperty('format');
    expect(previous).not.toHaveProperty('administrationStoreId');
    expect(previous).not.toHaveProperty('setupVersion');
    const next = karavanMarketplaceCreateSchema.parse({
      ...input,
      format: 'storefront',
      administrationStoreId: 'f07ca391-24bb-4f3b-b64e-e49ed0fdbed6',
    });
    expect(next.format).toBe('storefront');
    expect(canonicalKaravanMarketplaceJson(next)).not.toBe(
      canonicalKaravanMarketplaceJson(previous),
    );
    expect(
      karavanMarketplaceCreateSchema.safeParse({ ...input, format: 'admins_only' }).success,
    ).toBe(false);
    expect(karavanPublicationPreviewSchema.parse({ mode: 'administration_storefront' })).toEqual({
      mode: 'administration_storefront',
    });
  });

  it('binds format changes to the reviewed fingerprint and original command identity', () => {
    const commandId = 'operation:format';
    const input = {
      commandId,
      chatId: '-123',
      marketplaceId: 'f07ca391-24bb-4f3b-b64e-e49ed0fdbed6',
      expectedBindingGeneration: 2,
      command: {
        operation: 'format_update',
        input: {
          commandId,
          expectedRevision: 3,
          format: 'storefront',
          fingerprint: 'a'.repeat(64),
        },
      },
    };
    expect(marketplaceManagementRequestSchema.parse(input).command.operation).toBe('format_update');
    expect(
      marketplaceManagementRequestSchema.safeParse({ ...input, commandId: 'operation:another' })
        .success,
    ).toBe(false);
    const withoutReview = structuredClone(input);
    Reflect.deleteProperty(withoutReview.command.input, 'fingerprint');
    expect(marketplaceManagementRequestSchema.safeParse(withoutReview).success).toBe(false);
    expect(
      marketplaceManagementResponseSchema.safeParse({
        operation: 'format_preview',
        data: {
          fingerprint: 'a'.repeat(64),
          expectedRevision: 3,
          format: 'storefront',
          administrationStoreId: null,
          affectedStores: 1,
          affectedChats: 2,
          pendingApplications: 0,
        },
      }).success,
    ).toBe(true);
  });

  it('accepts explicit buyer destinations without allowing a caller-supplied return URL', () => {
    const input = {
      commandId: 'operation:preview',
      marketplaceId: 'f07ca391-24bb-4f3b-b64e-e49ed0fdbed6',
    };
    for (const destination of ['view', 'preview', 'storefront']) {
      expect(
        karavanMarketplaceHandoffIssueSchema.parse({ ...input, destination }).destination,
      ).toBe(destination);
      expect(
        karavanMarketplaceHandoffIssueSchema.safeParse({
          ...input,
          destination,
          returnUrl: 'https://max.ru/other_bot',
        }).success,
      ).toBe(false);
    }
  });

  it('signs the new admission modes only when explicitly requested', () => {
    const input = {
      commandId: 'operation:create',
      name: 'Соседи',
      rules: { text: 'Правила', allowedCategoryIds: ['services'], allowedSubcategoryIds: [] },
    };
    for (const admissionPolicy of ['open', 'applications', 'selected', 'invitation']) {
      const parsed = karavanMarketplaceCreateSchema.parse({
        ...input,
        admissionPolicy,
        setupVersion: 2,
      });
      expect(parsed.admissionPolicy).toBe(admissionPolicy);
      expect(parsed.setupVersion).toBe(2);
    }
    expect(karavanMarketplaceCreateSchema.safeParse({ ...input, setupVersion: 1 }).success).toBe(
      false,
    );
  });

  it('bounds administration changes and personal grants to exact command and binding revisions', () => {
    const commandId = 'operation:change';
    const envelope = {
      commandId,
      chatId: '-9007199254740993',
      marketplaceId: 'f07ca391-24bb-4f3b-b64e-e49ed0fdbed6',
      expectedBindingGeneration: 3,
    };
    const expectedChatBinding = {
      id: envelope.marketplaceId,
      chatId: envelope.chatId,
      botId: 'major_bot',
      generation: 3,
    };
    const command = {
      operation: 'administration_store_change',
      input: { commandId, expectedRevision: 2, expectedChatBinding, action: 'create' },
    };
    expect(marketplaceManagementRequestSchema.parse({ ...envelope, command }).command).toEqual(
      command,
    );
    for (const input of [
      { ...command.input, expectedChatBinding: undefined },
      { ...command.input, isAdmin: true },
      { ...command.input, storeId: envelope.marketplaceId },
      { ...command.input, commandId: 'operation:other' },
    ]) {
      expect(
        marketplaceManagementRequestSchema.safeParse({
          ...envelope,
          command: { ...command, input },
        }).success,
      ).toBe(false);
    }
    const grant = {
      operation: 'seller_grant_create',
      input: {
        commandId,
        expectedPolicyRevision: 4,
        targetMaxUserId: '9007199254740993',
        storeId: null,
        expiresAt: '2026-12-01T00:00:00.000Z',
      },
    };
    expect(
      marketplaceManagementRequestSchema.parse({ ...envelope, command: grant }).command,
    ).toEqual(grant);
    expect(
      marketplaceManagementRequestSchema.safeParse({
        ...envelope,
        command: {
          ...grant,
          input: { ...grant.input, targetMaxUserId: Number('9007199254740993') },
        },
      }).success,
    ).toBe(false);
  });
});

describe('Karavan current chat administrator access boundary', () => {
  const request = {
    actorMaxUserId: '9007199254740993',
    chatId: '-9007199254740993',
    botId: 'major_bot',
    authorityEpoch: 'a'.repeat(64),
    verifiedAt: '2026-01-01T00:00:00.000Z',
    bindingGeneration: 7,
  };
  const response = {
    ...request,
    allowed: true,
    reason: 'admin',
    checkedAt: '2026-01-01T01:00:00.000Z',
    expiresAt: '2026-01-01T01:00:15.000Z',
  };

  it('keeps exact actor/chat IDs and every original binding field', () => {
    expect(karavanMarketplaceActorAccessRequestSchema.parse(request)).toEqual(request);
    expect(karavanMarketplaceActorAccessResponseSchema.parse(response)).toEqual(response);
    for (const field of Object.keys(request)) {
      const incomplete = { ...request } as Record<string, unknown>;
      delete incomplete[field];
      expect(karavanMarketplaceActorAccessRequestSchema.safeParse(incomplete).success).toBe(false);
    }
    for (const invalid of [
      { isAdmin: true },
      { role: 'owner' },
      { chatId: Number(request.chatId) },
      { actorMaxUserId: Number(request.actorMaxUserId) },
      { bindingGeneration: 0 },
      { bindingGeneration: 1.5 },
      { authorityEpoch: 'other' },
    ])
      expect(
        karavanMarketplaceActorAccessRequestSchema.safeParse({ ...request, ...invalid }).success,
      ).toBe(false);
  });

  it('rejects contradictory decisions, added privileges and extended validity', () => {
    for (const invalid of [
      { allowed: false },
      { reason: 'not_admin' },
      { role: 'owner' },
      { expiresAt: response.checkedAt },
      { expiresAt: '2026-01-01T01:00:15.001Z' },
    ])
      expect(
        karavanMarketplaceActorAccessResponseSchema.safeParse({ ...response, ...invalid }).success,
      ).toBe(false);
    expect(
      karavanMarketplaceActorAccessResponseSchema.parse({
        ...response,
        allowed: false,
        reason: 'not_admin',
      }).allowed,
    ).toBe(false);
  });
});
