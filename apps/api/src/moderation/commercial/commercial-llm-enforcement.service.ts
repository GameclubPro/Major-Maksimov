import type { MaxUpdate } from '@maxim/contracts';
import type { CommercialDeleteSettings } from './commercial-delete-binding';
import {
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { RuleViolation } from '../rule-engine.contract';
import { readExactDeleteOrigin } from '../webhook-effect-origin-context';
import { createCommercialLlmRedis } from './commercial-llm-shadow.lease';
import {
  CommercialLlmEnforcementMailbox,
  type CommercialLlmAdmissionResult,
} from './commercial-llm-enforcement.mailbox';
import { resolveCommercialAiTriage } from './commercial-ai-triage';
import { CommercialLlmPoolAdmissionMailbox } from './commercial-llm-pool-admission.mailbox';
import {
  CommercialAiObservationService,
  commercialAiObservationInputSha256,
} from './commercial-ai-observation.service';
import {
  buildCommercialAiObservationContext,
  CommercialAiObservationGate,
  type CommercialAiObservationContext,
} from './commercial-ai-runtime-observation';
import type { Candidate } from './commercial-review.service';
import {
  buildCommercialLlmOffer,
  prepareCommercialLlmOffer,
  type CommercialLlmOfferRejection,
  type CommercialLlmSource,
  type CommercialLlmPoolPolicy,
} from './commercial-llm-enforcement.protocol';

type AdmissionSkipReason = Exclude<CommercialLlmAdmissionResult, 'accepted'> | 'producer_busy';
type EvaluationExclusion =
  | 'missing_message'
  | 'untrusted_event_time'
  | 'protected_author'
  | 'other_rule';

function evaluationCounts() {
  return {
    scope: 'evaluate_calls_while_enforcement_enabled' as const,
    evaluated: 0,
    forwardedToOffer: 0,
    excluded: 0,
    exclusionReasons: {} as Partial<Record<EvaluationExclusion, number>>,
  };
}

function admissionWindow() {
  return {
    offered: 0,
    eligible: 0,
    ineligible: 0,
    accepted: 0,
    skipped: 0,
    unavailable: 0,
    ineligibleReasons: {} as Partial<Record<CommercialLlmOfferRejection, number>>,
    skipReasons: {} as Partial<Record<AdmissionSkipReason, number>>,
    evaluation: evaluationCounts(),
  };
}

@Injectable()
export class CommercialLlmEnforcementService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(CommercialLlmEnforcementService.name);
  private readonly observationProcessId = randomUUID();
  private redis: Redis | null = null;
  private connecting: Promise<CommercialLlmEnforcementMailbox> | null = null;
  private offering = false;
  private lastLog = 0;
  private readonly counts = {
    offered: 0,
    eligible: 0,
    ineligible: 0,
    accepted: 0,
    skipped: 0,
    unavailable: 0,
  };
  private readonly ineligibleReasons: Partial<Record<CommercialLlmOfferRejection, number>> = {};
  private readonly skipReasons: Partial<Record<AdmissionSkipReason, number>> = {};
  private readonly evaluation = evaluationCounts();
  private timer: NodeJS.Timeout | null = null;
  private readonly observationStartedAtMs = Date.now();
  private readonly windows = new Map<number, ReturnType<typeof admissionWindow>>();
  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly observations?: CommercialAiObservationService,
    @Optional()
    private readonly observationGate: CommercialAiObservationGate = new CommercialAiObservationGate(),
  ) {}

  onModuleInit(): void {
    if (!this.enabled()) return;
    this.timer = setInterval(() => this.logWindows(), 10_000);
    this.timer.unref();
  }

  private logWindows(): void {
    const now = Date.now();
    for (const [startedAt, counts] of this.windows) {
      const inFlight = counts.eligible - counts.accepted - counts.skipped - counts.unavailable;
      if (startedAt + 60_000 > now || inFlight !== 0) continue;
      this.logger.log(
        {
          stage: 'commercial-ai-admission-window',
          schemaVersion: 1,
          ...this.observationIdentity(),
          basis: 'offer_intake_minute',
          scope: 'settled_offers_observed_by_this_process',
          windowStartAt: new Date(startedAt).toISOString(),
          windowEndAt: new Date(startedAt + 60_000).toISOString(),
          observedFromAt: new Date(Math.max(startedAt, this.observationStartedAtMs)).toISOString(),
          intakeBoundaryObserved: this.observationStartedAtMs <= startedAt,
          fleetCoverage: 'not_established',
          windowSelection: 'nonempty_only',
          selectionBasis: 'offers_or_evaluate_calls',
          ...counts,
          ineligibleReasons: { ...counts.ineligibleReasons },
          skipReasons: { ...counts.skipReasons },
          evaluation: {
            ...counts.evaluation,
            exclusionReasons: { ...counts.evaluation.exclusionReasons },
          },
          inFlight,
          settled: true,
        },
        'Closed commercial AI admission window',
      );
      this.windows.delete(startedAt);
    }
  }

  enabled(): boolean {
    return this.config.get<boolean>('COMMERCIAL_LLM_ENFORCEMENT_ENABLED', false) === true;
  }

  poolPolicy(): CommercialLlmPoolPolicy | undefined {
    return this.config.get<boolean>('COMMERCIAL_LLM_POOL_ENABLED', false) === true &&
      this.config.get<boolean>('COMMERCIAL_LLM_POOL_WORKERS_ENABLED', false) === true
      ? this.config.get<CommercialLlmPoolPolicy>(
          'COMMERCIAL_LLM_POOL_4B_POLICY',
          'confirm-positive',
        )
      : undefined;
  }

  private createMailbox(redis: Redis): CommercialLlmEnforcementMailbox {
    return this.poolPolicy()
      ? new CommercialLlmPoolAdmissionMailbox(redis)
      : new CommercialLlmEnforcementMailbox(redis);
  }

  evaluate(
    violations: RuleViolation[],
    update: MaxUpdate,
    settings: CommercialDeleteSettings,
    protectedAuthor: boolean,
    candidate?: Candidate | null,
  ): RuleViolation[] {
    const enabled = this.enabled();
    const routed = routeCommercialAiViolations(violations, enabled);
    const message = update.message;
    const exclusion: EvaluationExclusion | null = !message
      ? 'missing_message'
      : update.eventTimestampSource !== 'payload'
        ? 'untrusted_event_time'
        : protectedAuthor
          ? 'protected_author'
          : routed.length > 0
            ? 'other_rule'
            : null;
    if (enabled) {
      // FLAG: These are calls reaching evaluate, not all logical messages or fleet traffic.
      // One ordered exclusion accounts for each call without changing its moderation decision.
      const window = this.window(Math.floor(Date.now() / 60_000) * 60_000);
      for (const counts of [this.evaluation, window.evaluation]) {
        counts.evaluated += 1;
        counts[exclusion ? 'excluded' : 'forwardedToOffer'] += 1;
        if (exclusion)
          counts.exclusionReasons[exclusion] = (counts.exclusionReasons[exclusion] ?? 0) + 1;
      }
      if (exclusion) this.logCounts();
    }
    if (message && exclusion === null)
      this.offer({
        chatId: message.chatId,
        messageId: message.messageId,
        userId: message.senderId,
        text: message.text,
        eventAt: message.createdAt,
        settings,
        triage: resolveCommercialAiTriage({ text: message.text, violations }),
        observation:
          enabled && candidate ? buildCommercialAiObservationContext(candidate, violations) : null,
      });
    return routed;
  }

  async mailbox(): Promise<CommercialLlmEnforcementMailbox> {
    if (!this.enabled()) throw new Error('Commercial AI enforcement disabled');
    if (this.redis?.status === 'ready') return this.createMailbox(this.redis);
    if (this.connecting) return this.connecting;
    this.redis?.disconnect();
    const redis = createCommercialLlmRedis(this.config.getOrThrow<string>('REDIS_URL'));
    this.redis = redis;
    this.connecting = redis.connect().then(() => this.createMailbox(redis));
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  // FLAG: Optional bounded handoff, never awaited by ordinary moderation. At most one local
  // admission is in flight; dependency loss neither queues work nor retries the original handler.
  offer(
    input: Parameters<typeof buildCommercialLlmOffer>[0] & {
      triage?: ReturnType<typeof resolveCommercialAiTriage>;
      observation?: CommercialAiObservationContext | null;
    },
  ): void {
    if (!this.enabled()) return;
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const window = this.window(minute);
    this.counts.offered += 1;
    window.offered += 1;
    const origin = readExactDeleteOrigin(input.chatId, input.messageId);
    const prepared: ReturnType<typeof prepareCommercialLlmOffer> = origin
      ? prepareCommercialLlmOffer(
          {
            ...input,
            originBotId: origin.sourceExecutionBotId,
            eventAt: origin.sourceEventAt.toISOString(),
            origin: {
              sourceWebhookEventId: origin.sourceWebhookEventId,
              sourceReceivingBotId: origin.sourceReceivingBotId,
              sourceExecutionBotId: origin.sourceExecutionBotId,
              sourceEventAtMs: origin.sourceEventAt.getTime(),
              sourceEvidenceVersion: 1,
            },
          },
          Date.now(),
          this.poolPolicy(),
        )
      : {
          reason: input.settings.commercialAdsFilterEnabled
            ? ('invalid_origin' as const)
            : ('filter_disabled' as const),
        };
    if (!prepared.offer) {
      this.counts.ineligible += 1;
      window.ineligible += 1;
      this.ineligibleReasons[prepared.reason] = (this.ineligibleReasons[prepared.reason] ?? 0) + 1;
      window.ineligibleReasons[prepared.reason] =
        (window.ineligibleReasons[prepared.reason] ?? 0) + 1;
      this.logCounts();
      return;
    }
    const offer = prepared.offer;
    this.counts.eligible += 1;
    window.eligible += 1;
    const trace = {
      ...this.observationIdentity(),
      traceId: offer.source.nonce,
      intakeWindowStartAt: new Date(minute).toISOString(),
    };
    if (this.offering) {
      this.counts.skipped += 1;
      window.skipped += 1;
      this.skipReasons.producer_busy = (this.skipReasons.producer_busy ?? 0) + 1;
      window.skipReasons.producer_busy = (window.skipReasons.producer_busy ?? 0) + 1;
      this.logger.log(
        { stage: 'commercial-ai-offer', ...trace, outcome: 'producer_busy' },
        'Commercial AI admission',
      );
      this.logCounts();
      return;
    }
    this.offering = true;
    void this.mailbox()
      .then((mailbox) =>
        mailbox.offerDetailed(
          offer,
          input.observation && this.observations
            ? (request) => {
                // FLAG: Start the exact preselected snapshot before admission, but never
                // hold producer capacity for optional SQL. A missed update stays a gap.
                void this.observationGate.run(() =>
                  this.observations!.seed({
                    ...input.observation!,
                    request,
                  }),
                );
                return Promise.resolve();
              }
            : undefined,
        ),
      )
      .then((outcome) => {
        if (input.observation && this.observations)
          void this.observationGate.run(() =>
            this.observations!.update({
              source: offer.source,
              inputSha256: commercialAiObservationInputSha256(offer.excerpt),
              admission: {
                state: outcome === 'accepted' ? 'ACCEPTED' : 'REJECTED',
                reason:
                  outcome === 'accepted'
                    ? null
                    : outcome === 'source_expired' || outcome === 'source_stale'
                      ? 'STALE_SOURCE'
                      : 'NOT_ADMITTED',
              },
            }),
          );
        const accepted = outcome === 'accepted';
        this.counts[accepted ? 'accepted' : 'skipped'] += 1;
        window[accepted ? 'accepted' : 'skipped'] += 1;
        if (!accepted) {
          this.skipReasons[outcome] = (this.skipReasons[outcome] ?? 0) + 1;
          window.skipReasons[outcome] = (window.skipReasons[outcome] ?? 0) + 1;
        }
        this.logger.log(
          {
            stage: 'commercial-ai-offer',
            ...trace,
            outcome,
            triage: input.triage ?? resolveCommercialAiTriage({ text: input.text }),
          },
          'Commercial AI admission',
        );
      })
      .catch(() => {
        // FLAG: A lost Redis reply cannot prove rejection. The seeded admission
        // remains unobserved unless its exact runner later establishes acceptance.
        this.counts.unavailable += 1;
        window.unavailable += 1;
        this.logger.warn(
          { stage: 'commercial-ai-offer', ...trace, outcome: 'dependency_unavailable' },
          'Commercial AI admission unavailable',
        );
      })
      .finally(() => {
        this.offering = false;
        this.logCounts();
        this.logWindows();
      });
  }

  async hasProof(source: CommercialLlmSource): Promise<boolean> {
    // FLAG: A retained v2 proof cannot outlive its configured routing/4B authority.
    if (!this.enabled() || (source.version === 2 && source.poolPolicy !== this.poolPolicy()))
      return false;
    return (await this.mailbox()).hasProof(source);
  }

  private window(minute: number): ReturnType<typeof admissionWindow> {
    let window = this.windows.get(minute);
    if (!window) {
      window = admissionWindow();
      this.windows.set(minute, window);
    }
    return window;
  }

  private observationIdentity() {
    return {
      observationProcessId: this.observationProcessId,
      observationStartedAt: new Date(this.observationStartedAtMs).toISOString(),
    };
  }

  private logCounts() {
    if (Date.now() - this.lastLog < 30_000) return;
    this.lastLog = Date.now();
    this.logger.log(
      {
        stage: 'commercial-ai-admission',
        schemaVersion: 3,
        ...this.observationIdentity(),
        ...this.counts,
        evidenceWrites: this.observationGate.snapshot(),
        inFlight:
          this.counts.eligible -
          this.counts.accepted -
          this.counts.skipped -
          this.counts.unavailable,
        ineligibleReasons: { ...this.ineligibleReasons },
        skipReasons: { ...this.skipReasons },
        evaluation: {
          ...this.evaluation,
          exclusionReasons: { ...this.evaluation.exclusionReasons },
        },
      },
      'Commercial AI admission totals',
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.logWindows();
    this.redis?.disconnect();
  }
}

// FLAG: AI mode replaces only commercial decisions. Other violations keep their order and authority.
export function routeCommercialAiViolations(
  violations: RuleViolation[],
  enabled: boolean,
): RuleViolation[] {
  return enabled
    ? violations.filter((violation) => violation.ruleCode !== 'COMMERCIAL_AD')
    : violations;
}
