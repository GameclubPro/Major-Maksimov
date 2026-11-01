import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { CommercialAiQualityAttempt } from '@maxim/contracts/commercial-ai-quality';
import type { RuleViolation } from '../rule-engine.contract';
import type { Candidate } from './commercial-review.service';
import { isCommercialMessageDeleteEligible } from './commercial-action-policy';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';

export type CommercialAiObservationContext = {
  candidate: Candidate;
  detectorBaseline: CommercialAiQualityAttempt['detectorBaseline'];
  actualSynchronousDecision: CommercialAiQualityAttempt['actualSynchronousDecision'];
  activeAuthority: CommercialAiQualityAttempt['activeAuthority'];
};

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, 32)
    : [];

// FLAG: Preserve the actual detector output before AI routing, independently of the
// experimental candidate. Neither snapshot selects a sanction or changes rule routing.
export function buildCommercialAiObservationContext(
  candidate: Candidate,
  violations: RuleViolation[],
): CommercialAiObservationContext {
  const violation = violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');
  const metadata = violation?.metadata ?? {};
  const actionBand = typeof metadata.actionBand === 'string' ? metadata.actionBand : 'ALLOW';
  const eligible = isCommercialMessageDeleteEligible(
    actionBand,
    metadata.actionable === true,
    metadata.messageDisposition,
  );
  const detectorVersion =
    typeof metadata.decisionVersion === 'string'
      ? metadata.decisionVersion
      : COMMERCIAL_ENGINE_CONFIG.decisionVersion;
  const fingerprint = (band: string, disposition: string, semantics: string) =>
    createHash('sha256')
      .update(
        JSON.stringify([
          candidate.sourceSnapshotSha256,
          detectorVersion,
          band,
          disposition,
          semantics,
        ]),
      )
      .digest('hex');
  const keep = {
    hasDetection: false,
    actionable: false,
    deleteEligible: false,
    score: 0,
    actionBand: 'ALLOW',
    messageDisposition: 'KEEP' as const,
    detectorVersion,
    decisionFingerprint: fingerprint('ALLOW', 'KEEP', 'actual_post_routing_v1'),
    reasons: [],
    requiredPolicyCohorts: [],
  };
  return {
    candidate,
    activeAuthority: 'AI_DELETE_ONLY',
    detectorBaseline: candidate.detectorSourceSha256
      ? {
          semantics: 'counterfactual_pre_routing_v1',
          detectorSourceSha256: candidate.detectorSourceSha256,
          decision: {
            ...keep,
            hasDetection: Boolean(violation),
            actionable: metadata.actionable === true,
            deleteEligible: eligible,
            score: (violation?.score ?? 0) * 100,
            actionBand,
            messageDisposition: eligible ? 'DELETE' : 'KEEP',
            decisionFingerprint: fingerprint(
              actionBand,
              eligible ? 'DELETE' : 'KEEP',
              'counterfactual_pre_routing_v1',
            ),
            reasons: strings(metadata.reasonCodes),
            requiredPolicyCohorts: strings(metadata.requiredPolicyCohorts),
          },
        }
      : null,
    actualSynchronousDecision: { semantics: 'actual_post_routing_v1', decision: keep },
  };
}

@Injectable()
export class CommercialAiObservationGate {
  private readonly pending = new Set<Promise<void>>();
  private readonly counts = { completed: 0, failed: 0, timedOut: 0, capacitySkipped: 0 };
  private readonly statuses: Record<string, number> = {};

  snapshot() {
    return { ...this.counts, statuses: { ...this.statuses }, unsettled: this.pending.size };
  }

  // FLAG: Callers never await optional evidence at business admission. The 100ms
  // observation timeout neither retries moderation nor releases an unsettled SQL slot.
  async run(operation: () => Promise<unknown>): Promise<void> {
    if (this.pending.size >= 2) {
      this.counts.capacitySkipped += 1;
      return;
    }
    const work = Promise.resolve()
      .then(operation)
      .then(
        (status) => {
          this.counts.completed += 1;
          if (
            typeof status === 'string' &&
            [
              'written',
              'unchanged',
              'missing',
              'expired',
              'conflict',
              'overflow',
              'invalid',
              'unavailable',
            ].includes(status)
          )
            this.statuses[status] = (this.statuses[status] ?? 0) + 1;
        },
        () => {
          this.counts.failed += 1;
        },
      )
      .finally(() => this.pending.delete(work));
    this.pending.add(work);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          this.counts.timedOut += 1;
          resolve();
        }, 100);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
