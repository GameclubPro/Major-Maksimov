import type { Job, Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { PUBLISHER_AUTO_REPLY_BACKLOG_QUOTA_TESTING } from './publisher-auto-reply-backlog-quota';
import {
  buildPublisherAutoReplyJobId,
  PublisherAutoReplyQueueService,
  type PublisherAutoReplyJob,
} from './publisher-auto-reply.queue';

const QUEUE_PREFIX = 'bull:{publisher-auto-replies}';

type QueueHarnessOptions = {
  dispatchEnabled?: boolean;
  backlogLimit?: number;
  redisEval?: jest.Mock;
  redisUrl?: string;
};

function defaultRedisEval(
  script: unknown,
  _numberOfKeys: unknown,
  ...args: unknown[]
): Promise<unknown> {
  const source = String(script);
  if (source.includes('BACKLOG_RELEASE_V2')) {
    return Promise.resolve(1);
  }
  if (source.includes('BACKLOG_CLAIM_V2')) {
    return Promise.resolve([1, args.at(-3), 0, 1]);
  }
  return Promise.resolve([1, 0, 0]);
}

function createService(
  queueInput: Partial<Queue<PublisherAutoReplyJob>>,
  options: QueueHarnessOptions = {},
) {
  const dispatchEnabled = options.dispatchEnabled ?? true;
  const redisEval = options.redisEval ?? jest.fn(defaultRedisEval);
  const queue = queueInput as Queue<PublisherAutoReplyJob>;
  Object.assign(queue, {
    keys: {
      wait: `${QUEUE_PREFIX}:wait`,
      paused: `${QUEUE_PREFIX}:paused`,
      active: `${QUEUE_PREFIX}:active`,
      delayed: `${QUEUE_PREFIX}:delayed`,
      prioritized: `${QUEUE_PREFIX}:prioritized`,
      'waiting-children': `${QUEUE_PREFIX}:waiting-children`,
    },
    toKey: (suffix: string) => `${QUEUE_PREFIX}:${suffix}`,
  });
  Object.defineProperty(queue, 'client', {
    configurable: true,
    value: Promise.resolve({ eval: redisEval }),
  });

  const service = new PublisherAutoReplyQueueService(
    queue,
    {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'MAX_PUBLISHER_BOT_ID') return 'publisher-bot';
        if (key === 'PUBLISHER_AUTO_REPLY_QUEUE_BACKLOG_LIMIT') {
          return options.backlogLimit ?? fallback;
        }
        if (key === 'REDIS_URL') return options.redisUrl ?? fallback;
        return fallback;
      }),
    } as unknown as ConfigService,
    {
      read: jest.fn().mockResolvedValue({
        dispatchEnabled,
        blocker: dispatchEnabled ? null : 'runtime_disabled',
      }),
    } as never,
  );
  return { service, queue, redisEval };
}

function callsFor(redisEval: jest.Mock, marker: string): unknown[][] {
  return redisEval.mock.calls.filter((call) => String(call[0]).includes(marker));
}

