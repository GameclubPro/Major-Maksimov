import { CommercialOcrEnqueueService } from './commercial-ocr-enqueue.service';
import { COMMERCIAL_OCR_DEFAULT_VERSION } from './commercial-ocr.queue';

const input = {
  webhookEventId: 'event-1',
  chatId: 'chat-1',
  messageId: 'message-1',
  sourceCreatedAt: '2026-08-12T08:00:00.000Z',
  eventTimestamp: '2026-08-12T08:00:00.000Z',
  imageCount: 2,
  actionEligible: true,
};

const admissionLimits = {
  maxGlobalImageUnits: 16,
  maxChatImageUnits: 10,
  reservedActionableImageUnits: 4,
  maxJobAgeMs: 300_000,
  reservationTtlMs: 600_000,
};

function config(values: Record<string, unknown> = {}) {
  return {
    get: (key: string) =>
      values[key] ??
      (
        {
          COMMERCIAL_OCR_ROLLOUT_MODE: 'on',
        } as Record<string, unknown>
      )[key],
  };
}

function admission(overrides: Record<string, jest.Mock> = {}) {
  return {
    reserve: jest.fn().mockResolvedValue({ kind: 'admitted', state: 'pending' }),
    activate: jest.fn().mockResolvedValue('activated'),
    suppress: jest.fn().mockResolvedValue('suppressed'),
    ...overrides,
  };
}

function metrics() {
  return { recordCounter: jest.fn() };
}

