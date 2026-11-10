import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisCounterService } from '../redis-counter.service';
import {
  COMMERCIAL_TEXT_CONTROL_KEY,
  CommercialTextRuntimePolicyService,
  type CommercialTextControl,
} from './commercial-text-runtime-policy.service';

const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
const revisionKey = `${COMMERCIAL_TEXT_CONTROL_KEY}:revision`;
const keys = [COMMERCIAL_TEXT_CONTROL_KEY, revisionKey];

// FLAG: Fixed policy keys may be mutated only in the isolated local test store.
// No live message, model, DELETE or sanction client participates in these cases.
(url ? describe : describe.skip)('commercial text policy on native Redis', () => {
  let counter: RedisCounterService;
  let peerCounter: RedisCounterService;
  let inspector: Redis;
  let policy: CommercialTextRuntimePolicyService;
  let peerPolicy: CommercialTextRuntimePolicyService;

  const control = (revision: number, mode: 'off' | 'baseline' = 'off'): CommercialTextControl => ({
    version: 2,
    revision,
    mode,
    chatIds: [],
    promotedPolicyCohorts: [],
    detectorSourceSha256: null,
    decisionVersion: null,
    holdoutArtifactSha256: null,
    settingsProfileDigests: [],
    effectiveAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: null,
    canaryStartedAt: null,
  });

  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
      throw new Error('Isolated local Redis required');
    inspector = new Redis(url);
    counter = new RedisCounterService(new ConfigService({ REDIS_URL: url }));
    peerCounter = new RedisCounterService(new ConfigService({ REDIS_URL: url }));
    // FLAG: Establish both role connections before the production 750ms read budget.
    await Promise.all([inspector.ping(), counter.getStrings(keys), peerCounter.getStrings(keys)]);
    policy = new CommercialTextRuntimePolicyService(counter);
    peerPolicy = new CommercialTextRuntimePolicyService(peerCounter);
  });

  beforeEach(async () => {
    await inspector.del(...keys);
  });

  afterEach(async () => {
    await inspector.del(...keys);
  });

  afterAll(async () => {
    await Promise.all([
      inspector?.quit(),
      counter?.onModuleDestroy(),
      peerCounter?.onModuleDestroy(),
    ]);
  });

  it('observes atomic compare-and-set writes and fresh revocation across roles', async () => {
    await expect(policy.set(control(1), 0)).resolves.toEqual({ applied: true, revision: 1 });
    const candidates = [control(2, 'baseline'), control(2)];
    const writes = await Promise.all([
      policy.set(candidates[0]!, 1),
      peerPolicy.set(candidates[1]!, 1),
    ]);
    expect(writes.filter((result) => result.applied)).toHaveLength(1);
    expect(writes.every((result) => result.revision === 2)).toBe(true);
    const winner = candidates[writes.findIndex((result) => result.applied)]!;
    await expect(policy.snapshot()).resolves.toEqual({ revision: 2, control: winner });
    await expect(peerPolicy.authority('chat')).resolves.toMatchObject({
      revision: 2,
      mode: winner.mode,
      baselineAllowed: winner.mode === 'baseline',
    });
    await expect(peerPolicy.set(control(3), 2)).resolves.toEqual({ applied: true, revision: 3 });
    await expect(policy.authority('chat')).resolves.toMatchObject({
      revision: 3,
      mode: 'off',
      baselineAllowed: false,
      promotedPolicyCohorts: [],
    });
  });

  it('keeps the durable revision after the control body disappears', async () => {
    await policy.set(control(1), 0);
    await inspector.del(COMMERCIAL_TEXT_CONTROL_KEY);
    await expect(policy.snapshot()).resolves.toEqual({ revision: 1, control: null });
    await expect(policy.authority('chat')).resolves.toMatchObject({
      revision: 1,
      mode: 'baseline',
      baselineAllowed: true,
    });
    await expect(policy.set(control(1), 0)).resolves.toEqual({ applied: false, revision: 1 });
    expect(await inspector.get(COMMERCIAL_TEXT_CONTROL_KEY)).toBeNull();
  });

  it.each(keys)('fails closed when %s has the wrong Redis type', async (key) => {
    await policy.set(control(1), 0);
    await inspector.del(key);
    await inspector.rpush(key, 'invalid-proof');
    await expect(policy.snapshot()).rejects.toThrow('WRONGTYPE');
    await expect(policy.authority('chat')).resolves.toMatchObject({
      revision: -1,
      mode: 'unavailable',
      baselineAllowed: false,
      promotedPolicyCohorts: [],
    });
    expect(await inspector.type(key)).toBe('list');
  });

  it('refuses a mismatched control and revision without modifying either proof', async () => {
    const value = control(1);
    await policy.set(value, 0);
    await inspector.set(revisionKey, '2');
    await expect(policy.snapshot()).rejects.toThrow('changed during read');
    await expect(policy.authority('chat')).resolves.toMatchObject({
      revision: -1,
      mode: 'unavailable',
      baselineAllowed: false,
      promotedPolicyCohorts: [],
    });
    expect(await inspector.get(COMMERCIAL_TEXT_CONTROL_KEY)).toBe(JSON.stringify(value));
    expect(await inspector.get(revisionKey)).toBe('2');
  });
});
