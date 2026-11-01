import type Redis from 'ioredis';
import {
  CommercialLlmClient,
  CommercialLlmError,
} from '../moderation/commercial/commercial-llm.client';
import {
  COMMERCIAL_LLM_MODEL_SHA256,
  COMMERCIAL_LLM_PROMPT_SHA256,
} from '../moderation/commercial/commercial-llm.protocol';
import {
  COMMERCIAL_LLM_COOLDOWN_KEY,
  COMMERCIAL_LLM_LEASE_KEY,
  CommercialLlmShadowLease,
  createCommercialLlmRedis,
} from '../moderation/commercial/commercial-llm-shadow.lease';

const FAILURE_STAGES = {
  ENVIRONMENT_INVALID: 'environment',
  REDIS_UNAVAILABLE: 'redis',
  ADMISSION_BLOCKED: 'admission',
  LEASE_LOST: 'ownership',
  LEASE_RELEASE_UNAVAILABLE: 'ownership',
  DEADLINE_EXCEEDED: 'ownership',
  MODEL_TIMEOUT: 'classification',
  MODEL_ABORTED: 'classification',
  MODEL_HTTP_ERROR: 'classification',
  MODEL_INVALID_RESPONSE: 'classification',
  MODEL_RESPONSE_TOO_LARGE: 'classification',
  MODEL_UNAVAILABLE: 'classification',
  UNEXPECTED_CLASSIFICATION: 'classification',
} as const;
type FailureCode = keyof typeof FAILURE_STAGES;
type Admission = {
  observedAt: string;
  leaseState: 'MISSING' | 'HELD_EXPIRING' | 'HELD_PERSISTENT' | 'INVALID' | 'UNAVAILABLE';
  cooldownState: 'MISSING' | 'ACTIVE' | 'INVALID' | 'UNAVAILABLE';
};

export class CommercialLlmShadowSmokeError extends Error {
  constructor(
    readonly code: FailureCode,
    readonly admission?: Admission,
  ) {
    super(code);
    this.name = 'CommercialLlmShadowSmokeError';
  }

  diagnostic() {
    return {
      schemaVersion: 1,
      ok: false,
      stage: FAILURE_STAGES[this.code],
      code: this.code,
      ...(this.admission ? { admission: this.admission } : {}),
    };
  }
}

// FLAG: Observe only two exact keys without GET or writes. UUID ownership and inputs never leave
// Redis; a post-refusal observation does not claim it was atomic with the failed admission.
const READ_ADMISSION = `
local function lease(key)
  local kind=redis.call('TYPE',key).ok
  if kind=='none' then return 'MISSING' end
  if kind~='string' or redis.call('STRLEN',key)~=36 then return 'INVALID' end
  local ttl=redis.call('PTTL',key)
  if ttl==-1 then return 'HELD_PERSISTENT' end
  if ttl>0 and ttl<=120000 then return 'HELD_EXPIRING' end
  return 'INVALID'
end
local function cooldown(key)
  local kind=redis.call('TYPE',key).ok
  if kind=='none' then return 'MISSING' end
  if kind~='string' or redis.call('STRLEN',key)~=1 then return 'INVALID' end
  local ttl=redis.call('PTTL',key)
  if ttl>0 and ttl<=10000 then return 'ACTIVE' end
  return 'INVALID'
end
return {lease(KEYS[1]),cooldown(KEYS[2])}`;

export async function readCommercialLlmSmokeAdmission(
  redis: Pick<Redis, 'eval'>,
): Promise<Admission> {
  const observedAt = new Date().toISOString();
  try {
    const result: unknown = await redis.eval(
      READ_ADMISSION,
      2,
      COMMERCIAL_LLM_LEASE_KEY,
      COMMERCIAL_LLM_COOLDOWN_KEY,
    );
    if (
      Array.isArray(result) &&
      result.length === 2 &&
      ['MISSING', 'HELD_EXPIRING', 'HELD_PERSISTENT', 'INVALID'].includes(result[0]) &&
      ['MISSING', 'ACTIVE', 'INVALID'].includes(result[1])
    )
      return { observedAt, leaseState: result[0], cooldownState: result[1] };
  } catch {
    /* FLAG: Observation failure cannot change refused admission or expose Redis errors. */
  }
  return { observedAt, leaseState: 'UNAVAILABLE', cooldownState: 'UNAVAILABLE' };
}

type SmokeDependencies = {
  redis: Pick<Redis, 'connect' | 'disconnect' | 'eval'>;
  lease: Pick<CommercialLlmShadowLease, 'acquire' | 'owns' | 'retainUntilReleased' | 'release'>;
  client: Pick<CommercialLlmClient, 'classify'>;
};

