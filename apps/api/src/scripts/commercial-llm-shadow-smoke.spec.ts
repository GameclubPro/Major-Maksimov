import {
  CommercialLlmShadowSmokeError,
  readCommercialLlmSmokeAdmission,
  runCommercialLlmShadowSmoke,
} from './commercial-llm-shadow-smoke';
import {
  CommercialLlmError,
  type CommercialLlmResult,
} from '../moderation/commercial/commercial-llm.client';
import {
  COMMERCIAL_LLM_MODEL_ALIAS,
  COMMERCIAL_LLM_MODEL_SHA256,
  COMMERCIAL_LLM_PROMPT_SHA256,
  COMMERCIAL_LLM_RUNTIME_VERSION,
  COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
  COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256,
  COMMERCIAL_LLM_POLICY_VERSION,
} from '../moderation/commercial/commercial-llm.protocol';
import {
  COMMERCIAL_LLM_COOLDOWN_KEY,
  COMMERCIAL_LLM_LEASE_KEY,
} from '../moderation/commercial/commercial-llm-shadow.lease';

type Dependencies = Parameters<typeof runCommercialLlmShadowSmoke>[0];
function result(classification: CommercialLlmResult['classification']): CommercialLlmResult {
  return {
    classification,
    reasonCodes: classification === 'COMMERCIAL' ? ['COMMERCIAL_OFFER'] : ['PERSONAL_SALE'],
    modelAlias: COMMERCIAL_LLM_MODEL_ALIAS,
    modelSha256: COMMERCIAL_LLM_MODEL_SHA256,
    promptSha256: COMMERCIAL_LLM_PROMPT_SHA256,
    runtimeVersion: COMMERCIAL_LLM_RUNTIME_VERSION,
    runtimeImageSha256: COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
    chatTemplateSha256: COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256,
    policyVersion: COMMERCIAL_LLM_POLICY_VERSION,
    durationMs: 12,
  };
}
function fixture() {
  const redis = {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    eval: jest.fn().mockResolvedValue(['HELD_PERSISTENT', 'MISSING']),
  } satisfies Dependencies['redis'];
  const lease = {
    acquire: jest.fn().mockResolvedValue('owned-token'),
    owns: jest.fn().mockResolvedValue(true),
    retainUntilReleased: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(undefined),
  } satisfies Dependencies['lease'];
  const client = {
    classify: jest
      .fn<
        ReturnType<Dependencies['client']['classify']>,
        Parameters<Dependencies['client']['classify']>
      >()
      .mockResolvedValueOnce(result('COMMERCIAL'))
      .mockResolvedValueOnce(result('NOT_COMMERCIAL')),
  } satisfies Dependencies['client'];
  return { redis, lease, client };
}

