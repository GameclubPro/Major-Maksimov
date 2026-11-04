import { createHash } from 'node:crypto';
import { createDefaultCommercialAdsPolicy } from '@maxim/contracts/settings';
import {
  bindCommercialTextDeleteIntent,
  buildCommercialTextDeleteBinding,
  COMMERCIAL_TEXT_DELETE_MAX_AGE_MS,
  commercialTextDeleteReasonKey,
  fingerprintCommercialDeleteText,
  fingerprintCommercialDeleteSettings,
  isCommercialTextDeleteBindingCurrent,
} from './commercial-delete-binding';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';
import {
  COMMERCIAL_INTENT_QUALITY_COHORT,
  COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
} from './commercial-policy-cohorts';

const settings = {
  commercialAdsFilterEnabled: true,
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

describe('commercial text decision binding', () => {
  it('preserves the exact null-policy legacy digest and revokes it after explicit category changes', () => {
    const legacy = createHash('sha256')
      .update(
        JSON.stringify([
          settings.commercialAdsFilterEnabled,
          settings.commercialAdsSensitivity,
          settings.commercialAdsWarnThreshold,
          settings.commercialAdsDeleteThreshold,
          settings.nightModeTimezone,
          settings.textFiltersWarnEnabled,
          settings.textFiltersMuteEnabled,
          settings.textFiltersBanEnabled,
          settings.textFiltersMuteDurationHours,
          settings.textFiltersBotMessageEnabled,
        ]),
      )
      .digest('hex');
    expect(fingerprintCommercialDeleteSettings(settings)).toBe(legacy);
    expect(fingerprintCommercialDeleteSettings({ ...settings, commercialAdsPolicy: null })).toBe(
      legacy,
    );
    const commercialAdsPolicy = createDefaultCommercialAdsPolicy();
    const first = fingerprintCommercialDeleteSettings({ ...settings, commercialAdsPolicy });
    expect(first).not.toBe(legacy);
    commercialAdsPolicy.categories.SERVICES = 'ALLOW';
    expect(fingerprintCommercialDeleteSettings({ ...settings, commercialAdsPolicy })).not.toBe(
      first,
    );
  });

  it('preserves assertion layout in the fingerprint without persisting plaintext', () => {
    const text = 'Такси\n+7 900 000 10 42';
    const binding = buildCommercialTextDeleteBinding({
      text,
      settings,
      eventTimestampMs: Date.now(),
      campaignContext: null,
    });
    expect(binding.sourceSha256).not.toBe(
      fingerprintCommercialDeleteText(text.replaceAll('\n', ' ')),
    );
    expect(JSON.stringify(binding)).not.toContain('Такси');
    expect(JSON.stringify(binding)).not.toContain('900 000');
  });

  it('keeps the same revision and absolute deadline across duplicate processing', () => {
    const eventTimestampMs = Date.now() - 30_000;
    const context = { text: 'Такси', settings, campaignContext: null };
    const source = {
      chatId: 'chat',
      messageId: 'message',
      reasonKey: 'old',
      ruleCode: 'COMMERCIAL_AD_DELETE',
      sourceMessageAt: new Date(eventTimestampMs),
      event: { score: 0.8, metadata: { actionBand: 'WARN' } },
    };
    const first = bindCommercialTextDeleteIntent(source, context);
    const repeated = bindCommercialTextDeleteIntent(
      { ...source, sourceMessageAt: new Date(eventTimestampMs).toISOString() },
      context,
    );
    expect(first.reasonKey).toBe(repeated.reasonKey);
    expect(first.event).toEqual(repeated.event);
    expect(first.retryUntilAt).toEqual(repeated.retryUntilAt);
    expect(first.retryUntilAt).toEqual(
      new Date(eventTimestampMs + COMMERCIAL_TEXT_DELETE_MAX_AGE_MS),
    );
    expect(source.reasonKey).toBe('old');
    expect(source.event.metadata).toEqual({ actionBand: 'WARN' });
    expect(first.event?.metadata).toMatchObject({ actionBand: 'WARN' });
  });

  it('does not rebind another policy family', () => {
    const source = {
      chatId: 'chat',
      messageId: 'message',
      reasonKey: 'other',
      ruleCode: 'PROFANITY_DELETE',
    };
    expect(
      bindCommercialTextDeleteIntent(source, { text: '', settings, campaignContext: null }),
    ).toBe(source);
  });

  it('separates edits while preserving a hard expiry boundary', () => {
    const eventTimestampMs = Date.now();
    const binding = buildCommercialTextDeleteBinding({
      text: 'Такси',
      settings,
      eventTimestampMs,
      campaignContext: null,
    });
    const edited = buildCommercialTextDeleteBinding({
      text: 'Такси',
      settings,
      eventTimestampMs: eventTimestampMs + 1,
      campaignContext: null,
    });
    expect(commercialTextDeleteReasonKey(binding)).not.toBe(commercialTextDeleteReasonKey(edited));
    expect(isCommercialTextDeleteBindingCurrent(binding, settings, binding.deadlineAtMs - 1)).toBe(
      true,
    );
    expect(isCommercialTextDeleteBindingCurrent(binding, settings, binding.deadlineAtMs)).toBe(
      false,
    );
  });
  it('binds quality decisions to their distinct version and rejects baseline-version authority reuse', () => {
    const binding = buildCommercialTextDeleteBinding({
      text: 'Принимаю заказы на пряники.',
      settings,
      eventTimestampMs: Date.now(),
      campaignContext: null,
      requiredPolicyCohorts: [COMMERCIAL_INTENT_QUALITY_COHORT],
    });
    expect(binding.decisionVersion).toBe(COMMERCIAL_INTENT_QUALITY_DECISION_VERSION);
    expect(isCommercialTextDeleteBindingCurrent(binding, settings)).toBe(true);
    expect(
      isCommercialTextDeleteBindingCurrent(
        { ...binding, decisionVersion: COMMERCIAL_ENGINE_CONFIG.decisionVersion },
        settings,
      ),
    ).toBe(false);
  });
});
