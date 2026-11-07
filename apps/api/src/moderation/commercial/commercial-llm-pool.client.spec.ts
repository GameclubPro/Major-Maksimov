import { randomUUID } from 'node:crypto';
import { CommercialLlmError } from './commercial-llm.client';
import {
  CommercialLlmPoolClient,
  CommercialLlmPoolRoutingStats,
  type CommercialLlmPoolClientOptions,
} from './commercial-llm-pool.client';
import type {
  CommercialLlmPoolMailbox,
  CommercialLlmPoolReservation,
} from './commercial-llm-pool.mailbox';
import {
  COMMERCIAL_LLM_POOL_PROFILES,
  POOL_NODE_IDS,
  LEGACY_POOL_NODE_IDS,
  type CommercialLlmPoolNodeId,
} from './commercial-llm-pool.protocol';
import type { CommercialLlmClassification } from './commercial-llm.protocol';

function envelope(nodeId: CommercialLlmPoolNodeId, classification: CommercialLlmClassification) {
  return JSON.stringify({
    model: COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity.modelAlias,
    choices: [
      {
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify({
            classification,
            reasonCodes: [
              classification === 'COMMERCIAL'
                ? 'COMMERCIAL_OFFER'
                : classification === 'NOT_COMMERCIAL'
                  ? 'PERSONAL_SALE'
                  : 'INSUFFICIENT_CONTEXT',
            ],
          }),
        },
      },
    ],
  });
}

