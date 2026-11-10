import { describe, expect, it } from 'vitest';
import {
  COMMERCIAL_ADS_EXCEPTIONS_MAX,
  commercialAdsExceptionSchema,
  commercialAdsPolicySchema,
  commercialAdsPreviewResponseSchema,
  createDefaultCommercialAdsPolicy,
  resolveCommercialAdsPolicy,
  type CommercialAdsException,
} from '../src/commercial-policy.js';
import { commercialAdsPreviewRequestSchema } from '../src/commercial-preview.js';
import { chatSettingsSchema } from '../src/core.js';

const nowMs = Date.parse('2026-11-04T12:00:00.000Z');
const firstId = 'a1a4c09b-d61d-4e7d-b01d-30f389e2bf18';
const secondId = 'd59a845a-c64c-4891-8eb8-56e301cc34a6';
const exception = (changes: Partial<CommercialAdsException> = {}): CommercialAdsException => ({
  id: firstId,
  userId: '123456789',
  userName: 'Анна',
  categories: ['SERVICES'],
  expiresAt: '2026-11-05T12:00:00.000Z',
  ...changes,
});

describe('commercial policy contract', () => {
  it('preserves the historical settings policy until explicitly configured', () => {
    expect(chatSettingsSchema.parse({}).commercialAdsPolicy).toBeNull();
    expect(chatSettingsSchema.parse({ commercialAdsPolicy: null }).commercialAdsPolicy).toBeNull();
    const policy = createDefaultCommercialAdsPolicy();
    expect(chatSettingsSchema.parse({ commercialAdsPolicy: policy }).commercialAdsPolicy).toEqual(
      policy,
    );
  });

  it('creates separate default drafts with private sales allowed', () => {
    const first = createDefaultCommercialAdsPolicy();
    const second = createDefaultCommercialAdsPolicy();
    first.categories.SERVICES = 'ALLOW';
    first.exceptions.push(exception());
    expect(second).toEqual({
      version: 1,
      categories: {
        PERSONAL_SALE: 'ALLOW',
        SERVICES: 'BLOCK',
        BUSINESS: 'BLOCK',
        COMMUNITIES: 'BLOCK',
      },
      exceptions: [],
    });
  });

  it('requires all explicit rules and rejects unknown policy versions and fields', () => {
    const policy = createDefaultCommercialAdsPolicy();
    for (const candidate of [
      {},
      { ...policy, version: 2 },
      { ...policy, categories: { SERVICES: 'BLOCK' } },
      { ...policy, categories: { ...policy.categories, OTHER: 'ALLOW' } },
      { ...policy, deleteWithoutProof: true },
      { ...policy, exceptions: undefined },
    ])
      expect(commercialAdsPolicySchema.safeParse(candidate).success).toBe(false);
  });

  it('validates canonical actor ids, explicit category scopes and expiration dates', () => {
    expect(commercialAdsExceptionSchema.parse(exception({ userName: ' Анна ' })).userName).toBe(
      'Анна',
    );
    expect(
      commercialAdsExceptionSchema.safeParse(exception({ expiresAt: '2026-11-05T15:00:00+03:00' }))
        .success,
    ).toBe(true);
    for (const candidate of [
      exception({ userId: '0' }),
      exception({ userId: '-1' }),
      exception({ userId: '0123' }),
      exception({ userId: '123 OR 1=1' }),
      exception({ userId: '1'.repeat(21) }),
      exception({ userName: '   ' }),
      exception({ userName: 'а'.repeat(129) }),
      exception({ categories: [] }),
      exception({ categories: ['SERVICES', 'SERVICES'] }),
      exception({ expiresAt: '2026-02-31T00:00:00Z' }),
      exception({ expiresAt: 'tomorrow' }),
      { ...exception(), appliesToAllFilters: true },
    ])
      expect(commercialAdsExceptionSchema.safeParse(candidate).success).toBe(false);
  });

  it('bounds exceptions and refuses duplicate identities while permitting separately expiring grants', () => {
    const policy = createDefaultCommercialAdsPolicy();
    expect(
      commercialAdsPolicySchema.safeParse({
        ...policy,
        exceptions: [exception(), exception({ categories: ['BUSINESS'] })],
      }).success,
    ).toBe(false);
    expect(
      commercialAdsPolicySchema.safeParse({
        ...policy,
        exceptions: [exception(), exception({ id: secondId, categories: ['BUSINESS'] })],
      }).success,
    ).toBe(true);
    expect(
      commercialAdsPolicySchema.safeParse({
        ...policy,
        exceptions: Array.from({ length: COMMERCIAL_ADS_EXCEPTIONS_MAX + 1 }, (_, index) =>
          exception({ id: `a1a4c09b-d61d-4e7d-b01d-${String(index).padStart(12, '0')}` }),
        ),
      }).success,
    ).toBe(false);
  });
});

