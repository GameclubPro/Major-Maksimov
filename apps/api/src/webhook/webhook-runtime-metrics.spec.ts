import {
  addWebhookMetric,
  classifyWebhookPreparationError,
  sanitizeWebhookOutboxSnapshot,
  sanitizeWebhookPreparationSnapshot,
  WebhookOutboxRuntimeMetrics,
  WEBHOOK_OUTBOX_STAGES,
  WEBHOOK_RETENTION_PHASES,
  WEBHOOK_PREPARATION_ERROR_REASONS,
} from './webhook-runtime-metrics';
import { WebhookPreparationAdmission } from './webhook-preparation-admission';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import { WebhookExecutionOwnerUnavailableError } from '../common/webhook-execution-owner-unavailable.error';

const retentionConfig = {
  webhookCompletedRetentionEnabled: false,
  webhookFailedRetentionEnabled: false,
  webhookRetentionDays: 7,
  webhookFailedRetentionHours: 24,
  moderationRetentionDays: 90,
  userDisplayNameRetentionDays: 180,
};

function webhookOutboxSnapshot() {
  const metrics = new WebhookOutboxRuntimeMetrics();
  return {
    ...metrics,
    inFlightWorkUnits: 0,
    retention: {
      ...metrics.retention,
      config: retentionConfig,
      cleaning: false,
      maintenancePending: false,
    },
  };
}

