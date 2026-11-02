import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { DEFAULT_WEBHOOK_LEASE_SUMMARY_KEY } from '../runtime/default-webhook-dynamic-leases';
import { WebhookDynamicLeaseStatusService } from './webhook-dynamic-lease-status.service';

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue(null),
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
    disconnect: jest.fn(),
  })),
}));

function fixture() {
  const service = new WebhookDynamicLeaseStatusService({
    getOrThrow: () => 'redis://localhost:6379/0',
  } as never);
  const constructor = Redis as unknown as jest.Mock;
  const redis = constructor.mock.results.at(-1)!.value as {
    get: jest.Mock<ReturnType<Redis['get']>, Parameters<Redis['get']>>;
    on: jest.Mock;
    quit: jest.Mock;
    disconnect: jest.Mock;
  };
  return { service, redis };
}

describe('WebhookDynamicLeaseStatusService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('bounds advisory Redis commands and never queues reads while disconnected', async () => {
    const { service, redis } = fixture();
    expect(Redis).toHaveBeenCalledWith('redis://localhost:6379/0', {
      commandTimeout: 500,
      connectTimeout: 1_000,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    expect(redis.on).toHaveBeenCalledWith('error', expect.any(Function));
    await expect(service.getSummary()).resolves.toBeNull();
    expect(redis.get).toHaveBeenCalledWith(DEFAULT_WEBHOOK_LEASE_SUMMARY_KEY);
    await service.onModuleDestroy();
  });

  it('returns unavailable on a failed read without presenting stale leases as fresh', async () => {
    const { service, redis } = fixture();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const summary = {
      mode: 'off',
      generatedAt: new Date().toISOString(),
      queues: {},
      workerLoads: {},
      liveWorkerGroups: [],
    };
    redis.get.mockResolvedValueOnce(JSON.stringify(summary));
    await expect(service.getSummary()).resolves.toEqual(summary);
    await expect(service.getSummary(1_000)).resolves.toEqual(summary);
    expect(redis.get).toHaveBeenCalledTimes(1);
    redis.get.mockRejectedValueOnce(new Error('Command timed out'));
    await expect(service.getSummary()).resolves.toBeNull();
    await service.onModuleDestroy();
  });

  it('disconnects on failed graceful shutdown', async () => {
    const { service, redis } = fixture();
    redis.quit.mockRejectedValueOnce(new Error('Connection unavailable'));
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });
});
