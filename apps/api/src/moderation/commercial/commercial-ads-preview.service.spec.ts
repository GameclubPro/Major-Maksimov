import {
  CommercialTextRuntimePolicyService,
  COMMERCIAL_TEXT_BASELINE_POLICY_COHORTS,
  fingerprintCommercialTextSettingsProfile,
} from './commercial-text-runtime-policy.service';
import { ConfigService } from '@nestjs/config';
import { createDefaultCommercialAdsPolicy } from '@maxim/contracts/settings';
import { CommercialAdsPreviewService } from './commercial-ads-preview.service';
import * as shadowLease from './commercial-llm-shadow.lease';
import { CommercialLlmPreviewMailbox } from './commercial-llm-preview.mailbox';
import { COMMERCIAL_LLM_POOL_PROFILES } from './commercial-llm-pool.protocol';
import {
  COMMERCIAL_LLM_POLICY_VERSION,
  type CommercialLlmObservationResult,
} from './commercial-llm.protocol';

const settings = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'BALANCED' as const,
  commercialAdsWarnThreshold: 45,
  commercialAdsDeleteThreshold: 65,
  nightModeTimezone: 'Europe/Moscow',
  textFiltersWarnEnabled: false,
  textFiltersMuteEnabled: false,
  textFiltersBanEnabled: false,
  textFiltersMuteDurationHours: 1,
  textFiltersBotMessageEnabled: false,
};
const text =
  'Ремонтируем стиральные машины. Выезд ежедневно, гарантия. Принимаем заказы, запись по телефону +7 900 000 10 42.';
