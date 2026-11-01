import { CommercialAiObservationGate } from './commercial-ai-runtime-observation';

describe('optional commercial AI evidence budget', () => {
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
