import { Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ChatSettings } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256 } from '../commercial-ocr/commercial-ocr-detector-source.generated';
import { raceWithTimeout } from '../../common/promise-timeout.util';
import { RedisCounterService } from '../redis-counter.service';
import {
  COMMERCIAL_TEXT_BASELINE_POLICY_COHORTS,
  COMMERCIAL_TEXT_POLICY_COHORTS,
  commercialTextDecisionVersionForCohorts,
  COMMERCIAL_INTENT_QUALITY_COHORT,
  COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
} from './commercial-policy-cohorts';
export {
  COMMERCIAL_TEXT_BASELINE_POLICY_COHORTS,
  COMMERCIAL_TEXT_POLICY_COHORTS,
  commercialTextDecisionVersionForCohorts,
} from './commercial-policy-cohorts';

export const COMMERCIAL_TEXT_CONTROL_KEY = 'commercial-text:runtime-control:v1';
export function commercialQualityStopKey(detectorSourceSha256: string): string {
  return `commercial-text:quality-stop:v1:${detectorSourceSha256}:${COMMERCIAL_INTENT_QUALITY_DECISION_VERSION}`;
}
export const commercialTextControlSchema = z
  .object({
    version: z.literal(2),
    revision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER - 1),
    mode: z.enum(['baseline', 'shadow', 'canary', 'on', 'off']),
    chatIds: z.array(z.string().min(1).max(100)).max(1000),
    promotedPolicyCohorts: z.array(z.enum(COMMERCIAL_TEXT_POLICY_COHORTS)).max(3),
    detectorSourceSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable()
      .default(null),
    decisionVersion: z.string().min(1).max(100).nullable().default(null),
    holdoutArtifactSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable()
      .default(null),
    settingsProfileDigests: z
      .array(z.string().regex(/^[a-f0-9]{64}$/u))
      .max(10)
      .default([]),
    effectiveAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
    canaryStartedAt: z.iso.datetime().nullable().default(null),
  })
  .strict();
export type CommercialTextControl = z.infer<typeof commercialTextControlSchema>;
export type CommercialTextAuthority = {
  revision: number;
  baselineAllowed: boolean;
  promotedPolicyCohorts: readonly string[];
  mode: CommercialTextControl['mode'] | 'unavailable';
};

@Injectable()
export class CommercialTextRuntimePolicyService {
  constructor(
    private readonly redis: RedisCounterService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async snapshot(): Promise<{ revision: number; control: CommercialTextControl | null }> {
    const [raw, revisionRaw] = await raceWithTimeout({
      operation: this.redis.getStrings([
        COMMERCIAL_TEXT_CONTROL_KEY,
        `${COMMERCIAL_TEXT_CONTROL_KEY}:revision`,
      ]),
      timeoutMs: 750,
      onTimeout: () => {
        throw new Error('Commercial text policy unavailable');
      },
    });
    const revision = revisionRaw === null ? 0 : Number(revisionRaw);
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      (revisionRaw !== null && String(revision) !== revisionRaw)
    )
      throw new Error('Invalid commercial text policy revision');
    if (raw === null) return { revision, control: null };
    const control = commercialTextControlSchema.parse(JSON.parse(raw));
    if (control.revision !== revision)
      throw new Error('Commercial text policy changed during read');
    return { revision, control };
  }

