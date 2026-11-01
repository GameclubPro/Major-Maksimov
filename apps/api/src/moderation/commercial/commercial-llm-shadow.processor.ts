import { readFile } from 'node:fs/promises';
import type { Prisma } from '../../prisma/prisma-client';
import type { BackgroundRuntimeGovernorService } from '../../system/background-runtime-governor.service';
import type { CommercialLlmClassifier } from './commercial-llm.protocol';
import {
  COMMERCIAL_LLM_MODEL_SHA256,
  COMMERCIAL_LLM_PROMPT_SHA256,
  COMMERCIAL_LLM_RUNTIME_VERSION,
  COMMERCIAL_LLM_POLICY_VERSION,
} from './commercial-llm.protocol';
import type { CommercialLlmShadowLease } from './commercial-llm-shadow.lease';
import type { CommercialLlmShadowStore } from './commercial-llm-shadow.store';
import { CommercialLlmCpuLeaseScope } from './commercial-llm-cpu-lease-scope';

export async function commercialLlmHostHasHeadroom(): Promise<boolean> {
  try {
    const info = await readFile('/proc/meminfo', 'utf8');
    const available = /^MemAvailable:\s+(\d+) kB$/mu.exec(info)?.[1];
    return !!available && Number(available) >= 12 * 1024 * 1024;
  } catch {
    return false;
  }
}

export class CommercialLlmShadowProcessor {
  constructor(
    private readonly store: CommercialLlmShadowStore,
    private readonly lease: CommercialLlmShadowLease,
    private readonly createClient: (scope: CommercialLlmCpuLeaseScope) => CommercialLlmClassifier,
    private readonly governor: Pick<BackgroundRuntimeGovernorService, 'decide'>,
    private readonly hasHeadroom = commercialLlmHostHasHeadroom,
  ) {}

  async run(signal?: AbortSignal): Promise<Record<string, string | number | boolean>> {
    if (signal?.aborted) return { outcome: 'stopped' };
    const decision = await this.governor.decide({
      component: 'commercial-llm-shadow',
      sourceTag: 'commercial-llm-shadow',
    });
    if (decision.action !== 'run' || !(await this.hasHeadroom()))
      return { outcome: 'pressure_paused' };
    const token = await this.lease.acquire();
    if (!token) return { outcome: 'not_admitted' };
    const scope = new CommercialLlmCpuLeaseScope(this.lease, token);
    const lostLease = new AbortController();
    const workSignal = AbortSignal.any([
      ...(signal ? [signal] : []),
      lostLease.signal,
      AbortSignal.timeout(90_000),
    ]);
    const valid = async () => !workSignal.aborted && (await this.lease.owns(token));
    let checking = false;
    const monitor = setInterval(() => {
      if (checking) return;
      checking = true;
      void valid()
        .then((owned) => {
          if (!owned) lostLease.abort();
        })
        .catch(() => {
          lostLease.abort();
        })
        .finally(() => {
          checking = false;
        });
    }, 5_000);
    monitor.unref();
    try {
      const { candidate, ...coverage } = await this.store.select();
      if (!candidate || signal?.aborted)
        return { outcome: signal?.aborted ? 'stopped' : 'idle', ...coverage };
      if (!(await valid())) return { outcome: 'lease_lost', ...coverage };
      let observation: Prisma.InputJsonObject;
      let route: string | undefined;
      try {
        const result = await this.createClient(scope).classify(
          candidate.excerpt,
          workSignal,
          valid,
        );
        route = result.cascade?.route;
        observation = { status: 'COMPLETE', ...result };
      } catch {
        if (signal?.aborted) return { outcome: 'stopped', ...coverage };
        if (workSignal.aborted) return { outcome: 'lease_lost', ...coverage };
        // FLAG: A bounded technical outcome never becomes NOT_COMMERCIAL or permission to delete.
        observation = {
          status: 'TECHNICAL_FAILURE',
          modelSha256: COMMERCIAL_LLM_MODEL_SHA256,
          promptSha256: COMMERCIAL_LLM_PROMPT_SHA256,
          runtimeVersion: COMMERCIAL_LLM_RUNTIME_VERSION,
          policyVersion: COMMERCIAL_LLM_POLICY_VERSION,
        };
      }
      if (!(await valid())) return { outcome: 'lease_lost', ...coverage };
      const persisted = await this.store.persist(candidate, observation, valid);
      return {
        outcome: persisted ? String(observation.status) : 'source_changed',
        ...coverage,
        ...(persisted && observation.classification
          ? { classification: String(observation.classification) }
          : {}),
        ...(observation.durationMs !== undefined
          ? { durationMs: Number(observation.durationMs) }
          : {}),
        ...(persisted && typeof observation.modelAlias === 'string'
          ? { modelAlias: observation.modelAlias }
          : {}),
        ...(persisted && route ? { route } : {}),
      };
    } finally {
      clearInterval(monitor);
      await scope.finish();
    }
  }
}
