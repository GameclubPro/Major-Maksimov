// FLAG: Closed synthetic observations only, with the compiled runtime's ordinary global lease.
// Waiting here establishes a test precondition; production admission still skips an unavailable PC.
const { performance } = require('node:perf_hooks');
const { setTimeout: pause } = require('node:timers/promises');

async function waitForWorkstationReady(redis, key, matchesIdentity, signal, timeoutMs = 2000) {
  const deadline = performance.now() + timeoutMs;
  while (!signal.aborted && performance.now() < deadline) {
    const raw = await redis.get(key);
    if (raw && Buffer.byteLength(raw) <= 2048) {
      try {
        const heartbeat = JSON.parse(raw);
        if (matchesIdentity(heartbeat.identity)) return;
      } catch {
        /* FLAG: Malformed readiness is never permission to dispatch a synthetic request. */
      }
    }
    await pause(Math.min(50, Math.max(1, deadline - performance.now())), undefined, { signal });
  }
  throw new Error('cascade_smoke_primary_not_ready');
}

async function runWorkstationSmoke(
  {
    redis,
    lease,
    createCpuScope,
    createClient,
    hasHeadroom,
    heartbeatKey,
    matchesIdentity,
    cascadeVersion,
  },
  expectPrimary,
) {
  let token = null;
  let cpuScope = null;
  try {
    await redis.connect();
    const admissionDeadline = performance.now() + 30_000;
    while (!token && performance.now() < admissionDeadline) {
      token = await lease.acquire();
      if (!token) await pause(250);
    }
    if (!token) throw new Error('cascade_smoke_not_admitted');
    cpuScope = createCpuScope(token);
    const client = createClient(cpuScope);
    const signal = AbortSignal.timeout(80_000);
    const valid = async () => !signal.aborted && !!token && (await lease.owns(token));
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
      if (expectPrimary)
        await waitForWorkstationReady(redis, heartbeatKey, matchesIdentity, signal);
      if (!(await valid()) || !(await hasHeadroom())) throw new Error('cascade_smoke_shed');
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
    return { ok: true, casesPassed: 2, casesTotal: 2, expectPrimary, cascadeVersion, cases };
  } finally {
    if (cpuScope) await cpuScope.finish();
    else if (token) await lease.release(token).catch(() => undefined);
    redis.disconnect();
  }
}

async function main() {
  const mode = process.argv[2];
  if (
    process.argv.length !== 3 ||
    !['--expect-primary', '--expect-offline'].includes(mode) ||
    process.env.APP_SERVICE_NAME !== 'api-moderation-background' ||
    process.env.COMMERCIAL_LLM_SHADOW_ENABLED !== 'true' ||
    !process.env.REDIS_URL
  )
    throw new Error('cascade_smoke_role_refused');
  const base = './apps/api/dist/apps/api/src/moderation/commercial/';
  const { CommercialLlmClient } = require(base + 'commercial-llm.client.js');
  const { CommercialLlmCpuLeaseScope } = require(base + 'commercial-llm-cpu-lease-scope.js');
  const { CommercialLlmCascadeClient } = require(base + 'commercial-llm-cascade.client.js');
  const { CommercialLlmWorkstationMailbox } = require(
    base + 'commercial-llm-workstation.mailbox.js',
  );
  const { commercialLlmHostHasHeadroom } = require(base + 'commercial-llm-shadow.processor.js');
  const { CommercialLlmShadowLease, createCommercialLlmRedis } = require(
    base + 'commercial-llm-shadow.lease.js',
  );
  const {
    COMMERCIAL_LLM_CASCADE_VERSION,
    COMMERCIAL_LLM_WORKSTATION_KEYS,
    commercialLlmWorkstationIdentityMatches,
  } = require(base + 'commercial-llm-workstation.protocol.js');
  const redis = createCommercialLlmRedis(process.env.REDIS_URL);
  const lease = new CommercialLlmShadowLease(redis);
  const result = await runWorkstationSmoke(
    {
      redis,
      lease,
      createCpuScope: (token) => new CommercialLlmCpuLeaseScope(lease, token),
      createClient: (scope) =>
        new CommercialLlmCascadeClient(
          new CommercialLlmWorkstationMailbox(redis),
          scope.classifier(
            new CommercialLlmClient({ endpoint: 'http://gemma-commercial-shadow:8080' }),
          ),
          commercialLlmHostHasHeadroom,
          () => false,
        ),
      hasHeadroom: commercialLlmHostHasHeadroom,
      heartbeatKey: COMMERCIAL_LLM_WORKSTATION_KEYS.heartbeat,
      matchesIdentity: commercialLlmWorkstationIdentityMatches,
      cascadeVersion: COMMERCIAL_LLM_CASCADE_VERSION,
    },
    mode === '--expect-primary',
  );
  process.stdout.write(JSON.stringify(result) + '\n');
}
module.exports = { waitForWorkstationReady, runWorkstationSmoke };
if (require.main === module || process.argv[1] === '-')
  main().catch(() => {
    process.stderr.write('cascade_smoke_unavailable\n');
    process.exitCode = 1;
  });