  async authority(
    chatId: string,
    settingsProfileDigest?: string,
  ): Promise<CommercialTextAuthority> {
    try {
      const { revision, control } = await this.snapshot();
      if (!control || (control.expiresAt && Date.parse(control.expiresAt) <= Date.now()))
        return {
          revision,
          mode: 'baseline',
          baselineAllowed: true,
          promotedPolicyCohorts: [...COMMERCIAL_TEXT_BASELINE_POLICY_COHORTS],
        };
      if (Date.parse(control.effectiveAt) > Date.now())
        return {
          revision,
          mode: 'baseline',
          baselineAllowed: true,
          promotedPolicyCohorts: [...COMMERCIAL_TEXT_BASELINE_POLICY_COHORTS],
        };
      if (control.mode === 'baseline')
        return {
          revision,
          mode: 'baseline',
          baselineAllowed: true,
          promotedPolicyCohorts: [...COMMERCIAL_TEXT_BASELINE_POLICY_COHORTS],
        };
      const promoted =
        (control.mode === 'on' ||
          (control.mode === 'canary' && control.chatIds.includes(chatId))) &&
        control.detectorSourceSha256 === COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256 &&
        control.decisionVersion ===
          commercialTextDecisionVersionForCohorts(control.promotedPolicyCohorts) &&
        control.holdoutArtifactSha256 !== null &&
        settingsProfileDigest !== undefined &&
        control.settingsProfileDigests.includes(settingsProfileDigest);
      const quality = control.promotedPolicyCohorts.includes(COMMERCIAL_INTENT_QUALITY_COHORT);
      const qualityBlocked =
        quality &&
        promoted &&
        ((control.mode === 'on' &&
          (!control.canaryStartedAt ||
            Date.now() - Date.parse(control.canaryStartedAt) < 7 * 86_400_000)) ||
          (await this.qualityStopped(COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256)));
      return {
        revision,
        mode: control.mode,
        baselineAllowed: control.mode !== 'off',
        promotedPolicyCohorts: promoted && !qualityBlocked ? control.promotedPolicyCohorts : [],
      };
    } catch {
      // FLAG: An unknown authority cannot authorize a delete, strike or sanction.
      return {
        revision: -1,
        mode: 'unavailable',
        baselineAllowed: false,
        promotedPolicyCohorts: [],
      };
    }
  }

  async set(control: z.input<typeof commercialTextControlSchema>, expectedRevision: number) {
    const parsed = commercialTextControlSchema.parse(control);
    const now = Date.now();
    if (parsed.revision !== expectedRevision + 1 || Date.parse(parsed.effectiveAt) > now + 30_000)
      throw new Error('Invalid commercial text control revision/time');
    if (parsed.mode === 'canary' && !parsed.chatIds.length)
      throw new Error('Canary requires an explicit chat cohort');
    if (new Set(parsed.chatIds).size !== parsed.chatIds.length)
      throw new Error('Duplicate commercial text chat cohort');
    if (
      parsed.promotedPolicyCohorts.length &&
      ['canary', 'on'].includes(parsed.mode) &&
      (parsed.detectorSourceSha256 !== COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256 ||
        parsed.decisionVersion !==
          commercialTextDecisionVersionForCohorts(parsed.promotedPolicyCohorts) ||
        !parsed.holdoutArtifactSha256 ||
        !parsed.settingsProfileDigests.length)
    )
      throw new Error('Promotion requires current detector and reviewed settings evidence');
    const expiry = parsed.expiresAt === null ? null : Date.parse(parsed.expiresAt);
    if (expiry === null && parsed.mode !== 'off' && parsed.mode !== 'baseline')
      throw new Error('Promotions require a finite lifetime');
    if (expiry !== null && (expiry <= now || expiry > now + 86_400_000))
      throw new Error('Commercial text control must expire within 24 hours');
    // FLAG: The canary clock is server-owned and survives only uninterrupted renewals of
    // the identical reviewed policy and exact cohort. A supplied timestamp cannot start it early.
    parsed.canaryStartedAt = null;
    if (
      parsed.promotedPolicyCohorts.includes(COMMERCIAL_INTENT_QUALITY_COHORT) &&
      ['canary', 'on'].includes(parsed.mode)
    ) {
      if (await this.qualityStopped(COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256))
        throw new Error('Quality policy stopped after a confirmed false deletion');
      const previous = await this.snapshot();
      if (previous.revision !== expectedRevision)
        throw new Error('Commercial text control revision changed');
      const prior = previous.control;
      const samePolicy =
        prior !== null &&
        ['canary', 'on'].includes(prior.mode) &&
        prior.expiresAt !== null &&
        Date.parse(prior.expiresAt) > now &&
        Date.parse(prior.effectiveAt) <= now &&
        prior.detectorSourceSha256 === parsed.detectorSourceSha256 &&
        prior.decisionVersion === parsed.decisionVersion &&
        JSON.stringify([...prior.settingsProfileDigests].sort()) ===
          JSON.stringify([...parsed.settingsProfileDigests].sort()) &&
        JSON.stringify([...prior.promotedPolicyCohorts].sort()) ===
          JSON.stringify([...parsed.promotedPolicyCohorts].sort());
      const sameChats =
        samePolicy &&
        JSON.stringify([...prior.chatIds].sort()) === JSON.stringify([...parsed.chatIds].sort());
      if (parsed.mode === 'canary')
        parsed.canaryStartedAt =
          sameChats && prior.mode === 'canary' && prior.canaryStartedAt
            ? prior.canaryStartedAt
            : new Date(now).toISOString();
      else {
        if (
          !samePolicy ||
          !prior.canaryStartedAt ||
          now - Date.parse(prior.canaryStartedAt) < 7 * 86_400_000 ||
          prior.chatIds.some((chat) => !parsed.chatIds.includes(chat))
        )
          throw new Error(
            'Quality expansion requires an uninterrupted reviewed seven-day explicit-chat canary',
          );
        parsed.canaryStartedAt = prior.canaryStartedAt;
      }
    }
    return this.redis.compareAndSetRevisionedControl({
      key: COMMERCIAL_TEXT_CONTROL_KEY,
      expectedRevision,
      value: JSON.stringify(parsed),
      expiresAtMs: expiry,
    });
  }