function fixture(ai = false) {
  const authority = jest
    .fn<
      ReturnType<CommercialTextRuntimePolicyService['authority']>,
      Parameters<CommercialTextRuntimePolicyService['authority']>
    >()
    .mockResolvedValue({
      mode: 'baseline',
      revision: 0,
      baselineAllowed: true,
      promotedPolicyCohorts: COMMERCIAL_TEXT_BASELINE_POLICY_COHORTS,
    });
  const preview = new CommercialAdsPreviewService(
    new ConfigService({
      COMMERCIAL_LLM_ENFORCEMENT_ENABLED: ai,
      REDIS_URL: 'redis://127.0.0.1:1',
      COMMERCIAL_LLM_ENDPOINT: 'http://127.0.0.1:1',
    }),
    { authority },
  );
  const service = {
    preview: (
      input: Parameters<CommercialAdsPreviewService['preview']>[0],
      saved: Parameters<CommercialAdsPreviewService['preview']>[1],
    ) => preview.preview(input, saved, 'preview-chat'),
  };
  return { service, authority };
}
describe('commercial preview without moderation effects', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each(['off', 'unavailable'] as const)(
    'honors deterministic %s authority for the draft chat and profile',
    async (mode) => {
      const { service, authority } = fixture();
      authority.mockResolvedValue({
        mode,
        revision: 1,
        baselineAllowed: false,
        promotedPolicyCohorts: [],
      });
      const classification = {
        commercialAdsSensitivity: 'STRICT' as const,
        commercialAdsWarnThreshold: 38,
        commercialAdsDeleteThreshold: 55,
      };
      const result = await service.preview(
        { text, policy: null, enabled: true, classification },
        settings,
      );
      expect(result.decision).toBe(mode === 'off' ? 'KEEP' : 'UNAVAILABLE');
      expect(authority).toHaveBeenCalledWith(
        'preview-chat',
        fingerprintCommercialTextSettingsProfile(classification),
      );
    },
  );
  it('only previews cleanup of a current-order offer for chats with its promoted policy', async () => {
    const { service, authority } = fixture();
    const request = {
      text: 'Принимаю заказы на пряники. Пишите 8 900 000 10 42.',
      policy: null,
      enabled: true,
    };
    authority.mockResolvedValue({
      mode: 'canary',
      revision: 1,
      baselineAllowed: true,
      promotedPolicyCohorts: [],
    });
    await expect(service.preview(request, settings)).resolves.toMatchObject({ decision: 'KEEP' });
    authority.mockResolvedValue({
      mode: 'canary',
      revision: 1,
      baselineAllowed: true,
      promotedPolicyCohorts: ['commercial-intent-quality-v1'],
    });
    await expect(service.preview(request, settings)).resolves.toMatchObject({ decision: 'DELETE' });
  });

  it('uses the complete unsaved sensitivity profile without changing saved settings', async () => {
    const { service } = fixture();
    const saved = { ...settings, commercialAdsWarnThreshold: 60, commercialAdsDeleteThreshold: 82 };
    const request = {
      text: 'ГРУЗОПЕРЕВОЗКИ +7 900 000 10 42',
      enabled: true,
      policy: null,
      classification: {
        commercialAdsSensitivity: 'STRICT' as const,
        commercialAdsWarnThreshold: 38,
        commercialAdsDeleteThreshold: 55,
      },
    };
    const before = JSON.stringify({ saved, request });
    expect((await service.preview({ ...request, classification: undefined }, saved)).decision).toBe(
      'KEEP',
    );
    expect(await service.preview(request, saved)).toMatchObject({
      decision: 'DELETE',
      categories: ['SERVICES'],
    });
    expect(JSON.stringify({ saved, request })).toBe(before);
  });

  it.each([
    {
      commercialAdsSensitivity: 'BALANCED' as const,
      commercialAdsWarnThreshold: 60,
      commercialAdsDeleteThreshold: 82,
    },
    settings,
    {
      commercialAdsSensitivity: 'STRICT' as const,
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  ])('keeps incidental delivery out of the service category with profile %j', async (profile) => {
    const { service } = fixture();
    const policy = createDefaultCommercialAdsPolicy();
    policy.categories.BUSINESS = 'ALLOW';
    expect(
      await service.preview(
        {
          text: 'Наш магазин продаёт краску. Поможем подобрать цвет, доставка включена. Принимаем заказы. +7 900 000 10 42',
          enabled: true,
          policy,
        },
        { ...settings, ...profile },
      ),
    ).toMatchObject({ decision: 'KEEP', categories: ['BUSINESS'] });
  });

  it('retains a separate service and commercial channel without requiring a link', async () => {
    const { service } = fixture();
    const policy = createDefaultCommercialAdsPolicy();
    policy.categories.BUSINESS = 'ALLOW';
    policy.categories.SERVICES = 'ALLOW';
    expect(
      await service.preview(
        {
          text: 'Продаём краску. Отдельно выполняем покраску. Вступайте в наш канал с каталогом. +7 900 000 10 42.',
          enabled: true,
          policy,
        },
        settings,
      ),
    ).toMatchObject({
      decision: 'DELETE',
      categories: expect.arrayContaining(['BUSINESS', 'SERVICES', 'COMMUNITIES']),
    });
  });
  it('checks unsaved rules using the real text detector', async () => {
    const { service } = fixture();
    const policy = createDefaultCommercialAdsPolicy();
    expect(await service.preview({ text, policy, enabled: true }, settings)).toMatchObject({
      decision: 'DELETE',
      categories: ['SERVICES'],
      reason: 'BLOCKED_CATEGORY',
    });
    policy.categories.SERVICES = 'ALLOW';
    expect(await service.preview({ text, policy, enabled: true }, settings)).toMatchObject({
      decision: 'KEEP',
      categories: ['SERVICES'],
      reason: 'CATEGORY_ALLOWED',
    });
  });
  it('explains a blocked personal sale as unresolved while AI is off, then honors ALLOW', async () => {
    const { service } = fixture();
    const policy = createDefaultCommercialAdsPolicy();
    policy.categories.PERSONAL_SALE = 'BLOCK';
    const personalText = 'Продам свой старый велосипед после переезда, один, б/у.';
    expect(
      await service.preview({ text: personalText, policy, enabled: true }, settings),
    ).toMatchObject({
      decision: 'UNSURE',
      categories: ['PERSONAL_SALE'],
      reason: 'INSUFFICIENT_CONTEXT',
    });
    policy.categories.PERSONAL_SALE = 'ALLOW';
    expect(
      await service.preview({ text: personalText, policy, enabled: true }, settings),
    ).toMatchObject({
      decision: 'KEEP',
      categories: ['PERSONAL_SALE'],
      reason: 'CATEGORY_ALLOWED',
    });
  });

  it('keeps disabled and ordinary text without contacting the model', async () => {
    const { service } = fixture();
    const classify = jest.spyOn(CommercialLlmPreviewMailbox.prototype, 'classify');
    expect(await service.preview({ text, policy: null, enabled: false }, settings)).toMatchObject({
      decision: 'KEEP',
      reason: 'FILTER_DISABLED',
    });
    expect(
      await service.preview(
        { text: 'Доброе утро, соседи!', policy: createDefaultCommercialAdsPolicy(), enabled: true },
        settings,
      ),
    ).toMatchObject({ decision: 'KEEP', reason: 'NOT_ADVERTISING' });
    expect(classify).not.toHaveBeenCalled();
  });
  it('reports classifier unavailability separately from an allowed message', async () => {
    jest.spyOn(shadowLease, 'createCommercialLlmRedis').mockImplementation(() => {
      throw new Error('Preview dependency unavailable');
    });
    const { service } = fixture(true);
    expect(
      await service.preview(
        { text, policy: createDefaultCommercialAdsPolicy(), enabled: true },
        settings,
      ),
    ).toEqual({ decision: 'UNAVAILABLE', categories: [], reason: 'CLASSIFIER_UNAVAILABLE' });
  });

  it('uses semantic categories and scoped grants consistently with actual AI moderation', async () => {
    const redis = shadowLease.createCommercialLlmRedis('redis://127.0.0.1:1');
    jest.spyOn(redis, 'connect').mockResolvedValue(undefined);
    jest.spyOn(redis, 'disconnect').mockImplementation(() => undefined);
    jest.spyOn(redis, 'exists').mockResolvedValue(0);
    jest.spyOn(shadowLease, 'createCommercialLlmRedis').mockReturnValue(redis);
    const result: CommercialLlmObservationResult = {
      ...COMMERCIAL_LLM_POOL_PROFILES['server-9b'].identity,
      classification: 'COMMERCIAL',
      reasonCodes: ['SERVICE_OFFER'],
      policyVersion: COMMERCIAL_LLM_POLICY_VERSION,
      durationMs: 1,
    };
    jest.spyOn(CommercialLlmPreviewMailbox.prototype, 'classify').mockResolvedValue(result);
    const { service } = fixture(true);
    const policy = createDefaultCommercialAdsPolicy();
    const mixed =
      'Посоветуйте магазин мебели\nРемонт квартир под ключ по договору, принимаем заказы. Звоните 8 900 000 00 00';
    const multiline = await service.preview({ text: mixed, policy, enabled: true }, settings);
    expect(multiline).toMatchObject({ decision: 'DELETE', categories: ['SERVICES'] });
    expect(CommercialLlmPreviewMailbox.prototype.classify).toHaveBeenCalledWith(
      'Посоветуйте магазин мебели\nРемонт квартир под ключ по договору, принимаем заказы. Звоните [phone]',
    );
    const shortOffer = 'Мастерская принимает заказы на ремонт мебели. Работаем по договору.';
    expect(
      await service.preview({ text: shortOffer, policy, enabled: true }, settings),
    ).toMatchObject({ decision: 'DELETE', categories: ['SERVICES'] });
    policy.categories.SERVICES = 'ALLOW';
    expect(
      await service.preview({ text: shortOffer, policy, enabled: true }, settings),
    ).toMatchObject({ decision: 'KEEP', categories: ['SERVICES'] });
    jest.spyOn(CommercialLlmPreviewMailbox.prototype, 'classify').mockResolvedValue({
      ...result,
      reasonCodes: ['SERVICE_OFFER', 'BUSINESS_OFFER'],
    });
    expect(
      await service.preview({ text: shortOffer, policy, enabled: true }, settings),
    ).toMatchObject({ decision: 'DELETE', categories: ['SERVICES', 'BUSINESS'] });
    policy.exceptions.push({
      id: '9860f156-edc1-4c09-a42b-c3a6f44ea53b',
      userId: '123',
      userName: 'Участник',
      categories: ['BUSINESS'],
      expiresAt: null,
    });
    expect(
      await service.preview({ text: shortOffer, policy, enabled: true, userId: '123' }, settings),
    ).toMatchObject({ decision: 'KEEP', reason: 'PARTICIPANT_EXCEPTION' });
    expect(
      await service.preview({ text: shortOffer, policy, enabled: true, userId: '124' }, settings),
    ).toMatchObject({ decision: 'DELETE' });
    jest.spyOn(CommercialLlmPreviewMailbox.prototype, 'classify').mockResolvedValue({
      ...result,
      reasonCodes: ['COMMERCIAL_OFFER'],
    });
    expect(
      await service.preview({ text: shortOffer, policy, enabled: true }, settings),
    ).toMatchObject({ decision: 'UNSURE', reason: 'INSUFFICIENT_CONTEXT', categories: [] });
  });
});