describe('CommercialOcrEnqueueService', () => {
  it('uses event time for admission age and immutable creation time for the queued source', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    const store = admission();
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config() as never,
      store as never,
    );
    const eventTimestamp = '2026-08-12T08:00:00.150Z';

    await service.enqueue({ ...input, eventTimestamp, registerPendingActivation: jest.fn() });

    expect(store.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ sourceCreatedAt: eventTimestamp }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sourceCreatedAt: input.sourceCreatedAt,
        eventTimestamp,
        schemaVersion: 3,
      }),
      expect.any(Object),
    );
  });

  it('uses the configured reservation TTL for producer admission and recovery metadata', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    const store = admission();
    const registerPendingActivation = jest.fn();
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config({ COMMERCIAL_OCR_RESERVATION_TTL_MS: 420_000 }) as never,
      store as never,
    );

    await expect(service.enqueue({ ...input, registerPendingActivation })).resolves.toBe('queued');

    expect(store.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        limits: expect.objectContaining({ reservationTtlMs: 420_000 }),
      }),
    );
    expect(registerPendingActivation).toHaveBeenCalledWith(
      expect.objectContaining({ reservationTtlMs: 420_000 }),
    );
  });

  it('records fixed admission and enqueue outcomes without identifiers', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    const store = admission();
    const telemetry = metrics();
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config() as never,
      store as never,
      telemetry as never,
    );

    await expect(
      service.enqueue({ ...input, imageCount: 7, registerPendingActivation: jest.fn() }),
    ).resolves.toBe('queued');

    expect(telemetry.recordCounter.mock.calls).toEqual([
      ['admission.admitted.pending'],
      ['admission.image_units.admitted', 7],
      ['enqueue.queued'],
    ]);
  });

  it.each([
    ['rejected_global', 'admission.rejected.global'],
    ['rejected_actionable_reserve', 'admission.rejected.actionable_reserve'],
    ['rejected_chat', 'admission.rejected.chat'],
    ['rejected_age', 'admission.rejected.age'],
  ] as const)('records the %s admission outcome', async (kind, counter) => {
    const queue = { add: jest.fn() };
    const store = admission({ reserve: jest.fn().mockResolvedValue({ kind }) });
    const telemetry = metrics();
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config() as never,
      store as never,
      telemetry as never,
    );

    await service.enqueue({ ...input, imageCount: 9 });

    expect(telemetry.recordCounter).toHaveBeenCalledWith(counter);
    expect(telemetry.recordCounter).toHaveBeenCalledWith('enqueue.skipped');
    if (kind !== 'rejected_age') {
      expect(telemetry.recordCounter).toHaveBeenCalledWith(`admission.image_units.${kind}`, 9);
    }
  });

  it('suppresses a reservation that commits after reserve returned unavailable', async () => {
    const queue = { add: jest.fn() };
    const telemetry = metrics();
    const events: string[] = [];
    let reservedUnits = 0;
    let tombstoned = false;
    let commitLateReservation!: () => void;
    let markSuppressionIssued!: () => void;
    const lateReservation = new Promise<void>((resolve) => {
      commitLateReservation = resolve;
    });
    const suppressionIssued = new Promise<void>((resolve) => {
      markSuppressionIssued = resolve;
    });
    const store = admission({
      reserve: jest.fn().mockImplementation(async () => {
        events.push('reserve-timeout');
        void lateReservation.then(() => {
          reservedUnits = input.imageCount;
          events.push('reserve-commit');
        });
        return { kind: 'unavailable' };
      }),
      suppress: jest.fn().mockImplementation(async () => {
        events.push('suppress-issued');
        markSuppressionIssued();
        await lateReservation;
        reservedUnits = 0;
        tombstoned = true;
        events.push('suppress-commit');
        return 'suppressed';
      }),
    });
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config() as never,
      store as never,
      telemetry as never,
    );

    const enqueue = service.enqueue(input);
    await suppressionIssued;
    expect(queue.add).not.toHaveBeenCalled();

    commitLateReservation();

    await expect(enqueue).resolves.toBe('failed');
    expect(events).toEqual([
      'reserve-timeout',
      'suppress-issued',
      'reserve-commit',
      'suppress-commit',
    ]);
    expect(reservedUnits).toBe(0);
    expect(tombstoned).toBe(true);
    expect(store.suppress).toHaveBeenCalledWith({
      jobId: expect.stringMatching(/^commercial-image-ocr__[a-f0-9]{64}$/u),
      chatId: input.chatId,
      imageCount: input.imageCount,
      tombstoneTtlMs: admissionLimits.reservationTtlMs,
    });
    expect(telemetry.recordCounter.mock.calls).toEqual([
      ['admission.unavailable'],
      ['admission.suppression.suppressed'],
      ['enqueue.failed'],
    ]);
  });

  it.each([
    ['returns unavailable', jest.fn().mockResolvedValue('unavailable')],
    ['rejects', jest.fn().mockRejectedValue(new Error('suppression timeout'))],
  ])('fails open and records reconciliation when suppression %s', async (_label, suppress) => {
    const queue = { add: jest.fn() };
    const telemetry = metrics();
    const store = admission({
      reserve: jest.fn().mockResolvedValue({ kind: 'unavailable' }),
      suppress,
    });
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config() as never,
      store as never,
      telemetry as never,
    );

    await expect(service.enqueue(input)).resolves.toBe('failed');

    expect(queue.add).not.toHaveBeenCalled();
    expect(store.suppress).toHaveBeenCalledWith({
      jobId: expect.stringMatching(/^commercial-image-ocr__[a-f0-9]{64}$/u),
      chatId: input.chatId,
      imageCount: input.imageCount,
      tombstoneTtlMs: admissionLimits.reservationTtlMs,
    });
    expect(telemetry.recordCounter.mock.calls).toEqual([
      ['admission.unavailable'],
      ['admission.suppression.unavailable'],
      ['enqueue.failed'],
    ]);
  });

  it('records activation and fail-open suppression outcomes', async () => {
    const store = admission({
      activate: jest.fn().mockResolvedValue('expired'),
      suppress: jest.fn().mockResolvedValue('unavailable'),
    });
    const telemetry = metrics();
    const service = new CommercialOcrEnqueueService(
      undefined,
      config() as never,
      store as never,
      telemetry as never,
    );

    await expect(
      service.activatePending({
        jobId: `commercial-image-ocr__${'a'.repeat(64)}`,
        chatId: 'chat-1',
        imageCount: 2,
        reservationTtlMs: 600_000,
      }),
    ).resolves.toBe(false);

    expect(telemetry.recordCounter.mock.calls).toEqual([
      ['admission.activation.expired'],
      ['admission.suppression.unavailable'],
    ]);
  });

  it('queues enforce work as non-actionable data and registers activation for webhook commit', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    const store = admission();
    const pending: unknown[] = [];
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config() as never,
      store as never,
    );

    await expect(
      service.enqueue({
        ...input,
        registerPendingActivation: (activation) => {
          pending.push(activation);
        },
      }),
    ).resolves.toBe('queued');

    expect(store.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ imageCount: 2, actionEligible: true, limits: admissionLimits }),
    );
    const [jobName, data, options] = queue.add.mock.calls[0]!;
    expect(jobName).toBe('commercial-image-ocr-analysis');
    expect(data).toMatchObject({
      webhookEventId: 'event-1',
      chatId: 'chat-1',
      messageId: 'message-1',
      imageCount: 2,
      ocrVersion: COMMERCIAL_OCR_DEFAULT_VERSION,
      actionEligible: false,
      commercialScanRequested: true,
      imageTextScanRequested: false,
      sourceTag: 'commercial-image-ocr',
    });
    expect(JSON.stringify(data)).not.toMatch(/(?:url|token|bytes|base64)/iu);
    expect(options.jobId).toMatch(/^commercial-image-ocr__[a-f0-9]{64}$/u);
    expect(data.idempotencyKey).toBe(options.jobId);
    expect(store.activate).not.toHaveBeenCalled();
    expect(pending).toEqual([
      {
        jobId: options.jobId,
        chatId: 'chat-1',
        imageCount: 2,
        reservationTtlMs: 600_000,
      },
    ]);
  });

  it('keeps behavior identity image-owned when runtime config contains another version', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    const store = admission({
      reserve: jest.fn().mockResolvedValue({ kind: 'admitted', state: 'observation' }),
    });
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config({
        COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow',
        COMMERCIAL_OCR_VERSION: 'runtime-override-must-not-apply',
      }) as never,
      store as never,
    );

    await expect(service.enqueue(input)).resolves.toBe('queued');

    expect(queue.add.mock.calls[0]?.[1]).toMatchObject({
      ocrVersion: COMMERCIAL_OCR_DEFAULT_VERSION,
    });
  });

  it('suppresses enforce work when no canonical webhook collector is provided', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    const store = admission();
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config() as never,
      store as never,
    );

    await expect(service.enqueue(input)).resolves.toBe('queued');

    expect(store.activate).not.toHaveBeenCalled();
    expect(store.suppress).toHaveBeenCalledWith({
      jobId: expect.stringMatching(/^commercial-image-ocr__[a-f0-9]{64}$/u),
      chatId: 'chat-1',
      imageCount: 2,
      tombstoneTtlMs: 600_000,
    });
  });

  it('queues a newly admitted shadow observation without trying to activate it', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    const store = admission({
      reserve: jest.fn().mockResolvedValue({ kind: 'admitted', state: 'observation' }),
    });
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config({ COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow' }) as never,
      store as never,
    );

    await expect(service.enqueue({ ...input, registerPendingActivation: jest.fn() })).resolves.toBe(
      'queued',
    );
    expect(store.reserve).toHaveBeenCalledWith(expect.objectContaining({ actionEligible: false }));
    expect(store.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        limits: { ...admissionLimits, reservedActionableImageUnits: 0 },
      }),
    );
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(store.activate).not.toHaveBeenCalled();
  });

  it('stores a suppression tombstone before any true replay can reserve capacity', async () => {
    const queue = { add: jest.fn() };
    const store = admission();
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config() as never,
      store as never,
    );

    await expect(
      service.enqueue({
        ...input,
        actionEligible: false,
        registerPendingActivation: jest.fn(),
      }),
    ).resolves.toBe('skipped');
    expect(store.suppress).toHaveBeenCalledWith({
      jobId: expect.stringMatching(/^commercial-image-ocr__[a-f0-9]{64}$/u),
      chatId: 'chat-1',
      imageCount: 2,
      tombstoneTtlMs: 600_000,
    });
    expect(store.reserve).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not resurrect queued work after a suppression absorbed the identity', async () => {
    const queue = { add: jest.fn() };
    const store = admission({
      reserve: jest.fn().mockResolvedValue({ kind: 'duplicate', state: 'observation' }),
    });
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config() as never,
      store as never,
    );

    await expect(service.enqueue({ ...input, registerPendingActivation: jest.fn() })).resolves.toBe(
      'skipped',
    );
    expect(queue.add).not.toHaveBeenCalled();
    expect(store.activate).not.toHaveBeenCalled();
  });

  it('skips all Redis and queue work while rollout is off', async () => {
    const queue = { add: jest.fn() };
    const store = admission();
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config({ COMMERCIAL_OCR_ROLLOUT_MODE: 'off' }) as never,
      store as never,
    );

    await expect(service.enqueue({ ...input, registerPendingActivation: jest.fn() })).resolves.toBe(
      'skipped',
    );
    expect(store.reserve).not.toHaveBeenCalled();
    expect(store.suppress).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('queues image stop-list work independently of the commercial OCR rollout', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    const store = admission();
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config({
        COMMERCIAL_OCR_ROLLOUT_MODE: 'off',
        IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE: 'on',
      }) as never,
      store as never,
    );

    await expect(
      service.enqueue({
        ...input,
        commercialScanRequested: false,
        imageTextScanRequested: true,
        registerPendingActivation: jest.fn(),
      }),
    ).resolves.toBe('queued');

    expect(store.reserve).toHaveBeenCalledWith(expect.objectContaining({ actionEligible: true }));
    expect(queue.add).toHaveBeenCalledWith(
      'commercial-image-ocr-analysis',
      expect.objectContaining({
        commercialScanRequested: false,
        imageTextScanRequested: true,
      }),
      expect.any(Object),
    );
  });

  it('keeps the actionable reserve for canary observations', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    const store = admission({
      reserve: jest.fn().mockResolvedValue({ kind: 'admitted', state: 'observation' }),
    });
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config({
        COMMERCIAL_OCR_ROLLOUT_MODE: 'canary',
        COMMERCIAL_OCR_CANARY_CHAT_IDS: 'another-chat',
      }) as never,
      store as never,
    );

    await expect(service.enqueue(input)).resolves.toBe('queued');

    expect(store.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        actionEligible: false,
        limits: admissionLimits,
      }),
    );
  });

  it('allows an explicit zero actionable reserve in canary', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    const store = admission({
      reserve: jest.fn().mockResolvedValue({ kind: 'admitted', state: 'observation' }),
    });
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config({
        COMMERCIAL_OCR_ROLLOUT_MODE: 'canary',
        COMMERCIAL_OCR_CANARY_CHAT_IDS: 'another-chat',
        COMMERCIAL_OCR_RESERVED_ACTIONABLE_IMAGE_UNITS: 0,
      }) as never,
      store as never,
    );

    await expect(service.enqueue(input)).resolves.toBe('queued');

    expect(store.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        actionEligible: false,
        limits: { ...admissionLimits, reservedActionableImageUnits: 0 },
      }),
    );
  });

  it('leaves the job pending and fails open when webhook-time activation cannot be confirmed', async () => {
    const store = admission({ activate: jest.fn().mockResolvedValue('unavailable') });
    const service = new CommercialOcrEnqueueService(undefined, config() as never, store as never);

    await expect(
      service.activatePending({
        jobId: `commercial-image-ocr__${'a'.repeat(64)}`,
        chatId: 'chat-1',
        imageCount: 2,
        reservationTtlMs: 600_000,
      }),
    ).resolves.toBe(false);
    expect(store.activate).toHaveBeenCalledWith({
      jobId: `commercial-image-ocr__${'a'.repeat(64)}`,
      tombstoneTtlMs: 600_000,
    });
    expect(store.suppress).toHaveBeenCalledWith({
      jobId: `commercial-image-ocr__${'a'.repeat(64)}`,
      chatId: 'chat-1',
      imageCount: 2,
      tombstoneTtlMs: 600_000,
    });
  });

  it('suppresses an expired pending reservation to release its capacity', async () => {
    const store = admission({ activate: jest.fn().mockResolvedValue('expired') });
    const service = new CommercialOcrEnqueueService(undefined, config() as never, store as never);

    await expect(
      service.activatePending({
        jobId: `commercial-image-ocr__${'d'.repeat(64)}`,
        chatId: 'chat-1',
        imageCount: 2,
        reservationTtlMs: 600_000,
      }),
    ).resolves.toBe(false);
    expect(store.suppress).toHaveBeenCalledWith({
      jobId: `commercial-image-ocr__${'d'.repeat(64)}`,
      chatId: 'chat-1',
      imageCount: 2,
      tombstoneTtlMs: 600_000,
    });
  });

  it('settles activation batches independently when one activation throws', async () => {
    const store = admission({
      activate: jest
        .fn()
        .mockRejectedValueOnce(new Error('redis timeout'))
        .mockResolvedValueOnce('activated'),
    });
    const service = new CommercialOcrEnqueueService(undefined, config() as never, store as never);
    const activations = [
      {
        jobId: `commercial-image-ocr__${'e'.repeat(64)}`,
        chatId: 'chat-1',
        imageCount: 1,
        reservationTtlMs: 600_000,
      },
      {
        jobId: `commercial-image-ocr__${'f'.repeat(64)}`,
        chatId: 'chat-1',
        imageCount: 1,
        reservationTtlMs: 600_000,
      },
    ];

    await expect(service.activatePendingBatch(activations)).resolves.toBeUndefined();
    expect(store.activate).toHaveBeenCalledTimes(2);
  });

  it('fails open when Queue.add times out and suppression also fails', async () => {
    const queue = { add: jest.fn().mockRejectedValue(new Error('timeout')) };
    const store = admission({ suppress: jest.fn().mockResolvedValue('unavailable') });
    const service = new CommercialOcrEnqueueService(
      queue as never,
      config() as never,
      store as never,
    );

    await expect(service.enqueue({ ...input, registerPendingActivation: jest.fn() })).resolves.toBe(
      'failed',
    );
    expect(store.activate).not.toHaveBeenCalled();
    expect(store.suppress).toHaveBeenCalledWith(
      expect.objectContaining({ tombstoneTtlMs: 600_000 }),
    );
  });

  it('reports a concurrently suppressed commit activation without rearming the identity', async () => {
    const store = admission({ activate: jest.fn().mockResolvedValue('suppressed') });
    const service = new CommercialOcrEnqueueService(undefined, config() as never, store as never);

    await expect(
      service.activatePending({
        jobId: `commercial-image-ocr__${'b'.repeat(64)}`,
        chatId: 'chat-1',
        imageCount: 2,
        reservationTtlMs: 600_000,
      }),
    ).resolves.toBe(false);
    expect(store.activate).toHaveBeenCalledTimes(1);
  });

  it('suppresses a pending admission through the webhook failure path', async () => {
    const store = admission();
    const service = new CommercialOcrEnqueueService(undefined, config() as never, store as never);

    await expect(
      service.suppressPending({
        jobId: `commercial-image-ocr__${'c'.repeat(64)}`,
        chatId: 'chat-1',
        imageCount: 2,
        reservationTtlMs: 600_000,
      }),
    ).resolves.toBe(true);
    expect(store.suppress).toHaveBeenCalledWith({
      jobId: `commercial-image-ocr__${'c'.repeat(64)}`,
      chatId: 'chat-1',
      imageCount: 2,
      tombstoneTtlMs: 600_000,
    });
  });
});
