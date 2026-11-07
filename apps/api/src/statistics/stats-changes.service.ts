import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { StatsChangesResult } from '@maxim/contracts/statistics-central';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { centralEnabled, StatsFailure } from './stats-common';
import { decodeCursor, encodeCursor } from './stats-cursor';

type FeedCursor = { type: 'changes'; seq: string; view: string; expires: number };
@Injectable()
export class StatsChangesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StatsChangesService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private active: Promise<void> | null = null;
  private cleanupAt = 0;
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}
  onModuleInit() {
    if (!centralEnabled(this.config) || !roleRunsAction(getAppRole())) return;
    this.timer = setInterval(() => {
      if (!this.active)
        this.active = this.relay()
          .catch(() => this.logger.warn('STATISTICS_CENTRAL_RELAY_UNAVAILABLE'))
          .finally(() => {
            this.active = null;
          });
    }, 1000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
  async relay() {
    await this.prisma.$transaction(
      async (tx) => {
        // FLAG: Publication sequences are assigned only to committed source rows under a short serialized relay lock.
        // FLAG: Keep lock acquisition separate so reads after an advisory wait see the preceding commit.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(763429014)`;
        const rows = await tx.$queryRaw<
          Array<{ id: string; tuple_id: string }>
        >`SELECT id,ctid::text AS tuple_id FROM stats_changes WHERE published_seq IS NULL ORDER BY created_at,id LIMIT 500 FOR UPDATE SKIP LOCKED`;
        if (!rows.length) return;
        const last = (
          await tx.$queryRaw<
            Array<{ seq: bigint }>
          >`SELECT COALESCE((SELECT published_seq FROM stats_changes WHERE published_seq IS NOT NULL ORDER BY published_seq DESC LIMIT 1),0)::bigint AS seq`
        )[0]!.seq;
        // FLAG: Tuple IDs belong only to these row locks in this transaction; never persist or reuse them.
        await tx.$executeRaw(Prisma.sql`
          WITH assigned(id, tuple_id, seq) AS MATERIALIZED (
            VALUES ${Prisma.join(
              rows.map(
                (row, index) => Prisma.sql`
                  (${row.id}::uuid, ${row.tuple_id}::tid, ${last + BigInt(index) + 1n}::bigint)
                `,
              ),
            )}
          )
          UPDATE stats_changes AS change
          SET published_seq = assigned.seq, published_at = now()
          FROM assigned
          WHERE change.id = assigned.id
            AND change.ctid = assigned.tuple_id
            -- FLAG: The scalar array enables bounded TID probes; a VALUES join alone can scan retained history.
            AND change.ctid = ANY(ARRAY(SELECT tuple_id FROM assigned))
        `);
      },
      { timeout: 5000 },
    );
    if (this.cleanupAt > Date.now()) return;
    this.cleanupAt = Date.now() + 60_000;
    // Only central transport/storage retention; native history and independent product data are untouched.
    await this.prisma
      .$executeRaw`DELETE FROM stats_measurements WHERE (entity_id,producer,metric,horizon,method_id,method_version,day) IN (SELECT entity_id,producer,metric,horizon,method_id,method_version,day FROM stats_measurements WHERE day<(now() AT TIME ZONE 'UTC')::date-89 ORDER BY day,entity_id LIMIT 500 FOR UPDATE SKIP LOCKED)`;
    await this.prisma
      .$executeRaw`DELETE FROM stats_ingest_requests WHERE (producer,producer_epoch,record_kind,operation_key) IN (SELECT producer,producer_epoch,record_kind,operation_key FROM stats_ingest_requests WHERE created_at<now()-interval '90 days' ORDER BY created_at,producer,producer_epoch,record_kind,operation_key LIMIT 500 FOR UPDATE SKIP LOCKED)`;
    await this.prisma
      .$executeRaw`DELETE FROM stats_changes WHERE id IN(SELECT id FROM stats_changes WHERE published_at<now()-interval '7 days' AND published_seq<(SELECT max(published_seq) FROM stats_changes) ORDER BY created_at,id LIMIT 500 FOR UPDATE SKIP LOCKED)`;
  }
  async changes(cursor: string | undefined, limit = 250): Promise<StatsChangesResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 250)
      throw new StatsFailure('INVALID_REQUEST', 400);
    const secret = this.config.get<string>('SVYAZKA_ANALYTICS_TOKEN') ?? '';
    const head = (
      await this.prisma.$queryRaw<
        Array<{ seq: bigint }>
      >`SELECT COALESCE((SELECT published_seq FROM stats_changes WHERE published_seq IS NOT NULL ORDER BY published_seq DESC LIMIT 1),0)::bigint AS seq`
    )[0]!.seq;
    const now = new Date().toISOString();
    const make = (seq: string, view = '') =>
      encodeCursor({ type: 'changes', seq, view, expires: Date.now() + 7 * 86_400_000 }, secret);
    if (cursor === 'HEAD')
      return {
        contractVersion: 1,
        asOf: now,
        items: [],
        nextCursor: make(head.toString()),
        hasMore: false,
      };
    const c = cursor
      ? decodeCursor<FeedCursor>(cursor, secret)
      : { type: 'changes', seq: '0', view: '', expires: Date.now() + 7 * 86_400_000 };
    if (
      c.type !== 'changes' ||
      !/^\d{1,19}$/u.test(c.seq) ||
      BigInt(c.seq) > 9_223_372_036_854_775_807n ||
      typeof c.view !== 'string' ||
      (c.view !== '' && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(c.view))
    )
      throw new StatsFailure('INVALID_REQUEST', 400);
    if (c.expires <= Date.now()) throw new StatsFailure('CURSOR_EXPIRED', 410);
    const first = (
      await this.prisma.$queryRaw<
        Array<{ seq: bigint | null }>
      >`SELECT published_seq AS seq FROM stats_changes WHERE published_seq IS NOT NULL ORDER BY published_seq LIMIT 1`
    )[0]?.seq;
    if (first && BigInt(c.seq) !== 0n && BigInt(c.seq) < first - 1n)
      throw new StatsFailure('CURSOR_EXPIRED', 410);
    const rows = await this.prisma.$queryRaw<
      Array<{
        seq: bigint;
        view_id: string;
        epoch: bigint;
        state: string;
        producer_epoch: string;
        peer_valid_until: Date;
        kind: 'CHANNEL' | 'CHAT';
        max_id: string;
        entity_revision: bigint;
      }>
    >`
   SELECT ch.published_seq AS seq,a.id AS view_id,a.epoch,a.state,a.producer_epoch,a.peer_valid_until,e.kind,e.max_id,ch.entity_revision
   FROM stats_changes ch JOIN stats_entities e ON e.id=ch.entity_id
   CROSS JOIN LATERAL (
     -- FLAG: Disjoint branches seek current consumers by entity/id and the exact
     -- predecessor by PK. The per-change page cap resumes on the same seq/view.
     (SELECT id,epoch,state,producer_epoch,peer_valid_until FROM stats_authorities
     WHERE entity_id=ch.entity_id AND role='CONSUMER' AND issuer='EXCHANGE' AND consumer='EXCHANGE'
       AND superseded_by IS NULL
       AND id>=CASE WHEN ch.published_seq=${BigInt(c.seq)} THEN ${c.view || '00000000-0000-0000-0000-000000000000'}::uuid
         ELSE '00000000-0000-0000-0000-000000000000'::uuid END
       AND (ch.published_seq>${BigInt(c.seq)} OR ${c.view}='' OR id<>${c.view || '00000000-0000-0000-0000-000000000000'}::uuid)
     ORDER BY id LIMIT ${limit + 1})
     UNION ALL
     SELECT id,epoch,state,producer_epoch,peer_valid_until FROM stats_authorities
     WHERE id=ch.authority_id AND entity_id=ch.entity_id AND role='CONSUMER' AND issuer='EXCHANGE'
       AND consumer='EXCHANGE' AND superseded_by IS NOT NULL
   ) a
   WHERE ch.published_seq IS NOT NULL AND ch.published_seq>=${BigInt(c.seq)}
     AND (ch.published_seq>${BigInt(c.seq)} OR (ch.published_seq=${BigInt(c.seq)} AND a.id::text>${c.view}))
   ORDER BY ch.published_seq,a.id LIMIT ${limit + 1}`;
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items: StatsChangesResult['items'] = selected.map((r) =>
      r.state !== 'ACTIVE' ||
      r.peer_valid_until.getTime() <= Date.now() ||
      r.producer_epoch !== this.config.get('STATISTICS_CENTRAL_EXCHANGE_EPOCH')
        ? {
            action: 'REVOKE',
            viewId: r.view_id,
            authorityId: r.view_id,
            authorityEpoch: r.epoch.toString(),
          }
        : {
            action: 'REFRESH',
            viewId: r.view_id,
            entity: { kind: r.kind, maxId: r.max_id },
            entityRevision: r.entity_revision.toString(),
          },
    );
    const last = selected.at(-1);
    return {
      contractVersion: 1,
      asOf: now,
      items,
      nextCursor: last ? make(last.seq.toString(), last.view_id) : make(head.toString()),
      hasMore,
    };
  }
}
