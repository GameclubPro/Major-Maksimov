import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  CommercialLlmShadowSmokeError,
  readCommercialLlmSmokeAdmission,
  runCommercialLlmShadowSmoke,
} from './commercial-llm-shadow-smoke';
import { CommercialLlmError } from '../moderation/commercial/commercial-llm.client';
import {
  CommercialLlmShadowLease,
  COMMERCIAL_LLM_COOLDOWN_KEY,
  COMMERCIAL_LLM_LEASE_KEY,
} from '../moderation/commercial/commercial-llm-shadow.lease';

const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
(url ? describe : describe.skip)('closed smoke physical CPU fence on real Redis', () => {
  let observer: Redis;
  let prefix: string;
  beforeEach(async () => {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
      throw new Error('Disposable loopback Redis required');
    prefix = `commercial-smoke-test:${randomUUID()}:`;
    observer = new Redis(url, { keyPrefix: prefix, lazyConnect: true });
    await observer.connect();
  });
  afterEach(async () => {
    await observer.del(COMMERCIAL_LLM_LEASE_KEY, COMMERCIAL_LLM_COOLDOWN_KEY);
    observer.disconnect();
  });

  it('keeps an ambiguous HTTP timeout fenced without TTL and rejects a new owner', async () => {
    const redis = new Redis(url, { keyPrefix: prefix, lazyConnect: true });
    const classify = jest
      .fn<
        ReturnType<Parameters<typeof runCommercialLlmShadowSmoke>[0]['client']['classify']>,
        Parameters<Parameters<typeof runCommercialLlmShadowSmoke>[0]['client']['classify']>
      >()
      .mockRejectedValue(new CommercialLlmError('TIMEOUT'));
    const failure = await runCommercialLlmShadowSmoke({
      redis,
      lease: new CommercialLlmShadowLease(redis),
      client: { classify },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommercialLlmShadowSmokeError);
    expect((failure as CommercialLlmShadowSmokeError).code).toBe('MODEL_TIMEOUT');
    expect(await observer.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
    expect(await new CommercialLlmShadowLease(observer).acquire()).toBeNull();
    await expect(readCommercialLlmSmokeAdmission(observer)).resolves.toMatchObject({
      leaseState: 'HELD_PERSISTENT',
      cooldownState: 'ACTIVE',
    });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('observes a pre-existing persistent fence without changing its bytes or TTL', async () => {
    const token = randomUUID();
    await observer.set(COMMERCIAL_LLM_LEASE_KEY, token);
    const redis = new Redis(url, { keyPrefix: prefix, lazyConnect: true });
    const classify = jest.fn<
      ReturnType<Parameters<typeof runCommercialLlmShadowSmoke>[0]['client']['classify']>,
      Parameters<Parameters<typeof runCommercialLlmShadowSmoke>[0]['client']['classify']>
    >();
    const failure = await runCommercialLlmShadowSmoke({
      redis,
      lease: new CommercialLlmShadowLease(redis),
      client: { classify },
    }).catch((error: unknown) => error);
    expect((failure as CommercialLlmShadowSmokeError).diagnostic()).toMatchObject({
      code: 'ADMISSION_BLOCKED',
      admission: { leaseState: 'HELD_PERSISTENT', cooldownState: 'MISSING' },
    });
    expect(await observer.get(COMMERCIAL_LLM_LEASE_KEY)).toBe(token);
    expect(await observer.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
    expect(classify).not.toHaveBeenCalled();
  });
});
