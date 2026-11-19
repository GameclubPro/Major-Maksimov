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
import { deterministicCommercialCategories } from './commercial-ads-deterministic-categories';

let detector: CommercialAdDetector | undefined;

export function commercialAdsDetectionCategories(
  detection: CommercialDetection | null,
): CommercialAdCategory[] {
  if (detection?.safeContextBucket === 'private_one_off_sale') return ['PERSONAL_SALE'];
  return detection ? deterministicCommercialCategories(detection) : [];
}

type AiDecision = Pick<CommercialLlmObservationResult, 'classification' | 'reasonCodes'>;

function modelCategories(result: AiDecision): CommercialAdCategory[] {
  if (result.classification === 'NOT_COMMERCIAL') {
    return result.reasonCodes.length === 1 && result.reasonCodes[0] === 'PERSONAL_SALE'
      ? ['PERSONAL_SALE']
      : [];
  }
  if (result.classification !== 'COMMERCIAL') return [];
  // FLAG: Incidental lexical subtypes cannot widen the model's explicit set of offered categories.
  const categories: CommercialAdCategory[] = [];
  if (result.reasonCodes.includes('SERVICE_OFFER')) categories.push('SERVICES');
  if (result.reasonCodes.includes('BUSINESS_OFFER')) categories.push('BUSINESS');
  if (result.reasonCodes.includes('COMMERCIAL_COMMUNITY')) categories.push('COMMUNITIES');
  return categories;
}

export function detectCommercialAdsCategories(
  text: string,
  settings: CommercialDeleteSettings,
  result?: Pick<CommercialLlmObservationResult, 'classification' | 'reasonCodes'>,
): CommercialAdCategory[] {
  const categories = result ? modelCategories(result) : null;
  if (categories?.length === 0) return [];
  const rawLoweredText = normalizeCommercialRawText(text);
  const normalizedText = normalizePreparedCommercialText(rawLoweredText);
  const detection = (detector ??= new CommercialAdDetector()).detect({
    normalizedText,
    rawLoweredText,
    settings: settings as ChatSettings,
    commercialCampaignContext: null,
  });
  if (categories === null) return commercialAdsDetectionCategories(detection);

  let safeContext = detection?.safeContextBucket;
  if (safeContext === undefined) {
    const state = collectCommercialSignals({
      normalizedText,
      rawLoweredText,
      profile: resolveCommercialThresholds(settings),
      commercialCampaignContext: null,
    });
    // FLAG: The same buyer and quoted-discussion veto also applies to a 9B personal-sale label.
    safeContext = deriveCommercialSafeContextBucket({
      text: rawLoweredText,
      matchedSignals: state.matchedSignals,
      negativeSignals: state.negativeSignals,
      hasCommercialHit: detection !== null,
    });
  }
  if (safeContext === 'private_one_off_sale') return ['PERSONAL_SALE'];
  return safeContext === 'none' ? categories : [];
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
    if (source.version === 3 && modelCategories(result).length === 0)
      return { mayDelete: false, categories: [] as CommercialAdCategory[] };
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
