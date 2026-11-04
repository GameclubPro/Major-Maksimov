import { randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { CommercialLlmError } from './commercial-llm.client';
import type {
  CommercialLlmClassifier,
  CommercialLlmObservationResult,
} from './commercial-llm.protocol';
import type {
  CommercialLlmWorkstationMailbox,
  WorkstationOutcome,
} from './commercial-llm-workstation.mailbox';
import {
  COMMERCIAL_LLM_CASCADE_VERSION,
  COMMERCIAL_LLM_WORKSTATION_IDENTITY,
} from './commercial-llm-workstation.protocol';

export class CommercialLlmCascadeClient implements CommercialLlmClassifier {
  constructor(
    private readonly primary: Pick<CommercialLlmWorkstationMailbox, 'classify'>,
    private readonly secondary: CommercialLlmClassifier,
    private readonly canStartSecondary: () => Promise<boolean>,
    private readonly auditNegative: () => boolean = () => randomInt(10) === 0,
    private readonly primaryFinished: () => Promise<void> = async () => undefined,
    private readonly auditSecondary: CommercialLlmClassifier = secondary,
    private readonly confirmPersonalSales = false,
  ) {}

  async classify(
    excerpt: string,
    signal?: AbortSignal,
    mayContinue?: () => Promise<boolean>,
  ): Promise<CommercialLlmObservationResult> {
    const startedAt = performance.now();
    if (signal?.aborted) throw new CommercialLlmError('ABORTED');
    let first: WorkstationOutcome;
    try {
      first = await this.primary.classify(excerpt, signal);
    } catch {
      first = { outcome: 'FAILED' };
    } finally {
      // FLAG: Release only the primary resource; the source lease remains held through 9B.
      await this.primaryFinished();
    }
    if (signal?.aborted) throw new CommercialLlmError('ABORTED');
    const primary = first.outcome === 'COMPLETE' ? first.result : null;
    const audit =
      primary?.classification === 'NOT_COMMERCIAL' &&
      ((this.confirmPersonalSales &&
        primary.reasonCodes.length === 1 &&
        primary.reasonCodes[0] === 'PERSONAL_SALE') ||
        this.auditNegative());
    const cascade = {
      version: COMMERCIAL_LLM_CASCADE_VERSION,
      primaryModelSha256: COMMERCIAL_LLM_WORKSTATION_IDENTITY.modelSha256,
      ...(primary
        ? {
            primaryClassification: primary.classification,
            primaryDurationMs: primary.durationMs,
          }
        : {}),
    };
    if (primary?.classification === 'NOT_COMMERCIAL' && !audit) {
      return {
        ...primary,
        durationMs: Math.round(performance.now() - startedAt),
        cascade: { ...cascade, route: 'primary' },
      };
    }
    // FLAG: Positives and uncertainty always require 9B; pressure can shed the whole observation.
    // Neither model's answer or its self-reported confidence grants a moderation effect.
    if (
      signal?.aborted ||
      !(await this.canStartSecondary()) ||
      (mayContinue && !(await mayContinue())) ||
      signal?.aborted
    )
      throw new CommercialLlmError('ABORTED');
    let result: CommercialLlmObservationResult;
    if (audit && primary) {
      try {
        result = await this.auditSecondary.classify(excerpt, signal, mayContinue);
      } catch (error) {
        if (!(error instanceof CommercialLlmError) || error.kind !== 'BUSY') throw error;
        if (signal?.aborted || (mayContinue && !(await mayContinue())) || signal?.aborted)
          throw new CommercialLlmError('ABORTED');
        // FLAG: Only optional audit capacity loss may retain the completed primary negative.
        // Its original identity and fresh source ownership grant no DELETE authority.
        return {
          ...primary,
          durationMs: Math.round(performance.now() - startedAt),
          cascade: { ...cascade, route: 'primary', auditOutcome: 'capacity_skipped' },
        };
      }
    } else result = await this.secondary.classify(excerpt, signal, mayContinue);
    return {
      ...result,
      durationMs: Math.round(performance.now() - startedAt),
      cascade: {
        ...cascade,
        route: primary
          ? audit
            ? 'secondary_audit'
            : 'secondary_' + primary.classification.toLowerCase()
          : 'secondary_' + first.outcome.toLowerCase(),
        secondaryDurationMs: result.durationMs,
      },
    };
  }
}
