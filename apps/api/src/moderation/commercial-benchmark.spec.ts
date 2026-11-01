import { isDeepStrictEqual } from 'node:util';
import { isCommercialMessageDeleteEligible } from './commercial/commercial-action-policy';

import type { ChatSettings } from '../prisma/prisma-client';
import type { CommercialCampaignContext } from './commercial-campaign.util';
import {
  COMMERCIAL_BENCHMARK_LOCAL_LIMITS,
  COMMERCIAL_BENCHMARK_REPORT_PREFIX,
  isCommercialBenchmarkMedianGateEnabled,
  type CommercialBenchmarkPercentiles,
} from '../scripts/commercial-benchmark-ci.util';
import {
  COMMERCIAL_DETECTOR_BENCHMARK_CLOCK,
  COMMERCIAL_DETECTOR_BENCHMARK_SCHEMA_VERSION,
  measureCommercialAsync,
  measureCommercialSync,
  summarizeCommercialQualityCohorts,
  summarizeCommercialTimingCohorts,
  summarizeCommercialTimings,
  timingSummaryToMilliseconds,
  type CommercialDetectorBenchmarkEvidence,
  type CommercialDetectorQualityObservation,
  type CommercialDetectorTimingObservation,
  type CommercialDetectorTimingSummary,
} from '../scripts/commercial-detector-harness.util';
import { COMMERCIAL_NEGATIVE_CASES } from './commercial-negative.fixture';
import { COMMERCIAL_POSITIVE_CASES } from './commercial-positive.fixture';
import {
  CommercialAdDetector,
  type CommercialDetection,
} from './commercial/commercial-ad.detector';
import {
  auditCommercialRequiredAnchors,
  buildCommercialFeatureVector,
} from './commercial/commercial-features';
import { resolveCommercialSignalEvidence } from './commercial/commercial-evidence';
import { canCommercialActionDelete } from './commercial/commercial-scorer';
import { RedisCounterService } from './redis-counter.service';
import { createRuleDetectionContext } from './rule-engine-detection-context';
import { RuleEngineService } from './rule-engine.service';
import type { CommercialSubtype, RuleViolation } from './rule-engine.contract';

class NoopRedisCounterService {
  async incrementWithTtl(): Promise<number> {
    return 0;
  }

  async addToSetWithTtl(): Promise<{ added: boolean; size: number }> {
    return { added: true, size: 1 };
  }
}

const BASE_SETTINGS = {
  russianProfanityFilterEnabled: false,
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'STRICT',
  commercialAdsWarnThreshold: 38,
  commercialAdsDeleteThreshold: 55,
  topicFilterEnabled: false,
  linkMode: 'ALLOW_ALL',
  duplicateDetectionEnabled: false,
  messageCountLimitEnabled: false,
  antiSpamEnabled: false,
  maxMessageLength: 0,
  photoCooldownHours: 0,
  stickerCooldownMinutes: 0,
  messageLimitsBlockedWords: [],
  messageLimitsBlockedDomains: [],
} as unknown as ChatSettings;

function buildSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    ...BASE_SETTINGS,
    ...overrides,
    commercialAdsFilterEnabled: true,
  };
}

function createRuleEngine(): RuleEngineService {
  return new RuleEngineService(new NoopRedisCounterService() as unknown as RedisCounterService);
}

function prepareCommercialDetectorInput(
  text: string,
  overrides: Partial<ChatSettings> = {},
  options: { commercialCampaignContext?: CommercialCampaignContext | null } = {},
) {
  const settings = buildSettings(overrides);
  const context = createRuleDetectionContext({ text, settings });
  return {
    normalizedText: context.normalizedText,
    rawLoweredText: context.rawLoweredText,
    settings,
    commercialCampaignContext: options.commercialCampaignContext,
  };
}

