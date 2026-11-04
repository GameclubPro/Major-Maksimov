import { Injectable } from '@nestjs/common';
import type {
  SafetyDeskOverviewResponse,
  SafetyDeskOverviewPercentiles,
} from '@maxim/contracts/safety-desk';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';

export const OVERVIEW_ACTION_SAMPLE_LIMIT = 5000;
export function buildOverviewActionIndexQuery(): Prisma.Sql {
  return Prisma.sql`SELECT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_am am ON am.oid = c.relam
    WHERE i.indexrelid = to_regclass('max_action_ledger_terminal_completed_id_idx')
      AND i.indrelid = to_regclass('max_action_ledger')
      AND i.indisvalid AND i.indisready AND i.indislive AND am.amname = 'btree'
      AND i.indnkeyatts = 3 AND i.indnatts = 3
      AND i.indoption[0] = 0 AND i.indoption[1] = 3 AND i.indoption[2] = 3
      AND i.indexprs IS NULL AND i.indpred IS NULL
      AND ARRAY(SELECT pg_get_indexdef(i.indexrelid, n, false)
        FROM generate_series(1, 3) n ORDER BY n) = ARRAY['terminal', 'completed_at', 'id']
  ) AS ready`;
}

export function buildOverviewActionQuery(from: Date, to: Date): Prisma.Sql {
  // FLAG: Bound the indexed completion head before reading scalar details by primary key.
  // No JSON bodies, retained-history counts, or external effects belong in this reader.
  // FLAG: Storage admission precedes every JSON operation. Compressed values can expand
  // far beyond pg_column_size; nested CASE keeps PostgreSQL from reordering that boundary.
  return Prisma.sql`WITH heads AS MATERIALIZED (
    SELECT id, completed_at FROM max_action_ledger
    WHERE terminal = true AND completed_at >= ${from} AND completed_at <= ${to}
    ORDER BY completed_at DESC, id DESC LIMIT ${OVERVIEW_ACTION_SAMPLE_LIMIT + 1}
  ) SELECT heads.completed_at AS "completedAt", details.bot_id AS "botId",
      details.status::text AS status, details.enqueued_at AS "enqueuedAt",
      CASE WHEN details.metadata IS NULL THEN true
        WHEN pg_column_compression(details.metadata) IS NULL AND pg_column_size(details.metadata) <= 8192
        THEN CASE WHEN jsonb_typeof(details.metadata) = 'object'
          THEN CASE WHEN details.metadata -> 'scheduledFor' IS NULL OR details.metadata -> 'scheduledFor' = 'null'::jsonb
            THEN true ELSE jsonb_typeof(details.metadata -> 'scheduledFor') = 'string'
              AND octet_length(details.metadata ->> 'scheduledFor') <= 80 END
          ELSE false END
        ELSE false END AS "timingMetadataInspected",
      CASE WHEN pg_column_compression(details.metadata) IS NULL AND pg_column_size(details.metadata) <= 8192
        THEN CASE WHEN jsonb_typeof(details.metadata -> 'scheduledFor') = 'string'
          THEN CASE WHEN octet_length(details.metadata ->> 'scheduledFor') <= 80
            THEN details.metadata ->> 'scheduledFor' END END
        END AS "scheduledFor"
    FROM heads CROSS JOIN LATERAL (
      SELECT bot_id, status, enqueued_at, metadata FROM max_action_ledger
      WHERE id = heads.id OFFSET 0
    ) details ORDER BY heads.completed_at DESC, heads.id DESC`;
}

export type OverviewActionRow = {
  botId: string | null;
  status: string;
  enqueuedAt: Date | null;
  completedAt: Date;
  scheduledFor: string | null;
  timingMetadataInspected: boolean;
};
export type OverviewActionSnapshot = {
  observedAt: string;
  actions: NonNullable<SafetyDeskOverviewResponse['actions']['value']>;
  bots: Array<{
    botId: string;
    latency: SafetyDeskOverviewPercentiles;
    lastTerminalAt: string | null;
    outcomes: Array<{ outcome: string; count: number }>;
  }>;
};

function percentiles(rows: OverviewActionRow[]): SafetyDeskOverviewPercentiles {
  const samples = rows
    .flatMap((row) => {
      // FLAG: An unreadable or invalid scheduled time is unknown readiness. Do not
      // substitute enqueue time and manufacture a latency for that outcome.
      if (!row.timingMetadataInspected) return [];
      const enqueued = row.enqueuedAt?.getTime();
      const scheduled = row.scheduledFor !== null ? Date.parse(row.scheduledFor) : NaN;
      if (row.scheduledFor !== null && !Number.isFinite(scheduled)) return [];
      const ready = Number.isFinite(scheduled)
        ? Math.max(enqueued ?? -Infinity, scheduled)
        : (enqueued ?? NaN);
      const duration = row.completedAt.getTime() - ready;
      return Number.isSafeInteger(duration) && duration >= 0 ? [duration] : [];
    })
    .sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    samples[Math.ceil(samples.length * fraction) - 1] ?? null;
  return {
    sampleCount: samples.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
}
function outcomes(rows: OverviewActionRow[]) {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  return [...counts].map(([outcome, count]) => ({ outcome, count }));
}

export function projectOverviewActions(
  loaded: OverviewActionRow[],
  at: Date,
  botIds: string[],
  defaultBotId: string,
): OverviewActionSnapshot {
  const rows = loaded.slice(0, OVERVIEW_ACTION_SAMPLE_LIMIT);
  const allowed = ['SUCCEEDED', 'SKIPPED', 'AMBIGUOUS', 'FAILED_RETRYABLE', 'FAILED_TERMINAL'];
  if (
    rows.some(
      (row) =>
        !allowed.includes(row.status) ||
        !Number.isFinite(row.completedAt.getTime()) ||
        row.completedAt > at,
    )
  ) {
    throw new Error('Invalid terminal action evidence');
  }
  return {
    observedAt: at.toISOString(),
    actions: {
      windowSec: 900,
      windowStartedAt: new Date(at.getTime() - 900000).toISOString(),
      windowEndedAt: at.toISOString(),
      sampleCount: rows.length,
      sampleComplete: loaded.length <= OVERVIEW_ACTION_SAMPLE_LIMIT,
      latency: percentiles(rows),
      outcomes: outcomes(rows),
    },
    bots: botIds.map((botId) => {
      const group = rows.filter((row) => (row.botId ?? defaultBotId) === botId);
      return {
        botId,
        latency: percentiles(group),
        lastTerminalAt: group[0]?.completedAt.toISOString() ?? null,
        outcomes: outcomes(group),
      };
    }),
  };
}

@Injectable()
export class SafetyDeskOverviewActionsService {
  constructor(private readonly prisma: PrismaService) {}
  async getSnapshot(botIds: string[], defaultBotId: string): Promise<OverviewActionSnapshot> {
    const at = new Date();
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
        await tx.$executeRaw`SET LOCAL lock_timeout = '250ms'`;
        const indexes = await tx.$queryRaw<Array<{ ready: boolean }>>(
          buildOverviewActionIndexQuery(),
        );
        if (indexes[0]?.ready !== true) throw new Error('Overview action index unavailable');
        const rows = await tx.$queryRaw<OverviewActionRow[]>(
          buildOverviewActionQuery(new Date(at.getTime() - 900000), at),
        );
        return projectOverviewActions(rows, at, botIds, defaultBotId);
      },
      { maxWait: 2000, timeout: 5000 },
    );
  }
}
