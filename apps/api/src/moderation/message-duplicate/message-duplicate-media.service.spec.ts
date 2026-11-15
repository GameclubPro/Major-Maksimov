import type { MessageDuplicateEnforcementService } from './message-duplicate-enforcement.service';
import { MaxBotContextService } from '../../max/max-bot-context.service';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  MessageDuplicateMediaService,
  MessageDuplicateMediaDeferredError,
} from './message-duplicate-media.service';
import {
  messageDuplicateSettingsDigest,
  exactImageSettingsDigest,
} from './message-duplicate-state';
import {
  duplicateSettings,
  duplicateUpdate,
  preUnicodeNearSettingsDigests,
  preSafeTextSettingsDigests,
  preV3HistorySettingsDigests,
} from './message-duplicate-test-fixtures';
import type { MessageDuplicateJob } from './message-duplicate.queue';
import {
  PhotoDownloadHttpError,
  PhotoDownloadSourceRejectedError,
  PhotoDownloadByteLimitExceededError,
  PhotoDownloadFormatRejectedError,
  PhotoDownloadTimeoutError,
} from '../photo-duplicate/secure-photo-downloader';
import {
  PHOTO_FINGERPRINT_ALGORITHM_VERSION,
  PhotoNativeUnavailableError,
} from '../photo-duplicate/photo-fingerprint';
import type { PhotoDuplicateAnalysisService } from '../photo-duplicate/photo-duplicate-analysis.service';
import type { RedisCounterService } from '../redis-counter.service';
import { UnrecoverableError } from 'bullmq';
import { WebhookPreparationDeferredError } from '../../common/webhook-preparation-deferred.error';
import { PhotoDuplicateSourceNotReadyError } from '../photo-duplicate/photo-duplicate.queue';

function setup(config: Record<string, unknown> = {}) {
  const settings = { ...duplicateSettings(), chat: { entityType: 'CHAT', admins: [] } };
  const now = Date.now() - 10000;
  const rows = new Map<string, unknown>();
  const cache = new Map<string, string>();
  const redis = {
    getString: jest.fn(async (key: string) => cache.get(key) ?? null),
    getStrings: jest.fn(async (keys: string[]) => keys.map((key) => cache.get(key) ?? null)),
    setStringWithTtl: jest.fn(async (key: string, value: string) => {
      cache.set(key, value);
    }),
    setStringIfAbsentWithTtl: jest.fn(async (key: string, value: string) => {
      if (cache.has(key)) return false;
      cache.set(key, value);
      return true;
    }),
    admitDuplicateHeavyStart: jest
      .fn()
      .mockResolvedValue({ kind: 'granted', startedAtMs: Date.now() }),
    duplicateRecompressionIndex: jest
      .fn<
        ReturnType<RedisCounterService['duplicateRecompressionIndex']>,
        Parameters<RedisCounterService['duplicateRecompressionIndex']>
      >()
      .mockResolvedValue('{"candidates":[],"saturated":false}'),
  };
  const prisma = {
    webhookEvent: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id)),
    },
    chatSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
  };
  const photos = {
    fingerprintAlbum: jest.fn<
      ReturnType<PhotoDuplicateAnalysisService['fingerprintAlbum']>,
      Parameters<PhotoDuplicateAnalysisService['fingerprintAlbum']>
    >(),
  };
  const policy = {
    resolve: jest.fn().mockResolvedValue({
      mode: 'delete_only',
      revision: 1,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    }),
  };
  const observe = jest.fn().mockResolvedValue(null);
  const history = {
    candidateKeys: jest.fn().mockReturnValue(['caption']),
    observe,
    observeWithOutcome: jest.fn(async (input) => {
      const match = await observe(input);
      return { match, outcome: match ? 'MATCHED' : 'COMPARED_NO_MATCH' };
    }),
  };
  const enforcement = {
    selectMatch: jest.fn(
      async ({ observation }: Parameters<MessageDuplicateEnforcementService['selectMatch']>[0]) =>
        observation.match,
    ),
    enqueue: jest.fn().mockResolvedValue({ kind: 'intent_accepted', intentId: 'intent' }),
  };
  const bots = {
    isKnownBotUserId: jest.fn().mockReturnValue(false),
    getDefaultBotId: () => 'bot',
    resolveExecutableBotId: jest.fn((botId: string) => (botId === 'publisher' ? null : botId)),
  };
  const botContext = new MaxBotContextService();
  const governor = { decide: jest.fn().mockResolvedValue({ action: 'allow' }) };
  const max = { getExactMessageRow: jest.fn() };
  const metrics = { record: jest.fn(), recordObservation: jest.fn(), recordPhase: jest.fn() };
  const legacyHolds = { isUpdateHeld: jest.fn().mockResolvedValue(false) };
  const service = new MessageDuplicateMediaService(
    prisma as never,
    redis as never,
    photos as never,
    policy as never,
    history as never,
    enforcement as never,
    bots as never,
    governor as never,
    new ConfigService(config),
    max as never,
    botContext,
    metrics as never,
    undefined,
    legacyHolds as never,
  );
  const downloads = jest.fn(async (url: string) => ({
    bytes: Buffer.from(url.endsWith('b') ? 'different' : 'same'),
  }));
  Object.defineProperty(service, 'binary', { value: { downloadBinary: downloads } });
  const binaryVerifier = service as unknown as {
    verifyBinary: (bytes: Buffer, kind: string) => Promise<void>;
  };
  const actualVerifyBinary = binaryVerifier.verifyBinary.bind(service);
  const verifyBinary = jest.spyOn(binaryVerifier, 'verifyBinary').mockResolvedValue();
  const lease = {
    assertOwned: jest.fn(),
    resolveActionEligibility: jest.fn().mockResolvedValue(true),
  };
  const job = (
    id: string,
    timestamp: number,
    resource = 'a',
    messageId = id,
  ): MessageDuplicateJob => {
    const update = duplicateUpdate(messageId, now + timestamp, 'caption', [
      {
        type: 'file',
        payload: {
          id: 'same-untrusted-id',
          filename: 'same.pdf',
          size: 4,
          url: `https://fd.oneme.ru/${resource}`,
        },
      },
    ]);
    rows.set(id, {
      status: 'PROCESSED',
      normalizedPayload: update,
      botId: 'bot',
      nextEnqueueAt: null,
    });
    return {
      version: 2,
      webhookEventId: id,
      chatId: '-123',
      messageId,
      eventTimestampMs: now + timestamp,
      sourceCreatedAt: new Date(now + timestamp).toISOString(),
      createdAt: new Date().toISOString(),
      controlRevision: 1,
      policyRevision: settings.duplicatePolicyRevision,
      deadlineAtMs: now + timestamp + 600_000,
      settingsDigest: messageDuplicateSettingsDigest(settings),
      actionEligible: true,
      idempotencyKey: `message-duplicate__${'a'.repeat(64)}`,
    };
  };
  return {
    service,
    legacyHolds,
    botContext,
    bots,
    settings,
    rows,
    cache,
    redis,
    history,
    downloads,
    lease,
    job,
    governor,
    enforcement,
    policy,
    photos,
    max,
    verifyBinary,
    actualVerifyBinary,
    metrics,
  };
}

