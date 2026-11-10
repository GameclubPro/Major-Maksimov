import { COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256 } from '../commercial-ocr/commercial-ocr-detector-source.generated';
import type { RedisCounterService } from '../redis-counter.service';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';
import {
  COMMERCIAL_INTENT_QUALITY_COHORT,
  COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
} from './commercial-policy-cohorts';
import {
  CommercialTextRuntimePolicyService,
  COMMERCIAL_TEXT_CONTROL_KEY,
  commercialQualityStopKey,
} from './commercial-text-runtime-policy.service';

function harness() {
  const redis: jest.Mocked<
    Pick<RedisCounterService, 'getString' | 'getStrings' | 'compareAndSetRevisionedControl'>
  > = {
    getString: jest
      .fn<
        ReturnType<RedisCounterService['getString']>,
        Parameters<RedisCounterService['getString']>
      >()
      .mockResolvedValue(null),
    getStrings: jest
      .fn<
        ReturnType<RedisCounterService['getStrings']>,
        Parameters<RedisCounterService['getStrings']>
      >()
      .mockResolvedValue([null, null]),
    compareAndSetRevisionedControl: jest
      .fn<
        ReturnType<RedisCounterService['compareAndSetRevisionedControl']>,
        Parameters<RedisCounterService['compareAndSetRevisionedControl']>
      >()
      .mockResolvedValue({ applied: true, revision: 1 }),
  };
  const prisma = {
    commercialQualityPolicyStop: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ stoppedAt: new Date() }),
    },
  };
  return {
    redis,
    prisma,
    service: new CommercialTextRuntimePolicyService(
      redis as unknown as RedisCounterService,
      prisma as never,
    ),
  };
}
const control = (mode = 'canary') => ({
  detectorSourceSha256: COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256,
  decisionVersion: COMMERCIAL_ENGINE_CONFIG.decisionVersion,
  holdoutArtifactSha256: 'a'.repeat(64),
  settingsProfileDigests: ['b'.repeat(64)],
  version: 2 as const,
  revision: 1,
  mode: mode as 'canary',
  chatIds: ['test-chat'],
  promotedPolicyCohorts: ['owned-service-contrast-v1' as const],
  effectiveAt: new Date(Date.now() - 1000).toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
});