export async function runCommercialLlmShadowSmoke({ redis, lease, client }: SmokeDependencies) {
  let token: string | null = null;
  let uncertainHttp = false;
  let failure: CommercialLlmShadowSmokeError | undefined;
  const cases: { name: string; classification: string; durationMs: number }[] = [];
  try {
    try {
      await redis.connect();
      token = await lease.acquire();
    } catch {
      throw new CommercialLlmShadowSmokeError('REDIS_UNAVAILABLE');
    }
    if (!token)
      throw new CommercialLlmShadowSmokeError(
        'ADMISSION_BLOCKED',
        await readCommercialLlmSmokeAdmission(redis),
      );
    const signal = AbortSignal.timeout(90_000);
    const assertOwner = async () => {
      if (signal.aborted) throw new CommercialLlmShadowSmokeError('DEADLINE_EXCEEDED');
      let owned: boolean;
      try {
        owned = await lease.owns(token!);
      } catch {
        throw new CommercialLlmShadowSmokeError('REDIS_UNAVAILABLE');
      }
      if (!owned) throw new CommercialLlmShadowSmokeError('LEASE_LOST');
    };
    for (const sample of [
      {
        name: 'commercial-service',
        expected: 'COMMERCIAL',
        text: 'Наша компания ремонтирует стиральные машины. Мастера работают ежедневно, гарантия, принимаем заказы: [phone].',
      },
      {
        name: 'personal-used-item',
        expected: 'NOT_COMMERCIAL',
        text: 'Продам свой старый холодильник после переезда, один, б/у. Служил нашей семье десять лет.',
      },
    ] as const) {
      await assertOwner();
      let retained: boolean;
      try {
        retained = await lease.retainUntilReleased(token);
      } catch {
        throw new CommercialLlmShadowSmokeError('REDIS_UNAVAILABLE');
      }
      if (!retained) throw new CommercialLlmShadowSmokeError('LEASE_LOST');
      await assertOwner();
      // FLAG: Synthetic HTTP has the same uncertainty as production HTTP. Pin the physical
      // lease before handoff and retain it after failure; idle slots cannot prove cancellation.
      uncertainHttp = true;
      const result = await client.classify(sample.text, signal);
      uncertainHttp = false;
      await assertOwner();
      cases.push({
        name: sample.name,
        classification: result.classification,
        durationMs: result.durationMs,
      });
      if (result.classification !== sample.expected)
        throw new CommercialLlmShadowSmokeError('UNEXPECTED_CLASSIFICATION');
    }
  } catch (error: unknown) {
    if (error instanceof CommercialLlmShadowSmokeError) failure = error;
    else {
      const code = error instanceof CommercialLlmError ? error.kind : 'UNAVAILABLE';
      const codes = {
        TIMEOUT: 'MODEL_TIMEOUT',
        ABORTED: 'MODEL_ABORTED',
        HTTP_ERROR: 'MODEL_HTTP_ERROR',
        INVALID_RESPONSE: 'MODEL_INVALID_RESPONSE',
        RESPONSE_TOO_LARGE: 'MODEL_RESPONSE_TOO_LARGE',
      } as const;
      failure = new CommercialLlmShadowSmokeError(
        codes[code as keyof typeof codes] ?? 'MODEL_UNAVAILABLE',
      );
    }
  } finally {
    if (token && !uncertainHttp) {
      try {
        await lease.release(token);
      } catch {
        failure ??= new CommercialLlmShadowSmokeError('LEASE_RELEASE_UNAVAILABLE');
      }
    }
    redis.disconnect();
  }
  if (failure) throw failure;
  return {
    ok: true,
    casesPassed: cases.length,
    casesTotal: 2,
    modelSha256: COMMERCIAL_LLM_MODEL_SHA256,
    promptSha256: COMMERCIAL_LLM_PROMPT_SHA256,
    cases,
  };
}

// FLAG: Closed synthetic sources only. This executable has no MAX client, DB or effect authority.
export async function commercialLlmShadowSmoke() {
  if (
    process.argv.length !== 2 ||
    process.env.APP_SERVICE_NAME !== 'api-moderation-background' ||
    !process.env.REDIS_URL
  )
    throw new CommercialLlmShadowSmokeError('ENVIRONMENT_INVALID');
  const redis = createCommercialLlmRedis(process.env.REDIS_URL);
  return runCommercialLlmShadowSmoke({
    redis,
    lease: new CommercialLlmShadowLease(redis),
    client: new CommercialLlmClient({ endpoint: 'http://gemma-commercial-shadow:8080' }),
  });
}

if (require.main === module) {
  commercialLlmShadowSmoke()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error: unknown) => {
      // FLAG: No arbitrary error, model response, source, Redis URL or token reaches CLI output.
      const failure =
        error instanceof CommercialLlmShadowSmokeError
          ? error
          : new CommercialLlmShadowSmokeError('MODEL_UNAVAILABLE');
      process.stdout.write(`${JSON.stringify(failure.diagnostic())}\n`);
      process.exitCode = 1;
    });
}
