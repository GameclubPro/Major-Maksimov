import {
  createPublicationExecutionObserver,
  measurePublicationStage,
  recordPublicationDispatchOutcome,
  recordPublicationReceiptTiming,
  recordPublicationWaitTiming,
} from './publication-delivery-timing';
import { beginMaxSendLedgerObservation } from '../max/max-send-observation';
import type { ManagedBroadcastExecutionMedia } from './admin-managed-broadcast-media-runtime';
import { PUBLICATION_UPLOADED_VIDEO_FIELD } from './publication-video-media';

const publicationRow = {
  publicationOccurrenceId: 'private-occurrence',
  publicationContentRevisionId: 'private-frozen-revision',
  actorUserId: 'private-actor',
  mediaType: null,
  imageEnabled: false,
};

function frozenExecutionMedia(mimeTypes: readonly string[] = []): ManagedBroadcastExecutionMedia {
  return {
    requestMedia: {
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      images: [],
      mediaType: null,
      mediaPayload: null,
      mediaMimeType: '',
      mediaFileName: '',
    },
    publicationSource: {
      contentRevisionId: publicationRow.publicationContentRevisionId,
      actorUserId: publicationRow.actorUserId,
      assets: mimeTypes.map((mimeType, index) => ({
        id: `private-asset-${index}`,
        actorUserId: publicationRow.actorUserId,
        sha256: 'a'.repeat(64),
        sizeBytes: 1,
        mimeType,
        fileName: 'private-file',
        durablePayload: null,
      })),
    },
  };
}

