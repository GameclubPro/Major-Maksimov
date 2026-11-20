import type { HousekeepingHealth } from './housekeeping.js';
import {
  HTTP_PURPOSES,
  RIGHTS_OUTCOMES,
  RIGHTS_SOURCES,
  type TransportMetrics,
} from './telemetry.js';

type WorkerSample = {
  healthy: boolean;
  occupiedSlots: number;
  lastCompletedAt: string | null;
};
type ProgressSample = {
  schedulerHealthy: boolean;
  housekeeping?: HousekeepingHealth;
  workers?: { cleanup: WorkerSample; connection: WorkerSample };
};
type SchedulerCode =
  | 'cleanup_scheduler_failed'
  | 'connection_scheduler_failed'
  | 'housekeeping_failed';

// FLAG: One bounded progress event and one scheduler-error event per 30 seconds. Build
// records from scalar allowlists; queue payloads, error text and MAX paths never enter logs.
export class ProgressLog {
  private lastProgressAt = -Infinity;
  private lastErrorAt = -Infinity;
  private lastProgress = '';
  constructor(
    private readonly write: (line: string) => void = (line) => {
      process.stdout.write(line);
    },
    private readonly now: () => number = () => Date.now(),
  ) {}
  private emit(event: Record<string, unknown>): void {
    try {
      this.write(
        JSON.stringify({
          service: 'eraser',
          observedAt: new Date(this.now()).toISOString(),
          ...event,
        }) + '\n',
      );
    } catch {
      // Logging failure grants no effect authority and must not replace the worker result.
    }
  }
  failure(code: SchedulerCode): void {
    if (this.now() - this.lastErrorAt < 30_000) return;
    this.lastErrorAt = this.now();
    this.emit({ event: 'scheduler_error', code });
  }
  progress(health: ProgressSample, metrics?: TransportMetrics): void {
    if (this.now() - this.lastProgressAt < 30_000) return;
    const worker = (sample: WorkerSample) => ({
      healthy: sample.healthy,
      occupiedSlots: sample.occupiedSlots,
      lastCompletedAt: sample.lastCompletedAt,
    });
    const event = {
      event: 'runtime_progress',
      schedulerHealthy: health.schedulerHealthy,
      ...(health.housekeeping
        ? {
            housekeeping: {
              lastSuccessfulAt: health.housekeeping.lastSuccessfulAt,
              lastErrorCode: health.housekeeping.lastErrorCode,
              lastDurationMs: health.housekeeping.lastDurationMs,
              candidatesDeleted: health.housekeeping.rows.candidates,
              receiptsDeleted: health.housekeeping.rows.receipts,
              budgetExhausted: health.housekeeping.budgetExhausted,
              backlogObservedAt: health.housekeeping.backlogObservedAt,
              oldestExpiredCandidateAt: health.housekeeping.oldestExpiredCandidateAt,
              oldestExpiredReceiptAt: health.housekeeping.oldestExpiredReceiptAt,
            },
          }
        : {}),
      ...(health.workers
        ? {
            workers: {
              cleanup: worker(health.workers.cleanup),
              connection: worker(health.workers.connection),
            },
          }
        : {}),
      ...(metrics
        ? {
            transport: {
              scope: metrics.scope,
              since: metrics.since,
              rightsResponses: RIGHTS_SOURCES.flatMap((source) => {
                const row = metrics.rightsResponses.find((sample) => sample.source === source);
                if (!row) return [];
                return [
                  { source, ...Object.fromEntries(RIGHTS_OUTCOMES.map((key) => [key, row[key]])) },
                ];
              }),
              requests: HTTP_PURPOSES.flatMap((purpose) => {
                const row = metrics.requests.find((request) => request.purpose === purpose);
                return row
                  ? [
                      {
                        purpose,
                        attempts: row.attempts,
                        responses: row.responses,
                        httpSuccesses: row.httpSuccesses,
                        rateLimited: row.rateLimited,
                        transportErrors: row.transportErrors,
                      },
                    ]
                  : [];
              }),
              cooldownDeferrals: metrics.cooldownDeferrals,
              admissionUnavailable: metrics.admissionUnavailable,
              guardRejected: metrics.guardRejected,
              deleteAcknowledged: metrics.deleteAcknowledged,
              observedCooldownUntil: metrics.observedCooldownUntil,
            },
          }
        : {}),
    };
    const signature = JSON.stringify(event);
    if (signature === this.lastProgress) return;
    this.lastProgress = signature;
    this.lastProgressAt = this.now();
    this.emit(event);
  }
}
