import { createHash } from 'node:crypto';
import type { CommercialCampaignContext } from './commercial-campaign.util';
import type { CommercialDecisionBand, CommercialSubtype } from './rule-engine.contract';
import type { CommercialThresholdProfile } from './rule-engine-commercial-thresholds';
import type {
  CommercialClassification,
  CommercialSignalState,
} from './commercial/commercial.types';

export const COMMERCIAL_SECOND_STAGE_VERSION = '2026-service-private-v6';

export type CommercialSecondStageDecision = {
  adjustedConfidenceScore: number;
  primarySubtype: CommercialSubtype;
  supportingSubtypes: CommercialSubtype[];
  reviewRecommended: boolean;
  reviewReasons: string[];
  classifierVersion: string;
  commercialProbability: number;
  reviewProbability: number;
  classifierReasons: string[];
};

export type CommercialSecondStageInput = {
  normalizedText: string;
  rawLoweredText: string;
  state: CommercialSignalState;
  confidenceScore: number;
  decisionBand: CommercialDecisionBand;
  appliedThresholds: CommercialThresholdProfile;
  classification: CommercialClassification;
  commercialCampaignContext?: CommercialCampaignContext | null;
};

export class CommercialSecondStageDecisionCache {
  private readonly decisions = new Map<string, CommercialSecondStageDecision>();

  constructor(private readonly maxEntries = 4096) {}

  buildKey(params: CommercialSecondStageInput): string {
    // FLAG: Raw layout, all signal/classification inputs and exact numeric values affect scoring.
    // Retain only the digest, never message text, in this bounded process-local cache.
    return createHash('sha256')
      .update(COMMERCIAL_SECOND_STAGE_VERSION)
      .update(JSON.stringify(params))
      .digest('hex');
  }

  read(cacheKey: string): CommercialSecondStageDecision | null {
    const cached = this.decisions.get(cacheKey);
    if (!cached) {
      return null;
    }

    this.decisions.delete(cacheKey);
    this.decisions.set(cacheKey, cached);
    return cloneDecision(cached);
  }

  remember(cacheKey: string, decision: CommercialSecondStageDecision): void {
    this.decisions.delete(cacheKey);
    this.decisions.set(cacheKey, cloneDecision(decision));
    if (this.decisions.size <= this.maxEntries) {
      return;
    }

    const oldestKey = this.decisions.keys().next().value;
    if (typeof oldestKey === 'string') {
      this.decisions.delete(oldestKey);
    }
  }

  get size(): number {
    return this.decisions.size;
  }
}

function cloneDecision(decision: CommercialSecondStageDecision): CommercialSecondStageDecision {
  return {
    ...decision,
    supportingSubtypes: [...decision.supportingSubtypes],
    reviewReasons: [...decision.reviewReasons],
    classifierReasons: [...decision.classifierReasons],
  };
}
