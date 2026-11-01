import type { ChatSettings } from '../../prisma/prisma-client';
import type { RuleViolation } from '../rule-engine.contract';
import { buildCommercialTextQualityObservation } from './commercial-quality-observation';

const settings = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'BALANCED',
  commercialAdsWarnThreshold: 45,
  commercialAdsDeleteThreshold: 65,
} as ChatSettings;
const input = {
  secret: 'test-observation-key-123456',
  chatId: '-1',
  userId: '42',
  messageId: 'm',
  text: 'Хотела бы заказать уборку квартиры. Оплачу 3000 рублей, звоните +7 900 000 10 42.',
  messageCreatedAt: '2026-10-05T00:00:00.000Z',
  settings,
  violation: {
    ruleCode: 'COMMERCIAL_AD',
    score: 0.97,
    reason: 'test',
    metadata: {
      actionBand: 'DELETE',
      actionable: true,
      messageDisposition: 'DELETE',
      decisionVersion: 'commercial-deterministic-v5',
      reasonCodes: ['test'],
    },
  } as RuleViolation,
};

describe('commercial quality observation', () => {
  it('does not describe an asynchronous AI source without a result as a completed deterministic KEEP', () => {
    let sampled: ReturnType<typeof buildCommercialTextQualityObservation> = null;
    for (let index = 0; !sampled && index < 100; index++) {
      sampled = buildCommercialTextQualityObservation({
        ...input,
        messageId: `ai-pending-${index}`,
        violation: undefined,
        activeAiEnforcement: true,
      });
    }
    expect(sampled).not.toBeNull();
    expect(sampled).toMatchObject({
      detectorVersion: 'commercial-ai-asynchronous-v1',
      decisionOutcome: null,
      deleteEligible: null,
      executionOutcome: 'UNKNOWN',
      analysisOutcome: 'NOT_APPLICABLE',
      hasDetection: false,
    });
    expect(sampled?.candidateDecision).toMatchObject({
      detectorVersion: 'commercial-intent-quality-v1',
    });
  });

  it('stores released permission and independent candidate without changing the violation', () => {
    const before = JSON.stringify(input.violation);
    const sample = buildCommercialTextQualityObservation(input)!;
    expect(sample.decisionOutcome).toBe('DELETE');
    expect(sample.deleteEligible).toBe(true);
    expect(sample.executionOutcome).toBe('UNKNOWN');
    expect(sample.candidateDecision).toMatchObject({
      messageDisposition: 'KEEP',
      detectorVersion: 'commercial-intent-quality-v1',
    });
    expect(JSON.stringify(input.violation)).toBe(before);
  });
  it('counts WARN as permission but explicit KEEP never as a deletion', () => {
    const metadata = { ...input.violation.metadata, actionBand: 'WARN' };
    expect(
      buildCommercialTextQualityObservation({
        ...input,
        violation: {
          ...input.violation,
          metadata,
        },
      })?.deleteEligible,
    ).toBe(true);
    expect(
      buildCommercialTextQualityObservation({
        ...input,
        violation: {
          ...input.violation,
          metadata: { ...metadata, messageDisposition: 'KEEP' },
        },
      })?.executionOutcome,
    ).toBe('NOT_REQUESTED');
  });
  it('does not create a certifiable source from the event clock or missing secret', () => {
    expect(buildCommercialTextQualityObservation({ ...input, messageCreatedAt: null })).toBeNull();
    expect(buildCommercialTextQualityObservation({ ...input, secret: undefined })).toBeNull();
  });
});