describe('commercial text shared authority', () => {
  it('runs the released deterministic rules without an experimental control', async () => {
    const h = harness();
    await expect(h.service.authority('chat')).resolves.toMatchObject({
      baselineAllowed: true,
      promotedPolicyCohorts: ['owned-service-contrast-v1', 'sliding-campaign-v1'],
      revision: 0,
    });
    expect(h.redis.getStrings).toHaveBeenCalledWith([
      COMMERCIAL_TEXT_CONTROL_KEY,
      `${COMMERCIAL_TEXT_CONTROL_KEY}:revision`,
    ]);
    expect(h.redis.getString).not.toHaveBeenCalled();
  });
  it.each(['shadow', 'baseline', 'off', 'canary', 'on'])(
    'enforces %s with explicit cohort membership',
    async (mode) => {
      const h = harness();
      h.redis.getStrings.mockResolvedValue([JSON.stringify(control(mode)), '1']);
      const selected = await h.service.authority('test-chat', 'b'.repeat(64));
      const other = await h.service.authority('other-chat', 'b'.repeat(64));
      expect(selected.baselineAllowed).toBe(mode !== 'off');
      expect(selected.promotedPolicyCohorts.length).toBe(
        mode === 'baseline' ? 2 : ['canary', 'on'].includes(mode) ? 1 : 0,
      );
      expect(other.promotedPolicyCohorts.length).toBe(
        mode === 'baseline' ? 2 : mode === 'on' ? 1 : 0,
      );
    },
  );
  it.each(['malformed', 'mismatch', 'transport'])(
    'fails unknown %s authority closed',
    async (failure) => {
      const h = harness();
      if (failure === 'transport') h.redis.getStrings.mockRejectedValue(new Error('offline'));
      else
        h.redis.getStrings.mockResolvedValue([
          failure === 'malformed' ? '{}' : JSON.stringify(control()),
          '2',
        ]);
      await expect(h.service.authority('test-chat', 'b'.repeat(64))).resolves.toMatchObject({
        baselineAllowed: false,
        promotedPolicyCohorts: [],
        mode: 'unavailable',
      });
    },
  );
  it.each(['01', '-1', '1.0', 'NaN', '9007199254740992'])(
    'rejects the invalid revision %s even without a live control',
    async (revision) => {
      const h = harness();
      h.redis.getStrings.mockResolvedValue([null, revision]);
      await expect(h.service.authority('chat')).resolves.toMatchObject({
        revision: -1,
        baselineAllowed: false,
        promotedPolicyCohorts: [],
        mode: 'unavailable',
      });
    },
  );
  it('keeps the 750ms policy budget when the batched read never completes', async () => {
    jest.useFakeTimers();
    try {
      const h = harness();
      h.redis.getStrings.mockReturnValue(new Promise(() => {}));
      const settled = jest.fn();
      const result = h.service.authority('chat').then((value) => {
        settled();
        return value;
      });
      await jest.advanceTimersByTimeAsync(749);
      expect(settled).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({
        revision: -1,
        baselineAllowed: false,
        promotedPolicyCohorts: [],
        mode: 'unavailable',
      });
    } finally {
      jest.useRealTimers();
    }
  });
  it('does not lend expired recall to new deletes and checks revision on write', async () => {
    const h = harness();
    h.redis.getStrings.mockResolvedValue([
      JSON.stringify({ ...control(), expiresAt: new Date(Date.now() - 1).toISOString() }),
      '1',
    ]);
    await expect(h.service.authority('test-chat', 'b'.repeat(64))).resolves.toMatchObject({
      baselineAllowed: true,
      promotedPolicyCohorts: ['owned-service-contrast-v1', 'sliding-campaign-v1'],
      revision: 1,
    });
    await expect(h.service.set(control(), 1)).rejects.toThrow('revision');
    expect(h.redis.compareAndSetRevisionedControl).not.toHaveBeenCalled();
  });
  it('requires finite promotion lifetime and explicit canary chats', async () => {
    const h = harness();
    await expect(h.service.set({ ...control(), expiresAt: null }, 0)).rejects.toThrow('finite');
    await expect(h.service.set({ ...control(), chatIds: [] }, 0)).rejects.toThrow('explicit');
    await expect(h.service.set(control(), 0)).resolves.toMatchObject({
      applied: true,
      revision: 1,
    });
  });
  it('never promotes the quality cohort from baseline or a baseline-version artifact', async () => {
    const h = harness();
    const candidate = { ...control(), promotedPolicyCohorts: [COMMERCIAL_INTENT_QUALITY_COHORT] };
    h.redis.getStrings.mockResolvedValue([JSON.stringify(candidate), '1']);
    expect((await h.service.authority('test-chat', 'b'.repeat(64))).promotedPolicyCohorts).toEqual(
      [],
    );
    await expect(h.service.set(candidate, 0)).rejects.toThrow('current detector');
    const reviewed = { ...candidate, decisionVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION };
    h.redis.getStrings.mockResolvedValue([JSON.stringify(reviewed), '1']);
    expect((await h.service.authority('test-chat', 'b'.repeat(64))).promotedPolicyCohorts).toEqual([
      COMMERCIAL_INTENT_QUALITY_COHORT,
    ]);
    expect((await h.service.authority('other-chat', 'b'.repeat(64))).promotedPolicyCohorts).toEqual(
      [],
    );
    h.redis.getStrings.mockResolvedValue([JSON.stringify({ ...reviewed, mode: 'baseline' }), '1']);
    expect((await h.service.authority('test-chat', 'b'.repeat(64))).promotedPolicyCohorts).toEqual([
      'owned-service-contrast-v1',
      'sliding-campaign-v1',
    ]);
  });
  it('starts the quality canary clock on the server and rejects immediate broad expansion', async () => {
    const h = harness();
    const value = {
      ...control(),
      decisionVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
      promotedPolicyCohorts: [COMMERCIAL_INTENT_QUALITY_COHORT],
      canaryStartedAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    };
    await expect(h.service.set({ ...value, mode: 'on' }, 0)).rejects.toThrow('seven-day');
    await h.service.set(value, 0);
    const stored = JSON.parse(h.redis.compareAndSetRevisionedControl.mock.calls[0]![0].value);
    expect(Date.now() - Date.parse(stored.canaryStartedAt)).toBeLessThan(1_000);
  });

  it('preserves the same uninterrupted canary and requires the completed exact cohort for expansion', async () => {
    const h = harness();
    const previous = {
      ...control(),
      decisionVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
      promotedPolicyCohorts: [COMMERCIAL_INTENT_QUALITY_COHORT],
      canaryStartedAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    };
    h.redis.getStrings.mockImplementation(async () => [JSON.stringify(previous), '1']);
    const next = { ...previous, revision: 2 };
    await h.service.set(next, 1);
    expect(
      JSON.parse(h.redis.compareAndSetRevisionedControl.mock.calls[0]![0].value).canaryStartedAt,
    ).toBe(previous.canaryStartedAt);
    await h.service.set({ ...next, mode: 'on', chatIds: ['test-chat', 'expanded-chat'] }, 1);
    await expect(
      h.service.set({ ...next, mode: 'on', chatIds: ['other-chat'] }, 1),
    ).rejects.toThrow('explicit-chat');
    await expect(
      h.service.set({ ...next, mode: 'on', settingsProfileDigests: ['c'.repeat(64)] }, 1),
    ).rejects.toThrow('seven-day');
    previous.expiresAt = new Date(Date.now() - 1).toISOString();
    await expect(h.service.set({ ...next, mode: 'on' }, 1)).rejects.toThrow('seven-day');
  });

  it('permanently stops only the exact quality source after a confirmed independent false deletion', async () => {
    const h = harness();
    await expect(
      h.service.stopQualityAfterConfirmedFalseDeletion({
        detectorSourceSha256: COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256,
        decisionVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
      }),
    ).resolves.toBe(true);
    expect(h.redis.compareAndSetRevisionedControl).toHaveBeenCalledWith(
      expect.objectContaining({
        key: commercialQualityStopKey(COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256),
        expiresAtMs: null,
      }),
    );
    expect(h.prisma.commercialQualityPolicyStop.upsert).toHaveBeenCalled();
    const candidate = {
      ...control(),
      decisionVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
      promotedPolicyCohorts: [COMMERCIAL_INTENT_QUALITY_COHORT],
    };
    h.redis.getStrings.mockResolvedValue([JSON.stringify(candidate), '1']);
    h.redis.getString.mockImplementation(async (key) =>
      key === commercialQualityStopKey(COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256) ? 'stopped' : null,
    );
    expect((await h.service.authority('test-chat', 'b'.repeat(64))).promotedPolicyCohorts).toEqual(
      [],
    );
    await expect(h.service.set(candidate, 0)).rejects.toThrow('stopped');
    expect(
      await h.service.stopQualityAfterConfirmedFalseDeletion({
        detectorSourceSha256: COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256,
        decisionVersion: COMMERCIAL_ENGINE_CONFIG.decisionVersion,
      }),
    ).toBe(false);
  });
  it('keeps a confirmed stop after Redis data loss and rejects unknown durable authority', async () => {
    const h = harness();
    const candidate = {
      ...control(),
      decisionVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
      promotedPolicyCohorts: [COMMERCIAL_INTENT_QUALITY_COHORT],
    };
    h.redis.getStrings.mockResolvedValue([JSON.stringify(candidate), '1']);
    h.prisma.commercialQualityPolicyStop.findUnique.mockResolvedValue({ stoppedAt: new Date() });
    expect((await h.service.authority('test-chat', 'b'.repeat(64))).promotedPolicyCohorts).toEqual(
      [],
    );
    h.prisma.commercialQualityPolicyStop.findUnique.mockRejectedValue(
      new Error('database unavailable'),
    );
    expect((await h.service.authority('test-chat', 'b'.repeat(64))).baselineAllowed).toBe(false);
    const missing = new CommercialTextRuntimePolicyService(
      h.redis as unknown as RedisCounterService,
    );
    expect((await missing.authority('test-chat', 'b'.repeat(64))).baselineAllowed).toBe(false);
  });
});