describe('fixed cumulative webhook telemetry', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [new WebhookPreparationDeferredError('private-wait'), 'preparationDeferred'],
    [new WebhookExecutionOwnerUnavailableError('private-owner'), 'ownerUnavailable'],
    [{ code: 'P2002' }, 'databaseConflict'],
    [{ code: 'P2034' }, 'databaseConflict'],
    [{ code: 'P2024' }, 'databaseTimeout'],
    [{ code: 'P2010', meta: { code: '40P01', message: 'private-sql' } }, 'databaseConflict'],
    [{ code: 'P2010', meta: { code: '55P03' } }, 'databaseOther'],
    [{ code: '57014' }, 'databaseOther'],
    [{ code: 'P1001' }, 'databaseConnection'],
    [{ code: 'P2028' }, 'databaseOther'],
    [{ code: 'ETIMEDOUT' }, 'dependencyFailure'],
    [{ code: 'ECONNRESET' }, 'dependencyFailure'],
    [{ code: 'private-unrecognized-code', message: 'P2024' }, 'unclassified'],
    [null, 'unclassified'],
    [undefined, 'unclassified'],
  ])('classifies only fixed preparation reasons (%p)', (error, expected) => {
    expect(classifyWebhookPreparationError(error)).toBe(expected);
  });

  it('attributes recognized dependency codes inside typed deferrals with bounded cause reads', () => {
    const failure = new WebhookPreparationDeferredError('private-wait', 1_000, {
      cause: { code: 'P2010', meta: { code: '23505' } },
    });
    expect(classifyWebhookPreparationError(failure)).toBe('databaseConflict');
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    expect(classifyWebhookPreparationError(cycle)).toBe('unclassified');
    const tooDeep = { cause: { cause: { cause: { cause: { code: 'P2024' } } } } };
    expect(classifyWebhookPreparationError(tooDeep)).toBe('unclassified');
    const unreadable = Object.defineProperty({}, 'code', {
      get() {
        throw new Error('private-getter');
      },
    });
    expect(classifyWebhookPreparationError(unreadable)).toBe('unclassified');
    expect(
      classifyWebhookPreparationError(
        new WebhookPreparationDeferredError('private-wait', 1_000, unreadable),
      ),
    ).toBe('preparationDeferred');
  });

  it('keeps missing, corrupt or inconsistent reason coverage unknown without losing base counters', async () => {
    const admission = new WebhookPreparationAdmission(4, jest.fn());
    await expect(
      admission.run('private-bot', 'ordinary', async () => {
        throw { code: 'P2024', message: 'private-timeout' };
      }),
    ).rejects.toMatchObject({ code: 'P2024' });
    const source = admission.runtimeSnapshot();
    const snapshot = sanitizeWebhookPreparationSnapshot({
      ...source,
      errorReasons: Object.assign([...source.errorReasons], { privateLabel: 123 }),
    })!;
    expect(snapshot).toMatchObject({
      errors: { ordinary: 1 },
      errorReasons: [0, 0, 0, 1, 0, 0, 0, 0],
    });
    expect(JSON.stringify(snapshot)).not.toContain('private');
    expect(snapshot.errorReasons).toHaveLength(WEBHOOK_PREPARATION_ERROR_REASONS.length);
    source.errorReasons[3] = 0;
    for (const errorReasons of [
      undefined,
      null,
      {},
      source.errorReasons,
      [-1, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 1, 0, 0, 0, 0, 0],
      Array(8),
    ]) {
      expect(sanitizeWebhookPreparationSnapshot({ ...source, errorReasons })).toMatchObject({
        errors: { ordinary: 1 },
        duration: { calls: 1, errors: 1 },
        errorReasons: null,
      });
    }
    expect(
      sanitizeWebhookPreparationSnapshot({
        ...source,
        get errorReasons() {
          throw new Error('private-provider');
        },
      }),
    ).toMatchObject({ errors: { ordinary: 1 }, errorReasons: null });
    expect(snapshot).toMatchObject({ errorReasons: [0, 0, 0, 1, 0, 0, 0, 0] });
  });

  it('records failed and successful timing populations once with monotonic clocks', () => {
    const metrics = new WebhookOutboxRuntimeMetrics();
    jest.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(620);
    const finish = metrics.startTiming('selection');
    finish(true);
    finish();
    expect(metrics.stages.selection).toEqual({
      calls: 1,
      errors: 1,
      totalMs: 520,
      maxMs: 520,
      unknownClocks: 0,
      buckets: { under100Ms: 0, under500Ms: 0, under2000Ms: 1, atLeast2000Ms: 0 },
    });
    jest.spyOn(performance, 'now').mockReturnValueOnce(200).mockReturnValueOnce(100);
    metrics.startTiming('admission')();
    expect(metrics.stages.admission).toMatchObject({
      calls: 1,
      unknownClocks: 1,
      totalMs: 0,
    });
  });

  it('keeps retention outcomes bounded and ignores unknown phases', () => {
    const metrics = new WebhookOutboxRuntimeMetrics();
    metrics.finishRetentionPhase(
      'webhookProcessedOrDuplicate',
      {
        rows: 3,
        scannedRows: 500,
        batches: 1,
        durationMs: 20,
        budgetExhausted: false,
      },
      true,
    );
    metrics.finishRetentionPhase('private-phase', {
      rows: 999,
      scannedRows: 999,
      batches: 99,
      durationMs: 999,
      budgetExhausted: true,
    });
    expect(Object.keys(metrics.retention.phases)).toEqual(WEBHOOK_RETENTION_PHASES);
    expect(metrics.retention.phases.webhookProcessedOrDuplicate).toMatchObject({
      calls: 1,
      errors: 1,
      removed: 3,
      scanned: 500,
      batches: 1,
      budgetHits: 0,
    });
    expect(addWebhookMetric(Number.MAX_SAFE_INTEGER - 1, 20)).toBe(Number.MAX_SAFE_INTEGER);
    expect(addWebhookMetric(7, NaN)).toBe(7);
  });

  it('keeps row outcomes when a retention timing clock is unavailable', () => {
    const metrics = new WebhookOutboxRuntimeMetrics();
    metrics.finishRetentionPhase('voiceSources', {
      rows: 3,
      scannedRows: 4,
      batches: 1,
      durationMs: NaN,
      budgetExhausted: false,
    });
    expect(metrics.retention).toMatchObject({
      unknownClocks: 1,
      phases: { voiceSources: { calls: 1, removed: 3, scanned: 4, totalMs: 0 } },
    });
  });

  it.each([null, undefined, [], true, 7, 'bad', { retention: [] }, { stages: { selection: [] } }])(
    'keeps malformed optional telemetry unavailable (%p)',
    (value) => {
      expect(() => sanitizeWebhookOutboxSnapshot(value)).not.toThrow();
      expect(sanitizeWebhookOutboxSnapshot(value)).toBeNull();
      expect(() => sanitizeWebhookPreparationSnapshot(value)).not.toThrow();
      expect(sanitizeWebhookPreparationSnapshot(value)).toBeNull();
    },
  );

  it('isolates throwing property readers from malformed providers', () => {
    const broken = {
      get inFlightWorkUnits() {
        throw new Error('private-provider');
      },
    };
    expect(sanitizeWebhookOutboxSnapshot(broken)).toBeNull();
    const preparation = {
      get maxInFlight() {
        throw new Error('private-provider');
      },
    };
    expect(sanitizeWebhookPreparationSnapshot(preparation)).toBeNull();
  });

  it('drops arbitrary labels and marks corrupt or absent additive blocks unavailable', () => {
    const source = webhookOutboxSnapshot();
    const snapshot = sanitizeWebhookOutboxSnapshot({
      ...source,
      payload: 'private',
      stages: { ...source.stages, 'private-stage': source.stages.selection },
      retention: {
        ...source.retention,
        phases: { ...source.retention.phases, 'private-phase': {} },
      },
    })!;
    expect(Object.keys(snapshot.stages)).toEqual(WEBHOOK_OUTBOX_STAGES);
    expect(JSON.stringify(snapshot)).not.toContain('private');
    source.progress.prepared = 2;
    expect(snapshot.progress.prepared).toBe(0);
    expect(sanitizeWebhookOutboxSnapshot(undefined)).toBeNull();
    expect(sanitizeWebhookOutboxSnapshot({ ...source, selectedCount: -1 })).toBeNull();
    const preparation = new WebhookPreparationAdmission(4, jest.fn()).runtimeSnapshot();
    expect(sanitizeWebhookPreparationSnapshot({ ...preparation, admitted: null })).toBeNull();
    expect(sanitizeWebhookPreparationSnapshot(undefined)).toBeNull();
  });
});
