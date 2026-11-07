import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getAppRole, roleRunsAdmin } from '../runtime/app-role';
import { GlobalSpammerIntelligenceService } from './global-spammer-intelligence.service';
import { CommercialReviewService } from './commercial/commercial-review.service';

const DEFAULT_ARCHIVE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_ARCHIVE_LIMIT = 1000;

@Injectable()
export class GlobalSpammerArchiveRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GlobalSpammerArchiveRunnerService.name);
  private readonly enabled: boolean;
  private readonly archiveEnabled: boolean;
  private readonly intervalMs: number;
  private readonly limit: number;
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly globalSpammerIntelligence: GlobalSpammerIntelligenceService,
    configService: ConfigService,
    @Optional() private readonly commercialReview?: CommercialReviewService,
  ) {
    this.enabled = roleRunsAdmin(getAppRole());
    this.archiveEnabled = configService.get<boolean>('GLOBAL_SPAMMER_ARCHIVE_RUNNER_ENABLED', true);
    this.intervalMs = Math.max(
      60_000,
      configService.get<number>('GLOBAL_SPAMMER_ARCHIVE_INTERVAL_MS', DEFAULT_ARCHIVE_INTERVAL_MS),
    );
    this.limit = Math.max(
      1,
      Math.min(
        configService.get<number>('GLOBAL_SPAMMER_ARCHIVE_LIMIT', DEFAULT_ARCHIVE_LIMIT),
        5000,
      ),
    );
  }

  onModuleInit(): void {
    if (!this.enabled) {
      return;
    }

    this.timer = setInterval(() => {
      void this.run('scheduled');
    }, this.intervalMs);
    this.timer.unref?.();

    this.startupTimer = setTimeout(
      () => {
        void this.run('startup');
      },
      Math.min(60_000, this.intervalMs),
    );
    this.startupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  private async run(reason: 'startup' | 'scheduled'): Promise<void> {
    if (!this.enabled || this.inFlight) {
      return;
    }

    this.inFlight = true;
    try {
      // FLAG: Sanitized review retention is independent of reputation archival toggles and runs
      // only on the existing admin maintenance lane, with at most five bounded batches.
      let prunedReviewSamples = 0;
      try {
        for (let batch = 0; this.commercialReview && batch < 5; batch += 1) {
          const pruned = await this.commercialReview.pruneExpired(this.limit);
          prunedReviewSamples += pruned;
          if (pruned < this.limit) break;
        }
      } catch {
        this.logger.warn({ reason }, 'Commercial review retention unavailable');
      }
      if (prunedReviewSamples > 0)
        this.logger.log(
          { reason, prunedReviewSamples },
          'Pruned expired commercial review samples',
        );
      if (!this.archiveEnabled) return;
      const result = await this.globalSpammerIntelligence.archiveExpiredRegistryEntries({
        limit: this.limit,
        // FLAG: Scheduled maintenance must not scan the full backlog just for its log.
        // null means unmeasured; the explicit operator CLI retains an exact count by default.
        countRemainingExpired: false,
      });
      const pruneResult = await this.globalSpammerIntelligence.pruneExpiredRawEvidence({
        limit: this.limit,
      });
      if (
        result.archived > 0 ||
        result.deleted > 0 ||
        (result.remainingExpired !== null && result.remainingExpired > 0)
      ) {
        this.logger.log(
          {
            reason,
            archived: result.archived,
            deleted: result.deleted,
            remainingExpired: result.remainingExpired,
          },
          'Archived expired global spammer registry rows',
        );
      }
      if (pruneResult.pruned > 0) {
        this.logger.log(
          {
            reason,
            scanned: pruneResult.scanned,
            pruned: pruneResult.pruned,
            failed: pruneResult.failed ?? 0,
          },
          'Pruned expired global spammer raw evidence',
        );
      }
      if ((pruneResult.failed ?? 0) > 0) {
        this.logger.warn(
          {
            reason,
            scanned: pruneResult.scanned,
            pruned: pruneResult.pruned,
            failed: pruneResult.failed,
            failedIds: pruneResult.failedIds ?? [],
          },
          'Some expired global spammer raw evidence rows could not be pruned',
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          reason,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to archive expired global spammer registry rows',
      );
    } finally {
      this.inFlight = false;
    }
  }
}