  private async qualityStopped(detectorSourceSha256: string): Promise<boolean> {
    if (!this.prisma) throw new Error('Durable quality stop authority unavailable');
    const stopped = await raceWithTimeout({
      operation: this.prisma.commercialQualityPolicyStop.findUnique({
        where: {
          detectorSourceSha256_decisionVersion: {
            detectorSourceSha256,
            decisionVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
          },
        },
        select: { stoppedAt: true },
      }),
      timeoutMs: 750,
      onTimeout: () => {
        throw new Error('Durable quality stop authority unavailable');
      },
    });
    if (stopped !== null) return true;
    return raceWithTimeout({
      operation: this.redis.getString(commercialQualityStopKey(detectorSourceSha256)),
      timeoutMs: 750,
      onTimeout: () => {
        throw new Error('Quality stop authority unavailable');
      },
    }).then((value) => value !== null);
  }

  async stopQualityAfterConfirmedFalseDeletion(input: {
    detectorSourceSha256: string;
    decisionVersion: string;
  }): Promise<boolean> {
    if (
      !/^[a-f0-9]{64}$/u.test(input.detectorSourceSha256) ||
      input.decisionVersion !== COMMERCIAL_INTENT_QUALITY_DECISION_VERSION
    )
      return false;
    if (!this.prisma) throw new Error('Durable quality stop authority unavailable');
    await this.prisma.commercialQualityPolicyStop.upsert({
      where: { detectorSourceSha256_decisionVersion: input },
      create: { ...input, stoppedAt: new Date() },
      update: {},
    });
    // FLAG: A resolved independent false deletion revokes only this exact experimental behavior.
    // It cannot authorize a strike or sanction and cannot be cleared by a later control renewal.
    try {
      await this.redis.compareAndSetRevisionedControl({
        key: commercialQualityStopKey(input.detectorSourceSha256),
        expectedRevision: 0,
        expiresAtMs: null,
        value: JSON.stringify({
          revision: 1,
          detectorSourceSha256: input.detectorSourceSha256,
          decisionVersion: input.decisionVersion,
          stoppedAt: new Date().toISOString(),
        }),
      });
    } catch {
      /* FLAG: Durable DB revocation is authoritative even while Redis is unavailable. */
    }
    return true;
  }
}

export function fingerprintCommercialTextSettingsProfile(
  settings: Pick<
    ChatSettings,
    'commercialAdsSensitivity' | 'commercialAdsWarnThreshold' | 'commercialAdsDeleteThreshold'
  >,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        settings.commercialAdsSensitivity,
        settings.commercialAdsWarnThreshold,
        settings.commercialAdsDeleteThreshold,
      ]),
    )
    .digest('hex');
}
