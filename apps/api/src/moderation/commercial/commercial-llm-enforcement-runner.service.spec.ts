import { randomInt } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { BackgroundRuntimeGovernorService } from '../../system/background-runtime-governor.service';
import type { SystemModeSnapshot } from '../../system/system-mode.service';
import type { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { CommercialLlmEnforcementRunnerService } from './commercial-llm-enforcement-runner.service';
import { CommercialLlmEnforcementService } from './commercial-llm-enforcement.service';
import {
  CommercialLlmEnforcementMailbox,
  COMMERCIAL_LLM_ENFORCEMENT_KEYS,
} from './commercial-llm-enforcement.mailbox';
import { CommercialLlmEnforcementProcessor } from './commercial-llm-enforcement.processor';
import { CommercialLlmWorkstationMailbox } from './commercial-llm-workstation.mailbox';
import { CommercialLlmPreviewMailbox } from './commercial-llm-preview.mailbox';
import { CommercialLlmSecondaryScheduler } from './commercial-llm-secondary-scheduler';
import {
  buildCommercialLlmOffer,
  type CommercialLlmPoolPolicy,
} from './commercial-llm-enforcement.protocol';
import { CommercialLlmPoolClient } from './commercial-llm-pool.client';
import { CommercialLlmPoolMailbox } from './commercial-llm-pool.mailbox';
import { CommercialLlmPoolServer } from './commercial-llm-pool-server';
import type { CommercialLlmObservationResult } from './commercial-llm.protocol';
import * as shadowLease from './commercial-llm-shadow.lease';
import * as shadowProcessor from './commercial-llm-shadow.processor';

jest.mock('node:crypto', () => ({
  ...jest.requireActual<typeof import('node:crypto')>('node:crypto'),
  randomInt: jest.fn(() => 1),
}));

type ProcessorResult = Awaited<ReturnType<CommercialLlmEnforcementProcessor['run']>>;
type MailboxItem = NonNullable<Awaited<ReturnType<CommercialLlmEnforcementMailbox['take']>>>;

const negative: CommercialLlmObservationResult = {
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

function source(chatId: string, messageId = `message-${chatId}`, policy?: CommercialLlmPoolPolicy) {
  const now = Date.now();
  const offer = buildCommercialLlmOffer(
    {
      chatId,
      messageId,
      userId: 'user',
      originBotId: 'bot',
      text: 'Обсуждение объявления в чате.',
      eventAt: new Date(now).toISOString(),
      settings: {
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 65,
        nightModeTimezone: 'Europe/Moscow',
        textFiltersWarnEnabled: true,
        textFiltersMuteEnabled: true,
        textFiltersBanEnabled: true,
        textFiltersMuteDurationHours: 1,
        textFiltersBotMessageEnabled: true,
      },
      origin: {
        sourceWebhookEventId: `receipt-${messageId}`,
        sourceReceivingBotId: 'bot',
        sourceExecutionBotId: 'bot',
        sourceEventAtMs: now,
        sourceEvidenceVersion: 1,
      },
    },
    now,
    policy,
  );
  if (!offer) throw new Error('Synthetic current source required');
  return offer;
}

describe('commercial AI runner resource lifecycle', () => {
  let runner: CommercialLlmEnforcementRunnerService | null;
  let redis: Redis;
  let mailbox: CommercialLlmEnforcementMailbox;
  let cleanups: Array<() => void>;
  let config: ConfigService;
  const governor = {
    decide: jest.fn<
      ReturnType<BackgroundRuntimeGovernorService['decide']>,
      Parameters<BackgroundRuntimeGovernorService['decide']>
    >(),
  } satisfies Pick<BackgroundRuntimeGovernorService, 'decide'>;
  const intents = {
    ensureIntent: jest.fn<
      ReturnType<ModerationDeleteIntentService['ensureIntent']>,
      Parameters<ModerationDeleteIntentService['ensureIntent']>
    >(),
  } satisfies Pick<ModerationDeleteIntentService, 'ensureIntent'>;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-27T09:00:00.000Z') });
    cleanups = [];
    jest.mocked(randomInt).mockImplementation(() => 1);
    config = new ConfigService({
      APP_SERVICE_NAME: 'api-moderation-background',
      COMMERCIAL_LLM_ENFORCEMENT_ENABLED: true,
      COMMERCIAL_LLM_ENDPOINT: 'http://127.0.0.1:1',
      REDIS_URL: 'redis://127.0.0.1:1',
    });
    redis = shadowLease.createCommercialLlmRedis('redis://127.0.0.1:1');
    redis.status = 'ready';
    jest.spyOn(redis, 'connect').mockResolvedValue(undefined);
    jest.spyOn(redis, 'disconnect').mockImplementation(() => undefined);
    jest.spyOn(redis, 'set').mockResolvedValue('OK');
    jest.spyOn(CommercialLlmPreviewMailbox.prototype, 'advertise').mockResolvedValue(undefined);
    jest.spyOn(CommercialLlmPreviewMailbox.prototype, 'withdraw').mockResolvedValue(undefined);
    jest.spyOn(CommercialLlmPreviewMailbox.prototype, 'take').mockResolvedValue(null);
    jest.spyOn(shadowLease, 'createCommercialLlmRedis').mockReturnValue(redis);
    jest.spyOn(shadowProcessor, 'commercialLlmHostHasHeadroom').mockResolvedValue(true);
    mailbox = new CommercialLlmEnforcementMailbox(redis);
    jest.spyOn(mailbox, 'heartbeat').mockResolvedValue(true);
    jest.spyOn(mailbox, 'advertise').mockResolvedValue(true);
    jest.spyOn(mailbox, 'readObservations').mockResolvedValue({});
    jest.spyOn(mailbox, 'withdraw').mockResolvedValue(undefined);
    jest.spyOn(mailbox, 'releasePrimary').mockResolvedValue(true);
    jest.spyOn(mailbox, 'claimSecondary').mockResolvedValue(true);
    jest.spyOn(mailbox, 'releaseSecondary').mockResolvedValue(true);
    const admission = new CommercialLlmEnforcementService(config);
    jest.spyOn(admission, 'mailbox').mockResolvedValue(mailbox);
    governor.decide
      .mockReset()
      .mockResolvedValue({ action: 'run', reason: 'normal', retryAfterMs: 0 });
    intents.ensureIntent.mockReset().mockRejectedValue(new Error('Unexpected delete registration'));
    runner = new CommercialLlmEnforcementRunnerService(
      config,
      admission,
      governor as unknown as BackgroundRuntimeGovernorService,
      intents as unknown as ModerationDeleteIntentService,
    );
  });

  afterEach(async () => {
    cleanups.forEach((complete) => complete());
    await jest.advanceTimersByTimeAsync(0);
    await runner?.onModuleDestroy();
    jest.restoreAllMocks();
    redis.disconnect();
    jest.useRealTimers();
  });

  it('continues moderation polling when the independent preview mailbox fails', async () => {
    jest
      .mocked(CommercialLlmPreviewMailbox.prototype.take)
      .mockRejectedValue(new Error('WRONGTYPE diagnostic request'));
    const run = jest
      .spyOn(CommercialLlmEnforcementProcessor.prototype, 'run')
      .mockResolvedValue({ outcome: 'idle' });
    runner!.onModuleInit();
    await jest.advanceTimersByTimeAsync(500);
    expect(mailbox.advertise).toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
  });

  function pendingJob() {
    const job = deferred<ProcessorResult>();
    cleanups.push(() => job.resolve({ outcome: 'idle' }));
    return job;
  }

  function enablePool() {
    config.set('COMMERCIAL_LLM_POOL_ENABLED', true);
    config.set('COMMERCIAL_LLM_POOL_WORKERS_ENABLED', true);
    config.set('COMMERCIAL_LLM_POOL_4B_POLICY', 'confirm-positive');
    jest.spyOn(CommercialLlmPoolServer.prototype, 'tick').mockResolvedValue(undefined);
    jest.spyOn(CommercialLlmPoolServer.prototype, 'close').mockResolvedValue(undefined);
    jest.spyOn(CommercialLlmPoolMailbox.prototype, 'available').mockResolvedValue(['pc-b-9b']);
  }

  it('routes fresh v2 sources to the pool without applying CPU memory admission to GPU PCs', async () => {
    enablePool();
    jest.mocked(shadowProcessor.commercialLlmHostHasHeadroom).mockResolvedValue(false);
    const offered = offeredSources([source('pool-chat', 'message', 'confirm-positive')]);
    const classify = jest
      .spyOn(CommercialLlmPoolClient.prototype, 'classify')
      .mockResolvedValue(negative);
    const legacy = jest.spyOn(CommercialLlmWorkstationMailbox.prototype, 'classify');
    runner!.onModuleInit();
    await jest.advanceTimersByTimeAsync(250);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
    expect(offered.finish).toHaveBeenCalledWith(
      offered.items[0]!.raw,
      offered.items[0]!.request.worker,
    );
    expect(intents.ensureIntent).not.toHaveBeenCalled();
  });

  it('rejects a legacy source in the pool namespace before classification', async () => {
    enablePool();
    offeredSources([source('legacy-source')]);
    const classify = jest.spyOn(CommercialLlmPoolClient.prototype, 'classify');
    runner!.onModuleInit();
    await jest.advanceTimersByTimeAsync(250);
    expect(classify).not.toHaveBeenCalled();
    expect(intents.ensureIntent).not.toHaveBeenCalled();
  });

  it('preserves pool primary and consultation durations in the terminal observation', async () => {
    enablePool();
    offeredSources([source('pool-observation', 'message', 'confirm-positive')]);
    const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(CommercialLlmPoolClient.prototype, 'classify').mockResolvedValue({
      ...negative,
      pool: {
        version: 'commercial-pool-v2',
        nodeId: 'server-9b',
        route: 'consulted',
        policy: 'confirm-positive',
        attempts: 1,
        primaryNodeId: 'pc-a-4b',
        primaryClassification: 'UNSURE',
        primaryDurationMs: 130,
        consultationDurationMs: 900,
        consultationOutcome: 'completed',
      },
    });
    runner!.onModuleInit();
    await jest.advanceTimersByTimeAsync(250);
    expect(logs).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'commercial-ai',
        outcome: 'kept',
        primaryDurationMs: 130,
        consultationDurationMs: 900,
        consultationOutcome: 'completed',
        nodeId: 'server-9b',
      }),
      'Commercial AI result',
    );
    await jest.advanceTimersByTimeAsync(10000);
    const statuses = jest
      .mocked(redis.set)
      .mock.calls.map(([, value]) => JSON.parse(String(value)) as Record<string, unknown>);
    expect(statuses.at(-1)).toMatchObject({
      poolDiagnostics: { consultations: { completed: 1, noCapacity: 0, budgetExhausted: 0 } },
    });
    expect(intents.ensureIntent).not.toHaveBeenCalled();
  });

  it('retains short pending work while all physical pool slots are occupied', async () => {
    enablePool();
    const first = deferred<CommercialLlmObservationResult>();
    cleanups.push(() => first.resolve(negative));
    const offered = offeredSources([
      source('first', 'one', 'confirm-positive'),
      source('next', 'two', 'confirm-positive'),
    ]);
    jest
      .spyOn(CommercialLlmPoolClient.prototype, 'classify')
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(negative);
    runner!.onModuleInit();
    await jest.advanceTimersByTimeAsync(250);
    expect(offered.take).toHaveBeenCalledTimes(1);
    jest.mocked(CommercialLlmPoolMailbox.prototype.available).mockResolvedValue([]);
    await jest.advanceTimersByTimeAsync(500);
    expect(offered.take).toHaveBeenCalledTimes(1);
    expect(mailbox.withdraw).not.toHaveBeenCalled();
    jest.mocked(CommercialLlmPoolMailbox.prototype.available).mockResolvedValue(['pc-a-4b']);
    await jest.advanceTimersByTimeAsync(250);
    expect(offered.take).toHaveBeenCalledTimes(2);
    first.resolve(negative);
  });

  it('registers pool server capacity for closed preflight without starting enforcement', async () => {
    enablePool();
    config.set('COMMERCIAL_LLM_ENFORCEMENT_ENABLED', false);
    const run = jest.spyOn(CommercialLlmEnforcementProcessor.prototype, 'run');
    runner!.onModuleInit();
    await jest.advanceTimersByTimeAsync(500);
    expect(CommercialLlmPoolServer.prototype.tick).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(mailbox.heartbeat).not.toHaveBeenCalled();
    expect(intents.ensureIntent).not.toHaveBeenCalled();
  });

  function offeredSources(sources: ReturnType<typeof source>[]) {
    const items: MailboxItem[] = [];
    const take = jest.spyOn(mailbox, 'take').mockResolvedValue(null);
    for (const offered of sources) {
      take.mockImplementationOnce(async (worker) => {
        const request = { ...offered, submittedAtMs: Date.now(), worker };
        const item = { request, raw: JSON.stringify(request) };
        items.push(item);
        return item;
      });
    }
    jest.spyOn(mailbox, 'owns').mockResolvedValue(true);
    jest.spyOn(mailbox, 'ownsWorker').mockResolvedValue(true);
    const finish = jest.spyOn(mailbox, 'finish').mockResolvedValue(undefined);
    return { items, take, finish };
  }

  function writtenStatuses(): Array<Record<string, unknown>> {
    return jest
      .mocked(redis.set)
      .mock.calls.filter(([key]) => key === COMMERCIAL_LLM_ENFORCEMENT_KEYS.status)
      .map(([, value]) => JSON.parse(String(value)) as Record<string, unknown>);
  }

  it.each([
    { label: 'automatic stabilization', allowed: true },
    { label: 'active MAX degradation', condition: 'max_api', allowed: false },
    { label: 'mixed degradation', condition: 'mixed', allowed: false },
    { label: 'manual maintenance', manual: true, allowed: false },
    { label: 'fresh queue pressure', lag: 3, allowed: false },
    { label: 'CPU pressure', load: 1.3, allowed: false },
    { label: 'IO pressure', ioWait: 0.4, allowed: false },
    { label: 'slow CPU admission', load: 0.9, allowed: false },
    { label: 'background MAX traffic pressure', share: 0.8, allowed: false },
  ] as const)(
    'restores classification during recovery while preserving $label',
    async (scenario) => {
      const mode: SystemModeSnapshot = {
        mode: 'degrade',
        source: 'manual' in scenario ? 'manual' : 'auto',
        condition:
          'manual' in scenario
            ? 'manual'
            : 'condition' in scenario
              ? scenario.condition
              : 'stabilizing',
        reason:
          'manual' in scenario
            ? 'maintenance'
            : 'condition' in scenario
              ? `${scenario.condition} pressure`
              : 'recovery window in progress',
        manualMode: 'manual' in scenario ? 'degrade' : null,
        updatedAt: new Date().toISOString(),
        queueLagSec: 0,
        action: {
          windowSec: 60,
          total: 100,
          success: 100,
          failure: 0,
          critical: 0,
          errorRate: 0,
          criticalRate: 0,
        },
      };
      const pressure = {
        mode,
        queues: { operationalLagSec: 'lag' in scenario ? scenario.lag : 0 },
        backgroundShare: 'share' in scenario ? scenario.share : 0,
        systemPressure: {
          enabled: true,
          cpuCount: 24,
          loadRatio1m: 'load' in scenario ? scenario.load : 0.1,
          ioWaitRatio: 'ioWait' in scenario ? scenario.ioWait : 0,
          thresholds: { loadSlow: 0.85, loadPause: 1.25, ioWaitSlow: 0.15, ioWaitPause: 0.35 },
        },
        workerSkew: { groupName: null, pressure: 0, totalPressure: 0, share: 0 },
      };
      const realGovernor = new BackgroundRuntimeGovernorService(
        {} as never,
        { getEffectiveSnapshot: jest.fn().mockResolvedValue(mode) } as never,
        {} as never,
        config,
      );
      jest
        .spyOn(
          realGovernor as unknown as { getPressureSnapshot(): Promise<typeof pressure> },
          'getPressureSnapshot',
        )
        .mockResolvedValue(pressure);
      governor.decide.mockImplementation((options) => realGovernor.decide(options));
      const run = jest
        .spyOn(CommercialLlmEnforcementProcessor.prototype, 'run')
        .mockResolvedValue({ outcome: 'idle' });

      runner!.onModuleInit();
      await jest.advanceTimersByTimeAsync(500);

      if (scenario.allowed) {
        expect(mailbox.advertise).toHaveBeenCalled();
        expect(run).toHaveBeenCalled();
        expect(mailbox.withdraw).not.toHaveBeenCalled();
      } else {
        expect(mailbox.withdraw).toHaveBeenCalled();
        expect(mailbox.advertise).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
      }
      expect(intents.ensureIntent).not.toHaveBeenCalled();
    },
  );

  it('identifies one observation generation without exposing its worker lease or declaring initial readiness', async () => {
    const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const job = pendingJob();
    const run = jest
      .spyOn(CommercialLlmEnforcementProcessor.prototype, 'run')
      .mockReturnValue(job.promise);
    runner!.onModuleInit();
    await jest.advanceTimersByTimeAsync(250);
    expect(writtenStatuses()).toHaveLength(1);
    const initial = writtenStatuses()[0]!;
    expect(initial).toMatchObject({
      schemaVersion: 2,
      observationProcessId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      observationStartedAt: '2026-10-27T09:00:00.000Z',
      heartbeatAt: '2026-10-27T09:00:00.250Z',
      lastSuccessAt: null,
      outcome: 'idle',
      active: 0,
      availabilityState: 'unknown',
      availabilityObservedAt: null,
      outcomeBasis: 'process_cumulative',
      outcomes: {},
      pendingDiscardBasis: 'redis_namespace_cumulative',
      pendingDiscards: {},
    });
    const worker = run.mock.calls[0]![0];
    expect(initial.observationProcessId).not.toBe(worker);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(writtenStatuses()).toHaveLength(2);
    expect(writtenStatuses()[1]).toMatchObject({
      observationProcessId: initial.observationProcessId,
      observationStartedAt: initial.observationStartedAt,
      heartbeatAt: '2026-10-27T09:00:10.250Z',
      lastSuccessAt: null,
      outcome: 'active',
      active: 3,
      availabilityState: 'ready',
      availabilityObservedAt: '2026-10-27T09:00:10.000Z',
      outcomes: {},
    });
    expect(run).toHaveBeenCalledTimes(3);
    expect(governor.decide).toHaveBeenCalledTimes(41);
    expect(shadowProcessor.commercialLlmHostHasHeadroom).toHaveBeenCalledTimes(41);
    const statusWrites: readonly (readonly unknown[])[] = jest.mocked(redis.set).mock.calls;
    expect(statusWrites.every((call) => call[2] === 'EX' && call[3] === 30)).toBe(true);
    expect(JSON.stringify(writtenStatuses())).not.toContain(worker);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(worker);
  });

  it.each([
    { action: 'pause' as const, headroom: true, state: 'governor_paused', headroomCalls: 0 },
    { action: 'slow' as const, headroom: true, state: 'governor_paused', headroomCalls: 0 },
    { action: 'run' as const, headroom: false, state: 'headroom_paused', headroomCalls: 41 },
  ])(
    'observes $action/$headroom without adding gate calls or starting work',
    async ({ action, headroom, state, headroomCalls }) => {
      governor.decide.mockResolvedValue({ action, reason: 'synthetic', retryAfterMs: 250 });
      jest.mocked(shadowProcessor.commercialLlmHostHasHeadroom).mockResolvedValue(headroom);
      const run = jest
        .spyOn(CommercialLlmEnforcementProcessor.prototype, 'run')
        .mockResolvedValue({ outcome: 'idle' });
      runner!.onModuleInit();
      await jest.advanceTimersByTimeAsync(10_250);
      expect(writtenStatuses()).toHaveLength(2);
      expect(writtenStatuses()[1]).toMatchObject({
        outcome: 'idle',
        active: 0,
        lastSuccessAt: null,
        availabilityState: state,
        availabilityObservedAt: '2026-10-27T09:00:10.000Z',
        outcomes: {},
      });
      expect(governor.decide).toHaveBeenCalledTimes(41);
      expect(shadowProcessor.commercialLlmHostHasHeadroom).toHaveBeenCalledTimes(headroomCalls);
      expect(mailbox.withdraw).toHaveBeenCalledTimes(41);
      expect(mailbox.advertise).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();

      governor.decide.mockResolvedValue({ action: 'run', reason: 'normal', retryAfterMs: 0 });
      jest.mocked(shadowProcessor.commercialLlmHostHasHeadroom).mockResolvedValue(true);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(writtenStatuses()[2]).toMatchObject({
        availabilityState: 'ready',
        availabilityObservedAt: '2026-10-27T09:00:20.000Z',
        active: 0,
        outcome: 'idle',
        lastSuccessAt: null,
        outcomes: {},
      });
      expect(run).toHaveBeenCalledTimes(40);
      expect(mailbox.advertise).toHaveBeenCalledTimes(40);
    },
  );

  it('keeps the last completed gate observation clock when a later gate check fails', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const run = jest
      .spyOn(CommercialLlmEnforcementProcessor.prototype, 'run')
      .mockResolvedValue({ outcome: 'idle' });
    runner!.onModuleInit();
    await jest.advanceTimersByTimeAsync(250);
    governor.decide.mockRejectedValue(new Error('Synthetic unavailable governor'));
    await jest.advanceTimersByTimeAsync(10_000);
    expect(writtenStatuses()[1]).toMatchObject({
      heartbeatAt: '2026-10-27T09:00:10.250Z',
      availabilityState: 'ready',
      availabilityObservedAt: '2026-10-27T09:00:00.250Z',
      lastSuccessAt: null,
      outcome: 'idle',
      outcomes: {},
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(shadowProcessor.commercialLlmHostHasHeadroom).toHaveBeenCalledTimes(1);
  });

  it('keeps heartbeats alive at three active jobs and admits a replacement only after completion', async () => {
    const jobs = [pendingJob(), pendingJob(), pendingJob(), pendingJob()];
    let next = 0;
    const run = jest
      .spyOn(CommercialLlmEnforcementProcessor.prototype, 'run')
      .mockImplementation(() => jobs[next++]?.promise ?? Promise.resolve({ outcome: 'idle' }));
    runner!.onModuleInit();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(mailbox.heartbeat).toHaveBeenCalledTimes(8);
    const worker = run.mock.calls[0]![0];
    expect(jest.mocked(mailbox.heartbeat).mock.calls.every(([value]) => value === worker)).toBe(
      true,
    );
    expect(mailbox.withdraw).not.toHaveBeenCalled();

    jobs[0]!.resolve({ outcome: 'kept' });
    await jest.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(4);
    expect(mailbox.heartbeat).toHaveBeenCalledTimes(9);
    expect(run.mock.calls[3]![0]).toBe(worker);
    expect(redis.disconnect).not.toHaveBeenCalled();
  });

  it('admits four pool jobs and keeps the fifth waiting until an actual completion', async () => {
    enablePool();
    const jobs = Array.from({ length: 5 }, () => pendingJob());
    let next = 0;
    const run = jest
      .spyOn(CommercialLlmEnforcementProcessor.prototype, 'run')
      .mockImplementation(() => jobs[next++]?.promise ?? Promise.resolve({ outcome: 'idle' }));
    runner!.onModuleInit();
    await jest.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(4);
    expect(mailbox.heartbeat).toHaveBeenCalledTimes(8);
    jobs[0]!.resolve({ outcome: 'kept' });
    await jest.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(5);
  });

  it('aborts and drains actual work before withdrawing the worker or closing Redis', async () => {
    const job = pendingJob();
    const run = jest
      .spyOn(CommercialLlmEnforcementProcessor.prototype, 'run')
      .mockReturnValue(job.promise);
    runner!.onModuleInit();
    await jest.advanceTimersByTimeAsync(250);
    const signal = run.mock.calls[0]![1];
    const closing = runner!.onModuleDestroy();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(signal.aborted).toBe(true);
    expect(closed).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(mailbox.heartbeat).toHaveBeenCalledTimes(1);
    expect(mailbox.withdraw).not.toHaveBeenCalled();
    expect(redis.disconnect).not.toHaveBeenCalled();

    job.resolve({ outcome: 'source_expired' });
    await closing;
    expect(closed).toBe(true);
    expect(mailbox.withdraw).toHaveBeenCalledWith(run.mock.calls[0]![0]);
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
    runner = null;
  });

  it('releases primary before waiting on 9B and lets an independent primary start', async () => {
    const firstSecondary = deferred<CommercialLlmObservationResult>();
    const secondPrimary =
      deferred<Awaited<ReturnType<CommercialLlmWorkstationMailbox['classify']>>>();
    cleanups.push(() => firstSecondary.resolve(negative));
    cleanups.push(() => secondPrimary.resolve({ outcome: 'COMPLETE', result: negative }));
    const first = source('first-chat');
    const second = source('second-chat');
    const sources = [first, second];
    let next = 0;
    const take = jest.spyOn(mailbox, 'take').mockImplementation(async (worker) => {
      const offered = sources[next++];
      if (!offered) return null;
      const request = { ...offered, submittedAtMs: Date.now(), worker };
      return { request, raw: JSON.stringify(request) };
    });
    jest.spyOn(mailbox, 'owns').mockResolvedValue(true);
    jest.spyOn(mailbox, 'ownsWorker').mockResolvedValue(true);
    const finish = jest.spyOn(mailbox, 'finish').mockResolvedValue(undefined);
    const primary = jest
      .spyOn(CommercialLlmWorkstationMailbox.prototype, 'classify')
      .mockResolvedValueOnce({
        outcome: 'COMPLETE',
        result: { ...negative, classification: 'UNSURE', reasonCodes: ['INSUFFICIENT_CONTEXT'] },
      })
      .mockReturnValueOnce(secondPrimary.promise);
    const secondary = jest
      .spyOn(CommercialLlmSecondaryScheduler.prototype, 'classifyWithin')
      .mockReturnValueOnce(firstSecondary.promise)
      .mockResolvedValue(negative);
    jest
      .spyOn(CommercialLlmSecondaryScheduler.prototype, 'classifyAudit')
      .mockResolvedValue(negative);

    runner!.onModuleInit();
    await jest.advanceTimersByTimeAsync(250);
    expect(secondary).toHaveBeenCalledTimes(1);
    const worker = take.mock.calls[0]![0];
    const releasedRaw = jest.mocked(mailbox.releasePrimary).mock.calls[0]![0];
    expect(JSON.parse(releasedRaw).source.chatId).toBe('first-chat');
    expect(mailbox.releasePrimary).toHaveBeenCalledWith(releasedRaw, worker);
    expect(mailbox.claimSecondary).toHaveBeenCalledWith(releasedRaw, worker);
    expect(mailbox.releaseSecondary).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(jest.mocked(mailbox.releasePrimary).mock.invocationCallOrder[0]).toBeLessThan(
      secondary.mock.invocationCallOrder[0]!,
    );

    await jest.advanceTimersByTimeAsync(250);
    expect(primary).toHaveBeenCalledTimes(2);
    expect(take.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(finish).not.toHaveBeenCalledWith(releasedRaw, worker);
    expect(mailbox.releasePrimary).toHaveBeenCalledTimes(1);
    expect(intents.ensureIntent).not.toHaveBeenCalled();

    firstSecondary.resolve(negative);
    secondPrimary.resolve({ outcome: 'COMPLETE', result: negative });
    await jest.advanceTimersByTimeAsync(0);
    expect(mailbox.releaseSecondary).toHaveBeenCalledWith(releasedRaw, worker);
    expect(finish).toHaveBeenCalledWith(releasedRaw, worker);
  });

  it.each(['confirmation', 'audit'] as const)(
    'claims the exact source for %s and releases it when server work fails',
    async (path) => {
      const offered = offeredSources([source('reserved-chat')]);
      jest.mocked(randomInt).mockImplementation(() => (path === 'audit' ? 0 : 1));
      jest.spyOn(CommercialLlmWorkstationMailbox.prototype, 'classify').mockResolvedValue({
        outcome: 'COMPLETE',
        result:
          path === 'audit'
            ? negative
            : { ...negative, classification: 'UNSURE', reasonCodes: ['INSUFFICIENT_CONTEXT'] },
      });
      const within = jest
        .spyOn(CommercialLlmSecondaryScheduler.prototype, 'classifyWithin')
        .mockRejectedValue(new Error('Synthetic server failure'));
      const audit = jest
        .spyOn(CommercialLlmSecondaryScheduler.prototype, 'classifyAudit')
        .mockRejectedValue(new Error('Synthetic server failure'));

      runner!.onModuleInit();
      await jest.advanceTimersByTimeAsync(250);
      const { raw, request } = offered.items[0]!;
      const invoked = path === 'audit' ? audit : within;
      const unused = path === 'audit' ? within : audit;
      expect(mailbox.claimSecondary).toHaveBeenCalledWith(raw, request.worker);
      expect(invoked).toHaveBeenCalledTimes(1);
      expect(unused).not.toHaveBeenCalled();
      expect(jest.mocked(mailbox.claimSecondary).mock.invocationCallOrder[0]).toBeLessThan(
        invoked.mock.invocationCallOrder[0]!,
      );
      expect(mailbox.releaseSecondary).toHaveBeenCalledWith(raw, request.worker);
      expect(offered.finish).toHaveBeenCalledWith(raw, request.worker);
      expect(jest.mocked(mailbox.releaseSecondary).mock.invocationCallOrder[0]).toBeLessThan(
        offered.finish.mock.invocationCallOrder[0]!,
      );
      expect(intents.ensureIntent).not.toHaveBeenCalled();
    },
  );

  it.each(['confirmation', 'audit'] as const)(
    'does not enter %s or release another source after chat reservation refusal',
    async (path) => {
      const offered = offeredSources([source('occupied-chat')]);
      jest.mocked(randomInt).mockImplementation(() => (path === 'audit' ? 0 : 1));
      jest.mocked(mailbox.claimSecondary).mockResolvedValue(false);
      jest.spyOn(CommercialLlmWorkstationMailbox.prototype, 'classify').mockResolvedValue({
        outcome: 'COMPLETE',
        result:
          path === 'audit'
            ? negative
            : { ...negative, classification: 'UNSURE', reasonCodes: ['INSUFFICIENT_CONTEXT'] },
      });
      const within = jest.spyOn(CommercialLlmSecondaryScheduler.prototype, 'classifyWithin');
      const audit = jest.spyOn(CommercialLlmSecondaryScheduler.prototype, 'classifyAudit');

      runner!.onModuleInit();
      await jest.advanceTimersByTimeAsync(250);
      const { raw, request } = offered.items[0]!;
      expect(mailbox.claimSecondary).toHaveBeenCalledWith(raw, request.worker);
      expect(within).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
      expect(mailbox.releaseSecondary).not.toHaveBeenCalled();
      expect(offered.finish).toHaveBeenCalledWith(raw, request.worker);
      expect(intents.ensureIntent).not.toHaveBeenCalled();
    },
  );

  it('preserves a chat reservation across secondary scheduler replacement after Redis reconnect', async () => {
    const firstResult = deferred<CommercialLlmObservationResult>();
    cleanups.push(() => firstResult.resolve(negative));
    const offered = offeredSources([
      source('same-chat', 'first-message'),
      source('same-chat', 'next-message'),
    ]);
    const reservations = new Map<string, string>();
    jest.mocked(mailbox.claimSecondary).mockImplementation(async (raw) => {
      const request = JSON.parse(raw) as MailboxItem['request'];
      if (reservations.has(request.source.chatId)) return false;
      reservations.set(request.source.chatId, raw);
      return true;
    });
    jest.mocked(mailbox.releaseSecondary).mockImplementation(async (raw) => {
      const request = JSON.parse(raw) as MailboxItem['request'];
      if (reservations.get(request.source.chatId) !== raw) return false;
      return reservations.delete(request.source.chatId);
    });
    jest.spyOn(CommercialLlmWorkstationMailbox.prototype, 'classify').mockResolvedValue({
      outcome: 'COMPLETE',
      result: { ...negative, classification: 'UNSURE', reasonCodes: ['INSUFFICIENT_CONTEXT'] },
    });
    const within = jest
      .spyOn(CommercialLlmSecondaryScheduler.prototype, 'classifyWithin')
      .mockReturnValue(firstResult.promise);

    runner!.onModuleInit();
    await jest.advanceTimersByTimeAsync(250);
    const first = offered.items[0]!;
    expect(reservations.get('same-chat')).toBe(first.raw);
    expect(mailbox.releaseSecondary).not.toHaveBeenCalled();
    redis.status = 'end';
    jest.mocked(redis.connect).mockImplementationOnce(async () => {
      redis.status = 'ready';
    });
    await jest.advanceTimersByTimeAsync(250);
    const next = offered.items[1]!;
    expect(shadowLease.createCommercialLlmRedis).toHaveBeenCalledTimes(2);
    expect(mailbox.claimSecondary).toHaveBeenCalledTimes(2);
    expect(within).toHaveBeenCalledTimes(1);
    expect(reservations.get('same-chat')).toBe(first.raw);
    expect(mailbox.releaseSecondary).not.toHaveBeenCalled();
    expect(offered.finish).toHaveBeenCalledWith(next.raw, next.request.worker);
    expect(offered.finish).not.toHaveBeenCalledWith(first.raw, first.request.worker);

    firstResult.resolve(negative);
    await jest.advanceTimersByTimeAsync(0);
    expect(mailbox.releaseSecondary).toHaveBeenCalledWith(first.raw, first.request.worker);
    expect(reservations.size).toBe(0);
    expect(offered.finish).toHaveBeenCalledWith(first.raw, first.request.worker);
    expect(intents.ensureIntent).not.toHaveBeenCalled();
  });
});
