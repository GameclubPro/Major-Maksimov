import { CommercialLlmSecondaryScheduler } from './commercial-llm-secondary-scheduler';
import type { CommercialLlmSecondaryState } from './commercial-llm-secondary-scheduler';
import type { CommercialLlmShadowLease } from './commercial-llm-shadow.lease';
import type { CommercialLlmHttpClassifier } from './commercial-llm.client';
import type {
  CommercialLlmClassifier,
  CommercialLlmObservationResult,
} from './commercial-llm.protocol';

jest.mock('node:timers/promises', () => ({
  setTimeout: <T>(ms: number, value: T, options?: { signal?: AbortSignal }): Promise<T> =>
    new Promise((resolve, reject) => {
      const signal = options?.signal;
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve(value);
      }, ms);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    }),
}));

const result: CommercialLlmObservationResult = {
  classification: 'NOT_COMMERCIAL',
  reasonCodes: ['ORDINARY_DISCUSSION'],
  modelAlias: 'synthetic',
  modelSha256: 'synthetic',
  promptSha256: 'synthetic',
  runtimeVersion: 'synthetic',
  chatTemplateSha256: 'synthetic',
  policyVersion: 'synthetic',
  durationMs: 1,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('commercial confirmation scheduler', () => {
  let owner: string | null;
  let sequence: number;
  const lease = {
    acquire: jest.fn<
      ReturnType<CommercialLlmShadowLease['acquire']>,
      Parameters<CommercialLlmShadowLease['acquire']>
    >(),
    owns: jest.fn<
      ReturnType<CommercialLlmShadowLease['owns']>,
      Parameters<CommercialLlmShadowLease['owns']>
    >(),
    release: jest.fn<
      ReturnType<CommercialLlmShadowLease['release']>,
      Parameters<CommercialLlmShadowLease['release']>
    >(),
    retainUntilReleased: jest.fn<
      ReturnType<CommercialLlmShadowLease['retainUntilReleased']>,
      Parameters<CommercialLlmShadowLease['retainUntilReleased']>
    >(),
  } satisfies Pick<
    CommercialLlmShadowLease,
    'acquire' | 'owns' | 'release' | 'retainUntilReleased'
  >;
  const client = {
    classify: jest.fn<
      ReturnType<CommercialLlmClassifier['classify']>,
      Parameters<CommercialLlmClassifier['classify']>
    >(),
  } satisfies CommercialLlmClassifier;
  const httpClient: CommercialLlmHttpClassifier = {
    classifyWithLifecycle: async (excerpt, signal, lifecycle) => {
      await lifecycle.beforeDispatch();
      lifecycle.dispatched();
      const value = await client.classify(excerpt, signal);
      lifecycle.completed();
      return value;
    },
  };
  const observe = jest.fn<void, [CommercialLlmSecondaryState, number]>();

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-27T09:00:00.000Z') });
    owner = null;
    sequence = 0;
    lease.acquire.mockReset().mockImplementation(async () => {
      if (owner) return null;
      owner = `lease-${++sequence}`;
      return owner;
    });
    lease.owns.mockReset().mockImplementation(async (token) => owner === token);
    lease.retainUntilReleased.mockReset().mockImplementation(async (token) => owner === token);
    lease.release.mockReset().mockImplementation(async (token) => {
      if (owner === token) owner = null;
    });
    client.classify.mockReset().mockResolvedValue(result);
    observe.mockReset();
  });

  afterEach(() => jest.useRealTimers());

  it('admits one waiter and preserves its turn before a later arrival', async () => {
    const firstResult = deferred<CommercialLlmObservationResult>();
    client.classify.mockImplementationOnce(() => firstResult.promise);
    const scheduler = new CommercialLlmSecondaryScheduler(lease, httpClient, observe);
    const deadline = Date.now() + 20_000;
    const first = scheduler.classifyWithin('first', deadline);
    await jest.advanceTimersByTimeAsync(0);
    const waiting = scheduler.classifyWithin('waiting', deadline);
    await jest.advanceTimersByTimeAsync(0);
    expect(observe).toHaveBeenCalledWith('waiting', 0);

    firstResult.resolve(result);
    await expect(first).resolves.toEqual(result);
    const acquireCount = lease.acquire.mock.calls.length;
    await expect(scheduler.classifyWithin('late arrival', deadline)).rejects.toMatchObject({
      kind: 'BUSY',
    });
    expect(lease.acquire).toHaveBeenCalledTimes(acquireCount);
    expect(client.classify.mock.calls.map(([excerpt]) => excerpt)).toEqual(['first']);

    await jest.advanceTimersByTimeAsync(100);
    await expect(waiting).resolves.toEqual(result);
    expect(client.classify.mock.calls.map(([excerpt]) => excerpt)).toEqual(['first', 'waiting']);
    expect(lease.release.mock.calls).toEqual([['lease-1'], ['lease-2']]);
    expect(observe).toHaveBeenCalledWith('buffer_full', 0);
  });

  it('does not start after a queue wait consumes the six-second inference reserve', async () => {
    lease.acquire.mockResolvedValueOnce(null);
    const scheduler = new CommercialLlmSecondaryScheduler(lease, httpClient, observe);
    const work = scheduler.classifyWithin('waiting', Date.now() + 6_050);
    const rejected = expect(work).rejects.toMatchObject({ kind: 'ABORTED' });
    await jest.advanceTimersByTimeAsync(100);
    await rejected;
    expect(client.classify).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalledWith('started', expect.anything());
    expect(owner).toBeNull();
  });

  it('releases a token when acquiring it consumes the inference reserve', async () => {
    lease.acquire.mockImplementationOnce(async () => {
      jest.setSystemTime(Date.now() + 100);
      owner = 'slow-acquire';
      return owner;
    });
    const scheduler = new CommercialLlmSecondaryScheduler(lease, httpClient, observe);
    await expect(
      scheduler.classifyWithin('slow admission', Date.now() + 6_050),
    ).rejects.toMatchObject({ kind: 'ABORTED' });
    expect(client.classify).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledWith('slow-acquire');
    expect(owner).toBeNull();
  });

  it('releases a token when checking its owner consumes the inference reserve', async () => {
    lease.owns.mockImplementationOnce(async () => {
      jest.setSystemTime(Date.now() + 100);
      return true;
    });
    const scheduler = new CommercialLlmSecondaryScheduler(lease, httpClient, observe);
    await expect(
      scheduler.classifyWithin('slow owner check', Date.now() + 6_050),
    ).rejects.toMatchObject({ kind: 'ABORTED' });
    expect(client.classify).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledWith('lease-1');
    expect(owner).toBeNull();
  });

  it('prevents a negative audit from taking the lease before an existing confirmation waiter', async () => {
    lease.acquire.mockResolvedValueOnce(null);
    const scheduler = new CommercialLlmSecondaryScheduler(lease, httpClient, observe);
    const waiting = scheduler.classifyWithin('actionable confirmation', Date.now() + 20_000);
    await jest.advanceTimersByTimeAsync(0);
    expect(observe).toHaveBeenCalledWith('waiting', 0);
    const acquireCount = lease.acquire.mock.calls.length;
    await expect(scheduler.classifyAudit('negative audit')).rejects.toMatchObject({ kind: 'BUSY' });
    expect(lease.acquire).toHaveBeenCalledTimes(acquireCount);
    expect(client.classify).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(100);
    await expect(waiting).resolves.toEqual(result);
    expect(client.classify.mock.calls.map(([excerpt]) => excerpt)).toEqual([
      'actionable confirmation',
    ]);
  });

  it.each(['abort', 'source'] as const)(
    'clears its waiting slot when %s authority changes',
    async (guard) => {
      lease.acquire.mockResolvedValueOnce(null);
      const scheduler = new CommercialLlmSecondaryScheduler(lease, httpClient, observe);
      const controller = new AbortController();
      let current = true;
      const deadline = Date.now() + 20_000;
      const work = scheduler.classifyWithin(
        'cancelled waiter',
        deadline,
        controller.signal,
        async () => current,
      );
      const rejected = expect(work).rejects.toBeInstanceOf(Error);
      await jest.advanceTimersByTimeAsync(0);
      if (guard === 'abort') controller.abort();
      else current = false;
      await jest.advanceTimersByTimeAsync(100);
      await rejected;
      expect(client.classify).not.toHaveBeenCalled();
      expect(lease.release).not.toHaveBeenCalled();

      await expect(scheduler.classifyWithin('replacement', deadline)).resolves.toEqual(result);
      expect(client.classify).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['abort', 'source', 'lease', 'deadline'] as const)(
    'discards an in-flight result after %s changes and releases the original token',
    async (guard) => {
      const completion = deferred<CommercialLlmObservationResult>();
      client.classify.mockReturnValueOnce(completion.promise);
      const scheduler = new CommercialLlmSecondaryScheduler(lease, httpClient, observe);
      const controller = new AbortController();
      let current = true;
      const deadline = Date.now() + 20_000;
      const work = scheduler.classifyWithin(
        'in flight',
        deadline,
        controller.signal,
        async () => current,
      );
      const rejected = expect(work).rejects.toMatchObject({ kind: 'ABORTED' });
      await jest.advanceTimersByTimeAsync(0);
      expect(client.classify).toHaveBeenCalledTimes(1);
      if (guard === 'abort') controller.abort();
      if (guard === 'source') current = false;
      if (guard === 'lease') owner = 'another-owner';
      if (guard === 'deadline') jest.setSystemTime(deadline);
      completion.resolve(result);
      await rejected;
      expect(lease.release).toHaveBeenCalledWith('lease-1');
      expect(owner).toBe(guard === 'lease' ? 'another-owner' : null);
    },
  );

  it('does not call the model after losing the acquired model lease', async () => {
    lease.owns.mockResolvedValue(false);
    const scheduler = new CommercialLlmSecondaryScheduler(lease, httpClient);
    await expect(
      scheduler.classifyWithin('stale owner', Date.now() + 20_000),
    ).rejects.toMatchObject({ kind: 'ABORTED' });
    expect(client.classify).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledWith('lease-1');
  });
});
