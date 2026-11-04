import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  PublisherAutoReplyDeliveryStatus,
  Prisma,
  type PublisherAutoReplyDelivery,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';
import { PublisherDispatchHealthService } from './publisher-dispatch-health.service';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import { PublisherAutoReplyQueueService } from './publisher-auto-reply.queue';
import {
  buildPublisherAutoReplyUploadRecoveryQuery,
  type PublisherAutoReplyUploadRecoveryCursor,
  type PublisherAutoReplyUploadRecoveryRow,
} from './publisher-auto-reply-upload-recovery';

const RECOVERY_STARTUP_DELAY_MS = 8_000;
const RECOVERY_INTERVAL_MS = 30_000;
const STALE_LEASE_MS = 2 * 60_000;
const RECOVERY_BATCH_SIZE = 100;
const RECOVERY_ADMISSION_BUDGET_MS = 5_000;

type DeliveryRecoveryFamily = 'pending' | 'sending' | 'sending_null';
type DeliveryRecoveryCursor = { at: Date | null; id: string };
type DeliveryRecoveryCycle = { cutoff: Date; cursor: DeliveryRecoveryCursor | null };
type DeliveryRecoveryRow = Pick<
  PublisherAutoReplyDelivery,
  'id' | 'status' | 'dueAt' | 'lockedAt' | 'lockToken' | 'dispatchStartedAt'
>;
const DELIVERY_RECOVERY_FAMILIES: readonly DeliveryRecoveryFamily[] = [
  'pending',
  'sending',
  'sending_null',
];

function deliveryRecoveryQuery(
  family: DeliveryRecoveryFamily,
  cycle: DeliveryRecoveryCycle,
  take: number,
): Prisma.Sql {
  const { cutoff, cursor } = cycle;
  const eligibility =
    family === 'pending'
      ? Prisma.sql`status = 'PENDING' AND due_at <= ${cutoff}`
      : family === 'sending'
        ? Prisma.sql`status = 'SENDING' AND locked_at <= ${cutoff}`
        : Prisma.sql`status = 'SENDING' AND locked_at IS NULL`;
  const order =
    family === 'pending'
      ? Prisma.sql`due_at, id`
      : family === 'sending'
        ? Prisma.sql`locked_at, id`
        : Prisma.sql`locked_at, id`;
  const after = !cursor
    ? Prisma.empty
    : family === 'pending'
      ? Prisma.sql`AND (due_at, id) > (${cursor.at}, ${cursor.id})`
      : family === 'sending'
        ? Prisma.sql`AND (locked_at, id) > (${cursor.at}, ${cursor.id})`
        : Prisma.sql`AND id > ${cursor.id}`;
  const cursorAt = family === 'pending' ? Prisma.sql`due_at` : Prisma.sql`locked_at`;
  // FLAG: Each family seeks its own indexed eligibility range. A single dueAt
  // cursor cannot fairly seek stale leases with unrelated due dates.
  // FLAG: Select covered keys before fetching metadata: a wide projection can make
  // PostgreSQL prefer an old prefix index and sort an entire timestamp tie.
  return Prisma.sql`
    WITH candidates AS MATERIALIZED (
      SELECT id, ${cursorAt} AS "cursorAt"
      FROM publisher_auto_reply_deliveries
      WHERE ${eligibility} ${after}
      ORDER BY ${order}
      LIMIT ${take}
    )
    SELECT delivery.*
    FROM candidates
    CROSS JOIN LATERAL (
      SELECT id, status, due_at AS "dueAt", locked_at AS "lockedAt",
        lock_token AS "lockToken", dispatch_started_at AS "dispatchStartedAt"
      FROM publisher_auto_reply_deliveries
      WHERE id = candidates.id
      LIMIT 1
    ) AS delivery
    ORDER BY candidates."cursorAt", candidates.id`;
}

export type PublisherAutoReplyRecoveryResult = {
  scanned: number;
  alreadyLive: number;
  addAcknowledged: number;
  reset: number;
  ambiguous: number;
  uploadsReset: number;
  errors: number;
  alreadyRunning: boolean;
  budgetExhausted: boolean;
};