describe('closed CPU smoke safety and finite diagnostics', () => {
  it('preserves successful results and retains physical ownership before both HTTP handoffs', async () => {
    const f = fixture();
    await expect(runCommercialLlmShadowSmoke(f)).resolves.toEqual({
      ok: true,
      casesPassed: 2,
      casesTotal: 2,
      modelSha256: COMMERCIAL_LLM_MODEL_SHA256,
      promptSha256: COMMERCIAL_LLM_PROMPT_SHA256,
      cases: [
        { name: 'commercial-service', classification: 'COMMERCIAL', durationMs: 12 },
        { name: 'personal-used-item', classification: 'NOT_COMMERCIAL', durationMs: 12 },
      ],
    });
    expect(f.lease.retainUntilReleased).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++)
      expect(f.lease.retainUntilReleased.mock.invocationCallOrder[i]).toBeLessThan(
        f.client.classify.mock.invocationCallOrder[i]!,
      );
    expect(f.lease.release).toHaveBeenCalledWith('owned-token');
    expect(f.redis.disconnect).toHaveBeenCalledTimes(1);
  });

  it('reports persistent CPU fencing without invoking inference or releasing another owner', async () => {
    const f = fixture();
    f.lease.acquire.mockResolvedValue(null);
    const failure = await runCommercialLlmShadowSmoke(f).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommercialLlmShadowSmokeError);
    expect((failure as CommercialLlmShadowSmokeError).diagnostic()).toEqual({
      schemaVersion: 1,
      ok: false,
      stage: 'admission',
      code: 'ADMISSION_BLOCKED',
      admission: {
        observedAt: expect.any(String),
        leaseState: 'HELD_PERSISTENT',
        cooldownState: 'MISSING',
      },
    });
    const [lua, count, ...keys] = f.redis.eval.mock.calls[0]!;
    expect(count).toBe(2);
    expect(keys).toEqual([COMMERCIAL_LLM_LEASE_KEY, COMMERCIAL_LLM_COOLDOWN_KEY]);
    expect(lua).not.toMatch(/redis\.call\('(GET|SET|DEL|PERSIST|EXPIRE)'/u);
    expect(f.client.classify).not.toHaveBeenCalled();
    expect(f.lease.release).not.toHaveBeenCalled();
  });

  it.each([
    ['TIMEOUT', 'MODEL_TIMEOUT'],
    ['ABORTED', 'MODEL_ABORTED'],
    ['INVALID_RESPONSE', 'MODEL_INVALID_RESPONSE'],
    ['HTTP_ERROR', 'MODEL_HTTP_ERROR'],
  ] as const)('retains uncertainty after %s without exposing model output', async (kind, code) => {
    const f = fixture();
    f.client.classify.mockReset().mockRejectedValue(new CommercialLlmError(kind));
    const failure = await runCommercialLlmShadowSmoke(f).catch((error: unknown) => error);
    expect((failure as CommercialLlmShadowSmokeError).diagnostic()).toEqual({
      schemaVersion: 1,
      ok: false,
      stage: 'classification',
      code,
    });
    expect(f.lease.release).not.toHaveBeenCalled();
    expect(f.redis.disconnect).toHaveBeenCalledTimes(1);
  });

  it('releases an owned lease after a definite no-HTTP refusal', async () => {
    const f = fixture();
    f.lease.retainUntilReleased.mockResolvedValue(false);
    await expect(runCommercialLlmShadowSmoke(f)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(f.client.classify).not.toHaveBeenCalled();
    expect(f.lease.release).toHaveBeenCalledWith('owned-token');
  });

  it('releases after a complete validated but unexpected answer', async () => {
    const f = fixture();
    f.client.classify.mockReset().mockResolvedValue(result('NOT_COMMERCIAL'));
    await expect(runCommercialLlmShadowSmoke(f)).rejects.toMatchObject({
      code: 'UNEXPECTED_CLASSIFICATION',
    });
    expect(f.lease.release).toHaveBeenCalledWith('owned-token');
  });

  it('does not turn a release failure into a successful smoke', async () => {
    const f = fixture();
    f.lease.release.mockRejectedValue(new Error('redis://private'));
    await expect(runCommercialLlmShadowSmoke(f)).rejects.toMatchObject({
      code: 'LEASE_RELEASE_UNAVAILABLE',
    });
  });

  it('bounds projection to fixed enums when Redis fails or returns malformed values', async () => {
    for (const raw of [
      null,
      ['private-token', 'MISSING'],
      ['MISSING', {}],
      ['MISSING', 'MISSING', 'extra'],
    ]) {
      const f = fixture();
      f.redis.eval.mockResolvedValue(raw);
      await expect(readCommercialLlmSmokeAdmission(f.redis)).resolves.toMatchObject({
        leaseState: 'UNAVAILABLE',
        cooldownState: 'UNAVAILABLE',
      });
    }
    const f = fixture();
    f.redis.eval.mockRejectedValue(new Error('redis://private'));
    const observation = await readCommercialLlmSmokeAdmission(f.redis);
    expect(observation.leaseState).toBe('UNAVAILABLE');
    expect(JSON.stringify(observation)).not.toContain('private');
  });

  it('sanitizes unexpected inference and Redis exceptions', async () => {
    const f = fixture();
    f.client.classify.mockReset().mockRejectedValue(new Error('private model response'));
    const failure = await runCommercialLlmShadowSmoke(f).catch((error: unknown) => error);
    expect((failure as CommercialLlmShadowSmokeError).diagnostic()).toEqual({
      schemaVersion: 1,
      ok: false,
      stage: 'classification',
      code: 'MODEL_UNAVAILABLE',
    });
    expect(f.lease.release).not.toHaveBeenCalled();
    const redis = fixture();
    redis.redis.connect.mockRejectedValue(new Error('redis://private'));
    await expect(runCommercialLlmShadowSmoke(redis)).rejects.toMatchObject({
      code: 'REDIS_UNAVAILABLE',
    });
    expect(redis.client.classify).not.toHaveBeenCalled();
    expect(redis.lease.release).not.toHaveBeenCalled();
  });
});
