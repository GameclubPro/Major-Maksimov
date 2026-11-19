import { PublisherPostImportProcessor } from './publisher-post-import.processor';

describe('PublisherPostImportProcessor', () => {
  const previousRole = process.env.APP_ROLE;
  const previousServiceName = process.env.APP_SERVICE_NAME;

  afterEach(() => {
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
    if (previousServiceName === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = previousServiceName;
  });

  function fixture() {
    const processing = {
      process: jest.fn().mockResolvedValue('ready'),
      failInternalAfterFinalAttempt: jest.fn().mockResolvedValue(true),
    };
    const delivery = { deliver: jest.fn().mockResolvedValue(undefined) };
    const queue = { enqueueNotification: jest.fn().mockResolvedValue(undefined) };
    const attestation = { assertAttested: jest.fn().mockResolvedValue(undefined) };
    const dispatchHealth = { assertDispatchAllowed: jest.fn().mockResolvedValue(undefined) };
    const runtimeBoundary = { assertDispatchEnabled: jest.fn() };
    return {
      processor: new PublisherPostImportProcessor(
        processing as never,
        delivery as never,
        queue as never,
        attestation as never,
        dispatchHealth as never,
        runtimeBoundary as never,
      ),
      processing,
      delivery,
      queue,
      attestation,
      dispatchHealth,
      runtimeBoundary,
    };
  }

  it('rejects work outside the isolated publisher process', async () => {
    process.env.APP_ROLE = 'action';
    process.env.APP_SERVICE_NAME = 'api-action';
    const { processor, processing } = fixture();

    await expect(
      processor.process({
        data: {
          version: 1,
          kind: 'process',
          sessionId: 'session-1',
          requestedAt: '2026-08-28T12:00:00.000Z',
        },
      } as never),
    ).rejects.toThrow('outside api-publisher');
    expect(processing.process).not.toHaveBeenCalled();
  });

  it('passes identity, runtime and health guards before processing', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const { processor, processing, queue, attestation, dispatchHealth, runtimeBoundary } =
      fixture();

    await processor.process({
      data: {
        version: 1,
        kind: 'process',
        sessionId: 'session-1',
        requestedAt: '2026-08-28T12:00:00.000Z',
      },
    } as never);

    expect(runtimeBoundary.assertDispatchEnabled).toHaveBeenCalledTimes(1);
    expect(attestation.assertAttested).toHaveBeenCalledTimes(1);
    expect(dispatchHealth.assertDispatchAllowed).toHaveBeenCalledTimes(1);
    expect(processing.process).toHaveBeenCalledWith('session-1', true);
    expect(queue.enqueueNotification).toHaveBeenCalledWith({
      sessionId: 'session-1',
      notification: 'ready',
      dedupeKey: 'terminal-ready',
    });
  });

  it('keeps a transient process failure on Bull retry before the final attempt', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const { processor, processing, queue } = fixture();
    const failure = new Error('temporary database failure');
    processing.process.mockRejectedValue(failure);

    await expect(
      processor.process({
        data: {
          version: 1,
          kind: 'process',
          sessionId: 'session-1',
          requestedAt: '2026-08-28T12:00:00.000Z',
        },
        attemptsMade: 2,
        opts: { attempts: 5 },
      } as never),
    ).rejects.toBe(failure);

    expect(processing.failInternalAfterFinalAttempt).not.toHaveBeenCalled();
    expect(queue.enqueueNotification).not.toHaveBeenCalled();
  });

  it('terminalizes an unlocked session after the final process failure', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const { processor, processing, queue } = fixture();
    const failure = new Error('persistent database failure');
    processing.process.mockRejectedValue(failure);

    await expect(
      processor.process({
        data: {
          version: 1,
          kind: 'process',
          sessionId: 'session-1',
          requestedAt: '2026-08-28T12:00:00.000Z',
        },
        attemptsMade: 4,
        opts: { attempts: 5 },
      } as never),
    ).rejects.toBe(failure);

    expect(processing.failInternalAfterFinalAttempt).toHaveBeenCalledWith('session-1');
    expect(queue.enqueueNotification).toHaveBeenCalledWith({
      sessionId: 'session-1',
      notification: 'failed',
      dedupeKey: 'terminal-internal-error',
    });
  });
});
