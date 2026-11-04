import { Injectable } from '@nestjs/common';
import {
  commercialAdsPolicySchema,
  resolveCommercialAdsPolicy,
  type CommercialAdCategory,
} from '@maxim/contracts/settings';
import { PrismaService } from '../../prisma/prisma.service';
import type { ChatSettings } from '../../prisma/prisma-client';
import { resolveCommercialThresholds } from '../rule-engine-commercial-thresholds';
import { CommercialAdDetector, type CommercialDetection } from './commercial-ad.detector';
import {
  normalizeCommercialRawText,
  normalizePreparedCommercialText,
} from './commercial-normalization';
import { collectCommercialSignals } from './commercial-features';
import { deriveCommercialSafeContextBucket } from './commercial-safe-context';
import { classifyCommercialDetection } from './commercial-subtypes';
import {
  fingerprintCommercialDeleteSettings,
  type CommercialDeleteSettings,
} from './commercial-delete-binding';
import {
  commercialLlmMayDelete,
  commercialLlmPolicyMayDeletePersonalSale,
  type CommercialLlmSource,
} from './commercial-llm-enforcement.protocol';
import type { CommercialLlmObservationResult } from './commercial-llm.protocol';

let detector: CommercialAdDetector | undefined;
const CATEGORY_BY_SUBTYPE: Readonly<Record<string, CommercialAdCategory | undefined>> = {
  SERVICES: 'SERVICES',
  INFO_PRODUCT: 'SERVICES',
  PROPERTY_AGENT: 'SERVICES',
  GOODS: 'BUSINESS',
  GOODS_RETAIL: 'BUSINESS',
  BUYOUT: 'BUSINESS',
  PROPERTY_COMMERCIAL: 'BUSINESS',
  RECRUITMENT: 'BUSINESS',
  GROUP_PROMOTION: 'COMMUNITIES',
  CHANNEL_PLACEMENT: 'COMMUNITIES',
};

export function commercialAdsDetectionCategories(
  detection: CommercialDetection | null,
  result?: Pick<CommercialLlmObservationResult, 'classification' | 'reasonCodes'>,
): CommercialAdCategory[] {
  if (result?.classification === 'NOT_COMMERCIAL') {
    return result.reasonCodes.length === 1 && result.reasonCodes[0] === 'PERSONAL_SALE'
      ? ['PERSONAL_SALE']
      : [];
  }
  if (result?.classification === 'UNSURE') return [];
  if (detection?.safeContextBucket === 'private_one_off_sale') return ['PERSONAL_SALE'];
  const categories = new Set<CommercialAdCategory>();
  if (detection) {
    for (const subtype of [detection.primarySubtype, ...detection.supportingSubtypes]) {
      const category = CATEGORY_BY_SUBTYPE[subtype];
      if (category) categories.add(category);
    }
  }
  if (result?.reasonCodes.includes('COMMERCIAL_COMMUNITY')) categories.add('COMMUNITIES');
  return [...categories];
}

export function detectCommercialAdsCategories(
  text: string,
  settings: CommercialDeleteSettings,
  result?: Pick<CommercialLlmObservationResult, 'classification' | 'reasonCodes'>,
): CommercialAdCategory[] {
  const rawLoweredText = normalizeCommercialRawText(text);
  const normalizedText = normalizePreparedCommercialText(rawLoweredText);
  const detection = (detector ??= new CommercialAdDetector()).detect({
    normalizedText,
    rawLoweredText,
    settings: settings as ChatSettings,
    commercialCampaignContext: null,
  });
  const categories = commercialAdsDetectionCategories(detection, result);
  if (categories.length > 0 || result?.classification !== 'COMMERCIAL') return categories;

  // FLAG: AI supplies commercial authority; existing signals supply only its category.
  // Detector effect thresholds cannot erase a recognized subtype, or authorize a new effect.
  const appliedThresholds = resolveCommercialThresholds(settings);
  const state = collectCommercialSignals({
    normalizedText,
    rawLoweredText,
    profile: appliedThresholds,
    commercialCampaignContext: null,
  });
  if (
    deriveCommercialSafeContextBucket({
      text: rawLoweredText,
      matchedSignals: state.matchedSignals,
      negativeSignals: state.negativeSignals,
      // FLAG: A coarse AI label cannot erase protected context absent a detector hit.
      hasCommercialHit: detection !== null,
    }) !== 'none'
  ) {
    return [];
  }
  const confidenceScore = Math.round(Math.max(0, Math.min(100, state.score)));
  const classification = classifyCommercialDetection({
    state,
    confidenceScore,
    decisionBand:
      confidenceScore >= appliedThresholds.deleteThreshold
        ? 'HIGH'
        : confidenceScore >= appliedThresholds.warnThreshold
          ? 'MEDIUM'
          : 'LOW',
    appliedThresholds,
    hasCampaignDependentEvidence: false,
  });
  return [
    ...new Set(
      [classification.primarySubtype, ...classification.supportingSubtypes]
        .map((subtype) => CATEGORY_BY_SUBTYPE[subtype])
        .filter((category): category is CommercialAdCategory => category !== undefined),
    ),
  ];
}

export function evaluateCommercialAdsAiPolicy(input: {
  text: string;
  settings: CommercialDeleteSettings;
  source: CommercialLlmSource;
  result: CommercialLlmObservationResult;
}) {
  const { settings, source, result } = input;
  const categories = detectCommercialAdsCategories(input.text, settings, result);
  const policy = resolveCommercialAdsPolicy({
    policy: settings.commercialAdsPolicy,
    categories,
    userId: source.userId,
  });
  if (settings.commercialAdsPolicy == null) {
    return { ...policy, mayDelete: source.version !== 3 && commercialLlmMayDelete(result, source) };
  }
  const parsed = commercialAdsPolicySchema.safeParse(settings.commercialAdsPolicy);
  // FLAG: Explicit policy sources cannot borrow a legacy proof or an unrelated category decision.
  const bound =
    source.version === 3 &&
    parsed.success &&
    source.personalSaleBlocked === (parsed.data.categories.PERSONAL_SALE === 'BLOCK');
  return {
    ...policy,
    mayDelete:
      bound &&
      policy.decision === 'BLOCK' &&
      // FLAG: A coarse positive cannot turn deterministic private context into 4B authority.
      (categories.includes('PERSONAL_SALE')
        ? commercialLlmPolicyMayDeletePersonalSale(result, source)
        : commercialLlmMayDelete(result, source)),
  };
}

@Injectable()
export class CommercialAdsRuntimePolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async evaluateAi(
    source: CommercialLlmSource,
    text: string,
    result: CommercialLlmObservationResult,
  ) {
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId: source.chatId },
    });
    if (
      !settings ||
      !settings.commercialAdsFilterEnabled ||
      fingerprintCommercialDeleteSettings(settings) !== source.settingsSha256
    ) {
      return { mayDelete: false, categories: [] as CommercialAdCategory[] };
    }
    return evaluateCommercialAdsAiPolicy({ source, text, result, settings });
  }
}
