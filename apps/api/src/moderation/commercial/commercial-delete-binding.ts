import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ChatSettings } from '../../prisma/prisma-client';
import type { CommercialCampaignContext } from '../commercial-campaign.util';
import type { EnsureModerationDeleteIntentInput } from '../moderation-delete-intent.types';
import { COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256 } from '../commercial-ocr/commercial-ocr-detector-source.generated';
import {
  COMMERCIAL_TEXT_POLICY_COHORTS,
  commercialTextDecisionVersionForCohorts,
} from './commercial-policy-cohorts';

export const COMMERCIAL_TEXT_DELETE_RULE_CODE = 'COMMERCIAL_AD_DELETE';
export const COMMERCIAL_TEXT_DELETE_BINDING_VERSION = 2 as const;
export const COMMERCIAL_TEXT_DELETE_MAX_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 30_000;

export type CommercialDeleteSettings = Pick<
  ChatSettings,
  | 'commercialAdsFilterEnabled'
  | 'commercialAdsSensitivity'
  | 'commercialAdsWarnThreshold'
  | 'commercialAdsDeleteThreshold'
  | 'nightModeTimezone'
  | 'textFiltersWarnEnabled'
  | 'textFiltersMuteEnabled'
  | 'textFiltersBanEnabled'
  | 'textFiltersMuteDurationHours'
  | 'textFiltersBotMessageEnabled'
> & { commercialAdsPolicy?: unknown };

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const campaignSchema = z
  .object({
    senderDistinctChatCount: counter,
    sameTextDistinctChatCount: counter,
    repeatedPhoneDistinctChatCount: counter,
    repeatedLinkDistinctChatCount: counter,
    nearTextDistinctChatCount: counter.optional(),
    repeatedDomainDistinctChatCount: counter.optional(),
    repeatedHandleDistinctChatCount: counter.optional(),
    senderDistinctChatCount5m: counter.optional(),
    senderDistinctChatCount30m: counter.optional(),
    senderDistinctChatCount120m: counter.optional(),
    shadowSlidingSenderDistinctChatCount5m: counter.optional(),
    shadowSlidingSenderDistinctChatCount30m: counter.optional(),
    shadowSlidingSenderDistinctChatCount120m: counter.optional(),
  })
  .strict();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const bindingSchema = z
  .object({
    version: z.literal(COMMERCIAL_TEXT_DELETE_BINDING_VERSION),
    decisionVersion: z.string().min(1).max(100),
    detectorSourceSha256: sha256,
    sourceSha256: sha256,
    settingsSha256: sha256,
    eventTimestampMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    deadlineAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    campaignContext: campaignSchema.nullable(),
    textRuntimeRevision: z.number().int().nonnegative().default(0),
    requiredPolicyCohorts: z.array(z.enum(COMMERCIAL_TEXT_POLICY_COHORTS)).max(3).default([]),
  })
  .strict();
export type CommercialTextDeleteBinding = z.infer<typeof bindingSchema>;

export function fingerprintCommercialDeleteText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function fingerprintCommercialDeleteSettings(settings: CommercialDeleteSettings): string {
  return createHash('sha256')
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
        // FLAG: Null policy retains the exact legacy digest; explicit policy revokes older proofs.
        ...(settings.commercialAdsPolicy == null ? [] : [settings.commercialAdsPolicy]),
      ]),
    )
    .digest('hex');
}

export function buildCommercialTextDeleteBinding(params: {
  text: string;
  settings: CommercialDeleteSettings;
  eventTimestampMs: number;
  campaignContext: CommercialCampaignContext | null;
  textRuntimeRevision?: number;
  requiredPolicyCohorts?: readonly string[];
}): CommercialTextDeleteBinding {
  return bindingSchema.parse({
    version: COMMERCIAL_TEXT_DELETE_BINDING_VERSION,
    decisionVersion: commercialTextDecisionVersionForCohorts(params.requiredPolicyCohorts ?? []),
    detectorSourceSha256: COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256,
    sourceSha256: fingerprintCommercialDeleteText(params.text),
    settingsSha256: fingerprintCommercialDeleteSettings(params.settings),
    eventTimestampMs: params.eventTimestampMs,
    deadlineAtMs: params.eventTimestampMs + COMMERCIAL_TEXT_DELETE_MAX_AGE_MS,
    campaignContext: params.campaignContext,
    textRuntimeRevision: params.textRuntimeRevision ?? 0,
    requiredPolicyCohorts: params.requiredPolicyCohorts ?? [],
  });
}

export function readCommercialTextDeleteBinding(
  value: unknown,
): CommercialTextDeleteBinding | null {
  const parsed = bindingSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function isCommercialTextDeleteBindingCurrent(
  binding: CommercialTextDeleteBinding,
  settings: CommercialDeleteSettings,
  now = Date.now(),
): boolean {
  return (
    binding.decisionVersion ===
      commercialTextDecisionVersionForCohorts(binding.requiredPolicyCohorts) &&
    binding.detectorSourceSha256 === COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256 &&
    binding.settingsSha256 === fingerprintCommercialDeleteSettings(settings) &&
    binding.eventTimestampMs <= now + MAX_FUTURE_SKEW_MS &&
    binding.deadlineAtMs === binding.eventTimestampMs + COMMERCIAL_TEXT_DELETE_MAX_AGE_MS &&
    now < binding.deadlineAtMs
  );
}

export function commercialTextDeleteReasonKey(binding: CommercialTextDeleteBinding): string {
  return `COMMERCIAL_AD:violation-delete:v1:${binding.eventTimestampMs}:${binding.sourceSha256}`;
}

export function bindCommercialTextDeleteIntent(
  input: EnsureModerationDeleteIntentInput,
  context: {
    text: string;
    settings: CommercialDeleteSettings;
    campaignContext: CommercialCampaignContext | null;
  },
): EnsureModerationDeleteIntentInput {
  if (input.ruleCode !== COMMERCIAL_TEXT_DELETE_RULE_CODE) return input;
  const eventMetadata = input.event?.metadata;
  const metadataRecord =
    eventMetadata && typeof eventMetadata === 'object' && !Array.isArray(eventMetadata)
      ? (eventMetadata as Record<string, unknown>)
      : {};
  const commercialTextBinding = buildCommercialTextDeleteBinding({
    ...context,
    textRuntimeRevision:
      typeof metadataRecord.commercialTextRuntimeRevision === 'number'
        ? metadataRecord.commercialTextRuntimeRevision
        : 0,
    requiredPolicyCohorts: Array.isArray(metadataRecord.requiredPolicyCohorts)
      ? (metadataRecord.requiredPolicyCohorts as string[])
      : [],
    eventTimestampMs:
      input.sourceMessageAt instanceof Date
        ? input.sourceMessageAt.getTime()
        : Date.parse(input.sourceMessageAt ?? ''),
  });
  const metadata = input.event?.metadata;
  return {
    ...input,
    reasonKey: commercialTextDeleteReasonKey(commercialTextBinding),
    retryUntilAt: new Date(commercialTextBinding.deadlineAtMs),
    event: {
      ...input.event,
      metadata: {
        ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
        commercialTextBinding,
      },
    },
  };
}

export function fingerprintCommercialDeleteReasons(
  reasons: readonly { reasonKey: string; score: number; metadata: unknown }[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        [...reasons]
          .sort((a, b) => a.reasonKey.localeCompare(b.reasonKey))
          .map((reason) => [reason.reasonKey, reason.score, reason.metadata]),
      ),
    )
    .digest('hex');
}
