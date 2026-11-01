import { setTimeout as pause } from 'node:timers/promises';
import { CommercialLlmError, type CommercialLlmHttpClassifier } from './commercial-llm.client';
import type { CommercialLlmShadowLease } from './commercial-llm-shadow.lease';
import { CommercialLlmBudgetedSecondary } from './commercial-llm-budgeted-secondary';
import { CommercialLlmCpuLeaseScope } from './commercial-llm-cpu-lease-scope';

export type CommercialLlmSecondaryState =
  | 'waiting'
  | 'started'
  | 'buffer_full'
  | 'budget_exhausted';

// FLAG: One waiting confirmation, one real model lease. Waiting spends the original cascade budget.
export class CommercialLlmSecondaryScheduler {
  private waiting = false;

  constructor(
    private readonly lease: Pick<
      CommercialLlmShadowLease,
      'acquire' | 'owns' | 'retainUntilReleased' | 'release'
    >,
    private readonly client: CommercialLlmHttpClassifier,
    private readonly observe: (state: CommercialLlmSecondaryState, waitMs: number) => void = () =>
      undefined,
  ) {}

  async classifyAudit(excerpt: string, signal?: AbortSignal, mayContinue?: () => Promise<boolean>) {
    if (this.waiting) throw new CommercialLlmError('BUSY');
    return new CommercialLlmBudgetedSecondary(this.lease, this.client).classify(
      excerpt,
      signal,
      mayContinue,
    );
  }

  async classifyWithin(
    excerpt: string,
    deadlineAtMs: number,
    signal?: AbortSignal,
    mayContinue: () => Promise<boolean> = async () => true,
    observe = this.observe,
  ) {
    const startedAt = Date.now();
    const current = async () =>
      !signal?.aborted && Date.now() < deadlineAtMs && (await mayContinue());
    if (!(await current()) || deadlineAtMs - Date.now() < 6_000)
      throw new CommercialLlmError('ABORTED');
    if (this.waiting) {
      observe('buffer_full', 0);
      throw new CommercialLlmError('BUSY');
    }
    let token = await this.lease.acquire();
    let scope: CommercialLlmCpuLeaseScope | null = null;
    let queued = false;
    if (!token) {
      if (this.waiting) {
        observe('buffer_full', 0);
        throw new CommercialLlmError('BUSY');
      }
      this.waiting = true;
      queued = true;
      observe('waiting', 0);
    }
    try {
      while (!token) {
        // FLAG: Reserve six seconds for the measured server p95; never renew the original budget.
        if (!(await current()) || deadlineAtMs - Date.now() < 6_000) {
          observe('budget_exhausted', Date.now() - startedAt);
          throw new CommercialLlmError('ABORTED');
        }
        await pause(Math.min(100, deadlineAtMs - Date.now()), undefined, { signal });
        if (!(await current())) throw new CommercialLlmError('ABORTED');
        token = await this.lease.acquire();
      }
      if (queued) {
        this.waiting = false;
        queued = false;
      }
      if (!(await current()) || deadlineAtMs - Date.now() < 6_000) {
        observe('budget_exhausted', Date.now() - startedAt);
        throw new CommercialLlmError('ABORTED');
      }
      const ownedToken = token;
      scope = new CommercialLlmCpuLeaseScope(this.lease, ownedToken);
      const valid = async () => (await current()) && (await this.lease.owns(ownedToken));
      if (!(await valid())) throw new CommercialLlmError('ABORTED');
      if (deadlineAtMs - Date.now() < 6_000) {
        observe('budget_exhausted', Date.now() - startedAt);
        throw new CommercialLlmError('ABORTED');
      }
      observe('started', Date.now() - startedAt);
      const result = await scope
        .classifier(this.client, () => deadlineAtMs - Date.now() >= 6_000)
        .classify(excerpt, signal, valid);
      if (!(await valid())) throw new CommercialLlmError('ABORTED');
      return result;
    } finally {
      if (queued) this.waiting = false;
      if (scope) await scope.finish();
      else if (token) await this.lease.release(token).catch(() => undefined);
    }
  }
}
