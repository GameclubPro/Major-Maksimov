import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  resolveCommercialAdsPolicy,
  type CommercialAdsPreviewRequest,
  type CommercialAdsPreviewResponse,
} from '@maxim/contracts/settings';
import {
  CommercialTextRuntimePolicyService,
  fingerprintCommercialTextSettingsProfile,
} from './commercial-text-runtime-policy.service';
import { CommercialAdDetector } from './commercial-ad.detector';
import { isCommercialMessageDeleteEligible } from './commercial-action-policy';
import {
  commercialAdsDetectionCategories,
  detectCommercialAdsCategories,
} from './commercial-ads-runtime-policy.service';
import {
  normalizeCommercialRawText,
  normalizePreparedCommercialText,
} from './commercial-normalization';
import { collectCommercialSignals } from './commercial-features';
import { deriveCommercialSafeContextBucket } from './commercial-safe-context';
import { resolveCommercialThresholds } from '../rule-engine-commercial-thresholds';
import type { CommercialDeleteSettings } from './commercial-delete-binding';
import { CommercialLlmError } from './commercial-llm.client';
import { commercialLlmHasPinnedServerIdentity } from './commercial-llm-enforcement.protocol';
import { createCommercialLlmRedis } from './commercial-llm-shadow.lease';
import { CommercialLlmPreviewMailbox } from './commercial-llm-preview.mailbox';
import {
  sanitizeCommercialMessageExcerpt,
  hasResidualCommercialContactCandidate,
} from '../../scripts/commercial-corpus-sanitization.util';

@Injectable()
export class CommercialAdsPreviewService {
  private readonly detector = new CommercialAdDetector();
  private busy = false;

  constructor(
    private readonly config: ConfigService,
    @Inject(CommercialTextRuntimePolicyService)
    private readonly textPolicy: Pick<CommercialTextRuntimePolicyService, 'authority'>,
  ) {}

  async preview(
    input: CommercialAdsPreviewRequest,
    settings: CommercialDeleteSettings,
    chatId: string,
  ): Promise<CommercialAdsPreviewResponse> {
    if (!input.enabled) return { decision: 'KEEP', categories: [], reason: 'FILTER_DISABLED' };
    const effective = {
      ...settings,
      ...input.classification,
      commercialAdsFilterEnabled: true,
      commercialAdsPolicy: input.policy,
    };
    const aiEnabled =
      this.config.get<boolean>('COMMERCIAL_LLM_ENFORCEMENT_ENABLED', false) === true;
    const authority = aiEnabled
      ? null
      : await this.textPolicy.authority(
          chatId,
          fingerprintCommercialTextSettingsProfile(effective),
        );
    if (authority?.mode === 'unavailable') return this.unavailable();
    if (authority?.baselineAllowed === false)
      return { decision: 'KEEP', categories: [], reason: 'FILTER_DISABLED' };
    const rawLoweredText = normalizeCommercialRawText(input.text);
    const detection = aiEnabled
      ? null
      : this.detector.detect({
          normalizedText: normalizePreparedCommercialText(rawLoweredText),
          rawLoweredText,
          settings: effective as import('../../prisma/prisma-client').ChatSettings,
          commercialCampaignContext: null,
          promotedPolicyCohorts: authority?.promotedPolicyCohorts,
        });
    let categories = commercialAdsDetectionCategories(detection);
    let advertising = !!detection;
    let eligible =
      !!detection &&
      isCommercialMessageDeleteEligible(
        detection.actionBand ?? null,
        detection.actionable === true,
        detection.messageDisposition,
      );
    if (!aiEnabled && !detection && input.policy !== null) {
      const state = collectCommercialSignals({
        normalizedText: normalizePreparedCommercialText(rawLoweredText),
        rawLoweredText,
        profile: resolveCommercialThresholds(effective),
        commercialCampaignContext: null,
      });
      // FLAG: Existing safe-context evidence can explain a private sale; it never grants
      // deterministic deletion authority to a negative or substitutes for a pinned 9B decision.
      if (
        deriveCommercialSafeContextBucket({
          text: rawLoweredText,
          matchedSignals: state.matchedSignals,
          negativeSignals: state.negativeSignals,
          hasCommercialHit: false,
        }) === 'private_one_off_sale'
      ) {
        categories = ['PERSONAL_SALE'];
        advertising = true;
      }
    }
    if (aiEnabled) {
      if (this.busy) return this.unavailable();
      this.busy = true;
      let redis: ReturnType<typeof createCommercialLlmRedis> | undefined;
      try {
        const excerpt = sanitizeCommercialMessageExcerpt(input.text);
        if (
          !excerpt.trim() ||
          excerpt.length > 2500 ||
          hasResidualCommercialContactCandidate(excerpt)
        )
          return this.unavailable();
        redis = createCommercialLlmRedis(this.config.getOrThrow<string>('REDIS_URL'));
        await redis.connect();
        const result = await new CommercialLlmPreviewMailbox(redis).classify(excerpt);
        if (!commercialLlmHasPinnedServerIdentity(result))
          throw new CommercialLlmError('INVALID_RESPONSE');
        categories = detectCommercialAdsCategories(excerpt, effective, result);
        if (input.policy !== null && categories.length && input.text !== excerpt) {
          // FLAG: The runner evaluates its input and the dispatch guard evaluates the exact source.
          const sourceCategories = detectCommercialAdsCategories(input.text, effective, result);
          if (sourceCategories.join() !== categories.join()) categories = [];
        }
        advertising =
          result.classification === 'COMMERCIAL' || categories.includes('PERSONAL_SALE');
        eligible = categories.includes('PERSONAL_SALE')
          ? result.classification === 'NOT_COMMERCIAL' &&
            result.reasonCodes.length === 1 &&
            result.reasonCodes[0] === 'PERSONAL_SALE'
          : result.classification === 'COMMERCIAL';
        if (result.classification === 'UNSURE')
          return { decision: 'UNSURE', categories: [], reason: 'INSUFFICIENT_CONTEXT' };
      } catch {
        return this.unavailable();
      } finally {
        redis?.disconnect();
        this.busy = false;
      }
    }
    if (!advertising) return { decision: 'KEEP', categories: [], reason: 'NOT_ADVERTISING' };
    const policy = resolveCommercialAdsPolicy({
      policy: input.policy,
      categories,
      userId: input.userId,
    });
    if (policy.decision === 'LEGACY')
      return {
        decision: eligible && !categories.includes('PERSONAL_SALE') ? 'DELETE' : 'KEEP',
        categories,
        reason:
          eligible && !categories.includes('PERSONAL_SALE')
            ? 'BLOCKED_CATEGORY'
            : 'NOT_ADVERTISING',
      };
    return {
      decision: policy.decision === 'BLOCK' ? (eligible ? 'DELETE' : 'UNSURE') : policy.decision,
      categories,
      reason: policy.decision === 'BLOCK' && !eligible ? 'INSUFFICIENT_CONTEXT' : policy.reason,
      ...(policy.matchedExceptionIds[0]
        ? { matchedExceptionId: policy.matchedExceptionIds[0] }
        : {}),
    };
  }

  private unavailable(): CommercialAdsPreviewResponse {
    return { decision: 'UNAVAILABLE', categories: [], reason: 'CLASSIFIER_UNAVAILABLE' };
  }
}