describe('independent commercial model pool classifier', () => {
  it('reports actual model attempts without publishing a seeded latency as a measurement', () => {
    const stats = new CommercialLlmPoolRoutingStats();
    expect(
      stats
        .snapshot()
        .every((node) => node.completedAttempts === 0 && node.ewmaDurationMs === null),
    ).toBe(true);
    stats.recordSuccess('pc-a-4b', 1000);
    stats.recordSuccess('pc-a-4b', 5000);
    stats.recordFailure('server-9b');
    const snapshot = stats.snapshot();
    expect(snapshot[1]).toMatchObject({
      completedAttempts: 2,
      failedAttempts: 0,
      ewmaDurationMs: 2000,
    });
    expect(snapshot[0]).toMatchObject({
      completedAttempts: 0,
      failedAttempts: 1,
      ewmaDurationMs: null,
    });
    expect(snapshot[1]!.lastCompletedAt).not.toBeNull();
    snapshot[1]!.completedAttempts = 99;
    expect(stats.snapshot()[1]!.completedAttempts).toBe(2);
  });
  const mailbox = {
    available: jest.fn<ReturnType<CommercialLlmPoolMailbox['available']>, []>(),
    reserve: jest.fn<
      ReturnType<CommercialLlmPoolMailbox['reserve']>,
      Parameters<CommercialLlmPoolMailbox['reserve']>
    >(),
    wait: jest.fn<
      ReturnType<CommercialLlmPoolMailbox['wait']>,
      Parameters<CommercialLlmPoolMailbox['wait']>
    >(),
    release: jest.fn<
      ReturnType<CommercialLlmPoolMailbox['release']>,
      Parameters<CommercialLlmPoolMailbox['release']>
    >(),
  };
  const dispatch = jest.fn<Promise<void>, [CommercialLlmPoolReservation, AbortSignal]>();
  const primaryFinished = jest.fn<Promise<void>, []>();
  const canStartConsultation = jest.fn<Promise<boolean>, []>();
  const consultationFinished = jest.fn<Promise<void>, []>();
  let decisions: Record<CommercialLlmPoolNodeId, CommercialLlmClassification>;
  let options: CommercialLlmPoolClientOptions;
  const client = (changes: Partial<CommercialLlmPoolClientOptions> = {}) =>
    new CommercialLlmPoolClient(mailbox, dispatch, { ...options, ...changes });

  beforeEach(() => {
    options = {
      jobId: '00000000-0000-0000-0000-000000000001',
      deadlineAtMs: Date.now() + 20_000,
      policy: 'confirm-positive',
      primaryFinished,
      canStartConsultation,
      consultationFinished,
    };
    decisions = {
      'server-9b': 'NOT_COMMERCIAL',
      'pc-a-4b': 'NOT_COMMERCIAL',
      'pc-b-9b': 'NOT_COMMERCIAL',
      'pc-a-cpu-9b': 'NOT_COMMERCIAL',
    };
    mailbox.available.mockReset().mockResolvedValue([...LEGACY_POOL_NODE_IDS]);
    mailbox.reserve.mockReset().mockImplementation(async (nodeId, request) => {
      const id = randomUUID();
      return {
        ...request,
        nodeId,
        id,
        attemptId: id,
        session: randomUUID(),
        raw: JSON.stringify(request),
      };
    });
    mailbox.wait.mockReset().mockImplementation(async (reservation) => ({
      outcome: 'COMPLETE',
      body: envelope(reservation.nodeId, decisions[reservation.nodeId]),
    }));
    mailbox.release.mockReset().mockResolvedValue(undefined);
    dispatch.mockReset().mockResolvedValue(undefined);
    primaryFinished.mockReset().mockResolvedValue(undefined);
    canStartConsultation.mockReset().mockResolvedValue(true);
    consultationFinished.mockReset().mockResolvedValue(undefined);
  });

  it('confirms a 4B personal sale with 9B only when its explicit category policy requires it', async () => {
    mailbox.available.mockResolvedValueOnce(['pc-a-4b']).mockResolvedValue(['pc-b-9b']);
    const result = await client({ confirmPersonalSales: true }).classify('Личная продажа');
    expect(result).toMatchObject({
      classification: 'NOT_COMMERCIAL',
      reasonCodes: ['PERSONAL_SALE'],
      pool: {
        nodeId: 'pc-b-9b',
        route: 'consulted',
        primaryClassification: 'NOT_COMMERCIAL',
        consultationOutcome: 'completed',
      },
    });
    expect(canStartConsultation).toHaveBeenCalledTimes(1);
    expect(consultationFinished).toHaveBeenCalledTimes(1);
  });

  it.each(POOL_NODE_IDS)(
    'routes directly to available %s and preserves its actual runtime identity',
    async (nodeId) => {
      mailbox.available.mockResolvedValue([nodeId]);
      const result = await client().classify('синтетический текст');
      expect(result).toMatchObject({
        ...COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity,
        classification: 'NOT_COMMERCIAL',
        pool: { nodeId, route: 'direct', attempts: 1 },
      });
      if (nodeId !== 'server-9b') expect(result.runtimeImageSha256).toBeUndefined();
      expect(dispatch).toHaveBeenCalledTimes(nodeId === 'server-9b' ? 1 : 0);
      expect(primaryFinished).toHaveBeenCalledTimes(1);
      expect(canStartConsultation).not.toHaveBeenCalled();
    },
  );

  it('distributes four simultaneous sources across all ready nodes', async () => {
    mailbox.available.mockResolvedValue([...POOL_NODE_IDS]);
    const occupied = new Set<CommercialLlmPoolNodeId>();
    const complete: Array<() => void> = [];
    mailbox.reserve.mockImplementation(async (nodeId, request) => {
      if (occupied.has(nodeId)) return null;
      occupied.add(nodeId);
      const id = randomUUID();
      return {
        ...request,
        nodeId,
        id,
        attemptId: id,
        session: randomUUID(),
        raw: JSON.stringify(request),
      };
    });
    mailbox.wait.mockImplementation(
      (reservation) =>
        new Promise((resolve) => {
          complete.push(() =>
            resolve({ outcome: 'COMPLETE', body: envelope(reservation.nodeId, 'NOT_COMMERCIAL') }),
          );
        }),
    );
    const results = [0, 1, 2, 3].map((i) =>
      client({ jobId: `00000000-0000-0000-0000-00000000000${i}` }).classify('synthetic'),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(occupied).toEqual(new Set(POOL_NODE_IDS));
    expect(complete).toHaveLength(4);
    complete.forEach((finish) => finish());
    expect(new Set((await Promise.all(results)).map((result) => result.pool!.nodeId))).toEqual(
      new Set(POOL_NODE_IDS),
    );
  });

  it('preserves the finite invalid-response reason across both failed primary attempts', async () => {
    mailbox.wait.mockResolvedValue({ outcome: 'FAILED', responseIssue: 'decision' });
    await expect(client().classify('Привет')).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
      responseIssue: 'decision',
    });
  });

  it.each(['UNAVAILABLE', 'FAILED'] as const)(
    'retries %s once on a different node with the original input and deadline',
    async (outcome) => {
      mailbox.wait.mockResolvedValueOnce({ outcome });
      const result = await client().classify('synthetic');
      expect(result.pool).toMatchObject({ nodeId: 'server-9b', attempts: 2 });
      const [first, second] = mailbox.reserve.mock.calls;
      expect(first[0]).toBe('pc-b-9b');
      expect(second[0]).toBe('server-9b');
      expect(second[1]).toMatchObject({
        jobId: options.jobId,
        attempt: 2,
        deadlineAtMs: options.deadlineAtMs,
      });
      expect({ ...JSON.parse(first[1].body), model: 'same' }).toEqual({
        ...JSON.parse(second[1].body),
        model: 'same',
      });
      expect(primaryFinished).toHaveBeenCalledTimes(1);
    },
  );

  it('never retries a source more than once or presents failure as a negative', async () => {
    mailbox.wait.mockResolvedValue({ outcome: 'FAILED' });
    await expect(client().classify('synthetic')).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
    expect(mailbox.reserve).toHaveBeenCalledTimes(2);
    expect(mailbox.reserve.mock.calls.map(([node]) => node)).toEqual(['pc-b-9b', 'server-9b']);
  });

  it('lost capacity races do not consume an attempt or create a queue', async () => {
    mailbox.reserve.mockResolvedValueOnce(null);
    const result = await client().classify('synthetic');
    expect(result.pool).toMatchObject({ nodeId: 'server-9b', attempts: 1 });
    expect(mailbox.reserve.mock.calls.map(([, request]) => request.attempt)).toEqual([1, 1]);
  });

  it('prefers the fastest measured idle node over the stable tie order', async () => {
    const routingStats = new CommercialLlmPoolRoutingStats();
    routingStats.recordSuccess('pc-a-4b', 3000);
    routingStats.recordSuccess('pc-b-9b', 500);
    routingStats.recordSuccess('server-9b', 1500);
    const result = await client({ routingStats }).classify('synthetic');
    expect(result.pool?.nodeId).toBe('pc-b-9b');
  });

  it.each([false, true])(
    'prefers ready 9B capacity even when 4B is faster (metrics=%s)',
    async (measured) => {
      const routingStats = measured ? new CommercialLlmPoolRoutingStats() : undefined;
      routingStats?.recordSuccess('pc-a-4b', 100);
      routingStats?.recordSuccess('server-9b', 3000);
      routingStats?.recordSuccess('pc-b-9b', 1000);
      const result = await client({ routingStats, policy: 'direct-4b' }).classify('synthetic');
      expect(result.pool?.nodeId).toBe('pc-b-9b');
      expect(mailbox.reserve.mock.calls.map(([node]) => node)).toEqual(['pc-b-9b']);
    },
  );

  it('uses 4B immediately after all three 9B reservations lose capacity without spending an attempt', async () => {
    mailbox.available.mockResolvedValue([...POOL_NODE_IDS]);
    mailbox.reserve
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    decisions['pc-a-4b'] = 'COMMERCIAL';
    const result = await client({ policy: 'direct-4b' }).classify('synthetic');
    expect(result.pool).toMatchObject({ nodeId: 'pc-a-4b', route: 'direct', attempts: 1 });
    expect(mailbox.reserve.mock.calls.map(([node]) => node)).toEqual([
      'pc-b-9b',
      'pc-a-cpu-9b',
      'server-9b',
      'pc-a-4b',
    ]);
    expect(
      mailbox.reserve.mock.calls.every(
        ([, request]) => request.deadlineAtMs === options.deadlineAtMs,
      ),
    ).toBe(true);
    expect(canStartConsultation).not.toHaveBeenCalled();
  });

  it.each([
    ['server-9b', 5000],
    ['pc-a-cpu-9b', 12_000],
  ] as const)(
    'uses 4B when ready %s cannot fit the original CPU budget of %i ms',
    async (nodeId, remainingMs) => {
      mailbox.available.mockResolvedValue([nodeId, 'pc-a-4b']);
      const result = await client({
        policy: 'direct-4b',
        deadlineAtMs: Date.now() + remainingMs,
      }).classify('synthetic');
      expect(result.pool?.nodeId).toBe('pc-a-4b');
      expect(mailbox.reserve.mock.calls.map(([node]) => node)).toEqual(['pc-a-4b']);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each(['NOT_COMMERCIAL', 'COMMERCIAL', 'UNSURE'] as const)(
    'returns fallback 4B %s without consultation under direct policy',
    async (classification) => {
      mailbox.available.mockResolvedValue(['pc-a-4b']);
      decisions['pc-a-4b'] = classification;
      const result = await client({ policy: 'direct-4b', confirmPersonalSales: true }).classify(
        'synthetic',
      );
      expect(result).toMatchObject({
        classification,
        pool: { nodeId: 'pc-a-4b', route: 'direct', policy: 'direct-4b' },
      });
      expect(result.pool?.consultationOutcome).toBeUndefined();
      expect(mailbox.reserve).toHaveBeenCalledTimes(1);
      expect(canStartConsultation).not.toHaveBeenCalled();
      expect(consultationFinished).not.toHaveBeenCalled();
    },
  );

  it('temporarily penalizes a failed fast node and allows its preference to recover', async () => {
    const routingStats = new CommercialLlmPoolRoutingStats();
    routingStats.recordSuccess('pc-a-4b', 100);
    routingStats.recordSuccess('pc-b-9b', 500);
    routingStats.recordSuccess('server-9b', 1500);
    const now = Date.now();
    routingStats.recordFailure('pc-a-4b', now);
    expect(routingStats.rank(POOL_NODE_IDS, now)[0]).toBe('pc-b-9b');
    expect(routingStats.rank(POOL_NODE_IDS, now + 180_000)[0]).toBe('pc-a-4b');
    const result = await client({ routingStats }).classify('synthetic');
    expect(result.pool?.nodeId).toBe('pc-b-9b');
  });

  it('smooths latency samples, keeps cold-node ties stable and ignores invalid measurements', () => {
    const routingStats = new CommercialLlmPoolRoutingStats();
    expect(routingStats.rank(['pc-b-9b', 'server-9b', 'pc-a-4b'])).toEqual([
      'pc-b-9b',
      'server-9b',
      'pc-a-4b',
    ]);
    routingStats.recordSuccess('pc-b-9b', 1000);
    routingStats.recordSuccess('pc-b-9b', 5000);
    routingStats.recordSuccess('server-9b', 2100);
    routingStats.recordSuccess('pc-a-4b', Number.NaN);
    expect(routingStats.rank(POOL_NODE_IDS)[0]).toBe('pc-b-9b');
    routingStats.recordSuccess('pc-b-9b', 5000);
    expect(routingStats.rank(POOL_NODE_IDS)[0]).toBe('server-9b');
  });

  it('records completed attempts and transport failures in shared routing measurements', async () => {
    const routingStats = new CommercialLlmPoolRoutingStats();
    const success = jest.spyOn(routingStats, 'recordSuccess');
    const failed = jest.spyOn(routingStats, 'recordFailure');
    mailbox.wait.mockResolvedValueOnce({ outcome: 'UNAVAILABLE' });
    await client({ routingStats }).classify('synthetic');
    expect(failed).toHaveBeenCalledWith('pc-b-9b');
    expect(success).toHaveBeenCalledWith('server-9b', expect.any(Number));
  });

  it('reports unavailable initial capacity without fabricating a model answer', async () => {
    mailbox.available.mockResolvedValue([]);
    await expect(client().classify('synthetic')).rejects.toMatchObject({ kind: 'BUSY' });
    expect(mailbox.reserve).not.toHaveBeenCalled();
    expect(primaryFinished).toHaveBeenCalledTimes(1);
  });

  it.each(['UNSURE', 'COMMERCIAL'] as const)(
    'consults an idle 9B for 4B %s under confirmation policy',
    async (classification) => {
      mailbox.available.mockResolvedValueOnce(['pc-a-4b']).mockResolvedValue(['pc-b-9b']);
      decisions['pc-a-4b'] = classification;
      decisions['pc-b-9b'] = 'COMMERCIAL';
      const result = await client().classify('synthetic');
      expect(result).toMatchObject({
        classification: 'COMMERCIAL',
        pool: {
          nodeId: 'pc-b-9b',
          route: 'consulted',
          primaryNodeId: 'pc-a-4b',
          primaryClassification: classification,
          consultationOutcome: 'completed',
          attempts: 1,
        },
      });
      const second = mailbox.reserve.mock.calls[1];
      expect(second[1].jobId).not.toBe(options.jobId);
      expect(second[1]).toMatchObject({ deadlineAtMs: options.deadlineAtMs, attempt: 1 });
      expect(second[2]).toEqual({ consultation: true });
      expect(primaryFinished.mock.invocationCallOrder[0]).toBeLessThan(
        canStartConsultation.mock.invocationCallOrder[0],
      );
      expect(consultationFinished).toHaveBeenCalledTimes(1);
    },
  );

  it('direct-4B policy retains a positive without asking 9B', async () => {
    mailbox.available.mockResolvedValue(['pc-a-4b']);
    decisions['pc-a-4b'] = 'COMMERCIAL';
    const result = await client({ policy: 'direct-4b' }).classify('synthetic');
    expect(result).toMatchObject({
      classification: 'COMMERCIAL',
      pool: { nodeId: 'pc-a-4b', route: 'direct', policy: 'direct-4b' },
    });
    expect(canStartConsultation).not.toHaveBeenCalled();
    expect(mailbox.reserve).toHaveBeenCalledTimes(1);
  });

  it.each(['admission', 'atomic_capacity'] as const)(
    'leaves an unconfirmed 4B positive unresolved when %s prevents consultation',
    async (block) => {
      decisions['pc-a-4b'] = 'COMMERCIAL';
      if (block === 'admission') {
        mailbox.available.mockResolvedValue(['pc-a-4b']);
        canStartConsultation.mockResolvedValue(false);
      } else mailbox.available.mockResolvedValueOnce(['pc-a-4b']).mockResolvedValue(['pc-a-4b']);
      const result = await client().classify('synthetic');
      expect(result).toMatchObject({
        classification: 'UNSURE',
        reasonCodes: ['INSUFFICIENT_CONTEXT'],
        pool: {
          nodeId: 'pc-a-4b',
          primaryClassification: 'COMMERCIAL',
          consultationOutcome: 'no_capacity',
        },
      });
      expect(mailbox.reserve).toHaveBeenCalledTimes(1);
      expect(consultationFinished).toHaveBeenCalledTimes(block === 'admission' ? 0 : 1);
    },
  );

  it('skips consultation when less than one second of the original budget remains', async () => {
    mailbox.available.mockResolvedValue(['pc-a-4b']);
    decisions['pc-a-4b'] = 'UNSURE';
    const result = await client({ deadlineAtMs: Date.now() + 800 }).classify('synthetic');
    expect(result.pool?.consultationOutcome).toBe('budget_exhausted');
    expect(canStartConsultation).not.toHaveBeenCalled();
  });

  it('keeps GPU capacity usable when the remaining budget is too short for CPU', async () => {
    mailbox.available.mockResolvedValue(['server-9b', 'pc-b-9b']);
    const result = await client({
      jobId: '00000000-0000-0000-0000-000000000003',
      deadlineAtMs: Date.now() + 5000,
    }).classify('synthetic');
    expect(result.pool?.nodeId).toBe('pc-b-9b');
    expect(mailbox.reserve.mock.calls.map(([node]) => node)).toEqual(['pc-b-9b']);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not reserve CPU capacity with only milliseconds left', async () => {
    mailbox.available.mockResolvedValue(['server-9b']);
    await expect(
      client({ deadlineAtMs: Date.now() + 100 }).classify('synthetic'),
    ).rejects.toMatchObject({ kind: 'BUSY' });
    expect(mailbox.reserve).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('never retries a failed consultation or silently trusts its unconfirmed positive', async () => {
    mailbox.available.mockResolvedValueOnce(['pc-a-4b']).mockResolvedValue(['pc-b-9b']);
    decisions['pc-a-4b'] = 'COMMERCIAL';
    mailbox.wait
      .mockImplementationOnce(async (reservation) => ({
        outcome: 'COMPLETE',
        body: envelope(reservation.nodeId, 'COMMERCIAL'),
      }))
      .mockResolvedValue({ outcome: 'FAILED' });
    await expect(client().classify('synthetic')).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
    expect(mailbox.reserve).toHaveBeenCalledTimes(2);
    expect(consultationFinished).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch or consult after ownership is lost', async () => {
    await expect(
      client().classify('synthetic', undefined, async () => false),
    ).rejects.toMatchObject({ kind: 'ABORTED' });
    expect(mailbox.reserve).not.toHaveBeenCalled();
    expect(primaryFinished).toHaveBeenCalledTimes(1);
  });

  it('releases the reservation after caller cancellation without retrying its physical computation', async () => {
    const controller = new AbortController();
    mailbox.wait.mockImplementation(async () => {
      controller.abort();
      throw new CommercialLlmError('ABORTED');
    });
    await expect(client().classify('synthetic', controller.signal)).rejects.toMatchObject({
      kind: 'ABORTED',
    });
    expect(mailbox.reserve).toHaveBeenCalledTimes(1);
    expect(mailbox.release).toHaveBeenCalledTimes(1);
  });

  it('bounds even a stalled injected HTTP dispatcher by the original deadline', async () => {
    jest.useFakeTimers();
    try {
      mailbox.available.mockResolvedValue(['server-9b']);
      dispatch.mockImplementation(() => new Promise(() => undefined));
      const outcome = expect(
        client({ deadlineAtMs: Date.now() + 20_000 }).classify('synthetic'),
      ).rejects.toMatchObject({ kind: 'TIMEOUT' });
      await jest.advanceTimersByTimeAsync(20_001);
      await outcome;
      expect(mailbox.reserve).toHaveBeenCalledTimes(1);
      expect(mailbox.release).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('records an upstream deadline timeout as a failed attempt rather than caller cancellation', async () => {
    const controller = new AbortController();
    const routingStats = new CommercialLlmPoolRoutingStats();
    const failed = jest.spyOn(routingStats, 'recordFailure');
    mailbox.wait.mockImplementation(async () => {
      controller.abort(new DOMException('deadline', 'TimeoutError'));
      throw new CommercialLlmError('ABORTED');
    });
    await expect(
      client({ routingStats }).classify('synthetic', controller.signal),
    ).rejects.toMatchObject({ kind: 'TIMEOUT' });
    expect(failed).toHaveBeenCalledWith('pc-b-9b');
    expect(mailbox.reserve).toHaveBeenCalledTimes(1);
  });
});
