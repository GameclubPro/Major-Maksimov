import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import { WebhookPreparationAdmission } from './webhook-preparation-admission';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('Webhook durable preparation admission', () => {
  it('uses twelve preparation slots while keeping each bot class to one third of capacity', async () => {
    const admission = new WebhookPreparationAdmission(24, jest.fn());
    const gates: ReturnType<typeof gate>[] = [];
    const tasks: Promise<void>[] = [];
    const start = (bot: string) => {
      const pending = gate();
      gates.push(pending);
      const task = admission.run(bot, 'ordinary', () => pending.promise);
      tasks.push(task);
      return { ...pending, task };
    };
    const rejected = jest.fn(async () => undefined);
    try {
      expect(admission.maxInFlight).toBe(12);
      const first = start('a');
      for (let index = 0; index < 3; index++) start('a');
      await expect(admission.run('a', 'ordinary', rejected)).rejects.toBeInstanceOf(
        WebhookPreparationDeferredError,
      );
      expect(admission.schedulingState('a', 'ordinary')).toBe('scope_capacity');
      for (const bot of ['b', 'c']) for (let index = 0; index < 4; index++) start(bot);
      expect(admission.snapshot()).toMatchObject({ inFlight: 12, ordinary: 12, pending: 0 });
      expect(admission.schedulingState('command', 'interactive')).toBe('shared_capacity');
      first.release();
      await first.task;
      await expect(admission.run('d', 'ordinary', rejected)).rejects.toBeInstanceOf(
        WebhookPreparationDeferredError,
      );
      const commandGate = gate();
      gates.push(commandGate);
      tasks.push(admission.run('command', 'interactive', () => commandGate.promise));
      expect(admission.snapshot()).toMatchObject({ inFlight: 12, interactive: 1 });
      admission.stop();
      expect(admission.schedulingState('d', 'ordinary')).toBe('closed');
      expect(rejected).not.toHaveBeenCalled();
    } finally {
      gates.forEach((pending) => pending.release());
      await Promise.allSettled(tasks);
      await admission.drain();
    }
    expect(admission.snapshot()).toMatchObject({ inFlight: 0, botScopes: 0 });
  });

  it.each(['interactive', 'lifecycle'] as const)(
    'admits both priority classes under repeated ordinary refill attempts (%s waits first)',
    async (firstClass) => {
      const admission = new WebhookPreparationAdmission(12, jest.fn());
      const gates: ReturnType<typeof gate>[] = [];
      const tasks: Promise<void>[] = [];
      const start = (bot: string, workClass: 'ordinary' | 'interactive' | 'lifecycle') => {
        const pending = gate();
        gates.push(pending);
        const task = admission.run(bot, workClass, () => pending.promise);
        tasks.push(task);
        return { ...pending, task };
      };
      const secondClass = firstClass === 'interactive' ? 'lifecycle' : 'interactive';
      const rejected = jest.fn(async () => undefined);
      try {
        for (const bot of ['a', 'a', 'b', 'b', 'c']) start(bot, 'ordinary');
        let finishing = start('c', 'ordinary');
        for (let cycle = 0; cycle < 25; cycle++) {
          expect(admission.schedulingState('priority', firstClass)).toBe('shared_capacity');
          expect(admission.schedulingState('priority', secondClass)).toBe('shared_capacity');
          finishing.release();
          await finishing.task;
          for (const workClass of [firstClass, secondClass] as const) {
            await expect(admission.run('d', 'ordinary', rejected)).rejects.toBeInstanceOf(
              WebhookPreparationDeferredError,
            );
            // The most recently served class cannot replace the other class's hint.
            const competingClass = workClass === 'interactive' ? 'lifecycle' : 'interactive';
            await expect(
              admission.run('priority', competingClass, rejected),
            ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
            const priority = start('priority', workClass);
            expect(admission.snapshot()).toMatchObject({ inFlight: 6, ordinary: 5, pending: 0 });
            priority.release();
            await priority.task;
          }
          // The rejected first class has retained its turn after the second admission.
          await admission.run('priority', firstClass, async () => undefined);
          finishing = start('c', 'ordinary');
        }
        expect(rejected).not.toHaveBeenCalled();
      } finally {
        gates.forEach((pending) => pending.release());
        await Promise.allSettled(tasks);
        await admission.drain();
      }
      expect(admission.snapshot()).toMatchObject({ inFlight: 0, botScopes: 0 });
    },
  );

  it('does not reserve idle capacity for a second interactive task while one still owns its slot', async () => {
    const admission = new WebhookPreparationAdmission(4, jest.fn());
    const commandGate = gate();
    const ordinaryGate = gate();
    const command = admission.run('a', 'interactive', () => commandGate.promise);
    const ordinary = admission.run('a', 'ordinary', () => ordinaryGate.promise);
    try {
      expect(admission.schedulingState('b', 'interactive')).toBe('shared_capacity');
      ordinaryGate.release();
      await ordinary;
      expect(admission.schedulingState('b', 'interactive')).toBe('scope_capacity');
      await admission.run('b', 'ordinary', async () => undefined);
      expect(admission.snapshot()).toMatchObject({ inFlight: 1, interactive: 1 });
    } finally {
      commandGate.release();
      ordinaryGate.release();
      await Promise.all([command, ordinary]);
    }
  });

  it.each([2, 12])(
    'expires an abandoned command hint without releasing unfinished work (pool=%s)',
    async (pool) => {
      const admission = new WebhookPreparationAdmission(pool, jest.fn());
      const gates = Array.from({ length: admission.maxInFlight }, () => gate());
      const tasks = gates.map((pending, index) =>
        admission.run(`bot-${index}`, 'ordinary', () => pending.promise),
      );
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
      try {
        expect(admission.schedulingState('command', 'interactive')).toBe('shared_capacity');
        gates[0]!.release();
        await tasks[0];
        expect(admission.schedulingState('ordinary', 'ordinary')).toBe('shared_capacity');
        clock.mockReturnValue(now + 5_001);
        expect(admission.snapshot().inFlight).toBe(admission.maxInFlight - 1);
        await admission.run('ordinary', 'ordinary', async () => undefined);
      } finally {
        clock.mockRestore();
        gates.forEach((pending) => pending.release());
        await Promise.all(tasks);
      }
    },
  );

  it('shares the expanded preparation pool across bots without letting one class take a third slot', async () => {
    const admission = new WebhookPreparationAdmission(12, jest.fn());
    const gates: ReturnType<typeof gate>[] = [];
    const tasks: Promise<void>[] = [];
    const start = (botId: string) => {
      const pending = gate();
      gates.push(pending);
      const task = admission.run(botId, 'ordinary', () => pending.promise);
      tasks.push(task);
      return { ...pending, task };
    };
    const rejected = jest.fn(async () => undefined);
    try {
      const first = start('bot-a');
      start('bot-a');
      await expect(admission.run('bot-a', 'ordinary', rejected)).rejects.toBeInstanceOf(
        WebhookPreparationDeferredError,
      );
      expect(admission.schedulingState('bot-a', 'ordinary')).toBe('scope_capacity');
      for (const bot of ['bot-b', 'bot-b', 'bot-c', 'bot-c']) start(bot);
      expect(admission.snapshot()).toMatchObject({ inFlight: 6, ordinary: 6, pending: 0 });
      await expect(admission.run('bot-d', 'ordinary', rejected)).rejects.toBeInstanceOf(
        WebhookPreparationDeferredError,
      );
      const completion = admission.nextCompletion();
      first.release();
      await completion;
      await first.task;
      start('bot-d');
      expect(admission.snapshot()).toMatchObject({ inFlight: 6, botScopes: 4, pending: 0 });
      expect(rejected).not.toHaveBeenCalled();
    } finally {
      gates.forEach((pending) => pending.release());
      await Promise.allSettled(tasks);
      await admission.drain();
    }
    expect(admission.snapshot()).toMatchObject({ inFlight: 0, botScopes: 0, pending: 0 });
  });

  it('preserves class isolation, lifecycle reservation and draining in the expanded preparation pool', async () => {
    const admission = new WebhookPreparationAdmission(12, jest.fn());
    const gates: ReturnType<typeof gate>[] = [];
    const tasks: Promise<void>[] = [];
    const start = (botId: string, workClass: 'ordinary' | 'interactive' | 'lifecycle') => {
      const pending = gate();
      gates.push(pending);
      const task = admission.run(botId, workClass, () => pending.promise);
      tasks.push(task);
      return { ...pending, task };
    };
    const rejected = jest.fn(async () => undefined);
    let draining: Promise<void> | undefined;
    try {
      start('bot-a', 'ordinary');
      start('bot-a', 'ordinary');
      start('bot-a', 'lifecycle');
      start('bot-a', 'lifecycle');
      await expect(admission.run('bot-a', 'lifecycle', rejected)).rejects.toBeInstanceOf(
        WebhookPreparationDeferredError,
      );
      start('bot-a', 'interactive');
      await expect(admission.run('bot-b', 'interactive', rejected)).rejects.toBeInstanceOf(
        WebhookPreparationDeferredError,
      );
      const ordinary = start('bot-b', 'ordinary');
      expect(admission.snapshot()).toMatchObject({
        inFlight: 6,
        ordinary: 3,
        lifecycle: 2,
        interactive: 1,
      });
      await expect(admission.run('bot-c', 'lifecycle', rejected)).rejects.toBeInstanceOf(
        WebhookPreparationDeferredError,
      );
      ordinary.release();
      await ordinary.task;
      await expect(admission.run('bot-d', 'ordinary', rejected)).rejects.toBeInstanceOf(
        WebhookPreparationDeferredError,
      );
      const lifecycle = start('bot-c', 'lifecycle');
      lifecycle.release();
      await lifecycle.task;
      start('bot-d', 'ordinary');
      expect(admission.snapshot().inFlight).toBe(6);
      admission.stop();
      expect(admission.schedulingState('bot-e', 'ordinary')).toBe('closed');
      await expect(admission.run('bot-e', 'ordinary', rejected)).rejects.toBeInstanceOf(
        WebhookPreparationDeferredError,
      );
      let drained = false;
      draining = admission.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      expect(rejected).not.toHaveBeenCalled();
    } finally {
      gates.forEach((pending) => pending.release());
      await Promise.allSettled(tasks);
      await draining;
    }
    expect(admission.snapshot()).toMatchObject({ inFlight: 0, botScopes: 0, pending: 0 });
  });

  it('distinguishes shared saturation from a poisoned bot behind a lifecycle reservation', async () => {
    const admission = new WebhookPreparationAdmission(4, jest.fn());
    const a = gate();
    const b = gate();
    const first = admission.run('a', 'ordinary', () => a.promise);
    const second = admission.run('b', 'ordinary', () => b.promise);
    try {
      expect(admission.schedulingState('a', 'ordinary')).toBe('shared_capacity');
      expect(admission.schedulingState('c', 'lifecycle')).toBe('shared_capacity');
      b.release();
      await second;
      expect(admission.schedulingState('a', 'ordinary')).toBe('scope_capacity');
      expect(admission.schedulingState('b', 'ordinary')).toBe('shared_capacity');
      expect(admission.schedulingState('c', 'lifecycle')).toBe('available');
      admission.stop();
      expect(admission.schedulingState('b', 'ordinary')).toBe('closed');
    } finally {
      a.release();
      b.release();
      await Promise.all([first, second]);
    }
  });

  it('preserves lifecycle reservation and shutdown when the outbox checks scheduling availability', async () => {
    const admission = new WebhookPreparationAdmission(4, jest.fn());
    const a = gate();
    const b = gate();
    const first = admission.run('a', 'ordinary', () => a.promise);
    const second = admission.run('b', 'ordinary', () => b.promise);
    try {
      expect(admission.canRun('c', 'lifecycle')).toBe(false);
      const completion = admission.nextCompletion();
      b.release();
      await completion;
      expect(admission.canRun('b', 'ordinary')).toBe(false);
      expect(admission.canRun('c', 'lifecycle')).toBe(true);
      await admission.run('c', 'lifecycle', async () => undefined);
      expect(admission.canRun('b', 'ordinary')).toBe(true);
      admission.stop();
      expect(admission.canRun('b', 'ordinary')).toBe(false);
      expect(admission.canRun('c', 'lifecycle')).toBe(false);
    } finally {
      a.release();
      b.release();
      await Promise.all([first, second]);
    }
    expect(admission.nextCompletion()).toBeNull();
  });

  it('bounds 1,000 pending calls from a slow bot while another bot progresses', async () => {
    const report = jest.fn();
    const admission = new WebhookPreparationAdmission(4, report);
    const a = gate();
    const b = gate();
    const first = admission.run('bot-a', 'ordinary', () => a.promise);
    const extraTask = jest.fn();
    const excess = await Promise.allSettled(
      Array.from({ length: 1000 }, () => admission.run('bot-a', 'ordinary', extraTask)),
    );
    expect(
      excess.every(
        (result) =>
          result.status === 'rejected' && result.reason instanceof WebhookPreparationDeferredError,
      ),
    ).toBe(true);
    expect(extraTask).not.toHaveBeenCalled();
    const other = admission.run('bot-b', 'ordinary', () => b.promise);
    expect(admission.snapshot()).toMatchObject({ inFlight: 2, pending: 0, botScopes: 2 });
    b.release();
    await other;
    await admission.run('bot-b', 'ordinary', async () => undefined);
    expect(admission.snapshot().inFlight).toBe(1);
    a.release();
    await first;
    admission.flush();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        peakInFlight: 2,
        inFlight: 0,
        botScopes: 0,
        deferred: { ordinary: 1000, interactive: 0, lifecycle: 0 },
      }),
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain('bot-a');
  });

  it.each([false, true])(
    'does not reserve another slot for lifecycle work blocked by its own bot quota (initially full=%s)',
    async (initiallyFull) => {
      const admission = new WebhookPreparationAdmission(4, jest.fn());
      const lifecycleGate = gate();
      const ordinaryGate = gate();
      const lifecycle = admission.run('bot-a', 'lifecycle', () => lifecycleGate.promise);
      const ordinary = initiallyFull
        ? admission.run('bot-b', 'ordinary', () => ordinaryGate.promise)
        : Promise.resolve();
      try {
        await expect(
          admission.run('bot-a', 'lifecycle', async () => undefined),
        ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
        ordinaryGate.release();
        await ordinary;
        // The rejected bot already holds its lifecycle allowance. It cannot use the
        // other slot, which must remain available to independent ordinary work.
        await expect(admission.run('bot-b', 'ordinary', async () => 'progress')).resolves.toBe(
          'progress',
        );
        expect(admission.snapshot()).toMatchObject({ inFlight: 1, lifecycle: 1, pending: 0 });
      } finally {
        lifecycleGate.release();
        ordinaryGate.release();
        await Promise.all([lifecycle, ordinary]);
      }
    },
  );

  it('does not let a slow Start handshake occupy the same bot ordinary-event allowance', async () => {
    const admission = new WebhookPreparationAdmission(4, jest.fn());
    const pending = gate();
    const interactive = admission.run('bot-a', 'interactive', () => pending.promise);
    await admission.run('bot-a', 'ordinary', async () => undefined);
    expect(admission.snapshot()).toMatchObject({ inFlight: 1, ordinary: 0, interactive: 1 });
    pending.release();
    await interactive;
  });

  it('reserves the next slot for a deferred lifecycle event without retaining its payload', async () => {
    const admission = new WebhookPreparationAdmission(4, jest.fn());
    const a = gate();
    const b = gate();
    const first = admission.run('bot-a', 'ordinary', () => a.promise);
    const second = admission.run('bot-b', 'ordinary', () => b.promise);
    await expect(admission.run('bot-c', 'lifecycle', async () => undefined)).rejects.toBeInstanceOf(
      WebhookPreparationDeferredError,
    );
    b.release();
    await second;
    await expect(admission.run('bot-d', 'ordinary', async () => undefined)).rejects.toBeInstanceOf(
      WebhookPreparationDeferredError,
    );
    await admission.run('bot-c', 'lifecycle', async () => undefined);
    a.release();
    await first;
  });

  it('stops admission synchronously and drains only admitted work, including failed tasks', async () => {
    const admission = new WebhookPreparationAdmission(4, jest.fn());
    const pending = gate();
    const first = admission.run('bot-a', 'interactive', () => pending.promise);
    await expect(
      admission.run('bot-b', 'ordinary', async () => {
        throw new Error('DB unavailable');
      }),
    ).rejects.toThrow('DB unavailable');
    admission.stop();
    const task = jest.fn();
    await expect(admission.run('bot-c', 'lifecycle', task)).rejects.toBeInstanceOf(
      WebhookPreparationDeferredError,
    );
    let drained = false;
    const draining = admission.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    pending.release();
    await Promise.all([first, draining]);
    expect(task).not.toHaveBeenCalled();
    expect(admission.snapshot()).toMatchObject({ inFlight: 0, pending: 0, botScopes: 0 });
  });

  it.each([false, true])(
    'releases a consumed lifecycle reservation after its task settles (failed=%s)',
    async (fails) => {
      const admission = new WebhookPreparationAdmission(4, jest.fn());
      const a = gate();
      const b = gate();
      const first = admission.run('bot-a', 'ordinary', () => a.promise);
      const second = admission.run('bot-b', 'ordinary', () => b.promise);
      try {
        await expect(
          admission.run('bot-c', 'lifecycle', async () => undefined),
        ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
        b.release();
        await second;
        const lifecycle = admission.run('bot-c', 'lifecycle', async () => {
          if (fails) throw new Error('Required follow-up failed');
        });
        if (fails) await expect(lifecycle).rejects.toThrow('Required follow-up failed');
        else await lifecycle;
        await expect(admission.run('bot-b', 'ordinary', async () => 'progress')).resolves.toBe(
          'progress',
        );
        expect(admission.snapshot()).toMatchObject({ inFlight: 1, pending: 0 });
      } finally {
        a.release();
        b.release();
        await Promise.all([first, second]);
      }
    },
  );

  it('preserves a later lifecycle reservation when an earlier admitted task finishes', async () => {
    const admission = new WebhookPreparationAdmission(4, jest.fn());
    const a = gate();
    const b = gate();
    const lifecycleGate = gate();
    const first = admission.run('bot-a', 'ordinary', () => a.promise);
    const second = admission.run('bot-b', 'ordinary', () => b.promise);
    let lifecycle: Promise<void> | undefined;
    try {
      await expect(
        admission.run('bot-c', 'lifecycle', async () => undefined),
      ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
      b.release();
      await second;
      lifecycle = admission.run('bot-c', 'lifecycle', () => lifecycleGate.promise);
      await expect(
        admission.run('bot-d', 'lifecycle', async () => undefined),
      ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
      lifecycleGate.release();
      await lifecycle;
      await expect(
        admission.run('bot-b', 'ordinary', async () => undefined),
      ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
      await admission.run('bot-d', 'lifecycle', async () => undefined);
      await expect(admission.run('bot-b', 'ordinary', async () => 'progress')).resolves.toBe(
        'progress',
      );
    } finally {
      a.release();
      b.release();
      lifecycleGate.release();
      await Promise.all([first, second, lifecycle]);
    }
  });

  it('keeps cumulative attribution across log flushes, failures and reporting errors', async () => {
    const report = jest.fn();
    const admission = new WebhookPreparationAdmission(2, report);
    const pending = gate();
    const running = admission.run('private-bot', 'ordinary', () => pending.promise);
    try {
      await expect(
        admission.run('private-bot', 'ordinary', async () => undefined),
      ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
      expect(admission.runtimeSnapshot()).toMatchObject({
        inFlight: 1,
        peakInFlight: 1,
        admitted: { ordinary: 1 },
        deferred: { ordinary: 1 },
        completed: { ordinary: 0 },
      });
    } finally {
      pending.release();
      await running;
    }
    admission.flush();
    const error = new Error('private-error');
    await expect(
      admission.run('private-bot', 'lifecycle', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    admission.flush();
    expect(report.mock.calls[0][0].admitted).toEqual({ ordinary: 1, interactive: 0, lifecycle: 0 });
    expect(report.mock.calls[1][0].admitted).toEqual({ ordinary: 0, interactive: 0, lifecycle: 1 });
    report.mockImplementation(() => {
      throw error;
    });
    expect(() => admission.flush()).not.toThrow();
    const snapshot = admission.runtimeSnapshot();
    expect(snapshot).toMatchObject({
      inFlight: 0,
      botScopes: 0,
      peakInFlight: 1,
      admitted: { ordinary: 1, lifecycle: 1 },
      deferred: { ordinary: 1 },
      completed: { ordinary: 1, lifecycle: 1 },
      errors: { lifecycle: 1 },
      duration: { calls: 2, errors: 1, unknownClocks: 0 },
    });
    snapshot.admitted.ordinary = 999;
    snapshot.duration.buckets.under100Ms = 999;
    expect(admission.runtimeSnapshot().admitted.ordinary).toBe(1);
    expect(admission.runtimeSnapshot().duration.buckets.under100Ms).not.toBe(999);
    expect(JSON.stringify(admission.runtimeSnapshot())).not.toContain('private');
  });

  it.each([NaN, Infinity, 0, -1])(
    'rejects invalid pool budget %s instead of losing the bound',
    (pool) => {
      expect(() => new WebhookPreparationAdmission(pool, jest.fn())).toThrow('pool budget');
    },
  );
});