async function detectCommercialViolation(
  service: RuleEngineService,
  text: string,
  overrides: Partial<ChatSettings> = {},
  options: { commercialCampaignContext?: CommercialCampaignContext | null } = {},
): Promise<RuleViolation | undefined> {
  const result = await service.detect({
    chatId: 'commercial-benchmark-chat',
    userId: 'commercial-benchmark-user',
    text,
    settings: buildSettings(overrides),
    domainAllowlist: [],
    commercialCampaignContext: options.commercialCampaignContext,
    skipDuplicateState: true,
    skipStatefulMessageLimits: true,
  });

  return result.violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readMetadata(violation: RuleViolation | undefined): Record<string, unknown> {
  return violation?.metadata &&
    typeof violation.metadata === 'object' &&
    !Array.isArray(violation.metadata)
    ? violation.metadata
    : {};
}

function readCommercialSubtype(value: unknown): CommercialSubtype | null {
  const subtypes = new Set<CommercialSubtype>([
    'CHANNEL_PLACEMENT',
    'PROPERTY_AGENT',
    'PROPERTY_COMMERCIAL',
    'RECRUITMENT',
    'INFO_PRODUCT',
    'BUYOUT',
    'SERVICES',
    'GOODS_RETAIL',
    'GOODS',
    'GROUP_PROMOTION',
    'GENERIC',
  ]);

  return typeof value === 'string' && subtypes.has(value as CommercialSubtype)
    ? (value as CommercialSubtype)
    : null;
}

function calculateSubtypeAccuracy(params: {
  totalPositiveCases: number;
  detectedPositiveCases: number;
  detectedSubtypeMisses: number;
}): number {
  if (params.totalPositiveCases === 0) {
    return 1;
  }

  return (params.detectedPositiveCases - params.detectedSubtypeMisses) / params.totalPositiveCases;
}

type CommercialDecisionSignature = {
  hit: boolean;
  confidenceScore: number | null;
  decisionBand: string | null;
  primarySubtype: string | null;
  subtype: string | null;
  supportingSubtypes: string[];
  reviewRecommended: boolean;
  actionBand: string | null;
  messageDisposition: string;
  evidenceTier: string | null;
  reviewPriority: string | null;
  campaignStrength: string | null;
  safeContextBucket: string | null;
  actionable: boolean;
  recordable: boolean;
  deleteSuppressed: boolean;
  suppressionReasons: string[];
};

function decisionSignatureFromDetection(
  detection: CommercialDetection | null,
): CommercialDecisionSignature {
  return {
    hit: detection !== null,
    confidenceScore: detection?.confidenceScore ?? null,
    decisionBand: detection?.decisionBand ?? null,
    primarySubtype: detection?.primarySubtype ?? null,
    subtype: detection?.subtype ?? null,
    supportingSubtypes: detection?.supportingSubtypes ?? [],
    reviewRecommended: detection?.reviewRecommended === true,
    actionBand: detection?.actionBand ?? null,
    messageDisposition: detection?.messageDisposition ?? 'KEEP',
    evidenceTier: detection?.evidenceTier ?? null,
    reviewPriority: detection?.reviewPriority ?? null,
    campaignStrength: detection?.campaignStrength ?? null,
    safeContextBucket: detection?.safeContextBucket ?? null,
    actionable: detection?.actionable === true,
    recordable: detection?.recordable === true,
    deleteSuppressed: detection?.deleteSuppressed === true,
    suppressionReasons: detection?.suppressionReasons ?? [],
  };
}

function decisionSignatureFromViolation(
  violation: RuleViolation | undefined,
): CommercialDecisionSignature {
  const metadata = readMetadata(violation);
  return {
    hit: violation !== undefined,
    confidenceScore: typeof metadata.confidenceScore === 'number' ? metadata.confidenceScore : null,
    decisionBand: typeof metadata.decisionBand === 'string' ? metadata.decisionBand : null,
    primarySubtype: typeof metadata.primarySubtype === 'string' ? metadata.primarySubtype : null,
    subtype: typeof metadata.subtype === 'string' ? metadata.subtype : null,
    supportingSubtypes: readStringArray(metadata.supportingSubtypes),
    reviewRecommended: metadata.reviewRecommended === true,
    actionBand: typeof metadata.actionBand === 'string' ? metadata.actionBand : null,
    messageDisposition:
      typeof metadata.messageDisposition === 'string' ? metadata.messageDisposition : 'KEEP',
    evidenceTier: typeof metadata.evidenceTier === 'string' ? metadata.evidenceTier : null,
    reviewPriority: typeof metadata.reviewPriority === 'string' ? metadata.reviewPriority : null,
    campaignStrength:
      typeof metadata.campaignStrength === 'string' ? metadata.campaignStrength : null,
    safeContextBucket:
      typeof metadata.safeContextBucket === 'string' ? metadata.safeContextBucket : null,
    actionable: metadata.actionable === true,
    recordable: metadata.recordable === true,
    deleteSuppressed: metadata.deleteSuppressed === true,
    suppressionReasons: readStringArray(metadata.suppressionReasons),
  };
}

function campaignCohort(context: CommercialCampaignContext | null | undefined): string {
  if (!context) {
    return 'campaign:absent';
  }
  return Object.values(context).some((value) => value !== undefined && value > 0)
    ? 'campaign:nonzero'
    : 'campaign:zero';
}

function benchmarkTextCohorts(params: {
  text: string;
  overrides?: Partial<ChatSettings>;
  campaignContext?: CommercialCampaignContext | null;
}): string[] {
  const lengthBucket =
    params.text.length <= 80 ? 'short' : params.text.length <= 400 ? 'medium' : 'long';
  const hasCyrillic = /\p{Script=Cyrillic}/u.test(params.text);
  const hasLatin = /\p{Script=Latin}/u.test(params.text);
  const scriptBucket = hasCyrillic
    ? hasLatin
      ? 'mixed'
      : 'cyrillic'
    : hasLatin
      ? 'latin'
      : 'other';
  const hasPhone = /(?:\[phone\]|(?:\+?7|8)[\s()-]*\d{3})/iu.test(params.text);
  const hasLink = /(?:\[url\]|https?:\/\/|max\.ru\/)/iu.test(params.text);
  const contactBucket = hasPhone
    ? hasLink
      ? 'phone-and-link'
      : 'phone'
    : hasLink
      ? 'link'
      : 'none';
  const settings = buildSettings(params.overrides);
  return [
    `length:${lengthBucket}`,
    `script:${scriptBucket}`,
    `contact:${contactBucket}`,
    campaignCohort(params.campaignContext),
    `settings:${settings.commercialAdsSensitivity}-${settings.commercialAdsWarnThreshold}-${settings.commercialAdsDeleteThreshold}`,
  ];
}

describe('commercial deterministic benchmark', () => {
  const useMedianGate = isCommercialBenchmarkMedianGateEnabled(process.env);
  let hotPathMetrics: CommercialBenchmarkPercentiles | null = null;
  let adversarialMetrics: CommercialBenchmarkPercentiles | null = null;
  let initializationEvidence: CommercialDetectorBenchmarkEvidence['initialization'] | null = null;
  let detectorOnlyTiming: CommercialDetectorTimingSummary | null = null;
  let fullPathTiming: CommercialDetectorTimingSummary | null = null;
  let adversarialFullPathTiming: CommercialDetectorTimingSummary | null = null;
  let detectorOnlyTimingCohorts: Record<string, CommercialDetectorTimingSummary> | null = null;
  let fullPathTimingCohorts: Record<string, CommercialDetectorTimingSummary> | null = null;
  let qualityCohorts: CommercialDetectorBenchmarkEvidence['qualityCohorts'] | null = null;
  let pathEquivalence: CommercialDetectorBenchmarkEvidence['detectorToFullPathEquivalence'] | null =
    null;

  afterAll(() => {
    if (!useMedianGate) {
      return;
    }
    if (
      !hotPathMetrics ||
      !adversarialMetrics ||
      !initializationEvidence ||
      !detectorOnlyTiming ||
      !fullPathTiming ||
      !adversarialFullPathTiming ||
      !detectorOnlyTimingCohorts ||
      !fullPathTimingCohorts ||
      !qualityCohorts ||
      !pathEquivalence
    ) {
      throw new Error(
        'Commercial benchmark did not produce a complete performance evidence report',
      );
    }
    const evidence: CommercialDetectorBenchmarkEvidence = {
      schemaVersion: COMMERCIAL_DETECTOR_BENCHMARK_SCHEMA_VERSION,
      clock: COMMERCIAL_DETECTOR_BENCHMARK_CLOCK,
      initialization: initializationEvidence,
      warm: {
        detectorOnly: detectorOnlyTiming,
        fullPath: fullPathTiming,
        adversarialFullPath: adversarialFullPathTiming,
      },
      timingCohorts: {
        detectorOnly: detectorOnlyTimingCohorts,
        fullPath: fullPathTimingCohorts,
      },
      qualityCohorts,
      detectorToFullPathEquivalence: pathEquivalence,
    };
    process.stdout.write(
      `${COMMERCIAL_BENCHMARK_REPORT_PREFIX}${JSON.stringify({
        hotPath: hotPathMetrics,
        adversarial: adversarialMetrics,
        evidence,
      })}\n`,
    );
  });

  it('counts undetected positive cases as subtype errors', () => {
    expect(
      calculateSubtypeAccuracy({
        totalPositiveCases: 4,
        detectedPositiveCases: 3,
        detectedSubtypeMisses: 1,
      }),
    ).toBe(0.5);
  });

  it('records detector initialization and the first full-path call without hiding warm state', async () => {
    const text = 'ГРУЗОПЕРЕВОЗКИ +7 900 000 10 42';
    const overrides = {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 57,
      commercialAdsDeleteThreshold: 77,
    } as const;
    const detectorInput = prepareCommercialDetectorInput(text, overrides);
    const detectorFirstCall = measureCommercialSync(() => {
      const detector = new CommercialAdDetector();
      return detector.detect(detectorInput);
    });
    const fullPathFirstCall = await measureCommercialAsync(async () => {
      const service = createRuleEngine();
      return detectCommercialViolation(service, text, overrides);
    });

    expect(fullPathFirstCall.value?.metadata).toEqual(
      expect.objectContaining({
        primarySubtype: 'SERVICES',
        actionBand: 'WARN',
      }),
    );
    expect(detectorFirstCall.durationNs).toBeGreaterThan(0);
    expect(fullPathFirstCall.durationNs).toBeGreaterThan(0);
    initializationEvidence = {
      detectorConstructionAndFirstCallNs: detectorFirstCall.durationNs,
      fullPathConstructionAndFirstCallNs: fullPathFirstCall.durationNs,
      fullPathPatternState: 'PROCESS_PATTERNS_ALREADY_WARM',
    };
  });

  it('meets recall, false-positive, subtype, and action-policy gates', async () => {
    const service = createRuleEngine();
    const falseNegatives: string[] = [];
    const hardFalseNegatives: string[] = [];
    const grayFalseNegatives: string[] = [];
    const falsePositives: string[] = [];
    const subtypeMisses: string[] = [];
    const deleteWithoutStrongEvidence: string[] = [];
    const deleteFalsePositives: string[] = [];
    const missingExpectedSignals: string[] = [];
    const missingRequiredAnchors: string[] = [];
    const unsafeDeleteActions: string[] = [];
    const hardEnforcementMisses: string[] = [];
    const bySubtype = new Map<string, number>();
    const byAction = new Map<string, number>();
    const falseNegativeSignals = new Map<string, number>();
    const falsePositiveSignals = new Map<string, number>();
    const hardPositiveCases = COMMERCIAL_POSITIVE_CASES.filter(
      (item) => item.reviewRecommended !== true && item.requireClassifier !== true,
    );
    const grayPositiveCases = COMMERCIAL_POSITIVE_CASES.filter(
      (item) => item.reviewRecommended === true || item.requireClassifier === true,
    );
    const hardEnforcementCases = COMMERCIAL_POSITIVE_CASES.filter(
      (item) =>
        item.reviewRecommended !== true &&
        item.requireClassifier !== true &&
        item.expectedSignals.some((signal) => signal.startsWith('risk:')),
    );
    const hardEnforcementLabels = new Set(hardEnforcementCases.map((item) => item.label));

    for (const item of COMMERCIAL_POSITIVE_CASES) {
      const violation = await detectCommercialViolation(service, item.text, item.overrides, {
        commercialCampaignContext: item.campaignContext,
      });
      if (!violation) {
        falseNegatives.push(item.label);
        if (hardEnforcementLabels.has(item.label)) {
          hardEnforcementMisses.push(`${item.label}: action=ALLOW`);
        }
        if (item.reviewRecommended === true || item.requireClassifier === true) {
          grayFalseNegatives.push(item.label);
        } else {
          hardFalseNegatives.push(item.label);
        }
        continue;
      }

      const metadata = readMetadata(violation);
      const subtype = String(metadata.primarySubtype ?? 'UNKNOWN');
      const typedSubtype = readCommercialSubtype(metadata.primarySubtype);
      const actionBand = String(metadata.actionBand ?? 'UNKNOWN');
      if (
        hardEnforcementLabels.has(item.label) &&
        actionBand !== 'WARN' &&
        actionBand !== 'DELETE' &&
        actionBand !== 'DELETE_AND_ESCALATE'
      ) {
        hardEnforcementMisses.push(`${item.label}: action=${actionBand}`);
      }
      bySubtype.set(subtype, (bySubtype.get(subtype) ?? 0) + 1);
      byAction.set(actionBand, (byAction.get(actionBand) ?? 0) + 1);
      if (subtype !== item.expectedSubtype) {
        subtypeMisses.push(`${item.label}: expected=${item.expectedSubtype} actual=${subtype}`);
      }

      const matchedSignals = readStringArray(metadata.matchedSignals);
      const negativeSignals = readStringArray(metadata.negativeSignals);
      const expectedSignalsMissing = item.expectedSignals.filter(
        (signal) => !matchedSignals.includes(signal),
      );
      if (expectedSignalsMissing.length > 0) {
        missingExpectedSignals.push(`${item.label}: missing=${expectedSignalsMissing.join(',')}`);
      }
      const featureVector = buildCommercialFeatureVector(matchedSignals, negativeSignals);
      if (typedSubtype) {
        const anchorAudit = auditCommercialRequiredAnchors({
          subtype: typedSubtype,
          featureVector,
          matchedSignals,
        });
        if (!anchorAudit.hasRequiredAnchors) {
          missingRequiredAnchors.push(
            `${item.label}: subtype=${subtype} missing=${anchorAudit.missingAnchors.join(',')}`,
          );
        }
      }
      const evidenceTier = String(metadata.evidenceTier ?? metadata.evidenceStrength ?? 'NONE');
      const evidence = resolveCommercialSignalEvidence(matchedSignals);
      const hasDirectEvidence = evidence.hasActionDirectDealEvidence;
      const hasHighRiskEvidence = evidence.hasHighRiskEvidence;
      const hasEscalationRiskEvidence = evidence.hasEscalationRiskEvidence;
      if (
        (actionBand === 'DELETE' || actionBand === 'DELETE_AND_ESCALATE') &&
        !hasDirectEvidence &&
        !hasHighRiskEvidence &&
        evidenceTier !== 'DIRECT' &&
        evidenceTier !== 'HIGH_RISK'
      ) {
        deleteWithoutStrongEvidence.push(item.label);
      }
      if (
        !canCommercialActionDelete({
          actionBand,
          evidenceTier,
          hasHighRiskEvidence,
          hasEscalationRiskEvidence,
          hasDirectDealEvidence: hasDirectEvidence,
          fpRisk: typeof metadata.fpRisk === 'number' ? metadata.fpRisk : null,
        }) &&
        (actionBand === 'DELETE' || actionBand === 'DELETE_AND_ESCALATE')
      ) {
        unsafeDeleteActions.push(`${item.label}: action=${actionBand} evidence=${evidenceTier}`);
      }
    }

    for (const item of COMMERCIAL_NEGATIVE_CASES) {
      const violation = await detectCommercialViolation(service, item.text, item.overrides, {
        commercialCampaignContext: item.campaignContext ?? null,
      });
      if (!violation) {
        continue;
      }
      falsePositives.push(item.label);
      const metadata = readMetadata(violation);
      const actionBand = String(metadata.actionBand ?? 'UNKNOWN');
      if (
        isCommercialMessageDeleteEligible(
          actionBand,
          metadata.actionable === true,
          metadata.messageDisposition,
        )
      ) {
        deleteFalsePositives.push(item.label);
      }
      for (const signal of readStringArray(metadata.matchedSignals)) {
        falsePositiveSignals.set(signal, (falsePositiveSignals.get(signal) ?? 0) + 1);
      }
    }

    for (const label of falseNegatives) {
      falseNegativeSignals.set(label, 1);
    }

    const truePositives = COMMERCIAL_POSITIVE_CASES.length - falseNegatives.length;
    const hardTruePositives = hardPositiveCases.length - hardFalseNegatives.length;
    const grayTruePositives = grayPositiveCases.length - grayFalseNegatives.length;
    const trueNegatives = COMMERCIAL_NEGATIVE_CASES.length - falsePositives.length;
    const recall = truePositives / COMMERCIAL_POSITIVE_CASES.length;
    const hardRecall = hardTruePositives / hardPositiveCases.length;
    const hardEnforcementRecall =
      (hardEnforcementCases.length - hardEnforcementMisses.length) / hardEnforcementCases.length;
    const grayRecall =
      grayPositiveCases.length > 0 ? grayTruePositives / grayPositiveCases.length : 1;
    const falsePositiveRate = falsePositives.length / COMMERCIAL_NEGATIVE_CASES.length;
    const subtypeAccuracy = calculateSubtypeAccuracy({
      totalPositiveCases: COMMERCIAL_POSITIVE_CASES.length,
      detectedPositiveCases: truePositives,
      detectedSubtypeMisses: subtypeMisses.length,
    });
    const report = {
      confusionMatrix: {
        TP: truePositives,
        FP: falsePositives.length,
        FN: falseNegatives.length,
        TN: trueNegatives,
      },
      hardEnforcement: {
        eligible: hardEnforcementCases.length,
        misses: hardEnforcementMisses.length,
      },
      bySubtype: Object.fromEntries([...bySubtype.entries()].sort()),
      byAction: Object.fromEntries([...byAction.entries()].sort()),
      topFalsePositiveSignals: Object.fromEntries(
        [...falsePositiveSignals.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8),
      ),
      topFalseNegativeSignals: Object.fromEntries([...falseNegativeSignals.entries()].slice(0, 8)),
    };

    expect(hardEnforcementMisses).toEqual([]);
    expect(report).toMatchSnapshot();
    expect(hardRecall).toBeGreaterThanOrEqual(0.98);
    expect(hardEnforcementRecall).toBeGreaterThanOrEqual(0.98);
    expect(grayRecall).toBeGreaterThanOrEqual(0.8);
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(falsePositives).toEqual([]);
    expect(falsePositiveRate).toBeLessThanOrEqual(0.001);
    expect(subtypeAccuracy).toBeGreaterThanOrEqual(0.93);
    expect(deleteFalsePositives).toEqual([]);
    expect(deleteWithoutStrongEvidence).toEqual([]);
    expect(unsafeDeleteActions).toEqual([]);
    expect(missingExpectedSignals).toEqual([]);
    expect(missingRequiredAnchors).toEqual([]);
  });

  it('records stratified warm detector/full-path evidence and exact decision equivalence', async () => {
    type BenchmarkCase = {
      text: string;
      overrides?: Partial<ChatSettings>;
      campaignContext?: CommercialCampaignContext | null;
      expected: 'POSITIVE' | 'NEGATIVE';
      expectedSubtype: string | null;
      cohorts: string[];
    };
    const benchmarkCases: BenchmarkCase[] = [
      ...COMMERCIAL_POSITIVE_CASES.map((item) => ({
        text: item.text,
        overrides: item.overrides as Partial<ChatSettings> | undefined,
        campaignContext: item.campaignContext ?? null,
        expected: 'POSITIVE' as const,
        expectedSubtype: item.expectedSubtype,
        cohorts: [
          'class:positive',
          `positive:${item.reviewRecommended === true || item.requireClassifier === true ? 'gray' : 'hard'}`,
          `subtype:${item.expectedSubtype}`,
          ...benchmarkTextCohorts({
            text: item.text,
            overrides: item.overrides as Partial<ChatSettings> | undefined,
            campaignContext: item.campaignContext ?? null,
          }),
        ],
      })),
      ...COMMERCIAL_NEGATIVE_CASES.map((item) => ({
        text: item.text,
        overrides: item.overrides as Partial<ChatSettings> | undefined,
        campaignContext: item.campaignContext ?? null,
        expected: 'NEGATIVE' as const,
        expectedSubtype: null,
        cohorts: [
          'class:negative',
          ...benchmarkTextCohorts({
            text: item.text,
            overrides: item.overrides as Partial<ChatSettings> | undefined,
            campaignContext: item.campaignContext ?? null,
          }),
        ],
      })),
    ];
    const detector = new CommercialAdDetector();
    const service = createRuleEngine();
    const directTimings: CommercialDetectorTimingObservation[] = [];
    const fullPathTimings: CommercialDetectorTimingObservation[] = [];
    const quality: CommercialDetectorQualityObservation[] = [];
    const equivalenceMismatches: string[] = [];
    const repetitions = 6;

    // Exclude one shared warm-up call from cohort samples while retaining the separately measured
    // construction/first-call evidence above.
    const warmCase = benchmarkCases[0];
    if (!warmCase) {
      throw new Error('Commercial benchmark fixture is empty');
    }
    detector.detect(
      prepareCommercialDetectorInput(warmCase.text, warmCase.overrides, {
        commercialCampaignContext: warmCase.campaignContext,
      }),
    );
    await detectCommercialViolation(service, warmCase.text, warmCase.overrides, {
      commercialCampaignContext: warmCase.campaignContext,
    });

    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      for (let index = 0; index < benchmarkCases.length; index += 1) {
        const item = benchmarkCases[index];
        if (!item) {
          continue;
        }
        const detectorInput = prepareCommercialDetectorInput(item.text, item.overrides, {
          commercialCampaignContext: item.campaignContext,
        });
        let direct: { value: CommercialDetection | null; durationNs: number };
        let fullPath: { value: RuleViolation | undefined; durationNs: number };
        const measureDirect = () => measureCommercialSync(() => detector.detect(detectorInput));
        const measureFullPath = () =>
          measureCommercialAsync(() =>
            detectCommercialViolation(service, item.text, item.overrides, {
              commercialCampaignContext: item.campaignContext,
            }),
          );
        if ((repetition + index) % 2 === 0) {
          direct = measureDirect();
          fullPath = await measureFullPath();
        } else {
          fullPath = await measureFullPath();
          direct = measureDirect();
        }
        directTimings.push({ durationNs: direct.durationNs, cohorts: item.cohorts });
        fullPathTimings.push({ durationNs: fullPath.durationNs, cohorts: item.cohorts });

        if (repetition !== 0) {
          continue;
        }
        const directSignature = decisionSignatureFromDetection(direct.value);
        const fullPathSignature = decisionSignatureFromViolation(fullPath.value);
        if (!isDeepStrictEqual(directSignature, fullPathSignature)) {
          equivalenceMismatches.push(
            `${index}: detector=${JSON.stringify(directSignature)} fullPath=${JSON.stringify(fullPathSignature)}`,
          );
        }
        quality.push({
          cohorts: item.cohorts,
          expected: item.expected,
          detected: fullPathSignature.hit,
          expectedSubtype: item.expectedSubtype,
          actualSubtype: fullPathSignature.primarySubtype,
          actionBand: fullPathSignature.actionBand,
          actionable: fullPathSignature.actionable,
          messageDisposition: fullPathSignature.messageDisposition,
        });
      }
    }

    detectorOnlyTiming = summarizeCommercialTimings(
      directTimings.map((observation) => observation.durationNs),
    );
    fullPathTiming = summarizeCommercialTimings(
      fullPathTimings.map((observation) => observation.durationNs),
    );
    detectorOnlyTimingCohorts = summarizeCommercialTimingCohorts(directTimings);
    fullPathTimingCohorts = summarizeCommercialTimingCohorts(fullPathTimings);
    qualityCohorts = summarizeCommercialQualityCohorts(quality);
    pathEquivalence = {
      samples: benchmarkCases.length,
      exactMatches: benchmarkCases.length - equivalenceMismatches.length,
      mismatches: equivalenceMismatches.length,
    };

    expect(equivalenceMismatches).toEqual([]);
    expect(qualityCohorts.all?.samples).toBe(benchmarkCases.length);
    expect(detectorOnlyTimingCohorts.all?.samples).toBe(benchmarkCases.length * repetitions);
    expect(fullPathTimingCohorts.all?.samples).toBe(benchmarkCases.length * repetitions);
    expect(detectorOnlyTimingCohorts['campaign:absent']?.samples).toBeGreaterThan(0);
    expect(detectorOnlyTimingCohorts['campaign:nonzero']?.samples).toBeGreaterThan(0);
  });

  it('keeps campaign-only commercial repeats out of delete actions', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'В наличии свежая партия, доставка по городу. Подробности и заказ в личные сообщения.',
      {},
      {
        commercialCampaignContext: {
          senderDistinctChatCount: 5,
          sameTextDistinctChatCount: 3,
          repeatedPhoneDistinctChatCount: 0,
          repeatedLinkDistinctChatCount: 0,
          nearTextDistinctChatCount: 3,
          repeatedDomainDistinctChatCount: 0,
          repeatedHandleDistinctChatCount: 0,
          senderDistinctChatCount5m: 4,
          senderDistinctChatCount30m: 5,
          senderDistinctChatCount120m: 5,
        },
      },
    );

    expect(violation).toBeDefined();
    const actionBand = String(readMetadata(violation).actionBand ?? 'UNKNOWN');
    expect(actionBand).not.toBe('DELETE');
    expect(actionBand).not.toBe('DELETE_AND_ESCALATE');
    expect(['WARN', 'REVIEW_ONLY']).toContain(actionBand);
  });

  it.each([
    [
      'messaging automation spam repeated across chats',
      'ПРОДАЖА КАЧЕСТВЕННОЙ РАССЫЛКИ, ДЕШЕВО. ЛУЧШИЕ ТАРИФЫ ПИСАТЬ В ЛС. ПОЛУЧИТЬ КЛИЕНТСКУЮ БАЗУ И ДЕНЬГИ. ПРОДАЮ САЙТ НА ЗАКАЗ НЕДОРОГО ТГ ЗАБЛОКИРОВАЛИ? САЙТ ПОМОЖЕТ РЕШИТЬ ЛЮБУЮ ПРОБЛЕМУ. ТАК ЖЕ ПИСАТЬ В ЛС',
    ],
    [
      'remote bank vacancy repeated across chats',
      'Требуются сотрудники на удаленку в Альфа банк, подойдет всем 18+ студентам и мамам в декрете. Работаем в агентском портале через телефон, график свободный, ЗП белая на карту. Все вопросы в л/с Новичкам бонус 10000тыс.',
    ],
  ])('keeps campaign-only high-risk %s out of delete actions', async (_label, text) => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      text,
      {},
      {
        commercialCampaignContext: {
          senderDistinctChatCount: 4,
          sameTextDistinctChatCount: 4,
          repeatedPhoneDistinctChatCount: 0,
          repeatedLinkDistinctChatCount: 0,
          nearTextDistinctChatCount: 4,
          repeatedDomainDistinctChatCount: 0,
          repeatedHandleDistinctChatCount: 0,
          senderDistinctChatCount5m: 2,
          senderDistinctChatCount30m: 4,
          senderDistinctChatCount120m: 4,
        },
      },
    );

    expect(violation).toBeDefined();
    const actionBand = String(readMetadata(violation).actionBand ?? 'UNKNOWN');
    expect(actionBand).not.toBe('DELETE');
    expect(actionBand).not.toBe('DELETE_AND_ESCALATE');
    expect(['WARN', 'REVIEW_ONLY']).toContain(actionBand);
  });

  it('keeps hot-path commercial detection within the deterministic perf budget', async () => {
    const service = createRuleEngine();
    const samples = [
      ...COMMERCIAL_POSITIVE_CASES.slice(0, 10).map((item) => item.text),
      ...COMMERCIAL_NEGATIVE_CASES.slice(0, 10).map((item) => item.text),
    ];
    const timingsNs: number[] = [];

    for (let index = 0; index < 10_000; index += 1) {
      const text = samples[index % samples.length] ?? 'обычное сообщение';
      const measured = await measureCommercialAsync(() => detectCommercialViolation(service, text));
      timingsNs.push(measured.durationNs);
    }

    const timing = summarizeCommercialTimings(timingsNs);
    const { p95Ms: p95, p99Ms: p99 } = timingSummaryToMilliseconds(timing);

    hotPathMetrics = { p95Ms: p95, p99Ms: p99 };
    if (!useMedianGate) {
      expect(p95).toBeLessThanOrEqual(COMMERCIAL_BENCHMARK_LOCAL_LIMITS.hotPath.p95Ms);
      expect(p99).toBeLessThanOrEqual(COMMERCIAL_BENCHMARK_LOCAL_LIMITS.hotPath.p99Ms);
    }
  });

  it('keeps adversarial commercial near-misses within the deterministic perf budget', async () => {
    const service = createRuleEngine();
    const samples = [
      `продам ${Array.from({ length: 1200 }, (_, index) => index % 10).join(' ')} x`,
      `попробуйте ${Array.from({ length: 80 }, (_, index) => `label${index}`).join('.')}.invalidtld`,
      `напишите ${Array.from({ length: 900 }, () => 'a').join('.')}@${Array.from(
        { length: 120 },
        () => 'b',
      ).join('-')}-invalid`,
      `розыгрыш ${Array.from({ length: 420 }, () => '1').join(' ')} рублей за спортX`,
      'Бесплатный подбор новостроек. Квартиры от застройщика без комиссии.',
      `Мой канал с заметками про ручную работу ${Array.from({ length: 120 }, () => 'скидок').join(
        ' ',
      )} и заказов там нет.`,
      `Открыла для себя аромат ${Array.from({ length: 80 }, () => 'для себя').join(
        ' ',
      )}, но это личный отзыв без продаж.`,
      `Травы ${Array.from({ length: 80 }, (_, index) => `${index + 10}р.кг`).join(
        ' ',
      )} обсуждали в рецепте без заказов.`,
      `Продаем бензин ${Array.from({ length: 1100 }, () => 'x').join(
        '.',
      )}. Это архивный перечень без цены и контактов.`,
      `Редакция цитирует: „${Array.from({ length: 360 }, () => 'x. Отдельно: x').join(
        ' ',
      )}“. Это архив примеров, не предложение.`,
      'Приглашаю на обсуждение салона, окрашивание и цены выросли, телефон администратора не нужен.',
    ];
    const timingsNs: number[] = [];

    for (let index = 0; index < 500; index += 1) {
      const text = samples[index % samples.length] ?? 'обычное сообщение';
      const measured = await measureCommercialAsync(() => detectCommercialViolation(service, text));
      const violation = measured.value;
      timingsNs.push(measured.durationNs);
      if (text.includes('новостроек')) {
        expect(violation).toBeUndefined();
      }
    }

    const timing = summarizeCommercialTimings(timingsNs);
    const { p95Ms: p95, p99Ms: p99 } = timingSummaryToMilliseconds(timing);

    adversarialFullPathTiming = timing;
    adversarialMetrics = { p95Ms: p95, p99Ms: p99 };
    if (!useMedianGate) {
      expect(p95).toBeLessThanOrEqual(COMMERCIAL_BENCHMARK_LOCAL_LIMITS.adversarial.p95Ms);
      expect(p99).toBeLessThanOrEqual(COMMERCIAL_BENCHMARK_LOCAL_LIMITS.adversarial.p99Ms);
    }
  });
});