@Injectable()
export class PublisherAutoReplyRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherAutoReplyRecoveryService.name);
  private startupTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<PublisherAutoReplyRecoveryResult> | null = null;
  private readonly deliveryCycles: Partial<Record<DeliveryRecoveryFamily, DeliveryRecoveryCycle>> =
    {};
  private nextDeliveryFamily = 0;
  private uploadCursor: PublisherAutoReplyUploadRecoveryCursor | null = null;
  private uploadCutoff: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PublisherAutoReplyQueueService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly backgroundWork: PublisherBackgroundWorkCoordinatorService,
  ) {}

  onModuleInit(): void {
    if (!this.runtimeBoundary.dispatchEnabled) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      this.trigger();
    }, RECOVERY_STARTUP_DELAY_MS);
    this.startupTimer.unref();
    this.intervalTimer = setInterval(() => this.trigger(), RECOVERY_INTERVAL_MS);
    this.intervalTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.startupTimer = null;
    this.intervalTimer = null;
  }

  async recoverOnce(now = new Date()): Promise<PublisherAutoReplyRecoveryResult> {
    if (this.inFlight) {
      return { ...(await this.inFlight), alreadyRunning: true };
    }
    const run = this.backgroundWork.runExclusive('auto_reply_recovery', () =>
      this.recoverBatch(now),
    );
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  private async recoverBatch(now: Date): Promise<PublisherAutoReplyRecoveryResult> {
    const result: PublisherAutoReplyRecoveryResult = {
      scanned: 0,
      alreadyLive: 0,
      addAcknowledged: 0,
      reset: 0,
      ambiguous: 0,
      uploadsReset: 0,
      errors: 0,
      alreadyRunning: false,
      budgetExhausted: false,
    };
    const admissionDeadline = performance.now() + RECOVERY_ADMISSION_BUDGET_MS;
    const staleBefore = new Date(now.getTime() - STALE_LEASE_MS);
    const firstFamily = this.nextDeliveryFamily;
    this.nextDeliveryFamily = (firstFamily + 1) % DELIVERY_RECOVERY_FAMILIES.length;
    for (let offset = 0; offset < DELIVERY_RECOVERY_FAMILIES.length; offset += 1) {
      if (result.scanned >= RECOVERY_BATCH_SIZE) break;
      if (performance.now() >= admissionDeadline) {
        result.budgetExhausted = true;
        break;
      }
      const family =
        DELIVERY_RECOVERY_FAMILIES[(firstFamily + offset) % DELIVERY_RECOVERY_FAMILIES.length]!;
      // Keep each range's cutoff stable until wrap so new future work cannot
      // extend a cycle indefinitely ahead of rows inserted behind its cursor.
      const cycle = (this.deliveryCycles[family] ??= {
        cutoff: family === 'pending' ? now : staleBefore,
        cursor: null,
      });
      const take = RECOVERY_BATCH_SIZE - result.scanned;
      const deliveries = await this.prisma.$queryRaw<DeliveryRecoveryRow[]>(
        deliveryRecoveryQuery(family, cycle, take),
      );
      let considered = 0;

      for (const delivery of deliveries) {
        if (performance.now() >= admissionDeadline) {
          result.budgetExhausted = true;
          break;
        }
        result.scanned += 1;
        considered += 1;
        try {
          if (
            delivery.status === PublisherAutoReplyDeliveryStatus.SENDING &&
            delivery.dispatchStartedAt
          ) {
            const updated = await this.prisma.publisherAutoReplyDelivery.updateMany({
              where: {
                id: delivery.id,
                status: PublisherAutoReplyDeliveryStatus.SENDING,
                lockedAt: delivery.lockedAt,
                lockToken: delivery.lockToken,
                dispatchStartedAt: delivery.dispatchStartedAt,
              },
              data: {
                status: PublisherAutoReplyDeliveryStatus.AMBIGUOUS,
                lockedAt: null,
                lockToken: null,
                failureCode: 'STALE_SEND_FENCE',
                failureMessage: null,
              },
            });
            result.ambiguous += updated.count;
            continue;
          }
          if (delivery.status === PublisherAutoReplyDeliveryStatus.SENDING) {
            const reset = await this.prisma.publisherAutoReplyDelivery.updateMany({
              where: {
                id: delivery.id,
                status: PublisherAutoReplyDeliveryStatus.SENDING,
                dispatchStartedAt: null,
                lockedAt: delivery.lockedAt,
                lockToken: delivery.lockToken,
              },
              data: {
                status: PublisherAutoReplyDeliveryStatus.PENDING,
                lockedAt: null,
                lockToken: null,
                failureCode: 'STALE_PREPARATION_LEASE',
                failureMessage: null,
              },
            });
            if (reset.count !== 1) continue;
            result.reset += 1;
          }
          // FLAG: Admission may exceed the soft budget while its result is unknown.
          // Await it to completion; never release the coordinator or replay the call.
          const ensured = await this.queue.ensureDeliveryJob(delivery.id, delivery.dueAt);
          if (ensured.outcome === 'already_live') result.alreadyLive += 1;
          else result.addAcknowledged += 1;
        } catch (error: unknown) {
          result.errors += 1;
          this.logger.warn(
            { deliveryId: delivery.id, code: this.errorCode(error) },
            'Failed to recover Publisher auto-reply delivery',
          );
        } finally {
          // FLAG: Live jobs, lost CAS and failures all consume this cursor position.
          // Unvisited rows stay ahead of the cursor when the admission budget ends.
          cycle.cursor = {
            at: family === 'pending' ? delivery.dueAt : delivery.lockedAt,
            id: delivery.id,
          };
        }
      }
      if (considered === deliveries.length && deliveries.length < take) {
        delete this.deliveryCycles[family];
      }
    }
    // One bounded upload phase still runs after delivery admission exhausts its budget.
    this.uploadCutoff ??= staleBefore;
    const [uploads] = await this.prisma.$queryRaw<PublisherAutoReplyUploadRecoveryRow[]>(
      buildPublisherAutoReplyUploadRecoveryQuery(now, this.uploadCutoff, this.uploadCursor),
    );
    result.uploadsReset = Number(uploads!.changed_count);
    // FLAG: Skipped locks also consume a candidate position. Advance only after
    // the complete SQL statement succeeds; do not wait forever on a locked prefix.
    if (Number(uploads!.candidate_count) < RECOVERY_BATCH_SIZE) {
      this.uploadCursor = null;
      this.uploadCutoff = null;
    } else {
      this.uploadCursor = {
        id: uploads!.last_id!,
        lockedAt: uploads!.last_locked_at,
        updatedAt: uploads!.last_updated_at!,
      };
    }
    result.budgetExhausted ||= performance.now() >= admissionDeadline;
    return result;
  }

  private async runScheduled(): Promise<void> {
    if (await this.dispatchHealth.isGloballyPaused()) return;
    await this.identityAttestation.assertAttested();
    const result = await this.recoverOnce();
    if (
      result.addAcknowledged ||
      result.reset ||
      result.ambiguous ||
      result.uploadsReset ||
      result.errors ||
      result.budgetExhausted
    ) {
      this.logger.log(
        {
          scanned: result.scanned,
          alreadyLive: result.alreadyLive,
          addAcknowledged: result.addAcknowledged,
          reset: result.reset,
          ambiguous: result.ambiguous,
          uploadsReset: result.uploadsReset,
          errors: result.errors,
          budgetExhausted: result.budgetExhausted,
        },
        'Publisher auto-reply recovery sweep completed',
      );
    }
  }

  private trigger(): void {
    if (this.inFlight) return;
    void this.runScheduled().catch((error: unknown) => {
      this.logger.warn(
        { code: this.errorCode(error) },
        'Publisher auto-reply recovery sweep failed',
      );
    });
  }

  private errorCode(error: unknown): string {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' && code.trim() ? code.trim().slice(0, 80) : 'UNKNOWN';
  }
}
