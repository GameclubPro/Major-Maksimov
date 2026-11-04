import { randomUUID } from 'node:crypto';
import {
  createDefaultCommercialAdsPolicy,
  type CommercialAdsPolicy,
} from '@maxim/contracts/settings';
import {
  buildCommercialLlmOffer,
  commercialLlmMayDelete,
  commercialLlmPolicyMayDeletePersonalSale,
  type CommercialLlmPoolPolicy,
} from './commercial-llm-enforcement.protocol';
import { CommercialAdDetector, type CommercialDetection } from './commercial-ad.detector';
import { COMMERCIAL_LLM_POOL_PROFILES } from './commercial-llm-pool.protocol';
import {
  COMMERCIAL_LLM_POLICY_VERSION,
  type CommercialLlmObservationResult,
} from './commercial-llm.protocol';
import {
  detectCommercialAdsCategories,
  evaluateCommercialAdsAiPolicy,
} from './commercial-ads-runtime-policy.service';

const text = 'Мастерская принимает заказы на ремонт мебели. Работаем по договору.';
const positive: CommercialLlmObservationResult = {
  ...COMMERCIAL_LLM_POOL_PROFILES['pc-b-9b'].identity,
  classification: 'COMMERCIAL',
  reasonCodes: ['SERVICE_OFFER'],
  policyVersion: COMMERCIAL_LLM_POLICY_VERSION,
  durationMs: 1,
  pool: {
    version: 'commercial-pool-v2',
    nodeId: 'pc-b-9b',
    route: 'direct',
    policy: 'confirm-positive',
    attempts: 1,
  },
};
function fixture(
  policy: CommercialAdsPolicy | null = createDefaultCommercialAdsPolicy(),
  messageText = text,
  poolPolicy: CommercialLlmPoolPolicy = 'confirm-positive',
) {
  const settings = {
    commercialAdsFilterEnabled: true,
    commercialAdsPolicy: policy,
    commercialAdsSensitivity: 'BALANCED' as const,
    commercialAdsWarnThreshold: 45,
    commercialAdsDeleteThreshold: 65,
    nightModeTimezone: 'Europe/Moscow',
    textFiltersWarnEnabled: true,
    textFiltersMuteEnabled: true,
    textFiltersBanEnabled: true,
    textFiltersMuteDurationHours: 1,
    textFiltersBotMessageEnabled: true,
  };
  const now = Date.now();
  const offer = buildCommercialLlmOffer(
    {
      chatId: 'chat',
      messageId: 'message',
      userId: '10000007',
      originBotId: 'bot',
      text: messageText,
      eventAt: new Date(now).toISOString(),
      settings,
      origin: {
        sourceWebhookEventId: randomUUID(),
        sourceReceivingBotId: 'bot',
        sourceExecutionBotId: 'bot',
        sourceEventAtMs: now,
        sourceEvidenceVersion: 1,
      },
    },
    now,
    poolPolicy,
  )!;
  return { settings, source: offer.source, text: messageText, result: positive };
}

