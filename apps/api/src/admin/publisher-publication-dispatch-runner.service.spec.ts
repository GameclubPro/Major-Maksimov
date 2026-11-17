import { PublisherPublicationDispatchRunnerService } from './publisher-publication-dispatch-runner.service';
import type { Prisma } from '../prisma/prisma-client';
import type { PublisherPublicationSelectionStore } from './publisher-publication-temporal-selection';

describe('PublisherPublicationDispatchRunnerService', () => {
  const originalRole = process.env.APP_ROLE;
  const createBackgroundWork = () => ({
    runExclusive: jest.fn((_lane: string, operation: () => Promise<unknown>) => operation()),
  });
  const createPrisma = (
    findFirst = jest.fn().mockResolvedValue(null),
    findImmediate = jest.fn().mockResolvedValue(null),
  ) => {
    const queryRaw = jest.fn(async (query: Prisma.Sql) => {
      const row = await (query.values.includes('NOW') ? findImmediate(query) : findFirst(query));
      return row ? [row] : [];
    });
    const store: PublisherPublicationSelectionStore = {
      $transaction: async (read) =>
        read({
          $queryRaw: jest
            .fn()
            .mockImplementation((query: Prisma.Sql) =>
              query.sql.includes('set_config(')
                ? Promise.resolve([{ seq: 'off', bitmap: 'off', sort: 'off', jit: 'off' }])
                : queryRaw(query),
            ),
        }),
    };
    return {
      ...store,
      $queryRaw: queryRaw,
      publicationSchedule: { findUnique: jest.fn().mockResolvedValue({ mode: 'ONCE' }) },
    };
  };

  afterEach(() => {
    process.env.APP_ROLE = originalRole;
  });

  it('drains only publication execution lanes in the publisher role', async () => {
    process.env.APP_ROLE = 'publisher';
    const verificationBudget = { remaining: 3 };
    const immediate = jest.fn().mockResolvedValue(verificationBudget);
    const deadline = jest.fn().mockResolvedValue(verificationBudget);
    const service = {
      processDueImmediatePublicationBroadcasts: immediate,
      processDueDeadlinePublicationBroadcasts: deadline,
      processDueManagedBroadcasts: jest.fn(),
    };
    const identityAttestation = { assertAttested: jest.fn().mockResolvedValue(undefined) };
    const dispatchHealth = { isGloballyPaused: jest.fn().mockResolvedValue(false) };
    const runner = new PublisherPublicationDispatchRunnerService(
      service as never,
      identityAttestation as never,
      { dispatchEnabled: true } as never,
      dispatchHealth as never,
      createBackgroundWork() as never,
      createPrisma() as never,
    );

    await (runner as any).run('scheduled');

    expect(immediate).toHaveBeenCalledTimes(1);
    expect(deadline).toHaveBeenCalledWith(undefined, verificationBudget);
    expect(immediate.mock.invocationCallOrder[0]).toBeLessThan(
      deadline.mock.invocationCallOrder[0]!,
    );
    expect(service.processDueManagedBroadcasts).not.toHaveBeenCalled();
  });

  it('does not run publication dispatch from an action process', async () => {
    process.env.APP_ROLE = 'action';
    const immediate = jest.fn();
    const runner = new PublisherPublicationDispatchRunnerService(
      { processDueImmediatePublicationBroadcasts: immediate } as never,
      { assertAttested: jest.fn() } as never,
      { dispatchEnabled: true } as never,
      { isGloballyPaused: jest.fn().mockResolvedValue(false) } as never,
      createBackgroundWork() as never,
      createPrisma() as never,
    );

    await (runner as any).run('scheduled');

    expect(immediate).not.toHaveBeenCalled();
  });

  it('does not claim publication envelopes before identity attestation', async () => {
    process.env.APP_ROLE = 'publisher';
    const immediate = jest.fn();
    const identityAttestation = {
      assertAttested: jest.fn().mockRejectedValue(new Error('not attested')),
    };
    const runner = new PublisherPublicationDispatchRunnerService(
      { processDueImmediatePublicationBroadcasts: immediate } as never,
      identityAttestation as never,
      { dispatchEnabled: true } as never,
      { isGloballyPaused: jest.fn().mockResolvedValue(false) } as never,
      createBackgroundWork() as never,
      createPrisma() as never,
    );

    await (runner as any).run('scheduled');

    expect(immediate).not.toHaveBeenCalled();
  });

  it('keeps the timer idle before identity or publication scans while globally paused', async () => {
    jest.useFakeTimers();
    process.env.APP_ROLE = 'publisher';
    try {
      const verificationBudget = { remaining: 50 };
      const immediate = jest.fn().mockResolvedValue(verificationBudget);
      const deadline = jest.fn().mockResolvedValue(verificationBudget);
      const identityAttestation = { assertAttested: jest.fn() };
      let globallyPaused = true;
      const dispatchHealth = {
        isGloballyPaused: jest.fn(async () => globallyPaused),
      };
      const runner = new PublisherPublicationDispatchRunnerService(
        {
          processDueImmediatePublicationBroadcasts: immediate,
          processDueDeadlinePublicationBroadcasts: deadline,
        } as never,
        identityAttestation as never,
        { dispatchEnabled: true } as never,
        dispatchHealth as never,
        createBackgroundWork() as never,
        createPrisma() as never,
      );

      runner.onModuleInit();
      await jest.advanceTimersByTimeAsync(15_000);

      expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
      expect(immediate).not.toHaveBeenCalled();
      expect(deadline).not.toHaveBeenCalled();

      globallyPaused = false;
      await jest.advanceTimersByTimeAsync(15_000);

      expect(dispatchHealth.isGloballyPaused).toHaveBeenCalledTimes(4);
      expect(identityAttestation.assertAttested).toHaveBeenCalledTimes(2);
      expect(immediate).toHaveBeenCalledTimes(1);
      expect(deadline).toHaveBeenCalledTimes(1);
      runner.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails a sweep closed when the pause lookup fails', async () => {
    process.env.APP_ROLE = 'publisher';
    const immediate = jest.fn();
    const identityAttestation = { assertAttested: jest.fn() };
    const runner = new PublisherPublicationDispatchRunnerService(
      { processDueImmediatePublicationBroadcasts: immediate } as never,
      identityAttestation as never,
      { dispatchEnabled: true } as never,
      { isGloballyPaused: jest.fn().mockRejectedValue(new Error('redis unavailable')) } as never,
      createBackgroundWork() as never,
      createPrisma() as never,
    );

    await expect((runner as any).run('scheduled')).resolves.toBeUndefined();

    expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
    expect(immediate).not.toHaveBeenCalled();
  });

  it('keeps urgent publication ticks moving while a deadline sweep owns the coordinator', async () => {
    process.env.APP_ROLE = 'publisher';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const immediate = jest.fn().mockResolvedValue({ remaining: 1 });
    const deadline = jest.fn().mockResolvedValue({ remaining: 1 });
    const backgroundWork = {
      runExclusive: jest.fn(async (_lane: string, operation: () => Promise<void>) => {
        await gate;
        await operation();
      }),
    };
    const runner = new PublisherPublicationDispatchRunnerService(
      {
        processDueImmediatePublicationBroadcasts: immediate,
        processDueDeadlinePublicationBroadcasts: deadline,
      } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { dispatchEnabled: true } as never,
      { isGloballyPaused: jest.fn().mockResolvedValue(false) } as never,
      backgroundWork as never,
      createPrisma() as never,
    );

    const first = (runner as any).run('scheduled') as Promise<void>;
    while (backgroundWork.runExclusive.mock.calls.length === 0) await Promise.resolve();
    const second = (runner as any).run('scheduled') as Promise<void>;
    while (immediate.mock.calls.length < 2) await Promise.resolve();

    expect(backgroundWork.runExclusive).toHaveBeenCalledTimes(1);
    expect(immediate).toHaveBeenCalledTimes(2);
    expect(deadline).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);

    expect(immediate).toHaveBeenCalledTimes(2);
    expect(deadline).toHaveBeenCalledTimes(1);
  });

  it('does not start or run publication scans while dispatch is disabled', async () => {
    jest.useFakeTimers();
    process.env.APP_ROLE = 'publisher';
    try {
      const immediate = jest.fn();
      const identityAttestation = { assertAttested: jest.fn() };
      const dispatchHealth = { isGloballyPaused: jest.fn() };
      const runner = new PublisherPublicationDispatchRunnerService(
        { processDueImmediatePublicationBroadcasts: immediate } as never,
        identityAttestation as never,
        { dispatchEnabled: false } as never,
        dispatchHealth as never,
        createBackgroundWork() as never,
        createPrisma() as never,
      );

      runner.onModuleInit();
      await jest.advanceTimersByTimeAsync(30_000);
      await (runner as any).run('scheduled');

      expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
      expect(dispatchHealth.isGloballyPaused).not.toHaveBeenCalled();
      expect(immediate).not.toHaveBeenCalled();
      runner.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('fires an exact deadline wakeup while a long NOW sweep is still running', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    process.env.APP_ROLE = 'publisher';
    let releaseImmediate!: () => void;
    const immediateGate = new Promise<void>((resolve) => {
      releaseImmediate = resolve;
    });
    let runner: PublisherPublicationDispatchRunnerService | undefined;
    try {
      const immediate = jest.fn(async () => {
        await immediateGate;
        return { remaining: 50 };
      });
      const deadline = jest.fn().mockResolvedValue({ remaining: 50 });
      const findFirst = jest
        .fn()
        .mockResolvedValueOnce({
          id: 'broadcast-deadline',
          nextSendAt: new Date('2026-09-04T10:00:02.000Z'),
        })
        .mockResolvedValue(null);
      runner = new PublisherPublicationDispatchRunnerService(
        {
          processDueImmediatePublicationBroadcasts: immediate,
          processDueDeadlinePublicationBroadcasts: deadline,
        } as never,
        { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
        { dispatchEnabled: true } as never,
        { isGloballyPaused: jest.fn().mockResolvedValue(false) } as never,
        createBackgroundWork() as never,
        createPrisma(findFirst) as never,
      );

      runner.onModuleInit();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1_999);
      expect(deadline).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      expect(immediate).toHaveBeenCalledTimes(1);
      expect(deadline).toHaveBeenCalledTimes(1);

      releaseImmediate();
      await Promise.resolve();
    } finally {
      releaseImmediate?.();
      runner?.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('does not block urgent NOW recovery on a slow deadline lookup', async () => {
    process.env.APP_ROLE = 'publisher';
    let resolveLookup!: (value: null) => void;
    const lookup = new Promise<null>((resolve) => {
      resolveLookup = resolve;
    });
    const immediate = jest.fn().mockResolvedValue({ remaining: 50 });
    const runner = new PublisherPublicationDispatchRunnerService(
      {
        processDueImmediatePublicationBroadcasts: immediate,
        processDueDeadlinePublicationBroadcasts: jest.fn().mockResolvedValue({ remaining: 50 }),
      } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { dispatchEnabled: true } as never,
      { isGloballyPaused: jest.fn().mockResolvedValue(false) } as never,
      createBackgroundWork() as never,
      createPrisma(jest.fn().mockReturnValue(lookup)) as never,
    );
    try {
      runner.onModuleInit();
      for (let attempt = 0; attempt < 10 && immediate.mock.calls.length === 0; attempt += 1) {
        await Promise.resolve();
      }

      expect(immediate).toHaveBeenCalledTimes(1);
    } finally {
      resolveLookup(null);
      await Promise.resolve();
      runner.onModuleDestroy();
    }
  });

  it('serializes every targeted NOW wake behind the shared immediate drain', async () => {
    process.env.APP_ROLE = 'publisher';
    let releaseFirstImmediate!: () => void;
    const firstImmediateGate = new Promise<void>((resolve) => {
      releaseFirstImmediate = resolve;
    });
    let releaseSecondImmediate!: () => void;
    const secondImmediateGate = new Promise<void>((resolve) => {
      releaseSecondImmediate = resolve;
    });
    const verificationBudget = { remaining: 50 };
    let releaseFirstDeadline!: () => void;
    const firstDeadlineGate = new Promise<void>((resolve) => {
      releaseFirstDeadline = resolve;
    });
    const targetedDeadline = jest
      .fn()
      .mockImplementationOnce(async () => {
        await firstDeadlineGate;
        return verificationBudget;
      })
      .mockResolvedValue(verificationBudget);
    const targeted = jest
      .fn()
      .mockImplementationOnce(async () => {
        await firstImmediateGate;
        return verificationBudget;
      })
      .mockImplementationOnce(async () => {
        await secondImmediateGate;
        return verificationBudget;
      })
      .mockResolvedValue(verificationBudget);
    const runner = new PublisherPublicationDispatchRunnerService(
      {
        processDueImmediatePublicationBroadcasts: jest.fn(),
        processTargetedImmediatePublicationBroadcasts: targeted,
        processTargetedDeadlinePublicationBroadcasts: targetedDeadline,
        processDueDeadlinePublicationBroadcasts: jest.fn().mockResolvedValue(verificationBudget),
      } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { dispatchEnabled: true, assertDispatchEnabled: jest.fn() } as never,
      {
        isGloballyPaused: jest.fn().mockResolvedValue(false),
        assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
      } as never,
      createBackgroundWork() as never,
      createPrisma() as never,
    );

    const firstWake = runner.wakeAfterPublicationMaterialization('publication-1');
    for (let attempt = 0; attempt < 10 && targeted.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    const secondWake = runner.wakeAfterPublicationMaterialization('publication-2', 'occurrence-2');
    let secondWakeSettled = false;
    void secondWake.then(() => {
      secondWakeSettled = true;
    });
    await Promise.resolve();

    expect(targeted).toHaveBeenCalledTimes(1);
    releaseFirstImmediate();
    for (let attempt = 0; attempt < 10 && targeted.mock.calls.length < 2; attempt += 1) {
      await Promise.resolve();
    }

    expect(targeted).toHaveBeenCalledTimes(2);
    expect(secondWakeSettled).toBe(false);
    releaseSecondImmediate();
    while (targetedDeadline.mock.calls.length === 0) await Promise.resolve();
    expect(targetedDeadline).toHaveBeenCalledTimes(1);
    releaseFirstDeadline();
    await Promise.all([firstWake, secondWake]);

    expect(targeted).toHaveBeenNthCalledWith(1, 'publication-1', undefined);
    expect(targeted).toHaveBeenNthCalledWith(2, 'publication-2', 'occurrence-2');
    expect(targetedDeadline).toHaveBeenNthCalledWith(
      1,
      'publication-1',
      undefined,
      verificationBudget,
    );
    expect(targetedDeadline).toHaveBeenNthCalledWith(
      2,
      'publication-2',
      'occurrence-2',
      verificationBudget,
    );
    expect(secondWakeSettled).toBe(true);
  });

  it('repeats an in-flight deadline lookup and re-arms to the refreshed deadline', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    process.env.APP_ROLE = 'publisher';
    let releaseLookup!: (value: { id: string; nextSendAt: Date }) => void;
    const lookupGate = new Promise<{ id: string; nextSendAt: Date }>((resolve) => {
      releaseLookup = resolve;
    });
    let executeDeadline = false;
    const backgroundWork = {
      runExclusive: jest.fn((_lane: string, operation: () => Promise<unknown>) =>
        executeDeadline ? operation() : Promise.resolve(),
      ),
    };
    const verificationBudget = { remaining: 50 };
    const immediate = jest.fn().mockResolvedValue(verificationBudget);
    const deadline = jest.fn().mockResolvedValue(verificationBudget);
    const findFirst = jest
      .fn()
      .mockReturnValueOnce(lookupGate)
      .mockResolvedValueOnce({
        id: 'broadcast-refreshed',
        nextSendAt: new Date('2026-09-04T10:00:02.000Z'),
      })
      .mockResolvedValue(null);
    const runner = new PublisherPublicationDispatchRunnerService(
      {
        processDueImmediatePublicationBroadcasts: immediate,
        processTargetedImmediatePublicationBroadcasts: jest
          .fn()
          .mockResolvedValue(verificationBudget),
        processTargetedDeadlinePublicationBroadcasts: jest
          .fn()
          .mockResolvedValue(verificationBudget),
        processDueDeadlinePublicationBroadcasts: deadline,
      } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { dispatchEnabled: true, assertDispatchEnabled: jest.fn() } as never,
      {
        isGloballyPaused: jest.fn().mockResolvedValue(false),
        assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
      } as never,
      backgroundWork as never,
      createPrisma(findFirst) as never,
    );
    try {
      const firstWake = runner.wakeAfterPublicationMaterialization('publication-1');
      while (findFirst.mock.calls.length === 0) await Promise.resolve();
      const secondWake = runner.wakeAfterPublicationMaterialization('publication-2');

      releaseLookup({
        id: 'broadcast-stale',
        nextSendAt: new Date('2026-09-04T10:00:10.000Z'),
      });
      await Promise.all([firstWake, secondWake]);

      expect(findFirst).toHaveBeenCalledTimes(2);
      executeDeadline = true;
      await jest.advanceTimersByTimeAsync(1_999);
      expect(deadline).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      expect(deadline).toHaveBeenCalledTimes(1);
    } finally {
      runner.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('acknowledges a NOW wake while unrelated deadline work is waiting', async () => {
    process.env.APP_ROLE = 'publisher';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backgroundWork = {
      runExclusive: jest.fn(async () => {
        await gate;
      }),
    };
    const prisma = createPrisma();
    prisma.publicationSchedule.findUnique.mockResolvedValue({ mode: 'NOW' });
    const targetedDeadline = jest.fn();
    const runner = new PublisherPublicationDispatchRunnerService(
      {
        processTargetedImmediatePublicationBroadcasts: jest
          .fn()
          .mockResolvedValue({ remaining: 1 }),
        processTargetedDeadlinePublicationBroadcasts: targetedDeadline,
      } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { dispatchEnabled: true, assertDispatchEnabled: jest.fn() } as never,
      { assertDispatchAllowed: jest.fn().mockResolvedValue(undefined) } as never,
      backgroundWork as never,
      prisma as never,
    );
    (runner as any).startDeadlineRun('scheduled');
    try {
      await runner.wakeAfterPublicationMaterialization('now-publication');
      expect(targetedDeadline).not.toHaveBeenCalled();
      expect(backgroundWork.runExclusive).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await runner.onModuleDestroy();
    }
  });

  it('continues NOW quanta while an older deadline waits, without overlap or a pause loop', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-27T10:00:00Z'));
    process.env.APP_ROLE = 'publisher';
    let paused = false;
    let active = 0;
    let maxActive = 0;
    let releaseDeadline!: () => void;
    const deadlineGate = new Promise<void>((resolve) => {
      releaseDeadline = resolve;
    });
    const immediate = jest.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 500));
      active -= 1;
      return { remaining: 1 };
    });
    const runner = new PublisherPublicationDispatchRunnerService(
      { processDueImmediatePublicationBroadcasts: immediate } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { dispatchEnabled: true } as never,
      { isGloballyPaused: jest.fn(async () => paused) } as never,
      {
        runExclusive: jest.fn(async () => {
          await deadlineGate;
        }),
      } as never,
      createPrisma(
        jest.fn().mockResolvedValue({
          id: 'older-scheduled',
          nextSendAt: new Date('2026-09-27T08:00:00Z'),
        }),
        jest.fn().mockResolvedValue({
          id: 'pending-now',
          nextSendAt: new Date('2026-09-27T09:00:00Z'),
        }),
      ) as never,
    );
    try {
      await (runner as any).refreshDeadlineWakeup();
      await jest.advanceTimersByTimeAsync(250);
      expect(immediate).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(500);
      await jest.advanceTimersByTimeAsync(249);
      expect(immediate).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(immediate).toHaveBeenCalledTimes(2);
      paused = true;
      await jest.advanceTimersByTimeAsync(5_000);
      expect(immediate).toHaveBeenCalledTimes(2);
      expect(maxActive).toBe(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      releaseDeadline();
      await runner.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('serializes two strict wake refreshes behind one active interval lookup', async () => {
    process.env.APP_ROLE = 'publisher';
    const resolvers: Array<(value: null) => void> = [];
    let activeLookups = 0;
    let maxActiveLookups = 0;
    const findFirst = jest.fn(
      () =>
        new Promise<null>((resolve) => {
          activeLookups += 1;
          maxActiveLookups = Math.max(maxActiveLookups, activeLookups);
          resolvers.push((value) => {
            activeLookups -= 1;
            resolve(value);
          });
        }),
    );
    const runner = new PublisherPublicationDispatchRunnerService(
      {} as never,
      {} as never,
      { dispatchEnabled: true } as never,
      {} as never,
      {} as never,
      createPrisma(findFirst) as never,
    );

    const intervalRefresh = (runner as any).refreshDeadlineWakeup() as Promise<void>;
    while (findFirst.mock.calls.length < 1) await Promise.resolve();
    const firstWakeRefresh = (runner as any).refreshDeadlineWakeupForWake() as Promise<void>;
    const secondWakeRefresh = (runner as any).refreshDeadlineWakeupForWake() as Promise<void>;
    await Promise.resolve();
    expect(findFirst).toHaveBeenCalledTimes(1);

    resolvers.shift()!(null);
    while (findFirst.mock.calls.length < 2) await Promise.resolve();
    expect(maxActiveLookups).toBe(1);
    resolvers.shift()!(null);
    while (findFirst.mock.calls.length < 3) await Promise.resolve();
    expect(maxActiveLookups).toBe(1);
    resolvers.shift()!(null);

    await Promise.all([intervalRefresh, firstWakeRefresh, secondWakeRefresh]);
    expect(findFirst).toHaveBeenCalledTimes(3);
    expect(maxActiveLookups).toBe(1);
    await runner.onModuleDestroy();
  });

  it('does not lose a wake queued after the deadline drain completes but before in-flight cleanup', async () => {
    process.env.APP_ROLE = 'publisher';
    let releaseLookup!: (value: null) => void;
    const lookupGate = new Promise<null>((resolve) => {
      releaseLookup = resolve;
    });
    const verificationBudget = { remaining: 50 };
    const findFirst = jest.fn().mockReturnValueOnce(lookupGate).mockResolvedValueOnce(null);
    const runner = new PublisherPublicationDispatchRunnerService(
      {
        processDueImmediatePublicationBroadcasts: jest.fn().mockResolvedValue(verificationBudget),
        processTargetedImmediatePublicationBroadcasts: jest
          .fn()
          .mockResolvedValue(verificationBudget),
        processTargetedDeadlinePublicationBroadcasts: jest
          .fn()
          .mockResolvedValue(verificationBudget),
        processDueDeadlinePublicationBroadcasts: jest.fn().mockResolvedValue(verificationBudget),
      } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { dispatchEnabled: true, assertDispatchEnabled: jest.fn() } as never,
      {
        isGloballyPaused: jest.fn().mockResolvedValue(false),
        assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
      } as never,
      { runExclusive: jest.fn().mockResolvedValue(undefined) } as never,
      createPrisma(findFirst) as never,
    );

    const firstWake = runner.wakeAfterPublicationMaterialization('publication-1');
    while (findFirst.mock.calls.length === 0) await Promise.resolve();
    let boundaryWake: Promise<void> | undefined;
    releaseLookup(null);
    queueMicrotask(() => {
      boundaryWake = runner.wakeAfterPublicationMaterialization('publication-2');
    });

    await firstWake;
    expect(boundaryWake).toBeDefined();
    await boundaryWake;

    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('wakes both the NOW lane and the persisted deadline refresh', async () => {
    process.env.APP_ROLE = 'publisher';
    const verificationBudget = { remaining: 50 };
    const targeted = jest.fn().mockResolvedValue(verificationBudget);
    const findFirst = jest.fn().mockResolvedValue(null);
    const runner = new PublisherPublicationDispatchRunnerService(
      {
        processDueImmediatePublicationBroadcasts: jest.fn(),
        processTargetedImmediatePublicationBroadcasts: targeted,
        processTargetedDeadlinePublicationBroadcasts: jest
          .fn()
          .mockResolvedValue(verificationBudget),
        processDueDeadlinePublicationBroadcasts: jest.fn().mockResolvedValue(verificationBudget),
      } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { dispatchEnabled: true, assertDispatchEnabled: jest.fn() } as never,
      {
        isGloballyPaused: jest.fn().mockResolvedValue(false),
        assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
      } as never,
      createBackgroundWork() as never,
      createPrisma(findFirst) as never,
    );

    await runner.wakeAfterPublicationMaterialization('publication-1', 'occurrence-1');

    expect(targeted).toHaveBeenCalledWith('publication-1', 'occurrence-1');
    expect(findFirst).toHaveBeenCalled();
  });

  it('keeps the wake unacknowledged until its strict deadline pass completes', async () => {
    process.env.APP_ROLE = 'publisher';
    let releaseDeadline!: () => void;
    const deadlineGate = new Promise<void>((resolve) => {
      releaseDeadline = resolve;
    });
    const verificationBudget = { remaining: 50 };
    const deadline = jest.fn(async () => {
      await deadlineGate;
      return verificationBudget;
    });
    const runner = new PublisherPublicationDispatchRunnerService(
      {
        processDueImmediatePublicationBroadcasts: jest.fn(),
        processTargetedImmediatePublicationBroadcasts: jest
          .fn()
          .mockResolvedValue(verificationBudget),
        processTargetedDeadlinePublicationBroadcasts: deadline,
        processDueDeadlinePublicationBroadcasts: deadline,
      } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { dispatchEnabled: true, assertDispatchEnabled: jest.fn() } as never,
      {
        isGloballyPaused: jest.fn().mockResolvedValue(false),
        assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
      } as never,
      createBackgroundWork() as never,
      createPrisma() as never,
    );

    const wake = runner.wakeAfterPublicationMaterialization('publication-1');
    let settled = false;
    void wake.then(() => {
      settled = true;
    });
    while (deadline.mock.calls.length === 0) await Promise.resolve();

    expect(settled).toBe(false);
    releaseDeadline();
    await wake;
    expect(settled).toBe(true);
  });

  it('returns a shared deadline failure to the wake job while its background tick completes', async () => {
    process.env.APP_ROLE = 'publisher';
    const failure = new Error('deadline database unavailable');
    let rejectDeadline!: (error: Error) => void;
    const deadline = jest.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectDeadline = reject;
        }),
    );
    const verificationBudget = { remaining: 50 };
    const runner = new PublisherPublicationDispatchRunnerService(
      {
        processDueImmediatePublicationBroadcasts: jest.fn(),
        processTargetedImmediatePublicationBroadcasts: jest
          .fn()
          .mockResolvedValue(verificationBudget),
        processTargetedDeadlinePublicationBroadcasts: deadline,
        processDueDeadlinePublicationBroadcasts: jest.fn().mockRejectedValue(failure),
      } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { dispatchEnabled: true, assertDispatchEnabled: jest.fn() } as never,
      {
        isGloballyPaused: jest.fn().mockResolvedValue(false),
        assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
      } as never,
      createBackgroundWork() as never,
      createPrisma() as never,
    );

    const wake = runner.wakeAfterPublicationMaterialization('publication-1');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deadline).toHaveBeenCalledTimes(1);
    const tick = runner['run']('scheduled');
    await new Promise<void>((resolve) => setImmediate(resolve));
    rejectDeadline(failure);
    expect(await Promise.allSettled([wake, tick])).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'fulfilled', value: undefined },
    ]);
  });

  it('propagates a wake-owned deadline refresh failure for BullMQ retry', async () => {
    process.env.APP_ROLE = 'publisher';
    const failure = new Error('deadline lookup unavailable');
    const verificationBudget = { remaining: 50 };
    const deadline = jest.fn();
    const runner = new PublisherPublicationDispatchRunnerService(
      {
        processDueImmediatePublicationBroadcasts: jest.fn(),
        processTargetedImmediatePublicationBroadcasts: jest
          .fn()
          .mockResolvedValue(verificationBudget),
        processTargetedDeadlinePublicationBroadcasts: deadline,
        processDueDeadlinePublicationBroadcasts: deadline,
      } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { dispatchEnabled: true, assertDispatchEnabled: jest.fn() } as never,
      {
        isGloballyPaused: jest.fn().mockResolvedValue(false),
        assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
      } as never,
      createBackgroundWork() as never,
      createPrisma(jest.fn().mockRejectedValue(failure)) as never,
    );

    await expect(runner.wakeAfterPublicationMaterialization('publication-1')).rejects.toBe(failure);
    expect(deadline).not.toHaveBeenCalled();
  });

  it('propagates a pause that appears before the wake-owned deadline pass', async () => {
    process.env.APP_ROLE = 'publisher';
    const failure = new Error('publisher paused');
    const verificationBudget = { remaining: 50 };
    const assertDispatchAllowed = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure);
    const deadline = jest.fn();
    const runner = new PublisherPublicationDispatchRunnerService(
      {
        processDueImmediatePublicationBroadcasts: jest.fn(),
        processTargetedImmediatePublicationBroadcasts: jest
          .fn()
          .mockResolvedValue(verificationBudget),
        processTargetedDeadlinePublicationBroadcasts: deadline,
        processDueDeadlinePublicationBroadcasts: deadline,
      } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { dispatchEnabled: true, assertDispatchEnabled: jest.fn() } as never,
      {
        isGloballyPaused: jest.fn().mockResolvedValue(false),
        assertDispatchAllowed,
      } as never,
      createBackgroundWork() as never,
      createPrisma() as never,
    );

    await expect(runner.wakeAfterPublicationMaterialization('publication-1')).rejects.toBe(failure);
    expect(deadline).not.toHaveBeenCalled();
  });

  it('waits for captured immediate, deadline, and refresh work during destroy', async () => {
    process.env.APP_ROLE = 'publisher';
    const releases: Array<() => void> = [];
    const gates = Array.from(
      { length: 3 },
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const runner = new PublisherPublicationDispatchRunnerService(
      {} as never,
      {} as never,
      { dispatchEnabled: true } as never,
      {} as never,
      {} as never,
      createPrisma() as never,
    );
    (runner as any).immediateDrainInFlight = gates[0];
    (runner as any).deadlineInFlight = gates[1];
    (runner as any).deadlineWakeRefreshInFlight = gates[2];

    const destroy = runner.onModuleDestroy();
    let settled = false;
    void destroy.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect((runner as any).startDeadlineRun('deadline_wakeup')).toBeNull();

    releases[0]!();
    releases[1]!();
    await Promise.resolve();
    expect(settled).toBe(false);
    releases[2]!();
    await destroy;
    expect(settled).toBe(true);
  });

  it('re-arms overdue executable work after a bounded delay instead of waiting for safety polling', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    process.env.APP_ROLE = 'publisher';
    let runner: PublisherPublicationDispatchRunnerService | undefined;
    try {
      const deadline = jest.fn().mockResolvedValue({ remaining: 50 });
      const overdue = {
        id: 'broadcast-overdue',
        nextSendAt: new Date('2026-09-04T09:59:00.000Z'),
      };
      const findFirst = jest
        .fn()
        .mockResolvedValueOnce(overdue)
        .mockResolvedValueOnce(overdue)
        .mockResolvedValue(null);
      runner = new PublisherPublicationDispatchRunnerService(
        {
          processDueImmediatePublicationBroadcasts: jest.fn().mockResolvedValue({ remaining: 50 }),
          processDueDeadlinePublicationBroadcasts: deadline,
        } as never,
        { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
        { dispatchEnabled: true } as never,
        { isGloballyPaused: jest.fn().mockResolvedValue(false) } as never,
        createBackgroundWork() as never,
        createPrisma(findFirst) as never,
      );

      await (runner as any).refreshDeadlineWakeup();
      await jest.advanceTimersByTimeAsync(249);
      expect(deadline).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      expect(deadline).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(249);
      expect(deadline).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1);
      expect(deadline).toHaveBeenCalledTimes(2);
      expect(findFirst).toHaveBeenCalledTimes(3);
    } finally {
      runner?.onModuleDestroy();
      jest.useRealTimers();
    }
  });
});
