import { CommercialAiObservationGate } from './commercial-ai-runtime-observation';

describe('optional commercial AI evidence budget', () => {
  it('orders the same source behind an unsettled seed while another source progresses', async () => {
    const gate = new CommercialAiObservationGate();
    const events: string[] = [];
    let finish!: () => void;
    const seed = gate.runOrdered(
      'source-one',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const admission = gate.runOrdered('source-one', async () => {
      events.push('admission');
      return 'written';
    });
    await gate.runOrdered('source-two', async () => {
      events.push('independent');
      return 'written';
    });
    expect(events).toEqual(['independent']);
    expect(gate.snapshot().unsettled).toBe(1);
    finish();
    await Promise.all([seed, admission]);
    expect(events).toEqual(['independent', 'admission']);
    expect(gate.snapshot()).toMatchObject({ completed: 3, unsettled: 0, capacitySkipped: 0 });
  });

  it('bounds queued updates per source without releasing a timed-out seed', async () => {
    jest.useFakeTimers();
    const gate = new CommercialAiObservationGate();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const operations = [gate.runOrdered('one', () => pending)];
    for (let i = 0; i < 3; i++) operations.push(gate.runOrdered('one', async () => 'written'));
    const extra = jest.fn(async () => 'written');
    await gate.runOrdered('one', extra);
    operations.push(gate.runOrdered('two', () => pending));
    await gate.runOrdered('three', extra);
    await jest.advanceTimersByTimeAsync(100);
    await Promise.all(operations);
    expect(extra).not.toHaveBeenCalled();
    expect(gate.snapshot()).toMatchObject({ unsettled: 2, capacitySkipped: 2 });
    finish();
    await jest.advanceTimersByTimeAsync(0);
    expect(gate.snapshot()).toMatchObject({ unsettled: 0, completed: 5 });
  });

  afterEach(() => jest.useRealTimers());

  it('continues after 100ms, retains both unsettled slots and refuses an unbounded backlog', async () => {
    jest.useFakeTimers();
    const gate = new CommercialAiObservationGate();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = gate.run(() => pending);
    const second = gate.run(() => pending);
    await jest.advanceTimersByTimeAsync(100);
    await Promise.all([first, second]);
    const extra = jest.fn(async () => undefined);
    await gate.run(extra);
    expect(extra).not.toHaveBeenCalled();
    expect(gate.snapshot()).toMatchObject({ timedOut: 2, capacitySkipped: 1, unsettled: 2 });
    finish();
    await jest.advanceTimersByTimeAsync(0);
    expect(gate.snapshot()).toMatchObject({ completed: 2, unsettled: 0 });
    await gate.run(extra);
    expect(extra).toHaveBeenCalledTimes(1);
  });

  it('contains synchronous and asynchronous observer failures without retaining a settled slot', async () => {
    const gate = new CommercialAiObservationGate();
    await expect(
      gate.run(() => {
        throw new Error('isolated evidence outage');
      }),
    ).resolves.toBeUndefined();
    await expect(
      gate.run(async () => {
        throw new Error('isolated evidence outage');
      }),
    ).resolves.toBeUndefined();
    expect(gate.snapshot()).toMatchObject({ failed: 2, unsettled: 0, timedOut: 0 });
  });
});
