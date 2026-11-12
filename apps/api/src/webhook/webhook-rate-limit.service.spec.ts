import Redis from 'ioredis';
import { WebhookRateLimitService } from './webhook-rate-limit.service';

const redisEvalMock = jest.fn();
const redisQuitMock = jest.fn().mockResolvedValue(undefined);
const redisOnMock = jest.fn();

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    eval: redisEvalMock,
    on: redisOnMock,
    quit: redisQuitMock,
  })),
}));

const redisConstructorMock = Redis as unknown as jest.Mock;

describe('WebhookRateLimitService', () => {
  const originalRole = process.env.APP_ROLE;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 1));
    process.env.APP_ROLE = 'ingress';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env.APP_ROLE = originalRole;
  });

  it('reserves burst and rolling-window capacity in one atomic Redis call', async () => {
    redisEvalMock.mockResolvedValue([1, 1, 1]);
    const service = new WebhookRateLimitService({
      getOrThrow: jest.fn(() => 'redis://localhost:6379/0'),
      get: jest.fn((_key: string, fallback?: number) => fallback),
    } as never);

    await expect(service.isAllowed('127.0.0.1')).resolves.toBe(true);

    expect(redisOnMock).toHaveBeenCalledWith('error', expect.any(Function));
    expect(redisEvalMock).toHaveBeenCalledTimes(1);
    expect(redisEvalMock.mock.calls[0]?.[0]).toContain('MAXIM_WEBHOOK_RATE_LIMIT_V1');
    expect(redisEvalMock.mock.calls[0]?.slice(1)).toEqual([
      2,
      expect.stringMatching(/^webhook:rps:global:/u),
      expect.stringMatching(/^webhook:rps:avg:/u),
      2,
      21,
      450,
      6_000,
    ]);

    await service.onModuleDestroy();
  });

  it('does not open an ingress rate-limit Redis client in the Publisher role', async () => {
    process.env.APP_ROLE = 'publisher';
    const getOrThrow = jest.fn(() => 'redis://localhost:6379/0');
    const service = new WebhookRateLimitService({
      getOrThrow,
      get: jest.fn((_key: string, fallback?: number) => fallback),
    } as never);

    expect(redisConstructorMock).not.toHaveBeenCalled();
    expect(getOrThrow).not.toHaveBeenCalled();
    await service.onModuleDestroy();
    expect(redisQuitMock).not.toHaveBeenCalled();
  });

  it('falls back to in-memory counters when Redis is unavailable', async () => {
    redisEvalMock.mockRejectedValue(new Error('redis unavailable'));
    const service = new WebhookRateLimitService({
      getOrThrow: jest.fn(() => 'redis://localhost:6379/0'),
      get: jest.fn((key: string, fallback?: number) => {
        if (key === 'WEBHOOK_GLOBAL_RPS_LIMIT') {
          return 2;
        }
        if (key === 'WEBHOOK_BURST_LIMIT') {
          return 2;
        }
        return fallback;
      }),
    } as never);

    await expect(service.isAllowed('127.0.0.1')).resolves.toBe(true);
    await expect(service.isAllowed('127.0.0.1')).resolves.toBe(true);
    await expect(service.isAllowed('127.0.0.1')).resolves.toBe(false);

    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 1) + 1_000);
    await expect(service.isAllowed('127.0.0.1')).resolves.toBe(true);
    await expect(service.isAllowed('127.0.0.1')).resolves.toBe(true);
    await expect(service.isAllowed('127.0.0.1')).resolves.toBe(false);

    await service.onModuleDestroy();
    expect(redisQuitMock).toHaveBeenCalled();
  });
});