describe('commercial category policy resolution', () => {
  it.each([null, undefined])('retains legacy authority for unconfigured policy %s', (policy) => {
    expect(resolveCommercialAdsPolicy({ policy, categories: [], nowMs })).toMatchObject({
      decision: 'LEGACY',
      reason: 'LEGACY_POLICY',
    });
  });

  it('keeps invalid persisted policies and unknown classifications uncertain', () => {
    expect(
      resolveCommercialAdsPolicy({ policy: {}, categories: ['SERVICES'], nowMs }),
    ).toMatchObject({ decision: 'UNSURE', reason: 'INVALID_POLICY' });
    for (const categories of [[], ['UNKNOWN'], ['SERVICES', 'UNKNOWN']])
      expect(
        resolveCommercialAdsPolicy({
          policy: createDefaultCommercialAdsPolicy(),
          categories,
          nowMs,
        }),
      ).toMatchObject({ decision: 'UNSURE', reason: 'INSUFFICIENT_CONTEXT' });
    expect(
      resolveCommercialAdsPolicy({
        policy: createDefaultCommercialAdsPolicy(),
        categories: ['SERVICES'],
        nowMs: Number.NaN,
      }),
    ).toMatchObject({ decision: 'UNSURE', reason: 'INSUFFICIENT_CONTEXT' });
  });

  it('allows private sales by default and requires an explicit rule to block them', () => {
    const policy = createDefaultCommercialAdsPolicy();
    expect(resolveCommercialAdsPolicy({ policy, categories: ['PERSONAL_SALE'], nowMs })).toEqual({
      decision: 'KEEP',
      reason: 'CATEGORY_ALLOWED',
      categories: ['PERSONAL_SALE'],
      blockedCategories: [],
      matchedExceptionIds: [],
    });
    policy.categories.PERSONAL_SALE = 'BLOCK';
    expect(
      resolveCommercialAdsPolicy({ policy, categories: ['PERSONAL_SALE'], nowMs }),
    ).toMatchObject({
      decision: 'BLOCK',
      blockedCategories: ['PERSONAL_SALE'],
    });
  });

  it('keeps every unexempted blocked category when another category is allowed', () => {
    const policy = createDefaultCommercialAdsPolicy();
    policy.categories.SERVICES = 'ALLOW';
    expect(
      resolveCommercialAdsPolicy({
        policy,
        categories: ['BUSINESS', 'SERVICES', 'PERSONAL_SALE', 'BUSINESS'],
        nowMs,
      }),
    ).toEqual({
      decision: 'BLOCK',
      reason: 'BLOCKED_CATEGORY',
      categories: ['PERSONAL_SALE', 'SERVICES', 'BUSINESS'],
      blockedCategories: ['BUSINESS'],
      matchedExceptionIds: [],
    });
  });

  it('applies exceptions only to their exact actor and category', () => {
    const policy = { ...createDefaultCommercialAdsPolicy(), exceptions: [exception()] };
    expect(
      resolveCommercialAdsPolicy({ policy, categories: ['SERVICES'], userId: '123456789', nowMs }),
    ).toMatchObject({
      decision: 'KEEP',
      reason: 'PARTICIPANT_EXCEPTION',
      matchedExceptionIds: [firstId],
    });
    for (const userId of [undefined, null, '987654321'])
      expect(
        resolveCommercialAdsPolicy({ policy, categories: ['SERVICES'], userId, nowMs }).decision,
      ).toBe('BLOCK');
    expect(
      resolveCommercialAdsPolicy({
        policy,
        categories: ['SERVICES', 'BUSINESS'],
        userId: '123456789',
        nowMs,
      }),
    ).toMatchObject({ decision: 'BLOCK', blockedCategories: ['BUSINESS'] });
  });

  it('expires a grant at its exact deadline without extending another grant', () => {
    const policy = {
      ...createDefaultCommercialAdsPolicy(),
      exceptions: [
        exception({ expiresAt: new Date(nowMs).toISOString() }),
        exception({ id: secondId, categories: ['BUSINESS'], expiresAt: null }),
      ],
    };
    expect(
      resolveCommercialAdsPolicy({
        policy,
        categories: ['SERVICES', 'BUSINESS'],
        userId: '123456789',
        nowMs: nowMs - 1,
      }),
    ).toMatchObject({ decision: 'KEEP', matchedExceptionIds: [firstId, secondId] });
    expect(
      resolveCommercialAdsPolicy({
        policy,
        categories: ['SERVICES', 'BUSINESS'],
        userId: '123456789',
        nowMs,
      }),
    ).toMatchObject({
      decision: 'BLOCK',
      blockedCategories: ['SERVICES'],
      matchedExceptionIds: [secondId],
    });
  });

  it('unions separately scoped active grants for the same actor without changing input', () => {
    const policy = {
      ...createDefaultCommercialAdsPolicy(),
      exceptions: [exception(), exception({ id: secondId, categories: ['BUSINESS'] })],
    };
    const before = JSON.stringify(policy);
    expect(
      resolveCommercialAdsPolicy({
        policy,
        categories: ['SERVICES', 'BUSINESS'],
        userId: '123456789',
        nowMs,
      }),
    ).toMatchObject({ decision: 'KEEP', matchedExceptionIds: [firstId, secondId] });
    expect(JSON.stringify(policy)).toBe(before);
  });
});

