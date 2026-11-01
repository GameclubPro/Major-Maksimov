import { setTimeout as pause } from 'node:timers/promises';
import { CommercialLlmClient } from '../moderation/commercial/commercial-llm.client';
import { CommercialLlmCascadeClient } from '../moderation/commercial/commercial-llm-cascade.client';
import { CommercialLlmWorkstationMailbox } from '../moderation/commercial/commercial-llm-workstation.mailbox';
import { commercialLlmHostHasHeadroom } from '../moderation/commercial/commercial-llm-shadow.processor';
import {
  CommercialLlmShadowLease,
  createCommercialLlmRedis,
} from '../moderation/commercial/commercial-llm-shadow.lease';
import { COMMERCIAL_LLM_CASCADE_VERSION } from '../moderation/commercial/commercial-llm-workstation.protocol';
import { CommercialLlmCpuLeaseScope } from '../moderation/commercial/commercial-llm-cpu-lease-scope';

// FLAG: Two closed synthetic inputs, the ordinary global lease, no database/MAX client or effects.
export async function commercialLlmCascadeSmoke(expectPrimary: boolean) {
  if (
    process.env.APP_SERVICE_NAME !== 'api-moderation-background' ||
    !process.env.REDIS_URL ||
    process.env.COMMERCIAL_LLM_SHADOW_ENABLED !== 'true'
  )
    throw new Error('cascade_smoke_role_refused');
  const redis = createCommercialLlmRedis(process.env.REDIS_URL);
  const lease = new CommercialLlmShadowLease(redis);
  let token: string | null = null;
  let scope: CommercialLlmCpuLeaseScope | null = null;
  try {
    await redis.connect();
    const admissionDeadline = Date.now() + 30_000;
    while (!token && Date.now() < admissionDeadline) {
      token = await lease.acquire();
      if (!token) await pause(250);
    }
    if (!token) throw new Error('cascade_smoke_not_admitted');
    scope = new CommercialLlmCpuLeaseScope(lease, token);
    const signal = AbortSignal.timeout(80_000);
    const valid = async () => !signal.aborted && !!token && (await lease.owns(token));
    const client = new CommercialLlmCascadeClient(
      new CommercialLlmWorkstationMailbox(redis),
      scope.classifier(
        new CommercialLlmClient({ endpoint: 'http://gemma-commercial-shadow:8080' }),
      ),
      commercialLlmHostHasHeadroom,
      () => false,
    );
    const cases = [];
    for (const sample of [
      {
        name: 'personal-used-item',
        text: 'Продам свой старый холодильник после переезда, один, б/у. Служил нашей семье десять лет.',
        classification: 'NOT_COMMERCIAL',
        route: expectPrimary ? 'primary' : 'secondary_unavailable',
      },
      {
        name: 'commercial-service',
        text: 'Наша компания ремонтирует стиральные машины. Мастера работают ежедневно, гарантия, принимаем заказы: [phone].',
        classification: 'COMMERCIAL',
        route: expectPrimary ? 'secondary_commercial' : 'secondary_unavailable',
      },
    ]) {
      if (!(await valid()) || !(await commercialLlmHostHasHeadroom()))
        throw new Error('cascade_smoke_shed');
      const result = await client.classify(sample.text, signal, valid);
      if (
        !(await valid()) ||
        result.classification !== sample.classification ||
        result.cascade?.route !== sample.route
      )
        throw new Error('cascade_smoke_unexpected_route');
      cases.push({
        name: sample.name,
        classification: result.classification,
        route: result.cascade.route,
        modelAlias: result.modelAlias,
        modelSha256: result.modelSha256,
        promptSha256: result.promptSha256,
        durationMs: result.durationMs,
        primaryDurationMs: result.cascade.primaryDurationMs ?? null,
        secondaryDurationMs: result.cascade.secondaryDurationMs ?? null,
      });
    }
    return {
      ok: true,
      casesPassed: 2,
      casesTotal: 2,
      expectPrimary,
      cascadeVersion: COMMERCIAL_LLM_CASCADE_VERSION,
      cases,
    };
  } finally {
    if (scope) await scope.finish();
    else if (token) await lease.release(token).catch(() => undefined);
    redis.disconnect();
  }
}
if (require.main === module) {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['--expect-primary', '--expect-offline'].includes(mode))
    process.exitCode = 2;
  else
    commercialLlmCascadeSmoke(mode === '--expect-primary')
      .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
      .catch(() => {
        process.stderr.write('cascade_smoke_unavailable\n');
        process.exitCode = 1;
      });
}
