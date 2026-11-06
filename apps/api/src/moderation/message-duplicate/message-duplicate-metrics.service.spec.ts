import { Logger } from '@nestjs/common';
import {
  MESSAGE_DUPLICATE_METRIC_COUNTERS,
  MESSAGE_DUPLICATE_PHASES,
  MessageDuplicateMetricsService,
  type MessageDuplicateMetricCounter,
  measureDuplicatePhase,
} from './message-duplicate-metrics.service';
import {
  duplicateTelemetryKey,
  DUPLICATE_TELEMETRY_BUCKET_MS,
} from './message-duplicate-telemetry';

describe('privacy-safe message duplicate diagnostics', () => {
  let service: MessageDuplicateMetricsService;
  let log: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    service = new MessageDuplicateMetricsService();
  });
  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('aggregates attempts without per-message logging or idle timers', () => {
    expect(jest.getTimerCount()).toBe(0);
    for (let index = 0; index < 10_000; index += 1) service.record('history.matched');
    service.record('worker.retry');
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(29_999);
    expect(log).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({
      event: 'message_duplicate_diagnostics',
      schemaVersion: 2,
      windowStartedAt: expect.any(String),
      windowEndedAt: expect.any(String),
      counters: { 'history.matched': 10_000, 'worker.retry': 1 },
      phases: {},
      phaseBucketUpperBoundsMs: expect.any(Array),
    });
    jest.advanceTimersByTime(300_000);
    expect(log).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    service.record('history.matched');
    jest.advanceTimersByTime(30_000);
    expect(log.mock.calls[1]?.[0].counters).toEqual({ 'history.matched': 1 });
  });

  it('rejects arbitrary dimensions and never logs an unknown error verbatim', () => {
    for (let index = 0; index < 10_000; index += 1)
      service.record(`private-${index}` as MessageDuplicateMetricCounter);
    service.recordContentRejection('https://private.example/message');
    expect(jest.getTimerCount()).toBe(0);
    service.recordGuardRejection('secret free-form error');
    service.recordGuardRejection('message_duplicate_content_changed');
    service.recordGuardRejection('message_duplicate_sanction_delete_unconfirmed');
    service.recordGuardRejection('message_duplicate_sanction_source_unavailable');
    service.recordContentRejection('split_album');
    jest.advanceTimersByTime(30_000);
    expect(log.mock.calls[0]?.[0].counters).toEqual({
      'guard.other_rejection': 1,
      'guard.message_duplicate_content_changed': 1,
      'guard.message_duplicate_sanction_delete_unconfirmed': 1,
      'guard.message_duplicate_sanction_source_unavailable': 1,
      'content.split_album': 1,
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|secret|https/);
    expect(new Set(MESSAGE_DUPLICATE_METRIC_COUNTERS).size).toBe(
      MESSAGE_DUPLICATE_METRIC_COUNTERS.length,
    );
  });

  it('flushes once at shutdown and refuses new timers after destruction', () => {
    service.record('worker.completed');
    service.onModuleDestroy();
    service.onModuleDestroy();
    service.record('worker.started');
    expect(log).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('aggregates fixed scheduling causes while rejecting private reason and error dimensions', () => {
    service.record('worker.defer_ordering');
    service.record('worker.defer_ordering_not_head');
    service.record('worker.wakeup_unavailable');
    service.record('worker.wakeup_not_delayed');
    service.record('worker.wakeup_lookup_missing');
    service.record('worker.defer_ordering_private-chat' as MessageDuplicateMetricCounter);
    service.record('worker.wakeup_private-error' as MessageDuplicateMetricCounter);
    jest.advanceTimersByTime(30_000);
    expect(log.mock.calls[0]?.[0].counters).toEqual({
      'worker.defer_ordering': 1,
      'worker.defer_ordering_not_head': 1,
      'worker.wakeup_unavailable': 1,
      'worker.wakeup_not_delayed': 1,
      'worker.wakeup_lookup_missing': 1,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
  });

  it('does not propagate logging failure into moderation or shutdown', () => {
    log.mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    service.record('history.matched');
    expect(() => jest.advanceTimersByTime(30_000)).not.toThrow();
    service.record('worker.retry');
    expect(() => service.onModuleDestroy()).not.toThrow();
  });

  it('records monotonic phase duration on success and failure without replacing the original error', async () => {
    const clock = jest
      .spyOn(performance, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(30)
      .mockReturnValueOnce(280);
    await expect(measureDuplicatePhase(service, 'history', async () => 42)).resolves.toBe(42);
    const original = new Error('original private failure');
    await expect(
      measureDuplicatePhase(service, 'media', async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    clock.mockRestore();
    jest.advanceTimersByTime(30_000);
    expect(log.mock.calls[0]?.[0].phases).toMatchObject({
      history: { count: 1, totalMs: 10, maxMs: 10 },
      media: { count: 1, totalMs: 250, maxMs: 250 },
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
    jest.spyOn(service, 'recordPhase').mockImplementation(() => {
      throw new Error('telemetry failure');
    });
    await expect(
      measureDuplicatePhase(service, 'history', async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it('aggregates every fixed phase including pair work and rejects private phase labels', () => {
    for (const phase of MESSAGE_DUPLICATE_PHASES) service.recordPhase(phase, 6);
    service.recordPhase('private-image-url' as (typeof MESSAGE_DUPLICATE_PHASES)[number], 6);
    jest.advanceTimersByTime(30_000);
    const phases = log.mock.calls[0]?.[0].phases;
    expect(Object.keys(phases).sort()).toEqual([...MESSAGE_DUPLICATE_PHASES].sort());
    for (const phase of MESSAGE_DUPLICATE_PHASES) {
      expect(phases[phase]).toMatchObject({ count: 1, totalMs: 6, maxMs: 6 });
      expect(phases[phase].buckets.reduce((sum: number, count: number) => sum + count, 0)).toBe(1);
    }
  });

  it('keeps absence, failure and zero coverage distinct across distributed buckets', async () => {
    const stored = new Map<string, string>();
    service = new MessageDuplicateMetricsService({
      getString: jest.fn(async (key) => stored.get(key) ?? null),
    } as never);
    expect(await service.readObservations('chat')).toMatchObject({
      state: 'NO_DATA',
      coverage: null,
      supportedAttempts: null,
    });
    const key = duplicateTelemetryKey(
      'chat',
      Math.floor(Date.now() / DUPLICATE_TELEMETRY_BUCKET_MS),
    );
    stored.set(key, JSON.stringify({ supported: 2, COMPARISON_FAILED: 2 }));
    expect(await service.readObservations('chat')).toMatchObject({
      state: 'AVAILABLE',
      coverage: 0,
      supportedAttempts: 2,
      verifiedAttempts: 0,
    });
    stored.set(key, JSON.stringify({ supported: 2, verified: 3 }));
    expect(await service.readObservations('chat')).toMatchObject({
      state: 'UNAVAILABLE',
      coverage: null,
      supportedAttempts: null,
    });
    stored.set(key, JSON.stringify({ 'private-dimension': 1 }));
    expect(await service.readObservations('chat')).toMatchObject({
      state: 'UNAVAILABLE',
      outcomes: [],
    });
  });

  it('bounds buffered chat buckets and keeps blocked writes out of the moderation path', async () => {
    const merge = jest.fn(() => new Promise<void>(() => {}));
    service = new MessageDuplicateMetricsService({ mergeDuplicateTelemetry: merge } as never);
    for (let index = 0; index < 10_000; index += 1)
      service.recordObservation(`private-chat-${index}`, 'COMPARISON_FAILED', true);
    jest.advanceTimersByTime(30_000);
    expect(merge).toHaveBeenCalledTimes(4);
    expect(log.mock.calls[0]?.[0].counters).toEqual({
      'telemetry.buffer_limited': 9488,
      'telemetry.observations_lost': 9488,
    });
    for (let index = 0; index < 1000; index += 1)
      service.recordObservation(`other-${index}`, 'COMPARED_NO_MATCH', true);
    jest.advanceTimersByTime(30_000);
    expect(merge).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-chat|other-/);
    expect(JSON.stringify(merge.mock.calls)).not.toMatch(/private-chat|other-/);
  });

  it('aggregates fixed outcomes without recording a queued media handoff as a completed check', async () => {
    const merge = jest.fn().mockResolvedValue(undefined);
    service = new MessageDuplicateMetricsService({ mergeDuplicateTelemetry: merge } as never);
    service.recordObservation('chat', 'MEDIA_QUEUED', false);
    service.recordObservation('chat', 'DEFERRED', true);
    service.recordObservation('chat', 'COMPARED_NO_MATCH', true);
    service.recordObservation('chat', 'MATCHED_QUALIFICATION_REJECTED', true);
    service.recordObservation('chat', 'MATCHED_CLAIM_BLOCKED', true);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge.mock.calls[0]?.[1]).toEqual({
      MEDIA_QUEUED: 1,
      DEFERRED: 1,
      COMPARED_NO_MATCH: 1,
      MATCHED_QUALIFICATION_REJECTED: 1,
      MATCHED_CLAIM_BLOCKED: 1,
      supported: 4,
      verified: 3,
    });
  });
});