describe('commercial policy preview boundary', () => {
  it('validates a complete optional draft profile and preserves a one point threshold gap', () => {
    const request = { text: 'Сообщение', policy: null, enabled: true };
    for (const [warn, deletion] of [
      [10, 20],
      [60, 61],
      [90, 100],
    ]) {
      const classification = {
        commercialAdsSensitivity: 'STRICT',
        commercialAdsWarnThreshold: warn,
        commercialAdsDeleteThreshold: deletion,
      };
      expect(
        commercialAdsPreviewRequestSchema.parse({ ...request, classification }).classification,
      ).toEqual(classification);
    }
    for (const classification of [
      { commercialAdsSensitivity: 'STRICT', commercialAdsWarnThreshold: 45 },
      {
        commercialAdsSensitivity: 'UNKNOWN',
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 65,
      },
      {
        commercialAdsSensitivity: 'STRICT',
        commercialAdsWarnThreshold: 45.5,
        commercialAdsDeleteThreshold: 65,
      },
      {
        commercialAdsSensitivity: 'STRICT',
        commercialAdsWarnThreshold: 9,
        commercialAdsDeleteThreshold: 65,
      },
      {
        commercialAdsSensitivity: 'STRICT',
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 45,
      },
      {
        commercialAdsSensitivity: 'STRICT',
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 101,
      },
    ])
      expect(
        commercialAdsPreviewRequestSchema.safeParse({ ...request, classification }).success,
      ).toBe(false);
  });
  it('requires a bounded draft, explicit module state and valid optional author', () => {
    const request = { text: 'Проверяемый текст', enabled: true, policy: null };
    expect(commercialAdsPreviewRequestSchema.parse(request)).toEqual(request);
    expect(commercialAdsPreviewRequestSchema.parse({ ...request, userId: null }).userId).toBeNull();
    expect(
      commercialAdsPreviewRequestSchema.parse({ ...request, userId: '123456789' }).userId,
    ).toBe('123456789');
    for (const candidate of [
      { ...request, text: '' },
      { ...request, text: ' \n\t ' },
      { ...request, text: 'а'.repeat(2501) },
      { ...request, enabled: undefined },
      { ...request, policy: undefined },
      { ...request, userId: '-123' },
      { ...request, publish: true },
    ])
      expect(commercialAdsPreviewRequestSchema.safeParse(candidate).success).toBe(false);
  });

  it('preserves unavailable and uncertain outcomes as distinct from allowed messages', () => {
    for (const candidate of [
      { decision: 'UNAVAILABLE', categories: [], reason: 'CLASSIFIER_UNAVAILABLE' },
      { decision: 'UNSURE', categories: [], reason: 'INSUFFICIENT_CONTEXT' },
      {
        decision: 'KEEP',
        categories: ['SERVICES'],
        reason: 'PARTICIPANT_EXCEPTION',
        matchedExceptionId: firstId,
      },
      { decision: 'DELETE', categories: ['SERVICES'], reason: 'BLOCKED_CATEGORY' },
    ])
      expect(commercialAdsPreviewResponseSchema.parse(candidate)).toEqual(candidate);
    expect(
      commercialAdsPreviewResponseSchema.safeParse({
        decision: 'ALLOW',
        categories: [],
        reason: 'NOT_ADVERTISING',
      }).success,
    ).toBe(false);
    expect(
      commercialAdsPreviewResponseSchema.safeParse({
        decision: 'KEEP',
        categories: ['UNKNOWN'],
        reason: 'CATEGORY_ALLOWED',
      }).success,
    ).toBe(false);
  });
});