describe('category policy on the actual commercial detector and pinned AI response', () => {
  afterEach(() => jest.restoreAllMocks());
  it('distinguishes explicit policy source identity and keeps null-policy legacy authority', () => {
    const legacy = fixture(null);
    expect(legacy.source.version).toBe(2);
    expect(evaluateCommercialAdsAiPolicy(legacy).mayDelete).toBe(true);
    const explicit = fixture();
    expect(explicit.source.version).toBe(3);
    expect(explicit.source.classifierSha256).not.toBe(legacy.source.classifierSha256);
    expect(evaluateCommercialAdsAiPolicy(explicit)).toMatchObject({
      mayDelete: true,
      categories: ['SERVICES'],
    });
  });

  it('allows a real services offer according to the chat rule and preserves its recognized category', () => {
    const policy = createDefaultCommercialAdsPolicy();
    policy.categories.SERVICES = 'ALLOW';
    expect(evaluateCommercialAdsAiPolicy(fixture(policy))).toMatchObject({
      mayDelete: false,
      decision: 'KEEP',
      categories: ['SERVICES'],
    });
  });

  it('recognizes category signals below detector effect thresholds only with a commercial AI response', () => {
    const input = fixture();
    expect(detectCommercialAdsCategories(input.text, input.settings)).toEqual([]);
    expect(detectCommercialAdsCategories(input.text, input.settings, positive)).toEqual([
      'SERVICES',
    ]);
    expect(
      evaluateCommercialAdsAiPolicy({
        ...input,
        result: { ...positive, modelSha256: 'a'.repeat(64) },
      }),
    ).toMatchObject({ mayDelete: false, categories: ['SERVICES'] });
  });

  it('normalizes mixed-script and invisible characters before inspecting category evidence', () => {
    expect(
      evaluateCommercialAdsAiPolicy(
        fixture(
          undefined,
          'МАСТЕРСКАЯ принимает заказы на рeмoнт ме\u200bбели. Работаем по договору.',
        ),
      ),
    ).toMatchObject({ mayDelete: true, categories: ['SERVICES'] });
  });

  it.each([
    'Ищу мастера на ремонт мебели, посоветуйте специалиста.',
    'Пример рекламы для модераторов: «Мастерская принимает заказы на ремонт мебели».',
  ])('preserves protected contexts even with a coarse commercial AI label: %s', (messageText) => {
    expect(evaluateCommercialAdsAiPolicy(fixture(undefined, messageText))).toMatchObject({
      mayDelete: false,
      decision: 'UNSURE',
      categories: [],
    });
  });

  it('uses semantic categories for an offer without lexical service signals', () => {
    const input = fixture(undefined, 'За 1800 подготовлю персональную колыбельную вашему малышу.');
    expect(detectCommercialAdsCategories(input.text, input.settings)).toEqual([]);
    expect(evaluateCommercialAdsAiPolicy(input)).toMatchObject({
      mayDelete: true,
      categories: ['SERVICES'],
    });
    expect(
      evaluateCommercialAdsAiPolicy({
        ...input,
        result: {
          ...positive,
          promptSha256: '67aee2db688b67368346a246448c885585d5abcc4ce2b7d3bcd3e77963059aec',
        },
      }).mayDelete,
    ).toBe(false);
  });

  it('does not widen a business offer with incidental service or contact language', () => {
    const policy = createDefaultCommercialAdsPolicy();
    policy.categories.BUSINESS = 'ALLOW';
    const input = fixture(
      policy,
      'Наш магазин продаёт краску. Поможем подобрать цвет, доставка включена.',
    );
    expect(
      evaluateCommercialAdsAiPolicy({
        ...input,
        result: { ...positive, reasonCodes: ['BUSINESS_OFFER'] },
      }),
    ).toMatchObject({ mayDelete: false, decision: 'KEEP', categories: ['BUSINESS'] });
  });

  it('requires all blocked semantic categories to be covered by participant grants', () => {
    const policy = createDefaultCommercialAdsPolicy();
    policy.categories.COMMUNITIES = 'ALLOW';
    const result: CommercialLlmObservationResult = {
      ...positive,
      reasonCodes: ['SERVICE_OFFER', 'BUSINESS_OFFER', 'COMMERCIAL_COMMUNITY'],
    };
    policy.exceptions.push({
      id: randomUUID(),
      userId: '10000007',
      userName: 'Участник',
      categories: ['SERVICES'],
      expiresAt: null,
    });
    const input = () => ({
      ...fixture(
        policy,
        'Продаём краску. Отдельно выполняем покраску. Вступайте в наш канал с каталогом.',
      ),
      result,
    });
    expect(evaluateCommercialAdsAiPolicy(input())).toMatchObject({
      mayDelete: true,
      categories: ['SERVICES', 'BUSINESS', 'COMMUNITIES'],
      blockedCategories: ['BUSINESS'],
    });
    policy.exceptions[0]!.categories.push('BUSINESS');
    expect(evaluateCommercialAdsAiPolicy(input())).toMatchObject({
      mayDelete: false,
      reason: 'PARTICIPANT_EXCEPTION',
    });
  });

  it('applies category-specific exceptions only until their exact expiry', () => {
    const policy = createDefaultCommercialAdsPolicy();
    policy.exceptions.push({
      id: randomUUID(),
      userId: '10000007',
      userName: 'Участник',
      categories: ['SERVICES'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const active = fixture(policy);
    expect(evaluateCommercialAdsAiPolicy(active)).toMatchObject({
      mayDelete: false,
      reason: 'PARTICIPANT_EXCEPTION',
    });
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(policy.exceptions[0]!.expiresAt!));
    expect(evaluateCommercialAdsAiPolicy(active)).toMatchObject({
      mayDelete: true,
      reason: 'BLOCKED_CATEGORY',
    });
    jest.restoreAllMocks();
  });

  it('keeps unknown categories and ordinary discussion without borrowing a generic commercial label', () => {
    const uncertain = fixture(undefined, 'Пишите мне, есть предложение.');
    expect(
      evaluateCommercialAdsAiPolicy({
        ...uncertain,
        result: { ...positive, reasonCodes: ['COMMERCIAL_OFFER'] },
      }),
    ).toMatchObject({
      mayDelete: false,
      decision: 'UNSURE',
    });
    expect(
      evaluateCommercialAdsAiPolicy({
        ...fixture(),
        result: { ...positive, classification: 'NOT_COMMERCIAL', reasonCodes: ['BUYER_REQUEST'] },
      }),
    ).toMatchObject({ mayDelete: false });
  });

  it('requires explicit personal-sale blocking and a separate completed 9B proof', () => {
    const policy = createDefaultCommercialAdsPolicy();
    policy.categories.PERSONAL_SALE = 'BLOCK';
    const input = fixture(policy, 'Продам свой старый велосипед после переезда, один, б/у.');
    const personal: CommercialLlmObservationResult = {
      ...positive,
      classification: 'NOT_COMMERCIAL',
      reasonCodes: ['PERSONAL_SALE'],
    };
    expect(commercialLlmMayDelete(personal, input.source)).toBe(false);
    expect(commercialLlmPolicyMayDeletePersonalSale(personal, input.source)).toBe(true);
    expect(evaluateCommercialAdsAiPolicy({ ...input, result: personal })).toMatchObject({
      mayDelete: true,
      categories: ['PERSONAL_SALE'],
    });
    expect(commercialLlmPolicyMayDeletePersonalSale(personal, fixture().source)).toBe(false);
    expect(
      commercialLlmPolicyMayDeletePersonalSale(
        { ...personal, modelSha256: 'a'.repeat(64) },
        input.source,
      ),
    ).toBe(false);
    const primary: CommercialLlmObservationResult = {
      ...personal,
      ...COMMERCIAL_LLM_POOL_PROFILES['pc-a-4b'].identity,
      pool: { ...personal.pool!, nodeId: 'pc-a-4b', policy: 'direct-4b' },
    };
    expect(commercialLlmPolicyMayDeletePersonalSale(primary, input.source)).toBe(false);
  });

  it('does not borrow a positive 4B proof for deterministic private-sale context', () => {
    const policy = createDefaultCommercialAdsPolicy();
    policy.categories.PERSONAL_SALE = 'BLOCK';
    const input = fixture(policy, 'Продам свой старый велосипед, б/у.', 'direct-4b');
    const result: CommercialLlmObservationResult = {
      ...positive,
      ...COMMERCIAL_LLM_POOL_PROFILES['pc-a-4b'].identity,
      pool: { ...positive.pool!, nodeId: 'pc-a-4b', policy: 'direct-4b' },
    };
    // Isolate the category/authority boundary, regardless of detector score thresholds.
    jest.spyOn(CommercialAdDetector.prototype, 'detect').mockReturnValue({
      rawText: input.text,
      confidenceScore: 45,
      decisionBand: 'MEDIUM',
      matchedSignals: [],
      negativeSignals: ['private:свой'],
      primarySubtype: 'GOODS',
      supportingSubtypes: [],
      evidenceStrength: 'BORDERLINE',
      reviewRecommended: true,
      reviewReasons: [],
      campaignContext: null,
      appliedThresholds: {
        warnThreshold: 45,
        deleteThreshold: 65,
        sensitivity: 'BALANCED',
        strictness: 0.5,
      },
      classifierVersion: null,
      commercialProbability: null,
      reviewProbability: null,
      classifierReasons: [],
      safeContextBucket: 'private_one_off_sale',
    } satisfies CommercialDetection);
    expect(commercialLlmMayDelete(result, input.source)).toBe(true);
    expect(evaluateCommercialAdsAiPolicy({ ...input, result })).toMatchObject({
      mayDelete: false,
      categories: ['PERSONAL_SALE'],
    });
  });
});
