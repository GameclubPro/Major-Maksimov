import Redis from 'ioredis';
import type { Logger } from '@nestjs/common';
import {
  VkParsingRateLimitService,
  type VkApiAdmissionOptions,
} from './vk-parsing-rate-limit.service';

jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));

describe('VkParsingRateLimitService bounded metrics', () => {
  const credentialScope = 'a'.repeat(64);
  const admission = (overrides: Partial<VkApiAdmissionOptions> = {}): VkApiAdmissionOptions => ({
    credentialScope,
    deadlineAtMs: Date.now() + 20_000,
    ...overrides,
  });

  function fixture(config: Record<string, unknown> = {}) {
    const pipeline = {
      hgetall: jest.fn().mockReturnThis(),
      hincrby: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    const redis = {
      on: jest.fn(),
      pipeline: jest.fn().mockReturnValue(pipeline),
      multi: jest.fn().mockReturnValue(pipeline),
      eval: jest.fn().mockResolvedValue([1, 0, 0]),
      scan: jest.fn(),
    };
    (Redis as unknown as jest.Mock).mockReturnValue(redis);
    const service = new VkParsingRateLimitService({
      getOrThrow: () => 'redis://localhost',
      get: (key: string) => config[key],
    } as never);
    const warning = jest
      .spyOn(Reflect.get(service, 'logger') as Logger, 'warn')
      .mockImplementation();
    return { service, redis, pipeline, warning };
  }

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('reads only exact second buckets in one pipeline without scanning shared Redis', async () => {
    jest.useFakeTimers().setSystemTime(1_000_000);
    const { service, redis, pipeline } = fixture();
    pipeline.exec.mockResolvedValue([
      [null, { 'success:success': '8', 'error:vk_6': '2' }],
      [null, { 'error:vk_6': '1', 'error:network': '1', invalid: '100', 'error:bad': '-1' }],
    ]);
    await expect(service.getRecentVkApiMetrics(2)).resolves.toEqual({
      rps: 6,
      errorRate: 4 / 12,
      recentErrors: [
        { code: 'vk_6', count: 3 },
        { code: 'network', count: 1 },
      ],
    });
    expect(pipeline.hgetall.mock.calls).toEqual([
      ['vkapi:metrics:v2:1000'],
      ['vkapi:metrics:v2:999'],
    ]);
    expect(redis.scan).not.toHaveBeenCalled();
  });

  it.each([
    [1e9, 900],
    [NaN, 300],
    [0, 1],
  ])('bounds a requested window of %s seconds', async (requested, expected) => {
    const { service, pipeline } = fixture();
    await service.getRecentVkApiMetrics(requested);
    expect(pipeline.hgetall).toHaveBeenCalledTimes(expected);
  });

  it('stores counters with expiry and does not fail a VK request when metrics fail', async () => {
    jest.useFakeTimers().setSystemTime(1_000_000);
    const { service, pipeline } = fixture();
    pipeline.exec.mockResolvedValue([[new Error('metrics unavailable'), null]]);
    await expect(
      service.recordVkApiOutcome({ method: 'wall.get', outcome: 'error', code: 'vk_6' }),
    ).resolves.toBeUndefined();
    expect(pipeline.hincrby).toHaveBeenCalledWith('vkapi:metrics:v2:1000', 'error:vk_6', 1);
    expect(pipeline.expire).toHaveBeenCalledWith('vkapi:metrics:v2:1000', 21_600);
  });

  it('retries at the next rate window instead of sleeping for the key cleanup TTL', async () => {
    jest.useFakeTimers().setSystemTime(1_000_900);
    const { service, redis } = fixture();
    redis.eval.mockResolvedValueOnce([0, 1, 2_000]);
    const reserved = service.reserveVkApiSlot('wall.get', admission());
    await jest.advanceTimersByTimeAsync(100);
    await reserved;
    expect(redis.eval).toHaveBeenCalledTimes(2);
  });

  it('fails fast on Redis failures rather than queueing indefinitely', () => {
    fixture();
    expect(Redis).toHaveBeenLastCalledWith(
      'redis://localhost',
      expect.objectContaining({
        commandTimeout: 1_000,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      }),
    );
  });

  it('admits one healthy reservation with no local waiting configured', async () => {
    const { service, redis } = fixture({ VK_API_RATE_LIMIT_WAIT_MS: 0 });
    await expect(service.reserveVkApiSlot('wall.get', admission())).resolves.toBeUndefined();
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      3,
      expect.stringMatching(/^vkapi:rps:global:\d+$/u),
      expect.stringMatching(/^vkapi:rps:method:wall.get:\d+$/u),
      `vkapi:provider-cooldown:v1:${credentialScope}`,
      '5',
      '5',
      '2000',
    );
  });

  it('returns a provider deadline promptly when it exceeds the admission budget', async () => {
    jest.useFakeTimers().setSystemTime(1_000_000);
    const { service, redis } = fixture();
    redis.eval.mockResolvedValue([0, 3, 5_000, 1_005_000]);
    await expect(service.reserveVkApiSlot('wall.get', admission())).rejects.toMatchObject({
      code: 'provider_cooldown',
      retryable: true,
      retryAtMs: 1_005_000,
    });
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('waits only to a short provider deadline before reserving again', async () => {
    jest.useFakeTimers().setSystemTime(1_000_000);
    const { service, redis } = fixture();
    redis.eval.mockResolvedValueOnce([0, 3, 500, 1_000_500]);
    const reserved = service.reserveVkApiSlot('wall.get', admission());
    await jest.advanceTimersByTimeAsync(499);
    expect(redis.eval).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await reserved;
    expect(redis.eval).toHaveBeenCalledTimes(2);
  });

  it('retains a local provider pause after a rejected publication and a new request', async () => {
    jest.useFakeTimers().setSystemTime(1_000_000);
    const { service, redis, warning } = fixture();
    redis.eval.mockRejectedValueOnce(new Error('publication unavailable'));
    await expect(service.publishVkApiCooldown(credentialScope, 1_120_000)).rejects.toThrow(
      'publication unavailable',
    );
    await expect(service.reserveVkApiSlot('wall.get', admission())).rejects.toMatchObject({
      code: 'provider_cooldown',
      retryAtMs: 1_120_000,
    });
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      { code: 'vk_provider_cooldown_unconfirmed' },
      'VK provider cooldown publication was not acknowledged',
    );
  });

  it('honors a provider pause learned while an earlier reservation acknowledgement is pending', async () => {
    jest.useFakeTimers().setSystemTime(1_000_000);
    const { service, redis } = fixture();
    let acknowledge!: (reply: number[]) => void;
    redis.eval.mockImplementationOnce(() => new Promise((resolve) => (acknowledge = resolve)));
    redis.eval.mockResolvedValueOnce(1_120_000);
    const result = expect(service.reserveVkApiSlot('wall.get', admission())).rejects.toMatchObject({
      code: 'provider_cooldown',
      retryAtMs: 1_120_000,
    });
    await service.publishVkApiCooldown(credentialScope, 1_120_000);
    acknowledge([1, 0, 0, 0]);
    await result;
  });

  it.each([null, '1005000', -1, 1_000_999, Number.NaN])(
    'does not accept a malformed or shorter publication acknowledgement: %s',
    async (acknowledgement) => {
      jest.useFakeTimers().setSystemTime(1_000_000);
      const { service, redis } = fixture();
      redis.eval.mockResolvedValueOnce(acknowledgement);
      await expect(service.publishVkApiCooldown(credentialScope, 1_005_000)).rejects.toThrow(
        'Failed to acknowledge',
      );
      await expect(service.reserveVkApiSlot('wall.get', admission())).rejects.toMatchObject({
        code: 'provider_cooldown',
        retryAtMs: 1_005_000,
      });
      expect(redis.eval).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects an expired request before Redis admission', async () => {
    const { service, redis } = fixture();
    await expect(
      service.reserveVkApiSlot('wall.get', admission({ deadlineAtMs: Date.now() })),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('rejects a reservation acknowledged after its request budget', async () => {
    jest.useFakeTimers().setSystemTime(1_000_000);
    const { service, redis } = fixture();
    redis.eval.mockImplementationOnce(async () => {
      jest.setSystemTime(1_020_001);
      return [1, 0, 0, 0];
    });
    await expect(service.reserveVkApiSlot('wall.get', admission())).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it.each(['raw-token', '', 'a'.repeat(65)])(
    'rejects a non-digest scope before Redis: %s',
    async (scope) => {
      const { service, redis } = fixture();
      await expect(
        service.reserveVkApiSlot('wall.get', admission({ credentialScope: scope })),
      ).rejects.toThrow('Invalid VK API credential scope');
      expect(redis.eval).not.toHaveBeenCalled();
    },
  );
});