describe('Publication delivery timing', () => {
  const scheduledAt = new Date('2026-09-30T10:00:00Z');

  afterEach(() => jest.useRealTimers());

  it.each([
    { mimeTypes: [], expected: 'none' },
    { mimeTypes: ['image/jpeg'], expected: 'image' },
    { mimeTypes: ['image/jpeg', 'image/png'], expected: 'image' },
    { mimeTypes: ['video/mp4'], expected: 'video' },
    { mimeTypes: ['application/octet-stream'], expected: 'unknown' },
    { mimeTypes: [''], expected: 'unknown' },
    { mimeTypes: ['image/jpeg', 'video/mp4'], expected: 'unknown' },
    { mimeTypes: ['video/mp4', 'video/mp4'], expected: 'unknown' },
  ])(
    'uses frozen $mimeTypes media despite empty canonical envelopes',
    async ({ mimeTypes, expected }) => {
      const logger = { log: jest.fn() };
      const observer = createPublicationExecutionObserver(logger, publicationRow, true);
      observer.onOccurrenceScheduledAt(scheduledAt, { mode: 'NOW', intentCreatedAt: scheduledAt });
      expect(observer.dimensions.media).toBe('unknown');
      observer.observeExecutionMedia(frozenExecutionMedia(mimeTypes));
      observer.observeClaim({ attemptCount: 0 });
      await observer.runDispatch('private-action', 'interactive', async () => {
        beginMaxSendLedgerObservation('private-action')('exact_readback');
      });
      observer.observeAcknowledgement();
      observer.observeReceipt();
      const observations = logger.log.mock.calls.map(([event]) => event);
      expect(observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ stage: 'initial_recipient_claim', media: expected }),
          expect.objectContaining({ outcome: 'max_acknowledgement_observed', media: expected }),
          expect.objectContaining({ outcome: 'receipt_persisted', media: expected }),
          expect.objectContaining({ stage: 'ledger_observed_to_recipient', media: expected }),
        ]),
      );
      expect(observations.every((event) => event.media === expected)).toBe(true);
      expect(JSON.stringify(observations)).not.toContain('private');
    },
  );

  it('keeps receipt recovery unknown when media was never loaded', () => {
    const logger = { log: jest.fn() };
    const observer = createPublicationExecutionObserver(logger, publicationRow, true);
    observer.observeClaim({ attemptCount: 1 });
    observer.observeReceipt();
    expect(logger.log.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ outcome: 'receipt_persisted', media: 'unknown' }),
      expect.objectContaining({ stage: 'observed_acknowledgement_to_receipt', media: 'unknown' }),
    ]);
  });

  it.each(['image/jpeg', 'video/mp4'])(
    'classifies copied %s assets from the accepted revision without changing their owner',
    (mimeType) => {
      const execution = frozenExecutionMedia([mimeType]);
      execution.publicationSource!.assets[0]!.actorUserId = 'original-author';
      const observer = createPublicationExecutionObserver({ log: jest.fn() }, publicationRow, true);
      observer.observeExecutionMedia(execution);
      expect(observer.dimensions.media).toBe(mimeType.startsWith('image/') ? 'image' : 'video');
    },
  );

  it('refuses missing, mismatched and contradictory frozen metadata without legacy fallback', () => {
    const observer = createPublicationExecutionObserver({ log: jest.fn() }, publicationRow, true);
    const execution = frozenExecutionMedia(['image/jpeg']);
    const source = execution.publicationSource!;
    for (const media of [
      { requestMedia: execution.requestMedia },
      { ...execution, publicationSource: { ...source, contentRevisionId: 'different-revision' } },
      { ...execution, publicationSource: { ...source, actorUserId: 'different-actor' } },
      {
        ...execution,
        publicationSource: {
          ...source,
          assets: [{ ...source.assets[0]!, actorUserId: '' }],
        },
      },
      {
        ...execution,
        publicationSource: {
          ...source,
          assets: [{ ...source.assets[0]!, durablePayload: { token: 'private-video-token' } }],
        },
      },
      {
        ...execution,
        publicationSource: {
          ...source,
          assets: [{ ...source.assets[0]!, durablePayload: 'invalid' }],
        },
      },
      {
        ...execution,
        publicationSource: {
          ...source,
          assets: [
            {
              ...source.assets[0]!,
              mimeType: 'application/octet-stream',
              durablePayload: {},
            },
          ],
        },
      },
      {
        ...execution,
        publicationSource: {
          ...source,
          assets: [{ ...source.assets[0]!, sizeBytes: 0 }],
        },
      },
      {
        ...execution,
        publicationSource: {
          ...source,
          assets: Array.from({ length: 11 }, () => source.assets[0]!),
        },
      },
    ] satisfies ManagedBroadcastExecutionMedia[]) {
      observer.observeExecutionMedia(media);
      expect(observer.dimensions.media).toBe('unknown');
    }
  });

  it.each(['video/mp4', 'application/octet-stream'])(
    'classifies a frozen %s video with a retained token without exposing it',
    (mimeType) => {
      const logger = { log: jest.fn() };
      const observer = createPublicationExecutionObserver(logger, publicationRow, true);
      const execution = frozenExecutionMedia([mimeType]);
      const source = execution.publicationSource!;
      observer.observeExecutionMedia({
        ...execution,
        publicationSource: {
          ...source,
          assets: [{ ...source.assets[0]!, durablePayload: { token: 'private-video-token' } }],
        },
      });
      observer.observeAcknowledgement();
      expect(logger.log.mock.calls[0]![0]).toMatchObject({ media: 'video' });
      expect(JSON.stringify(logger.log.mock.calls)).not.toContain('private');
    },
  );

  it.each([
    {},
    { token: ' ' },
    { token: 123 },
    { arbitrary: 'private-value' },
    {
      [PUBLICATION_UPLOADED_VIDEO_FIELD]: {
        version: 1,
        botId: 'publisher',
        token: 'private-token',
      },
    },
    { token: 'private-token', [PUBLICATION_UPLOADED_VIDEO_FIELD]: {} },
  ])(
    'keeps opaque metadata with insufficient or tagged token evidence unknown: %j',
    (durablePayload) => {
      const observer = createPublicationExecutionObserver({ log: jest.fn() }, publicationRow, true);
      const execution = frozenExecutionMedia(['application/octet-stream']);
      const source = execution.publicationSource!;
      observer.observeExecutionMedia({
        ...execution,
        publicationSource: { ...source, assets: [{ ...source.assets[0]!, durablePayload }] },
      });
      expect(observer.dimensions.media).toBe('unknown');
    },
  );

  it('uses loaded legacy request media only without a canonical revision', () => {
    const canonical = createPublicationExecutionObserver({ log: jest.fn() }, publicationRow, true);
    const legacy = createPublicationExecutionObserver(
      { log: jest.fn() },
      { ...publicationRow, publicationContentRevisionId: null },
      true,
    );
    const empty = frozenExecutionMedia().requestMedia;
    for (const [requestMedia, expected] of [
      [empty, 'none'],
      [{ ...empty, imageEnabled: true, imageBase64: 'AA==', imageMimeType: 'image/jpeg' }, 'image'],
      [{ ...empty, mediaType: 'video', mediaPayload: { token: 'private-video' } }, 'video'],
      [{ ...empty, mediaType: 'video', mediaPayload: {} }, 'unknown'],
    ] satisfies Array<[ManagedBroadcastExecutionMedia['requestMedia'], string]>) {
      legacy.observeExecutionMedia({ requestMedia });
      canonical.observeExecutionMedia({ requestMedia });
      expect(legacy.dimensions.media).toBe(expected);
      expect(canonical.dimensions.media).toBe('unknown');
    }
    legacy.observeExecutionMedia(frozenExecutionMedia());
    expect(legacy.dimensions.media).toBe('unknown');
  });

  it('keeps failed media observation out of dispatch control flow and clears stale evidence', async () => {
    const observer = createPublicationExecutionObserver({ log: jest.fn() }, publicationRow, true);
    observer.observeExecutionMedia(frozenExecutionMedia(['image/jpeg']));
    expect(observer.dimensions.media).toBe('image');
    const media = frozenExecutionMedia(['video/mp4']);
    Object.defineProperty(media, 'publicationSource', {
      get: () => {
        throw new Error('unavailable');
      },
    });
    expect(() => observer.observeExecutionMedia(media)).not.toThrow();
    expect(observer.dimensions.media).toBe('unknown');
    const result = {};
    await expect(
      observer.runDispatch('private-action', 'interactive', async () => result),
    ).resolves.toBe(result);
  });

  it('observes only the current recipient persistence and preserves recovered provenance', async () => {
    const logger = { log: jest.fn() };
    const observer = createPublicationExecutionObserver(logger, publicationRow, true);
    observer.observeExecutionMedia(frozenExecutionMedia());
    observer.onOccurrenceScheduledAt(scheduledAt, { mode: 'NOW', intentCreatedAt: scheduledAt });
    observer.observeClaim({ attemptCount: 0 });
    await observer.runDispatch('private-action', 'interactive', async () => {
      beginMaxSendLedgerObservation('private-action')('exact_readback');
    });
    observer.observeReceipt();
    observer.observeClaim({ attemptCount: 1 });
    await observer.runDispatch('other-action', 'background', async () => undefined);
    observer.observeReceipt();
    const exact = logger.log.mock.calls
      .map(([event]) => event)
      .filter((event) => event.metric === 'publication_send_v1');
    expect(exact.filter((event) => event.stage === 'http')).toEqual([]);
    expect(exact.filter((event) => event.stage === 'ledger_observed_to_recipient')).toEqual([
      expect.objectContaining({ outcome: 'cas_committed', mode: 'NOW', lane: 'interactive' }),
      expect.objectContaining({
        outcome: 'source_unavailable',
        durationMs: null,
        lane: 'background',
      }),
    ]);
    expect(JSON.stringify(exact)).not.toContain('private');
  });

  it('distinguishes the original first claim clock from a persisted retry due time', () => {
    jest.useFakeTimers().setSystemTime(new Date(scheduledAt.getTime() + 12_000));
    const logger = { log: jest.fn() };
    const observer = createPublicationExecutionObserver(logger, publicationRow, true);
    observer.observeExecutionMedia(frozenExecutionMedia(['video/mp4']));
    observer.onOccurrenceScheduledAt(new Date(scheduledAt.getTime() + 60_000), {
      mode: 'NOW',
      intentCreatedAt: scheduledAt,
    });
    observer.observeClaim({ attemptCount: 0, capacityDeferralCount: 0 });
    observer.observeClaim({
      attemptCount: 0,
      capacityDeferralCount: 1,
      nextAttemptAt: new Date(scheduledAt.getTime() + 10_000),
      waitReason: 'local_capacity',
    });
    expect(logger.log.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        stage: 'initial_recipient_claim',
        mode: 'NOW',
        media: 'video',
        durationMs: 12_000,
      }),
      expect.objectContaining({
        stage: 'recipient_retry_lateness',
        reason: 'local_capacity',
        durationMs: 2_000,
      }),
    ]);
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('private');
  });

  it('does not carry a previous recipient acknowledgement into a recovery receipt', () => {
    jest.useFakeTimers().setSystemTime(scheduledAt);
    const logger = { log: jest.fn() };
    const observer = createPublicationExecutionObserver(logger, publicationRow, true);
    observer.observeExecutionMedia(frozenExecutionMedia(['image/jpeg']));
    observer.onOccurrenceScheduledAt(scheduledAt, { mode: 'ONCE', intentCreatedAt: scheduledAt });
    observer.observeClaim({ attemptCount: 0 });
    observer.observeAcknowledgement();
    jest.advanceTimersByTime(250);
    observer.observeReceipt();
    observer.observeClaim({ attemptCount: 1 });
    jest.advanceTimersByTime(1_000);
    observer.observeReceipt();
    const receiptIntervals = logger.log.mock.calls
      .map(([event]) => event)
      .filter((event) => event.stage === 'observed_acknowledgement_to_receipt');
    expect(receiptIntervals).toEqual([
      expect.objectContaining({ durationMs: 250, clock: 'wall', media: 'image' }),
      expect.objectContaining({ durationMs: null, clock: 'unknown' }),
    ]);
  });

  it.each([null, new Date('invalid'), new Date(scheduledAt.getTime() + 1)])(
    'preserves unknown interval evidence for absent, invalid or backwards clocks: %s',
    (from) => {
      const logger = { log: jest.fn() };
      recordPublicationWaitTiming(logger, {
        stage: 'recipient_retry_lateness',
        from,
        to: scheduledAt,
        reason: 'private-user-content',
      });
      expect(logger.log.mock.calls[0]![0]).toMatchObject({
        durationMs: null,
        clock: 'unknown',
        reason: 'unknown',
      });
      expect(JSON.stringify(logger.log.mock.calls)).not.toContain('private');
    },
  );

  it('keeps failing logger and date accessors outside dispatch control flow', () => {
    const logger = {
      get log(): never {
        throw new Error('logger unavailable');
      },
    };
    const invalidClock = new Date();
    invalidClock.getTime = () => {
      throw new Error('clock unavailable');
    };
    expect(() =>
      recordPublicationWaitTiming(logger, {
        stage: 'wakeup_queue',
        from: scheduledAt,
        to: scheduledAt,
      }),
    ).not.toThrow();
    expect(() =>
      recordPublicationWaitTiming(
        { log: jest.fn() },
        {
          stage: 'wakeup_queue',
          from: invalidClock,
          to: scheduledAt,
        },
      ),
    ).not.toThrow();
  });

  it('emits no execution observations for a disabled or non-publication observer', () => {
    const logger = { log: jest.fn() };
    for (const [enabled, publicationOccurrenceId] of [
      [false, 'occurrence'],
      [true, null],
    ] as const) {
      const observer = createPublicationExecutionObserver(
        logger,
        {
          ...publicationRow,
          publicationOccurrenceId,
        },
        enabled,
      );
      observer.observeClaim({ attemptCount: 0 });
      observer.observeAcknowledgement();
      observer.observeReceipt();
    }
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('observes failures without swallowing the error or leaking its content', async () => {
    const logger = { log: jest.fn() };
    const failure = new Error('private target and content');
    await expect(
      measurePublicationStage(logger, 'target_preparation', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(logger.log.mock.calls[0]![0]).toMatchObject({
      metric: 'publication_stage_v1',
      stage: 'target_preparation',
      outcome: 'threw',
    });
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('private');
  });

  it('keeps the original work pending and preserves its result despite logging failure', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const logger = {
      log: jest.fn(() => {
        throw new Error('logger down');
      }),
    };
    const settled = jest.fn();
    const work = measurePublicationStage(
      logger,
      'dispatch_quantum',
      async () => {
        await gate;
        return 42;
      },
      'deadline',
    );
    void work.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
    release();
    await expect(work).resolves.toBe(42);
  });

  it('measures scheduled delivery through durable receipt persistence with fixed labels', () => {
    const logger = { log: jest.fn() };
    recordPublicationReceiptTiming(logger, {
      mode: 'RECURRENCE',
      media: 'image',
      scheduledAt,
      receiptPersistedAt: new Date(scheduledAt.getTime() + 12_000),
    });
    expect(logger.log).toHaveBeenCalledWith(
      {
        metric: 'publication_delivery_v1',
        scope: 'delivery',
        outcome: 'receipt_persisted',
        mode: 'RECURRENCE',
        media: 'image',
        clock: 'scheduled_at',
        durationMs: 12_000,
        latencyBucket: 'le_15000ms',
      },
      'Publication delivery observation',
    );
  });

  it('keeps NOW on the original intent clock rather than a retried nextSendAt', () => {
    const logger = { log: jest.fn() };
    recordPublicationReceiptTiming(logger, {
      mode: 'NOW',
      media: 'video',
      scheduledAt: new Date(scheduledAt.getTime() + 7_200_000),
      intentCreatedAt: scheduledAt,
      receiptPersistedAt: new Date(scheduledAt.getTime() + 7_201_000),
    });
    expect(logger.log.mock.calls[0]![0]).toMatchObject({
      clock: 'intent_created_at',
      durationMs: 7_201_000,
      latencyBucket: 'over_300000ms',
    });
  });

  it.each([null, new Date('invalid'), new Date(scheduledAt.getTime() + 1_000)])(
    'reports unknown timing rather than zero latency for %s',
    (reference) => {
      const logger = { log: jest.fn() };
      recordPublicationReceiptTiming(logger, {
        mode: 'ONCE',
        media: 'none',
        scheduledAt: reference,
        receiptPersistedAt: scheduledAt,
      });
      expect(logger.log.mock.calls[0]![0]).toMatchObject({
        clock: 'unknown',
        durationMs: null,
        latencyBucket: 'unknown',
      });
    },
  );

  it('normalizes arbitrary blocker details and separates deferrals from occurrence outcomes', () => {
    const logger = { log: jest.fn() };
    recordPublicationDispatchOutcome(logger, {
      scope: 'deferral',
      outcome: 'blocked',
      reason: 'secret-user-123',
    });
    recordPublicationDispatchOutcome(logger, {
      mode: 'ONCE',
      scope: 'occurrence',
      outcome: 'missed_window',
    });
    expect(logger.log.mock.calls[0]![0]).toMatchObject({ scope: 'deferral', reason: 'other' });
    expect(logger.log.mock.calls[1]![0]).toMatchObject({
      scope: 'occurrence',
      outcome: 'missed_window',
      reason: 'window_expired',
    });
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('secret-user');
  });

  it('cannot turn a logging outage into a delivery error after the receipt commit', () => {
    const logger = {
      log: jest.fn(() => {
        throw new Error('logging unavailable');
      }),
    };
    expect(() =>
      recordPublicationReceiptTiming(logger, {
        mode: 'ONCE',
        media: 'none',
        scheduledAt,
        receiptPersistedAt: scheduledAt,
      }),
    ).not.toThrow();
    expect(() =>
      recordPublicationDispatchOutcome(logger, {
        scope: 'deferral',
        outcome: 'blocked',
        reason: 'bot_access_expired',
      }),
    ).not.toThrow();
  });
});