describe('PublisherAutoReplyQueueService', () => {
  it('does not open a dedicated admission client in a non-owning runtime role', async () => {
    const originalRole = process.env.APP_ROLE;
    process.env.APP_ROLE = 'admin';
    try {
      const { service } = createService({}, { redisUrl: 'redis://127.0.0.1:1' });
      const quota = (service as unknown as { backlogQuota: { ownedRedis: unknown } }).backlogQuota;
      expect(quota.ownedRedis).toBeNull();
      await service.onModuleDestroy();
    } finally {
      process.env.APP_ROLE = originalRole;
    }
  });

  it('enqueues only a delivery identity under a stable operation lease', async () => {
    const queue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const { service, redisEval } = createService(queue);

    await expect(service.ensureDeliveryJob('delivery-1')).resolves.toEqual({
      outcome: 'add_acknowledged',
    });

    expect(queue.add).toHaveBeenCalledWith(
      'deliver',
      {
        version: 1,
        kind: 'deliver',
        retryPolicyName: 'publisher-auto-reply',
        deliveryId: 'delivery-1',
      },
      expect.objectContaining({
        jobId: buildPublisherAutoReplyJobId('delivery-1'),
        attempts: 7,
      }),
    );
    expect(JSON.stringify((queue.add as jest.Mock).mock.calls[0]?.[1])).not.toContain('base64');
    expect(callsFor(redisEval, 'BACKLOG_CLAIM_V2')).toHaveLength(1);
    expect(callsFor(redisEval, 'BACKLOG_RELEASE_V2')).toHaveLength(1);
  });

  it.each(['active', 'waiting', 'delayed', 'prioritized'])(
    'reports an existing %s job without allocating another quota slot',
    async (state) => {
      const existing = {
        getState: jest.fn().mockResolvedValue(state),
      } as unknown as Job<PublisherAutoReplyJob>;
      const queue = {
        getJob: jest.fn().mockResolvedValue(existing),
        add: jest.fn(),
      };
      const { service, redisEval } = createService(queue);

      await expect(service.ensureDeliveryJob('delivery-1')).resolves.toEqual({
        outcome: 'already_live',
      });

      expect(queue.add).not.toHaveBeenCalled();
      expect(redisEval).not.toHaveBeenCalled();
    },
  );

  it.each(['completed', 'failed'])(
    'acknowledges replacement of a %s job when its durable delivery remains pending',
    async (state) => {
      const existing = {
        getState: jest.fn().mockResolvedValue(state),
        remove: jest.fn().mockResolvedValue(undefined),
      } as unknown as Job<PublisherAutoReplyJob>;
      const queue = {
        getJob: jest.fn().mockResolvedValue(existing),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const { service } = createService(queue);

      await expect(service.ensureDeliveryJob('delivery-1')).resolves.toEqual({
        outcome: 'add_acknowledged',
      });

      expect(existing.remove).toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalled();
    },
  );

  it('rejects admission while the Publisher runtime kill switch is active', async () => {
    const queue = {
      getJob: jest.fn(),
      add: jest.fn(),
    };
    const { service, redisEval } = createService(queue, { dispatchEnabled: false });

    await expect(service.ensureDeliveryJob('delivery-1')).rejects.toMatchObject({
      reason: 'dispatch_disabled',
    });
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(redisEval).not.toHaveBeenCalled();
  });

  it('preflights every live BullMQ state and inflight lease without a cached snapshot', async () => {
    const queue = {
      getJobCounts: jest.fn(),
    };
    const { service, redisEval } = createService(queue);

    await service.assertNewDeliveryAdmissionEnabled();

    expect(queue.getJobCounts).not.toHaveBeenCalled();
    const preflightCall = callsFor(redisEval, 'BACKLOG_PREFLIGHT_V2')[0]!;
    expect(preflightCall[1]).toBe(7);
    expect(preflightCall.slice(2, 9)).toEqual([
      `${QUEUE_PREFIX}:auto-reply-backlog-inflight`,
      `${QUEUE_PREFIX}:wait`,
      `${QUEUE_PREFIX}:paused`,
      `${QUEUE_PREFIX}:active`,
      `${QUEUE_PREFIX}:delayed`,
      `${QUEUE_PREFIX}:prioritized`,
      `${QUEUE_PREFIX}:waiting-children`,
    ]);
    expect(String(preflightCall[0])).toContain("redis.call('LLEN', KEYS[2])");
    expect(String(preflightCall[0])).toContain("redis.call('ZCARD', KEYS[7])");
  });

  it('fails closed before a new row when preflight observes the ceiling', async () => {
    const redisEval = jest.fn().mockResolvedValue([0, 200, 0]);
    const { service } = createService({}, { redisEval });

    await expect(service.assertNewDeliveryAdmissionEnabled()).rejects.toMatchObject({
      reason: 'backlog_limit',
    });
  });

  it('atomically grants only one free slot across service instances at the final ceiling', async () => {
    const operations = new Set<string>();
    const redisEval = jest.fn(async (script: unknown, _keyCount: unknown, ...args: unknown[]) => {
      const source = String(script);
      if (source.includes('BACKLOG_RELEASE_V2')) {
        return 1;
      }
      if (!source.includes('BACKLOG_CLAIM_V2')) {
        return [1, 9, operations.size];
      }
      const operationId = String(args.at(-4));
      const attemptToken = args.at(-3);
      if (!operations.has(operationId) && 9 + operations.size >= 10) {
        return [0, '', 9, operations.size];
      }
      operations.add(operationId);
      return [1, attemptToken, 9, operations.size];
    });
    const firstQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const secondQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const first = createService(firstQueue, { backlogLimit: 10, redisEval }).service;
    const second = createService(secondQueue, { backlogLimit: 10, redisEval }).service;

    const results = await Promise.allSettled([
      first.ensureDeliveryJob('delivery-a'),
      second.ensureDeliveryJob('delivery-b'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(firstQueue.add.mock.calls.length + secondQueue.add.mock.calls.length).toBe(1);
  });

  it.each([
    ['Redis error', () => Promise.reject(new Error('redis unavailable'))],
    ['malformed result', () => Promise.resolve({ status: 1 })],
    ['late script', () => Promise.resolve([-2, 0, 0])],
  ])('fails closed when preflight has a %s', async (_label, result) => {
    const redisEval = jest.fn().mockImplementation(result);
    const { service } = createService({}, { redisEval });

    await expect(service.assertNewDeliveryAdmissionEnabled()).rejects.toMatchObject({
      reason: 'backlog_unavailable',
    });
  });

  it('best-effort releases the exact attempt after an ambiguous claim failure', async () => {
    const redisEval = jest.fn(async (script: unknown) => {
      if (String(script).includes('BACKLOG_CLAIM_V2')) {
        throw new Error('claim response timed out after commit');
      }
      return 1;
    });
    const queue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn(),
    };
    const { service } = createService(queue, { redisEval });

    await expect(service.ensureDeliveryJob('delivery-ambiguous')).rejects.toMatchObject({
      reason: 'backlog_unavailable',
    });

    const claimCall = callsFor(redisEval, 'BACKLOG_CLAIM_V2')[0]!;
    const releaseCall = callsFor(redisEval, 'BACKLOG_RELEASE_V2')[0]!;
    expect(releaseCall.at(-2)).toBe(claimCall.at(-4));
    expect(releaseCall.at(-1)).toBe(claimCall.at(-3));
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('reports only acknowledgements for concurrent duplicate ensures under separate fencing attempts', async () => {
    const redisEval = jest.fn(defaultRedisEval);
    const acknowledgedJob = { id: buildPublisherAutoReplyJobId('same-delivery') };
    const firstQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(acknowledgedJob),
    };
    const secondQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(acknowledgedJob),
    };
    const first = createService(firstQueue, { redisEval }).service;
    const second = createService(secondQueue, { redisEval }).service;

    const results = await Promise.all([
      first.ensureDeliveryJob('same-delivery'),
      second.ensureDeliveryJob('same-delivery'),
    ]);

    expect(results).toEqual([{ outcome: 'add_acknowledged' }, { outcome: 'add_acknowledged' }]);
    const claims = callsFor(redisEval, 'BACKLOG_CLAIM_V2');
    expect(claims).toHaveLength(2);
    expect(claims[0]?.at(-4)).toBe(claims[1]?.at(-4));
    expect(claims[0]?.at(-3)).not.toBe(claims[1]?.at(-3));
    expect(String(claims[0]?.at(-4))).toMatch(/^[a-f0-9]{32}$/u);
  });

  it('releases the exact fencing attempt immediately when BullMQ add fails', async () => {
    const addFailure = new Error('BullMQ add failed');
    const queue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockRejectedValue(addFailure),
    };
    const { service, redisEval } = createService(queue);

    await expect(service.ensureDeliveryJob('delivery-1')).rejects.toBe(addFailure);

    const claimCall = callsFor(redisEval, 'BACKLOG_CLAIM_V2')[0]!;
    const releaseCall = callsFor(redisEval, 'BACKLOG_RELEASE_V2')[0]!;
    expect(releaseCall.at(-2)).toBe(claimCall.at(-4));
    expect(releaseCall.at(-1)).toBe(claimCall.at(-3));
  });

  it('keeps the original add failure when best-effort lease release is unavailable', async () => {
    const addFailure = new Error('BullMQ add failed');
    const redisEval = jest.fn(async (script: unknown, _keyCount: unknown, ...args: unknown[]) => {
      if (String(script).includes('BACKLOG_RELEASE_V2')) {
        throw new Error('release unavailable');
      }
      return [1, args.at(-3), 0, 1];
    });
    const { service } = createService(
      {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn().mockRejectedValue(addFailure),
      },
      { redisEval },
    );

    await expect(service.ensureDeliveryJob('delivery-1')).rejects.toBe(addFailure);
  });

  it('defers recovery when the stable delivery claim has no global slot', async () => {
    const redisEval = jest.fn().mockResolvedValue([0, '', 200, 0]);
    const queue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn(),
    };
    const { service } = createService(queue, { redisEval });

    await expect(service.ensureDeliveryJob('delivery-recovery-1')).rejects.toMatchObject({
      reason: 'backlog_limit',
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('uses Redis time, expiry cleanup and fenced release in the quota scripts', () => {
    const { preflightScript, claimScript, releaseScript, inflightLeaseTtlMs, redisOptions } =
      PUBLISHER_AUTO_REPLY_BACKLOG_QUOTA_TESTING;

    for (const script of [preflightScript, claimScript]) {
      expect(script).toContain("redis.call('TIME')");
      expect(script).toContain("redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms)");
      expect(script).toContain('now_ms >= tonumber(ARGV[1])');
    }
    expect(claimScript).toContain("redis.call('SADD', KEYS[2], ARGV[3])");
    expect(releaseScript).toContain("redis.call('SREM', KEYS[2], ARGV[2])");
    expect(releaseScript).toContain("redis.call('SCARD', KEYS[2]) == 0");
    expect(inflightLeaseTtlMs).toBe(10 * 60_000);
    expect(redisOptions).toMatchObject({
      commandTimeout: 250,
      connectTimeout: 250,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
  });
});