describe('bounded message duplicate media analysis', () => {
  it('defers an immediate TEXT job until its source is processed, then resumes without media work', async () => {
    const s = setup();
    const job = s.job('text-source', 0);
    job.comparison = 'TEXT';
    const row = s.rows.get(job.webhookEventId) as { status: string };
    row.status = 'PROCESSING';
    await expect(s.service.process(job, s.lease)).rejects.toBeInstanceOf(
      PhotoDuplicateSourceNotReadyError,
    );
    expect(s.history.observe).not.toHaveBeenCalled();
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
    row.status = 'PROCESSED';
    expect(await s.service.process(job, s.lease)).toBe('COMPARED_NO_MATCH');
    expect(s.history.observe).toHaveBeenCalledTimes(1);
    expect(s.downloads).not.toHaveBeenCalled();
    expect(s.photos.fingerprintAlbum).not.toHaveBeenCalled();
  });

  it.each(['NO_REPLAY_HELD', 'FAILED', 'PROCESSED'] as const)(
    'settles a permanently held %s source and leaves independent media runnable',
    async (status) => {
      const s = setup();
      const held = s.job('held-source', 0);
      const row = s.rows.get(held.webhookEventId) as Record<string, unknown>;
      row.status = status;
      row.errorMessage = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:legacy: timeout';
      s.legacyHolds.isUpdateHeld.mockImplementation(
        async (update) => update.message.messageId === 'held-source',
      );
      expect(await s.service.process(held, s.lease)).toBe('SOURCE_UNAVAILABLE');
      expect(s.downloads).not.toHaveBeenCalled();
      expect(s.photos.fingerprintAlbum).not.toHaveBeenCalled();
      expect(s.history.observe).not.toHaveBeenCalled();
      expect(s.enforcement.enqueue).not.toHaveBeenCalled();
      expect(await s.service.process(s.job('independent', 100), s.lease)).toBe('MEDIA_CANDIDATE');
      await s.service.process(s.job('independent-next', 200), s.lease);
      expect(s.downloads).toHaveBeenCalled();
      expect(s.history.observe).toHaveBeenCalled();
    },
  );

  it.each(['STANDARD', 'STRICT', 'CUSTOM_NEAR', 'CUSTOM_PHONE', 'IMAGE'] as const)(
    'rejects a pre-v3 %s job before any source or native work',
    async (preset) => {
      const s = setup();
      s.settings.duplicateDetectionPreset =
        preset === 'CUSTOM_NEAR' || preset === 'CUSTOM_PHONE'
          ? 'CUSTOM'
          : preset === 'IMAGE'
            ? 'STANDARD'
            : preset;
      s.settings.duplicateNearMatchEnabled = preset === 'CUSTOM_NEAR';
      s.settings.duplicateIgnorePhonesEnabled = preset === 'CUSTOM_PHONE';
      const job = s.job('old-v2-history', 0);
      if (preset === 'IMAGE') {
        job.comparison = 'IMAGE';
        s.policy.resolve.mockResolvedValue({
          mode: 'full',
          revision: 1,
          expiresAtMs: Number.MAX_SAFE_INTEGER,
        });
      }
      job.settingsDigest = preV3HistorySettingsDigests[preset];
      expect(await s.service.process(job, s.lease)).toBe('SETTINGS_CHANGED');
      expect(s.downloads).not.toHaveBeenCalled();
      expect(s.photos.fingerprintAlbum).not.toHaveBeenCalled();
      expect(s.enforcement.enqueue).not.toHaveBeenCalled();
    },
  );
  it.each(['STRICT', 'CUSTOM_NEAR', 'CUSTOM_PHONE'] as const)(
    'rejects pre-safe-text %s settings before any download or native work',
    async (preset) => {
      const s = setup();
      s.settings.duplicateDetectionPreset = preset === 'STRICT' ? 'STRICT' : 'CUSTOM';
      s.settings.duplicateNearMatchEnabled = preset === 'CUSTOM_NEAR';
      s.settings.duplicateIgnorePhonesEnabled = preset === 'CUSTOM_PHONE';
      const job = s.job('old-safe-text', 0);
      job.settingsDigest = preSafeTextSettingsDigests[preset];
      expect(await s.service.process(job, s.lease)).toBe('SETTINGS_CHANGED');
      expect(s.downloads).not.toHaveBeenCalled();
      expect(s.photos.fingerprintAlbum).not.toHaveBeenCalled();
      expect(s.enforcement.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['qualification_rejected', 'MATCHED_QUALIFICATION_REJECTED'],
    ['claim_blocked', 'MATCHED_CLAIM_BLOCKED'],
    ['policy_changed', 'POLICY_CHANGED'],
    ['binding_invalid', 'MATCHED_INELIGIBLE'],
  ] as const)(
    'reports an actual %s action refusal instead of accepted intent',
    async (reason, outcome) => {
      const s = setup();
      await s.service.process(s.job('first', 0), s.lease);
      s.history.observe.mockResolvedValue({
        hit: {},
        binding: { eventTimestampMs: Date.now() - 1000 },
      });
      s.enforcement.enqueue.mockResolvedValue({ kind: 'rejected', reason });
      expect(await s.service.process(s.job('repeat', 100), s.lease)).toBe(outcome);
      expect(s.metrics.recordObservation).toHaveBeenLastCalledWith('-123', outcome, true);
    },
  );

  it('measures pre-head wait once and keeps pure cached comparisons outside heavy pressure', async () => {
    const s = setup();
    const first = s.job('first', 0);
    first.idempotencyKey = `message-duplicate__${'1'.repeat(64)}`;
    const repeat = s.job('repeat', 100);
    repeat.idempotencyKey = `message-duplicate__${'2'.repeat(64)}`;
    await s.service.process(first, s.lease);
    await s.service.process(repeat, s.lease);
    expect(s.downloads).toHaveBeenCalledTimes(2);
    const firstHeadSamples = s.metrics.recordPhase.mock.calls.filter(
      ([phase]) => phase === 'prehead_wait',
    );
    expect(firstHeadSamples).toHaveLength(2);
    s.governor.decide.mockClear().mockResolvedValue({ action: 'pause', retryAfterMs: 180_000 });
    await s.service.process(repeat, s.lease);
    expect(s.governor.decide).not.toHaveBeenCalled();
    expect(s.downloads).toHaveBeenCalledTimes(2);
    expect(s.metrics.record).toHaveBeenCalledWith('media.cache_only');
    expect(
      s.metrics.recordPhase.mock.calls.filter(([phase]) => phase === 'prehead_wait'),
    ).toHaveLength(2);
  });

  it('timeboxes a stuck first-head diagnostic without blocking a policy decision', async () => {
    jest.useFakeTimers();
    try {
      const s = setup();
      s.policy.resolve.mockResolvedValue({ mode: 'off', revision: 1 });
      s.redis.setStringIfAbsentWithTtl.mockImplementation(() => new Promise(() => {}));
      const result = s.service.process(s.job('diagnostic-outage', 0), s.lease);
      await jest.advanceTimersByTimeAsync(251);
      expect(await result).toBe('POLICY_CHANGED');
      expect(s.metrics.recordPhase).not.toHaveBeenCalledWith('prehead_wait', expect.any(Number));
      expect(s.downloads).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('measures only additional shared-gate wait after prior queue-age credit', async () => {
    const s = setup({ MESSAGE_DUPLICATE_MEDIA_SHARED_ADMISSION_ENABLED: true });
    await s.service.process(s.job('first', 0), s.lease);
    const repeat = s.job('repeat', 100);
    repeat.createdAt = new Date(Date.now() - 100_000).toISOString();
    const gateStartedAt = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(gateStartedAt);
    try {
      s.governor.decide.mockResolvedValue({ action: 'slow', retryAfterMs: 90_000 });
      s.redis.admitDuplicateHeavyStart.mockResolvedValueOnce({
        kind: 'deferred',
        retryAtMs: gateStartedAt + 5000,
      });
      await expect(s.service.process(repeat, s.lease)).rejects.toMatchObject({
        reason: 'governor_slow',
      });
      expect(s.metrics.recordPhase).not.toHaveBeenCalledWith('governor_wait', expect.any(Number));
      clock.mockReturnValue(gateStartedAt + 1500);
      await s.service.process(repeat, s.lease);
      expect(s.metrics.recordPhase).toHaveBeenCalledWith('governor_wait', 1500);
      expect(s.metrics.record).toHaveBeenCalledWith('media.governor_credit_reused');
    } finally {
      clock.mockRestore();
    }
  });

  it('requires fresh pause before prior wait or shared budget and fails closed on unavailable budget', async () => {
    const s = setup({ MESSAGE_DUPLICATE_MEDIA_SHARED_ADMISSION_ENABLED: true });
    await s.service.process(s.job('first', 0), s.lease);
    const repeat = s.job('repeat', 100);
    repeat.createdAt = new Date(Date.now() - 100_000).toISOString();
    s.governor.decide.mockResolvedValue({ action: 'pause', retryAfterMs: 180_000 });
    await expect(s.service.process(repeat, s.lease)).rejects.toMatchObject({
      reason: 'governor_pause',
    });
    expect(s.redis.admitDuplicateHeavyStart).not.toHaveBeenCalled();
    s.governor.decide.mockResolvedValue({ action: 'slow', retryAfterMs: 90_000 });
    s.redis.admitDuplicateHeavyStart.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(s.service.process(repeat, s.lease)).rejects.toMatchObject({
      reason: 'governor_slow',
      retryAfterMs: 90_000,
    });
    expect(s.downloads).not.toHaveBeenCalled();
    expect(s.redis.admitDuplicateHeavyStart).toHaveBeenCalledWith({
      eligibleAtMs: Date.parse(repeat.createdAt) + 90_000,
      intervalMs: 90_000,
      deadlineAtMs: expect.any(Number),
    });
    await s.service.process(repeat, s.lease);
    expect(s.downloads).toHaveBeenCalledTimes(2);
    expect(s.metrics.record).toHaveBeenCalledWith('media.governor_credit_reused');
  });

  it.each([
    [new PhotoDownloadByteLimitExceededError(), 'bytes'],
    [new PhotoDownloadFormatRejectedError('private-format-error'), 'format'],
    [new PhotoDownloadTimeoutError(), 'source_timeout'],
    [new PhotoNativeUnavailableError(), 'native_unavailable'],
    [new PhotoDownloadHttpError(403), 'http_4xx'],
    [new PhotoDownloadHttpError(503), 'http_5xx'],
  ] as const)('records only bounded failure code %s', async (error, reason) => {
    const s = setup();
    await s.service.process(s.job('first', 0), s.lease);
    s.downloads.mockRejectedValueOnce(error);
    const operation = s.service.process(s.job('repeat', 100), s.lease);
    if (
      error instanceof UnrecoverableError ||
      (error instanceof PhotoDownloadHttpError && error.statusCode === 403)
    )
      await operation;
    else await expect(operation).rejects.toBe(error);
    expect(s.metrics.record).toHaveBeenCalledWith(`media.failure_${reason}`);
    expect(JSON.stringify(s.metrics.record.mock.calls)).not.toContain('private-format-error');
  });
  it.each(['STRICT', 'CUSTOM'] as const)(
    'rejects queued pre-Unicode %s evidence before media work',
    async (preset) => {
      const s = setup();
      s.settings.duplicateDetectionPreset = preset;
      s.settings.duplicateNearMatchEnabled = true;
      const job = s.job('old-policy', 0);
      job.settingsDigest = preUnicodeNearSettingsDigests[preset];
      await s.service.process(job, s.lease);
      expect(s.downloads).not.toHaveBeenCalled();
      expect(s.history.observe).not.toHaveBeenCalled();
      expect(s.enforcement.enqueue).not.toHaveBeenCalled();
      expect(s.metrics.record).toHaveBeenCalledWith('media.settings_rejected');
    },
  );

  it('expires scheduled media work before downloading or using history', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-29T14:59Z'));
    try {
      const s = setup();
      s.settings.duplicateWindowMode = 'DAILY';
      const job = s.job('scheduled', 0);
      clock.mockReturnValue(Date.parse('2026-09-29T15:00Z'));
      await s.service.process(job, s.lease);
      expect(s.downloads).not.toHaveBeenCalled();
      expect(s.history.observe).not.toHaveBeenCalled();
      expect(s.enforcement.enqueue).not.toHaveBeenCalled();
      expect(s.metrics.record).toHaveBeenCalledWith('media.schedule_closed');
    } finally {
      clock.mockRestore();
    }
  });

  it.each([false, true])(
    'resumes all candidates within the media budget (terminal baseline: %s)',
    async (terminal) => {
      const s = setup();
      s.history.candidateKeys.mockImplementation((content) => content.text.split(' '));
      const album = (id: string, timestamp: number, text: string) => {
        const job = s.job(id, timestamp);
        s.rows.set(id, {
          status: 'PROCESSED',
          botId: 'bot',
          normalizedPayload: duplicateUpdate(
            id,
            job.eventTimestampMs,
            text,
            Array.from({ length: 10 }, (_, index) => ({
              type: 'file',
              payload: { url: `https://fd.oneme.ru/${id}-${index}` },
            })),
          ),
        });
        return job;
      };
      for (const [index, id] of ['first', 'second', 'third'].entries())
        await s.service.process(album(id, index * 100, id), s.lease);
      expect(s.downloads).not.toHaveBeenCalled();
      if (terminal) s.verifyBinary.mockRejectedValueOnce(new UnrecoverableError('invalid bytes'));
      const repeat = album('repeat', 400, 'first second third');
      await expect(s.service.process(repeat, s.lease)).rejects.toBeInstanceOf(
        MessageDuplicateMediaDeferredError,
      );
      expect(s.downloads.mock.calls.length).toBeLessThanOrEqual(20);
      expect(s.history.observe).not.toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'repeat' }),
      );
      expect(s.enforcement.enqueue).not.toHaveBeenCalled();
      expect(s.metrics.record).toHaveBeenCalledWith('media.budget_deferred');
      const before = s.downloads.mock.calls.length;
      await s.service.process(repeat, s.lease);
      expect(s.downloads.mock.calls.length - before).toBe(20);
      expect(s.history.observe).toHaveBeenLastCalledWith(
        expect.objectContaining({ messageId: 'repeat' }),
      );
      const total = s.downloads.mock.calls.length;
      await s.service.process(repeat, s.lease);
      expect(s.downloads).toHaveBeenCalledTimes(total);
      expect(s.downloads.mock.calls.filter(([url]) => url.includes('/first-0'))).toHaveLength(1);
      if (terminal) expect(s.metrics.record).toHaveBeenCalledWith('media.baseline_rejected_cached');
    },
  );

  it('verifies a shared predecessor only once across candidate keys', async () => {
    const s = setup();
    s.history.candidateKeys.mockReturnValue(['one', 'two', 'three']);
    await s.service.process(s.job('original', 0), s.lease);
    await s.service.process(s.job('repeat', 100), s.lease);
    expect(s.downloads).toHaveBeenCalledTimes(2);
    expect(s.history.observe).toHaveBeenCalledTimes(2);
  });

  it('classifies unsupported binary contents as terminal, without retrying the same bytes', async () => {
    const s = setup();
    const verify = s.actualVerifyBinary;
    await expect(verify(Buffer.from('unsupported plain text file'), 'file')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(verify(Buffer.from('%PDF-1.7\n'), 'video')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(verify(Buffer.from('%PDF-1.7\n'), 'file')).resolves.toBeUndefined();
  });

  it('does not let an unsupported first binary poison the following valid pair', async () => {
    const s = setup();
    s.verifyBinary.mockImplementationOnce(s.actualVerifyBinary);
    await s.service.process(s.job('unsupported', 0), s.lease);
    await s.service.process(s.job('valid-first', 100), s.lease);
    expect(s.history.observe).toHaveBeenCalledTimes(1);
    expect(s.history.observe).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'valid-first' }),
    );
    s.history.observe.mockResolvedValue({
      hit: {},
      binding: { eventTimestampMs: Date.now() - 1000 },
    });
    await s.service.process(s.job('valid-repeat', 200), s.lease);
    expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
    expect(s.enforcement.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          message: expect.objectContaining({ messageId: 'valid-repeat' }),
        }),
      }),
    );
  });

  function photoSetup() {
    const s = setup();
    s.settings.duplicatePhotoEnabled = true;
    s.policy.resolve.mockResolvedValue({
      mode: 'full',
      revision: 1,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    });
    const photoJob = (id: string, timestamp: number, url: string | null = null) => {
      const job = s.job(id, timestamp);
      job.comparison = 'IMAGE';
      job.settingsDigest = exactImageSettingsDigest(s.settings);
      const update = duplicateUpdate(id, job.eventTimestampMs, '', [
        { type: 'image', payload: { photo_id: id, ...(url ? { url } : {}) } },
      ]);
      s.rows.set(id, { status: 'PROCESSED', normalizedPayload: update, botId: 'bot' });
      return job;
    };
    const complete = {
      kind: 'complete',
      fingerprint: {
        algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
        albumHash: 'b'.repeat(64),
        images: [
          {
            algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
            canonicalHash: 'a'.repeat(64),
            recompressionHash: '1'.repeat(16),
            pdqHash: '0'.repeat(64),
            pdqQuality: 0,
            decodeCost: { encodedBytes: 100, pixels: 100 },
          },
        ],
      },
    } satisfies Awaited<ReturnType<PhotoDuplicateAnalysisService['fingerprintAlbum']>>;
    s.photos.fingerprintAlbum.mockResolvedValue(complete);
    return { ...s, photoJob, complete };
  }

  it.each([
    ['unsupported_multi_frame', 'multiframe'],
    ['image_byte_limit_exceeded', 'bytes'],
    ['image_pixel_limit_exceeded', 'pixels'],
    ['album_decode_budget_exceeded', 'album_budget'],
  ] as const)(
    'keeps IMAGE %s rejection terminal and outside action authority',
    async (reason, counter) => {
      const s = photoSetup();
      await s.service.process(s.photoJob('first', 0, 'https://i.oneme.ru/a'), s.lease);
      s.photos.fingerprintAlbum.mockResolvedValueOnce(s.complete).mockResolvedValueOnce({
        kind: 'incomplete',
        reason,
      });
      await expect(
        s.service.process(s.photoJob('repeat', 100, 'https://i.oneme.ru/a'), s.lease),
      ).rejects.toMatchObject({ reason });
      expect(
        s.metrics.record.mock.calls.filter(([value]) => value === `media.failure_${counter}`),
      ).toHaveLength(1);
      expect(s.enforcement.enqueue).not.toHaveBeenCalled();
    },
  );

  it('reports a missing photo URL distinctly after an unchanged source refresh', async () => {
    const s = photoSetup();
    await s.service.process(s.photoJob('first', 0, 'https://i.oneme.ru/a'), s.lease);
    const current = s.photoJob('repeat', 100);
    s.photos.fingerprintAlbum.mockResolvedValueOnce(s.complete).mockResolvedValue({
      kind: 'incomplete',
      reason: 'missing_download_url',
    });
    const row = s.rows.get(current.webhookEventId) as {
      normalizedPayload: ReturnType<typeof duplicateUpdate>;
    };
    s.max.getExactMessageRow.mockResolvedValue(
      (row.normalizedPayload.raw as { message: unknown }).message,
    );
    await expect(s.service.process(current, s.lease)).rejects.toMatchObject({
      reason: 'missing_download_url',
    });
    expect(s.metrics.record).toHaveBeenCalledWith('media.failure_source_missing');
    expect(s.metrics.record).not.toHaveBeenCalledWith('media.failure_other');
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
  });

  it('charges every album member when an outer hash checkpoint contains only a prefix', async () => {
    const s = photoSetup();
    const job = s.photoJob('partial', 0, 'https://i.oneme.ru/first');
    const update = (
      s.rows.get(job.webhookEventId) as { normalizedPayload: ReturnType<typeof duplicateUpdate> }
    ).normalizedPayload;
    const { extractDuplicateMessageContent } = await import('./message-duplicate-content');
    const one = extractDuplicateMessageContent(update.raw);
    const content = {
      ...one,
      media: [
        one.media[0]!,
        {
          ...one.media[0]!,
          identity: 'second',
          photoId: 'second',
          url: 'https://i.oneme.ru/second',
        },
      ],
    };
    s.photos.fingerprintAlbum.mockResolvedValue({
      kind: 'incomplete',
      reason: 'album_decode_budget_exceeded',
    });
    const boundary = s.service as unknown as {
      hashMedia: (
        content: typeof one,
        source: typeof update,
        ttl: number,
        deadline: number,
        bot: string,
        cached: (string | null)[],
        budget: { remaining: number },
        receiptId: string,
      ) => Promise<unknown>;
    };
    await expect(
      boundary.hashMedia(
        content,
        update,
        3600,
        Date.now() + 30_000,
        'bot',
        ['a'.repeat(64), null],
        { remaining: 20 },
        job.webhookEventId,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(s.photos.fingerprintAlbum).toHaveBeenCalledWith(
      expect.objectContaining({
        receiptId: job.webhookEventId,
        images: [
          expect.objectContaining({ downloadUrl: 'https://i.oneme.ru/first' }),
          expect.objectContaining({ downloadUrl: 'https://i.oneme.ru/second' }),
        ],
      }),
      3600,
      expect.any(Number),
      false,
    );
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
  });
  it.each(['decode_deadline_exceeded', 'decode_capacity_exceeded'] as const)(
    'defers %s without enforcing an incomplete album',
    async (reason) => {
      const s = photoSetup();
      await s.service.process(s.photoJob('a', 0, 'https://i.oneme.ru/a'), s.lease);
      s.photos.fingerprintAlbum.mockResolvedValue({ kind: 'incomplete', reason });
      await expect(
        s.service.process(s.photoJob('b', 100, 'https://i.oneme.ru/b'), s.lease),
      ).rejects.toBeInstanceOf(MessageDuplicateMediaDeferredError);
      expect(s.enforcement.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each(['photo_complete', 'source_refresh', 'outer_checkpoint'] as const)(
    'defers attempt expiry at %s without consuming error attempts or authorizing current media',
    async (boundary) => {
      const s = photoSetup();
      await s.service.process(s.photoJob('first', 0, 'https://i.oneme.ru/a'), s.lease);
      const current = s.photoJob('repeat', 100, 'https://i.oneme.ru/b');
      const absoluteDeadline = current.deadlineAtMs;
      let currentTime = Date.now();
      const attemptDeadline = currentTime + 30_000;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
      const writeCheckpoint = s.redis.setStringWithTtl.getMockImplementation()!;
      let completedOuterCheckpoints = 0;
      s.redis.setStringWithTtl.mockImplementation(async (key, value) => {
        await writeCheckpoint(key, value);
        if (
          boundary === 'outer_checkpoint' &&
          key.startsWith('message-duplicate:media-hash:') &&
          ++completedOuterCheckpoints === 2
        ) {
          currentTime = attemptDeadline;
        }
      });
      if (boundary !== 'outer_checkpoint') {
        s.photos.fingerprintAlbum
          .mockResolvedValueOnce(s.complete)
          .mockImplementationOnce(async () => {
            currentTime = attemptDeadline;
            return boundary === 'source_refresh'
              ? { kind: 'incomplete', reason: 'missing_download_url' }
              : s.complete;
          });
      }
      try {
        await expect(s.service.process(current, s.lease)).rejects.toMatchObject({
          name: 'MessageDuplicateMediaDeferredError',
          reason: 'proof_budget',
        });
        expect(current.deadlineAtMs).toBe(absoluteDeadline);
        expect(s.history.observe).toHaveBeenCalledTimes(1);
        expect(s.history.observe).toHaveBeenCalledWith(
          expect.objectContaining({ messageId: 'first' }),
        );
        expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
        expect(s.enforcement.enqueue).not.toHaveBeenCalled();
        expect(s.metrics.recordObservation).toHaveBeenLastCalledWith('-123', 'DEFERRED', true);
        expect(s.metrics.record).not.toHaveBeenCalledWith('media.failure_other');
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each(['completed', 'timed_out'] as const)(
    'defers a %s binary download at the attempt deadline before native verification',
    async (outcome) => {
      const s = setup();
      await s.service.process(s.job('first', 0), s.lease);
      const current = s.job('repeat', 100);
      let currentTime = Date.now();
      const attemptDeadline = currentTime + 30_000;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
      s.downloads.mockImplementation(async () => {
        currentTime = attemptDeadline;
        if (outcome === 'timed_out') throw new PhotoDownloadTimeoutError();
        return { bytes: Buffer.from('complete') };
      });
      try {
        await expect(s.service.process(current, s.lease)).rejects.toBeInstanceOf(
          MessageDuplicateMediaDeferredError,
        );
        expect(s.verifyBinary).not.toHaveBeenCalled();
        expect(s.history.observe).not.toHaveBeenCalled();
        expect(s.enforcement.enqueue).not.toHaveBeenCalled();
        expect(s.metrics.recordObservation).toHaveBeenLastCalledWith('-123', 'DEFERRED', true);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it('verifies exact photo copies with different IDs and forwards full action execution', async () => {
    const s = photoSetup();
    const execute = jest.fn();
    await s.service.process(s.photoJob('a', 0, 'https://i.oneme.ru/a'), s.lease, execute);
    expect(s.photos.fingerprintAlbum).not.toHaveBeenCalled();
    s.history.observe.mockResolvedValue({
      hit: {},
      binding: { eventTimestampMs: Date.now() - 1000 },
    });
    await s.service.process(s.photoJob('b', 100, 'https://i.oneme.ru/b'), s.lease, execute);
    expect(s.photos.fingerprintAlbum).toHaveBeenCalledTimes(2);
    expect(s.history.observe).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ messageId: 'a', mediaHashes: ['a'.repeat(64)] }),
    );
    expect(s.history.observe).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ messageId: 'b', mediaHashes: ['a'.repeat(64)] }),
    );
    expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
    const request = s.enforcement.enqueue.mock.calls[0]![0];
    expect(request.update.message.messageId).toBe('b');
    await request.executeFullAction({});
    expect(execute).toHaveBeenCalledTimes(1);
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('uses the persisted execution owner when the receiving bot has lost source access', async () => {
    const s = photoSetup();
    await s.service.process(s.photoJob('owner-a', 0, 'https://i.oneme.ru/a'), s.lease);
    const next = s.photoJob('owner-b', 100);
    const received = s.rows.get('owner-b') as Record<string, unknown>;
    s.rows.set('owner-b', {
      ...received,
      botId: 'receiver',
      executionClaims: [{ executionBotId: 'executor' }],
    });
    s.photos.fingerprintAlbum.mockResolvedValueOnce(s.complete).mockResolvedValueOnce({
      kind: 'incomplete',
      reason: 'missing_download_url',
    });
    const fresh = duplicateUpdate('owner-b', next.eventTimestampMs, '', [
      { type: 'image', payload: { photo_id: 'owner-b', url: 'https://i.oneme.ru/fresh' } },
    ]);
    s.max.getExactMessageRow.mockImplementation(async (_chat, _message, options) => {
      if (options.botId !== 'executor')
        throw Object.assign(new Error('forbidden'), { response: { status: 403 } });
      return (fresh.raw as { message: unknown }).message;
    });
    s.history.observe.mockResolvedValue({
      hit: {},
      binding: { eventTimestampMs: Date.now() - 1000 },
    });
    const execute = jest.fn(async () => {
      expect(s.botContext.getActiveBotId()).toBe('executor');
    });
    await s.service.process(next, s.lease, execute);
    await s.enforcement.enqueue.mock.calls[0]![0].executeFullAction({});
    expect(execute).toHaveBeenCalledTimes(1);
    expect(s.botContext.getActiveBotId()).toBeNull();
    expect(s.max.getExactMessageRow).toHaveBeenCalledWith(
      next.chatId,
      next.messageId,
      expect.objectContaining({ botId: 'executor', bypassCache: true }),
    );
    expect(s.enforcement.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'executor' }),
    );
  });

  it('rejects an executor outside the Major action registry without token fallback', async () => {
    const s = photoSetup();
    const job = s.photoJob('foreign-owner', 0, 'https://i.oneme.ru/a');
    const received = s.rows.get('foreign-owner') as Record<string, unknown>;
    s.rows.set('foreign-owner', {
      ...received,
      executionClaims: [{ executionBotId: 'publisher' }],
    });
    await s.service.process(job, s.lease);
    expect(s.history.observe).not.toHaveBeenCalled();
    expect(s.photos.fingerprintAlbum).not.toHaveBeenCalled();
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
  });

  it('retries enforcement after refreshing a missing URL even when the candidate points to itself', async () => {
    const s = photoSetup();
    await s.service.process(s.photoJob('a', 0, 'https://i.oneme.ru/a'), s.lease);
    const next = s.photoJob('b', 100);
    s.photos.fingerprintAlbum.mockResolvedValueOnce(s.complete).mockResolvedValueOnce({
      kind: 'incomplete',
      reason: 'missing_download_url',
    });
    const fresh = duplicateUpdate('b', next.eventTimestampMs, '', [
      { type: 'image', payload: { photo_id: 'b', url: 'https://i.oneme.ru/fresh' } },
    ]);
    s.max.getExactMessageRow.mockResolvedValue((fresh.raw as { message: unknown }).message);
    s.history.observe.mockResolvedValue({
      hit: {},
      binding: { eventTimestampMs: Date.now() - 1000 },
    });
    s.enforcement.enqueue.mockRejectedValueOnce(new Error('temporary intent store failure'));
    await expect(s.service.process(next, s.lease)).rejects.toThrow('intent store failure');
    s.photos.fingerprintAlbum.mockClear();
    await s.service.process(next, s.lease);
    expect(s.enforcement.enqueue).toHaveBeenCalledTimes(2);
    expect(s.photos.fingerprintAlbum).not.toHaveBeenCalled();
  });

  it('re-verifies a retry after its own media hash cache is evicted', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    const next = s.job('b', 100);
    s.history.observe.mockResolvedValue({
      hit: {},
      binding: { eventTimestampMs: Date.now() - 1000 },
    });
    s.enforcement.enqueue.mockRejectedValueOnce(new Error('temporary intent store failure'));
    await expect(s.service.process(next, s.lease)).rejects.toThrow('intent store failure');
    for (const key of s.cache.keys()) {
      if (key.startsWith('message-duplicate:media-hash:')) s.cache.delete(key);
    }
    await s.service.process(next, s.lease);
    expect(s.enforcement.enqueue).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a newer candidate when an older job arrives late', async () => {
    const s = setup();
    const first = s.job('newer', 1000);
    await s.service.process(first, s.lease);
    const pointerKey = [...s.cache.keys()].find((key) =>
      key.startsWith('message-duplicate:candidate:'),
    )!;
    const pointer = s.cache.get(pointerKey);
    await s.service.process(s.job('older', 0), s.lease);
    expect(s.cache.get(pointerKey)).toBe(pointer);
    expect(s.downloads).not.toHaveBeenCalled();
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
  });

  it.each(['oversized', 'expired'] as const)(
    'repairs a %s candidate pointer before the next matching pair',
    async (kind) => {
      const s = setup();
      const first = s.job('a', 0);
      await s.service.process(first, s.lease);
      const key = [...s.cache.keys()].find((value) =>
        value.startsWith('message-duplicate:candidate:'),
      )!;
      s.cache.set(
        key,
        kind === 'oversized'
          ? 'x'.repeat(2048)
          : JSON.stringify({
              webhookEventId: 'expired',
              messageId: 'expired',
              eventTimestampMs: first.eventTimestampMs - 604800000,
            }),
      );
      await s.service.process(s.job('b', 100), s.lease);
      expect(s.downloads).not.toHaveBeenCalled();
      await s.service.process(s.job('c', 200), s.lease);
      expect(s.downloads).toHaveBeenCalledTimes(2);
      expect(s.history.observe).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ messageId: 'b' }),
      );
    },
  );

  it.each(['missing', 403, 404, 410, 'forbidden'] as const)(
    'refreshes a %s photo URL without treating its ID as equality proof',
    async (reason) => {
      const s = photoSetup();
      await s.service.process(s.photoJob('a', 0, 'https://i.oneme.ru/a'), s.lease);
      const current = s.photoJob(
        'b',
        100,
        reason === 'missing'
          ? null
          : reason === 'forbidden'
            ? 'https://untrusted.example/photo?opaque=secret'
            : 'https://i.oneme.ru/expired',
      );
      s.photos.fingerprintAlbum.mockResolvedValueOnce(s.complete);
      if (reason === 'missing')
        s.photos.fingerprintAlbum.mockResolvedValueOnce({
          kind: 'incomplete',
          reason: 'missing_download_url',
        });
      else
        s.photos.fingerprintAlbum.mockRejectedValueOnce(
          reason === 'forbidden'
            ? new PhotoDownloadSourceRejectedError('host')
            : new PhotoDownloadHttpError(reason),
        );
      const fresh = duplicateUpdate('b', current.eventTimestampMs, '', [
        { type: 'image', payload: { photo_id: 'b', url: 'https://i.oneme.ru/fresh' } },
      ]);
      s.max.getExactMessageRow.mockResolvedValue((fresh.raw as { message: unknown }).message);
      s.history.observe.mockResolvedValueOnce(null).mockResolvedValueOnce({
        hit: {},
        binding: { eventTimestampMs: current.eventTimestampMs },
      });
      await s.service.process(current, s.lease);
      expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(1);
      expect(s.max.getExactMessageRow).toHaveBeenCalledWith(
        '-123',
        'b',
        expect.objectContaining({ botId: 'bot', trafficClass: 'background', bypassCache: true }),
      );
      expect(s.photos.fingerprintAlbum).toHaveBeenLastCalledWith(
        expect.objectContaining({
          images: [{ source: 'direct', photoId: 'b', downloadUrl: 'https://i.oneme.ru/fresh' }],
        }),
        expect.any(Number),
        expect.any(Number),
        true,
      );
      expect(s.history.observe).toHaveBeenLastCalledWith(
        expect.objectContaining({ messageId: 'b', mediaHashes: ['a'.repeat(64)] }),
      );
      expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
      if (reason === 'forbidden') expect(s.metrics.record).toHaveBeenCalledWith('media.url_host');
    },
  );

  it.each([
    ['malformed_url', 'media.url_malformed'],
    ['protocol', 'media.url_protocol'],
    ['credentials', 'media.url_credentials'],
    ['port', 'media.url_port'],
    ['host', 'media.url_host'],
  ] as const)(
    'records fixed %s diagnostics before one guarded source refresh',
    async (reason, counter) => {
      const s = photoSetup();
      await s.service.process(s.photoJob('a', 0, 'https://i.oneme.ru/a'), s.lease);
      const current = s.photoJob('b', 100, 'https://untrusted.example/photo?opaque=secret');
      s.photos.fingerprintAlbum
        .mockResolvedValueOnce(s.complete)
        .mockRejectedValueOnce(new PhotoDownloadSourceRejectedError(reason));
      const fresh = duplicateUpdate('b', current.eventTimestampMs, '', [
        { type: 'image', payload: { photo_id: 'b', url: 'https://i.oneme.ru/fresh' } },
      ]);
      s.max.getExactMessageRow.mockResolvedValue((fresh.raw as { message: unknown }).message);
      await s.service.process(current, s.lease);
      expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(1);
      expect(s.metrics.record.mock.calls.filter(([value]) => value === counter)).toHaveLength(1);
      expect(s.metrics.record.mock.calls.flat()).not.toEqual(
        expect.arrayContaining([expect.stringContaining('secret')]),
      );
      expect(s.history.observe).toHaveBeenLastCalledWith(
        expect.objectContaining({ messageId: 'b', mediaHashes: ['a'.repeat(64)] }),
      );
    },
  );

  it.each(
    (['missing', 'forbidden'] as const).flatMap((reason) =>
      (['photo', 'author', 'message', 'chat', 'deleted'] as const).map((change) => ({
        reason,
        change,
      })),
    ),
  )('rejects changed $change after a $reason photo source refresh', async ({ reason, change }) => {
    const s = photoSetup();
    await s.service.process(s.photoJob('a', 0, 'https://i.oneme.ru/a'), s.lease);
    const current = s.photoJob(
      'b',
      100,
      reason === 'forbidden' ? 'https://untrusted.example/photo' : null,
    );
    s.photos.fingerprintAlbum.mockResolvedValueOnce(s.complete);
    if (reason === 'forbidden')
      s.photos.fingerprintAlbum.mockRejectedValueOnce(new PhotoDownloadSourceRejectedError('host'));
    else
      s.photos.fingerprintAlbum.mockResolvedValueOnce({
        kind: 'incomplete',
        reason: 'missing_download_url',
      });
    const fresh = duplicateUpdate(
      change === 'message' ? 'other' : 'b',
      current.eventTimestampMs,
      '',
      [
        {
          type: 'image',
          payload: {
            photo_id: change === 'photo' ? 'other' : 'b',
            url: 'https://i.oneme.ru/fresh',
          },
        },
      ],
    );
    const raw = (
      fresh.raw as {
        message: { sender: { user_id: number }; recipient: { chat_id: number } };
      }
    ).message;
    if (change === 'author') raw.sender.user_id = 999;
    if (change === 'chat') raw.recipient.chat_id = -999;
    s.max.getExactMessageRow.mockResolvedValue(change === 'deleted' ? null : raw);
    const rejectionReason = change === 'deleted' ? 'source_unavailable' : 'source_changed';
    await expect(s.service.process(current, s.lease)).rejects.toMatchObject({
      reason: rejectionReason,
    });
    expect(s.metrics.record).toHaveBeenCalledWith(`media.failure_${rejectionReason}`);
    expect(s.metrics.record).not.toHaveBeenCalledWith('media.failure_other');
    expect(s.photos.fingerprintAlbum).toHaveBeenCalledTimes(2);
    expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(1);
    expect(
      s.metrics.record.mock.calls.filter(([value]) => value === 'media.url_host'),
    ).toHaveLength(reason === 'forbidden' ? 1 : 0);
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
  });

  it('classifies a rejected binary source without treating it as equality evidence', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    s.downloads.mockRejectedValueOnce(new PhotoDownloadSourceRejectedError('host'));
    await s.service.process(s.job('b', 100), s.lease);
    expect(s.metrics.record).toHaveBeenCalledWith('media.url_host');
    expect(s.metrics.record).toHaveBeenCalledWith('media.baseline_rejected');
    expect(s.history.observe).toHaveBeenCalledTimes(1);
    expect(s.history.observe).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'b' }));
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
  });

  it('rejects a still forbidden refreshed photo URL after one exact-message read', async () => {
    const s = photoSetup();
    await s.service.process(s.photoJob('a', 0, 'https://i.oneme.ru/a'), s.lease);
    const current = s.photoJob('b', 100, 'https://untrusted.example/stale');
    const rejected = new PhotoDownloadSourceRejectedError('host');
    s.photos.fingerprintAlbum
      .mockResolvedValueOnce(s.complete)
      .mockRejectedValueOnce(rejected)
      .mockRejectedValueOnce(rejected);
    const fresh = duplicateUpdate('b', current.eventTimestampMs, '', [
      {
        type: 'image',
        payload: { photo_id: 'b', url: 'https://untrusted.example/still-forbidden' },
      },
    ]);
    s.max.getExactMessageRow.mockResolvedValue((fresh.raw as { message: unknown }).message);
    await expect(s.service.process(current, s.lease)).rejects.toBe(rejected);
    expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(1);
    expect(
      s.metrics.record.mock.calls.filter(([value]) => value === 'media.url_host'),
    ).toHaveLength(2);
    expect(s.photos.fingerprintAlbum).toHaveBeenCalledTimes(3);
    expect(s.photos.fingerprintAlbum).toHaveBeenLastCalledWith(
      expect.objectContaining({
        images: [
          {
            source: 'direct',
            photoId: 'b',
            downloadUrl: 'https://untrusted.example/still-forbidden',
          },
        ],
      }),
      expect.any(Number),
      expect.any(Number),
      true,
    );
    expect(s.history.observe).toHaveBeenCalledTimes(1);
    expect(s.history.observe).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'a' }));
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
  });

  it.each([403, 404])(
    'advances past an unverifiable photo baseline when MAX refresh returns %s',
    async (status) => {
      const s = photoSetup();
      await s.service.process(s.photoJob('a', 0), s.lease);
      s.photos.fingerprintAlbum.mockResolvedValueOnce({
        kind: 'incomplete',
        reason: 'missing_download_url',
      });
      s.max.getExactMessageRow.mockRejectedValueOnce({ response: { status } });

      await s.service.process(s.photoJob('b', 100, 'https://i.oneme.ru/b'), s.lease);

      expect(s.history.observe).toHaveBeenCalledTimes(1);
      expect(s.history.observe).toHaveBeenLastCalledWith(
        expect.objectContaining({ messageId: 'b', mediaHashes: ['a'.repeat(64)] }),
      );
      expect(s.metrics.record).toHaveBeenCalledWith('media.baseline_rejected');
      expect(s.enforcement.enqueue).not.toHaveBeenCalled();

      s.history.observe
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ hit: {}, binding: { eventTimestampMs: Date.now() - 1000 } });
      await s.service.process(s.photoJob('c', 200, 'https://i.oneme.ru/c'), s.lease);
      expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(1);
      expect(s.history.observe).toHaveBeenLastCalledWith(
        expect.objectContaining({ messageId: 'c' }),
      );
      expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
      expect(s.enforcement.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            message: expect.objectContaining({ messageId: 'c' }),
          }),
        }),
      );
    },
  );

  it.each([403, 404])(
    'rejects unverified current photo evidence after MAX refresh returns %s',
    async (status) => {
      const s = photoSetup();
      await s.service.process(s.photoJob('a', 0, 'https://i.oneme.ru/a'), s.lease);
      s.photos.fingerprintAlbum
        .mockResolvedValueOnce(s.complete)
        .mockResolvedValueOnce({ kind: 'incomplete', reason: 'missing_download_url' });
      s.max.getExactMessageRow.mockRejectedValueOnce({ response: { status } });

      await expect(s.service.process(s.photoJob('b', 100), s.lease)).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(s.history.observe).toHaveBeenCalledTimes(1);
      expect(s.history.observe).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'a' }));
      expect(s.enforcement.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([401, 429, 500, undefined])(
    'preserves retry of photo baseline refresh failures with status %s',
    async (status) => {
      const s = photoSetup();
      await s.service.process(s.photoJob('a', 0), s.lease);
      s.photos.fingerprintAlbum.mockResolvedValueOnce({
        kind: 'incomplete',
        reason: 'missing_download_url',
      });
      const error = Object.assign(new Error('MAX lookup unavailable'), {
        response: status ? { status } : undefined,
      });
      s.max.getExactMessageRow.mockRejectedValueOnce(error);

      await expect(
        s.service.process(s.photoJob('b', 100, 'https://i.oneme.ru/b'), s.lease),
      ).rejects.toBe(error);
      expect(s.history.observe).not.toHaveBeenCalled();
      expect(s.metrics.record).not.toHaveBeenCalledWith('media.baseline_rejected');
      expect(s.enforcement.enqueue).not.toHaveBeenCalled();
    },
  );

  it('retries a not-yet-processed baseline instead of losing its first occurrence', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    s.rows.set('a', { status: 'QUEUED' });
    await expect(s.service.process(s.job('b', 100), s.lease)).rejects.toThrow();
    expect(s.downloads).not.toHaveBeenCalled();
    expect(s.history.observe).not.toHaveBeenCalled();
  });
  it('does not download first occurrences and proves each candidate independently', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    expect(s.downloads).not.toHaveBeenCalled();
    await s.service.process(s.job('b', 100, 'b'), s.lease);
    expect(s.downloads).toHaveBeenCalledTimes(2);
    const hashes = s.history.observe.mock.calls.map(
      (call) => (call[0] as { mediaHashes: string[] }).mediaHashes[0],
    );
    expect(hashes).toEqual(
      ['same', 'different'].map((value) => createHash('sha256').update(value).digest('hex')),
    );
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
  });
  it('retains caches per message and edit revision, not untrusted resource id', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    const second = s.job('b', 100);
    await s.service.process(second, s.lease);
    await s.service.process(second, s.lease);
    expect(s.downloads).toHaveBeenCalledTimes(2);
    await s.service.process(s.job('edit', 200, 'b', 'b'), s.lease);
    expect(s.downloads).toHaveBeenCalledTimes(3);
    expect(s.history.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageId: 'b',
        mediaHashes: [createHash('sha256').update('different').digest('hex')],
      }),
    );
  });
  it('handles two different messages bearing the same trusted timestamp', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    await s.service.process(s.job('b', 0), s.lease);
    expect(s.downloads).toHaveBeenCalledTimes(2);
  });
  it('continues current evidence collection when the baseline download fails', async () => {
    const s = setup();
    expect(await s.service.process(s.job('a', 0), s.lease)).toBe('MEDIA_CANDIDATE');
    s.downloads.mockRejectedValueOnce(new PhotoDownloadHttpError(410));
    expect(await s.service.process(s.job('b', 100), s.lease)).toBe('CONTENT_UNVERIFIED');
    expect(s.history.observe).toHaveBeenCalledTimes(1);
    expect(s.history.observe).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'b' }));
    expect(s.metrics.recordObservation).toHaveBeenLastCalledWith(
      '-123',
      'CONTENT_UNVERIFIED',
      true,
    );
  });
  it('retries transient baseline downloads before committing current history', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    const next = s.job('b', 100);
    s.downloads.mockRejectedValueOnce(new Error('temporary download timeout'));
    await expect(s.service.process(next, s.lease)).rejects.toThrow('temporary download timeout');
    expect(s.history.observe).not.toHaveBeenCalled();
    expect(s.metrics.recordObservation).toHaveBeenLastCalledWith('-123', 'COMPARISON_FAILED', true);
    expect(await s.service.process(next, s.lease)).toBe('COMPARED_NO_MATCH');
    expect(s.history.observe).toHaveBeenCalledTimes(2);
  });
  it('defers pressure without downloading, and requires the durable receipt to be processed', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    s.governor.decide.mockResolvedValue({ action: 'pause', retryAfterMs: 180_000 });
    await expect(s.service.process(s.job('b', 100), s.lease)).rejects.toMatchObject({
      reason: 'governor_pause',
      retryAfterMs: 180_000,
    });
    expect(s.downloads).not.toHaveBeenCalled();
    expect(s.governor.decide).toHaveBeenCalledWith({
      component: 'message-duplicate-media',
      sourceTag: 'message-duplicate',
      allowRecoveryWindowRun: true,
    });
    const job = s.job('c', 200);
    s.rows.set('c', { status: 'QUEUED' });
    await expect(s.service.process(job, s.lease)).rejects.toThrow();
  });
  it('makes bounded progress after one slow governor delay instead of starving the job', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const s = setup();
      await s.service.process(s.job('a', 0), s.lease);
      const job = s.job('b', 100);
      s.governor.decide.mockResolvedValue({ action: 'slow', retryAfterMs: 20_000 });
      await expect(s.service.process(job, s.lease)).rejects.toMatchObject({
        reason: 'governor_slow',
        retryAfterMs: 20_000,
      });
      expect(s.downloads).not.toHaveBeenCalled();
      clock.mockReturnValue(now + 20_000);
      await s.service.process(job, s.lease);
      expect(s.downloads).toHaveBeenCalledTimes(2);
      expect(s.history.observe).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([NaN, Infinity, -1, 0])('bounds malformed retry delays (%p)', (delay) => {
    const error = new MessageDuplicateMediaDeferredError('governor_pause', delay);
    expect(error.retryAfterMs).toBe(60_000);
  });
  it('enforces only the current verified hit and never a retroactive baseline', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    s.history.observe.mockResolvedValue({
      hit: {},
      binding: { eventTimestampMs: Date.now() - 1000 },
    });
    await s.service.process(s.job('b', 100), s.lease);
    expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
    s.lease.resolveActionEligibility.mockResolvedValue(false);
    await s.service.process(s.job('c', 200), s.lease);
    expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('media executor stage handoff', () => {
  it.each([1, 4, 9, 13])(
    'keeps canonical attribution and job identity with %s configured bots',
    async (count) => {
      const s = setup();
      await s.service.process(s.job('handoff-baseline', -100), s.lease);
      const job = s.job('handoff', 0);
      const before = { ...job };
      const row = s.rows.get('handoff') as { executionClaims?: { executionBotId: string }[] };
      row.executionClaims = [{ executionBotId: 'executor-b' }];
      let selected = 'executor-b';
      const denied = Object.assign(new Error('qualification denied'), {
        response: { status: 403 },
      });
      const readiness = {
        ensureReady: jest.fn(async ({ force }: { force?: boolean }) => {
          if (force) selected = count === 1 ? '' : 'executor-c';
          return selected ? { botId: selected } : null;
        }),
      };
      Object.assign(s.service, { executionReadiness: readiness });
      s.history.observe.mockResolvedValue({
        binding: { eventTimestampMs: job.eventTimestampMs },
        hit: {},
      } as never);
      s.enforcement.enqueue
        .mockRejectedValueOnce(denied)
        .mockResolvedValue({ kind: 'intent_accepted', intentId: 'handoff-intent' });
      await expect(s.service.process(job, s.lease)).rejects.toBeInstanceOf(
        MessageDuplicateMediaDeferredError,
      );
      expect(readiness.ensureReady).toHaveBeenCalledWith(
        expect.objectContaining({
          force: true,
          preferredBotId: 'executor-b',
          purpose: 'delete_message',
        }),
      );
      if (count === 1) {
        await expect(s.service.process(job, s.lease)).rejects.toBeInstanceOf(
          MessageDuplicateMediaDeferredError,
        );
        expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
      } else {
        await expect(s.service.process(job, s.lease)).resolves.toBe('ENFORCEMENT_REQUESTED');
        expect(s.enforcement.enqueue).toHaveBeenLastCalledWith(
          expect.objectContaining({ botId: 'executor-c' }),
        );
      }
      expect(job).toEqual(before);
      expect(row.executionClaims).toEqual([{ executionBotId: 'executor-b' }]);
    },
  );

  it.each([false, true])(
    'preserves owned deferral and original deadline when readiness is unknown (forced: %s)',
    async (force) => {
      const s = setup();
      if (force) await s.service.process(s.job('readiness-baseline', -100), s.lease);
      const job = s.job('unknown-readiness', 0);
      const originalDeadline = job.deadlineAtMs;
      const readiness = {
        ensureReady: jest.fn(async (params: { force?: boolean }) => {
          if (Boolean(params.force) === force)
            throw new WebhookPreparationDeferredError('access unknown', 30_000);
          return { botId: 'executor-b' };
        }),
      };
      Object.assign(s.service, { executionReadiness: readiness });
      if (force) {
        s.history.observe.mockResolvedValue({
          binding: { eventTimestampMs: job.eventTimestampMs },
          hit: {},
        } as never);
        s.enforcement.enqueue.mockRejectedValue(
          Object.assign(new Error('qualification denied'), { response: { status: 403 } }),
        );
      }
      await expect(s.service.process(job, s.lease)).rejects.toMatchObject({
        name: 'MessageDuplicateMediaDeferredError',
        reason: 'proof_budget',
        retryAfterMs: 30_000,
      });
      expect(job.deadlineAtMs).toBe(originalDeadline);
      expect(s.metrics.record.mock.calls.some(([key]) => key.startsWith('media.failure_'))).toBe(
        false,
      );
    },
  );

  it('never hands off after a full business action begins', async () => {
    const s = setup();
    await s.service.process(s.job('action-baseline', -100), s.lease);
    const job = s.job('action-denied', 0);
    const readiness = { ensureReady: jest.fn(async () => ({ botId: 'executor-b' })) };
    Object.assign(s.service, { executionReadiness: readiness });
    s.history.observe.mockResolvedValue({
      binding: { eventTimestampMs: job.eventTimestampMs },
      hit: {},
    } as never);
    const denied = Object.assign(new Error('mutation denied after dispatch'), {
      response: { status: 403 },
    });
    s.enforcement.enqueue.mockImplementation(async (params) => params.executeFullAction({}));
    const execute = jest.fn(async () => {
      throw denied;
    });
    await expect(s.service.process(job, s.lease, execute)).rejects.toBe(denied);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(readiness.ensureReady.mock.calls).toHaveLength(2);
    expect(readiness.ensureReady).not.toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
  });

  it.each([408, 500, 503])(
    'does not convert a %s unknown read into peer failover',
    async (status) => {
      const s = setup();
      await s.service.process(s.job('unknown-baseline', -100), s.lease);
      const job = s.job('unknown', 0);
      const readiness = { ensureReady: jest.fn(async () => ({ botId: 'executor-b' })) };
      Object.assign(s.service, { executionReadiness: readiness });
      s.history.observe.mockResolvedValue({
        binding: { eventTimestampMs: job.eventTimestampMs },
        hit: {},
      } as never);
      const error = Object.assign(new Error('not accessible'), { response: { status } });
      s.enforcement.enqueue.mockRejectedValue(error);
      await expect(s.service.process(job, s.lease)).rejects.toBe(error);
      expect(readiness.ensureReady.mock.calls).toHaveLength(2);
      expect(readiness.ensureReady).not.toHaveBeenCalledWith(
        expect.objectContaining({ force: true }),
      );
    },
  );
});
