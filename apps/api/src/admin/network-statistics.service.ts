import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { StatsEntity } from '@maxim/contracts/statistics-central';
import {
  managedEntityTypeSchema,
  type ManagedEntityFavoriteType,
  type ManagedEntityType,
} from '@maxim/contracts';
import {
  networkStatisticsQuerySchema,
  networkStatisticsResponseSchema,
  type NetworkMetricCoverage,
  type NetworkStatisticsResponse,
} from '@maxim/contracts/networks-stats';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { Prisma, type Prisma as PrismaTypes } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { centralEnabled, StatsFailure } from '../statistics/stats-common';
import { StatsReadService } from '../statistics/stats-read.service';
import {
  NetworkAuthorizationService,
  NETWORK_AUTHORIZATION_CONCURRENCY,
} from './network-authorization.service';
import { ManagedEntitiesService } from './managed-entities.service';
import { ManagedEntityNetworksService } from './managed-entity-networks.service';

const HOUR_MS = 3600_000;
const FRESH_MS = 2 * HOUR_MS;
const GENERATION_DEADLINE_MS = 10 * 60_000;
const GENERATION_IDLE_MS = 60_000;
const MAX_GENERATIONS = 100;
const AUTHORIZATION_BATCH_SIZE = 8;

export function networkStatisticsPeriodStart(to: Date, range: '7d' | '30d'): Date {
  const dayMs = 24 * HOUR_MS;
  const moscowOffsetMs = 3 * HOUR_MS;
  const today = Math.floor((to.getTime() + moscowOffsetMs) / dayMs) * dayMs - moscowOffsetMs;
  return new Date(today - ((range === '7d' ? 7 : 30) - 1) * dayMs);
}
const AUTHORIZATION_CONCURRENCY = NETWORK_AUTHORIZATION_CONCURRENCY;

type Generation = {
  id: string;
  userId: string;
  entityType: ManagedEntityType;
  favoriteType: ManagedEntityFavoriteType;
  label: string;
  compositionVersion: string;
  entityIds: string[];
  range: '7d' | '30d';
  from: Date;
  to: Date;
  next: number;
  allowed: Set<string>;
  denied: number;
  unavailable: number;
  createdAt: number;
  touchedAt: number;
  pending?: Promise<NetworkStatisticsResponse>;
  proofs: Map<string, string>;
};
type AudienceRow = { chat_id: string; participants_count: number; observed_at: Date };
type AudienceRead = { rows: AudienceRow[]; verifyAccess?: () => Promise<void> };
type GrowthRow = { chat_id: string; at: Date; joined: bigint; left_count: bigint };
type MembershipCoverageRow = {
  chat_id: string;
  observed_from: Date | null;
  observed_at: Date | null;
};
type ViewRow = {
  chat_id: string;
  at: Date;
  value: bigint;
  allocatable: bigint;
  excluded: bigint;
  uncertain: bigint;
  observed_from: Date;
  observed_at: Date;
  interval_count: bigint;
};
type ScopeRow = {
  chat_id: string;
  post_count: bigint;
  observed_count: bigint;
  first_baseline_at: Date | null;
  last_observed_at: Date | null;
  last_success_at: Date | null;
  discovery_complete_at: Date | null;
  full_refresh_at: Date | null;
  stalled_at: Date | null;
};
const count = (value: bigint | number | undefined) => Number(value ?? 0);
const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;
const minimumDate = (dates: Array<Date | null | undefined>): Date | null => {
  const values = dates.flatMap((value) =>
    value && Number.isFinite(value.getTime()) ? [value.getTime()] : [],
  );
  return values.length ? new Date(Math.min(...values)) : null;
};

export function networkViewIntervalsSql(
  ids: string[],
  from: Date,
  to: Date,
  bucket: 'hour' | 'day',
): Prisma.Sql {
  const start =
    bucket === 'hour'
      ? Prisma.sql`date_trunc('hour', i.from_at)`
      : Prisma.sql`date_trunc('day', i.from_at AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow'`;
  const end =
    bucket === 'hour'
      ? Prisma.sql`date_trunc('hour', i.to_at)`
      : Prisma.sql`date_trunc('day', i.to_at AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow'`;
  return Prisma.sql`
    SELECT i.chat_id,${end} AS at,
      sum(CASE WHEN i.from_at>=${from} THEN i.delta ELSE 0 END)::bigint AS value,
      sum(CASE WHEN i.from_at>=${from} AND ${start}=${end} AND i.quality='ready' THEN i.delta ELSE 0 END)::bigint AS allocatable,
      count(*) FILTER (WHERE i.from_at<${from})::bigint AS excluded,
      count(*) FILTER (WHERE i.quality<>'ready' OR ${start}<>${end})::bigint AS uncertain,
      count(*) FILTER (WHERE i.from_at>=${from})::bigint AS interval_count,
      min(i.from_at) AS observed_from,max(i.to_at) AS observed_at
    FROM channel_view_observed_intervals i
    WHERE i.chat_id IN (${Prisma.join(ids)}) AND i.to_at>${from} AND i.to_at<=${to}
    GROUP BY i.chat_id,2 ORDER BY 2,i.chat_id
  `;
}

@Injectable()
export class NetworkStatisticsService {
  private readonly generations = new Map<string, Generation>();
  constructor(
    private readonly prisma: PrismaService,
    private readonly managed: ManagedEntitiesService,
    private readonly networks: ManagedEntityNetworksService,
    private readonly authorization: NetworkAuthorizationService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly stats?: StatsReadService,
  ) {}

  async read(
    user: AuthUser,
    typeInput: string,
    input: unknown,
  ): Promise<NetworkStatisticsResponse> {
    const type = managedEntityTypeSchema.safeParse(typeInput);
    const parsed = networkStatisticsQuerySchema.safeParse(input);
    if (!type.success || !parsed.success)
      throw new BadRequestException('Некорректный запрос статистики сетки.');
    const query = parsed.data;
    const selection = await this.networks.resolveSelection(user, type.data, query.favoriteType);
    const now = Date.now();
    for (const [key, generation] of this.generations) {
      if (
        now - generation.touchedAt > GENERATION_IDLE_MS ||
        now - generation.createdAt > GENERATION_DEADLINE_MS
      )
        this.generations.delete(key);
    }
    let generation = query.cursor ? this.generations.get(query.cursor) : undefined;
    if (
      query.cursor &&
      (!generation ||
        generation.userId !== user.userId ||
        generation.entityType !== type.data ||
        generation.favoriteType !== query.favoriteType ||
        generation.range !== query.range)
    )
      throw new ConflictException({
        code: 'NETWORK_STATISTICS_CURSOR_EXPIRED',
        message: 'Обновите статистику сетки.',
      });
    if (generation && generation.compositionVersion !== selection.compositionVersion) {
      this.generations.delete(generation.id);
      throw new ConflictException({
        code: 'NETWORK_STATISTICS_COMPOSITION_CHANGED',
        message: 'Состав сетки изменился. Обновите статистику.',
      });
    }
    if (!generation) {
      while (this.generations.size >= MAX_GENERATIONS)
        this.generations.delete(this.generations.keys().next().value!);
      const to = new Date();
      generation = {
        id: randomUUID(),
        userId: user.userId,
        entityType: type.data,
        favoriteType: query.favoriteType,
        label: selection.label,
        compositionVersion: selection.compositionVersion,
        entityIds: [...new Set(selection.entityIds)],
        range: query.range,
        from: networkStatisticsPeriodStart(to, query.range),
        to,
        next: 0,
        allowed: new Set(),
        proofs: new Map(),
        denied: 0,
        unavailable: 0,
        createdAt: now,
        touchedAt: now,
      };
      this.generations.set(generation.id, generation);
    }
    generation.touchedAt = now;
    if (generation.pending) return generation.pending;
    const current = generation;
    const pending = this.advance(current, user).finally(() => {
      current.pending = undefined;
    });
    current.pending = pending;
    return pending;
  }

  private async advance(
    generation: Generation,
    user: AuthUser,
  ): Promise<NetworkStatisticsResponse> {
    // FLAG: Favorites and home edges are navigation only. Every included entity must
    // pass the same strict actor + bot read check as its individual statistics page.
    // Across every generation only two checks run together; the shared MAX
    // admission/cooldown remains authoritative after this local scheduling limit.
    const batch = generation.entityIds.slice(
      generation.next,
      generation.next + AUTHORIZATION_BATCH_SIZE,
    );
    for (let offset = 0; offset < batch.length; offset += AUTHORIZATION_CONCURRENCY) {
      await Promise.all(
        batch.slice(offset, offset + AUTHORIZATION_CONCURRENCY).map(async (entityId) => {
          try {
            const release = await this.authorization.acquireSlot();
            try {
              const probeStartedAt = new Date();
              await this.managed.assertManagedEntityReadAccess(
                entityId,
                user,
                generation.entityType,
                { timeoutMs: 2500 },
              );
              // FLAG: The strict guard persists its own exact grant. Capture the epoch
              // after that write and require a fresh surviving grant, so a concurrent
              // denial between MAX success and this SQL read cannot become a proof.
              const proof = await this.authorization.readEpochs(
                generation,
                [entityId],
                probeStartedAt,
              );
              if (!proof.has(entityId)) {
                generation.unavailable += 1;
                return;
              }
              generation.allowed.add(entityId);
              generation.proofs.set(entityId, proof.get(entityId)!);
            } finally {
              release();
            }
          } catch (error) {
            if (error instanceof ForbiddenException) generation.denied += 1;
            else generation.unavailable += 1;
          }
        }),
      );
    }
    generation.next += batch.length;
    const current = await this.networks.resolveSelection(
      user,
      generation.entityType,
      generation.favoriteType,
    );
    if (current.compositionVersion !== generation.compositionVersion) {
      this.generations.delete(generation.id);
      throw new ConflictException({
        code: 'NETWORK_STATISTICS_COMPOSITION_CHANGED',
        message: 'Состав или доступ к сетке изменился.',
      });
    }
    await this.assertEpochs(generation);
    // FLAG: Every response has one current window. A singleton audience observation can
    // advance during progressive authorization; an old cursor anchor must not hide it.
    generation.to = new Date();
    generation.from = networkStatisticsPeriodStart(generation.to, generation.range);
    const response = await this.aggregate(generation);
    await this.assertEpochs(generation);
    return response;
  }

  private async assertEpochs(g: Generation): Promise<void> {
    const current = await this.authorization.readEpochs(g, [...g.allowed]);
    if ([...g.allowed].some((id) => !g.proofs.has(id) || current.get(id) !== g.proofs.get(id))) {
      this.generations.delete(g.id);
      throw new ConflictException({
        code: 'NETWORK_STATISTICS_ACCESS_CHANGED',
        message: 'Доступ изменился. Обновите статистику сетки.',
      });
    }
  }

  private async aggregate(g: Generation): Promise<NetworkStatisticsResponse> {
    const ids = [...g.allowed];
    const bucket = 'day' as const;
    const bucketSql = (column: Prisma.Sql) =>
      Prisma.sql`date_trunc('day', ${column} + interval '3 hours') - interval '3 hours'`;
    let audienceRows: AudienceRow[] = [];
    let growthRows: GrowthRow[] = [];
    let viewRows: ViewRow[] = [];
    let scopeRows: ScopeRow[] = [];
    let membershipCoverageRows: MembershipCoverageRow[] = [];
    let titles: Array<{ id: string; title: string | null }> = [];
    let verifyAudienceAccess: (() => Promise<void>) | undefined;
    if (ids.length) {
      const selected = Prisma.join(ids);
      [
        audienceRows,
        growthRows,
        viewRows,
        scopeRows,
        membershipCoverageRows,
        titles,
        verifyAudienceAccess,
      ] = await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL statement_timeout='2500ms'`;
          await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
          // FLAG: Acquire the RepeatableRead snapshot before choosing its window.
          // A singleton advanced before that snapshot stays eligible; advances
          // committed afterwards retain their previous MVCC version for this read.
          const [clock] = await tx.$queryRaw<
            Array<{ as_of: Date }>
          >`SELECT clock_timestamp() AS as_of`;
          g.to = clock.as_of;
          g.from = networkStatisticsPeriodStart(g.to, g.range);
          const fromComplete = new Date(Math.ceil(g.from.getTime() / HOUR_MS) * HOUR_MS);
          const toComplete = new Date(Math.floor(g.to.getTime() / HOUR_MS) * HOUR_MS);
          const audienceRead: AudienceRead =
            this.config && centralEnabled(this.config)
              ? await this.readAudience(g, ids, tx)
              : {
                  rows: await tx.$queryRaw<AudienceRow[]>`
          SELECT chat_id,participants_count,observed_at FROM managed_entity_audience_observations
          WHERE chat_id IN (${selected}) AND entity_type=${g.entityType === 'chat' ? 'CHAT' : 'CHANNEL'}::"ChatEntityType"
            AND observed_at<=${g.to}
        `,
                };
          const growth = await tx.$queryRaw<GrowthRow[]>`
          WITH membership AS (
            SELECT chat_id,bucket_start AS at,joined_users::bigint AS joined,left_users::bigint AS left_count
            FROM chat_membership_activity_rollups WHERE chat_id IN (${selected})
              AND bucket_start>=${fromComplete} AND bucket_start<${toComplete}
            UNION ALL
            SELECT chat_id,event_at AS at,CASE WHEN event_type='user_added' THEN 1 ELSE 0 END AS joined,
              CASE WHEN event_type='user_removed' THEN 1 ELSE 0 END AS left_count
            FROM chat_membership_activity_feed_items WHERE chat_id IN (${selected})
              AND event_type IN ('user_added','user_removed') AND event_at>=${g.from} AND event_at<=${g.to}
              AND (event_at<${fromComplete} OR event_at>=${toComplete})
          ) SELECT chat_id,${bucketSql(Prisma.sql`at`)} AS at,sum(joined)::bigint AS joined,sum(left_count)::bigint AS left_count
          FROM membership GROUP BY chat_id,2 ORDER BY 2,chat_id
        `;
          const views =
            g.entityType === 'channel' ? await this.readViews(tx, ids, g.from, g.to, bucket) : [];
          const scope =
            g.entityType === 'channel'
              ? await tx.$queryRaw<ScopeRow[]>`
          SELECT a.chat_id,a.observed_post_count::bigint AS post_count,a.observed_post_count::bigint AS observed_count,
            a.first_observed_at AS first_baseline_at,a.last_observed_at,
            a.last_success_at,a.discovery_complete_at,a.full_refresh_at,a.stalled_at
          FROM channel_view_archive_states a WHERE a.chat_id IN (${selected})
        `
              : [];
          // FLAG: An empty membership result is not evidence of zero growth. These
          // four indexed edge probes describe retained observations, not continuous
          // webhook delivery; membership coverage therefore remains partial.
          const membershipCoverage = await tx.$queryRaw<MembershipCoverageRow[]>`
          SELECT c.id AS chat_id,
            LEAST(s.membership_coverage_from,first_feed.event_at,first_rollup.bucket_start) AS observed_from,
            GREATEST(last_feed.event_at,last_rollup.bucket_start) AS observed_at
          FROM chats c
          LEFT JOIN channel_stats_sync_states s ON s.chat_id=c.id AND c.entity_type='CHANNEL'
          LEFT JOIN LATERAL (SELECT event_at FROM chat_membership_activity_feed_items f
            WHERE f.chat_id=c.id AND f.event_type IN ('user_added','user_removed') AND f.event_at<=${g.to}
            ORDER BY event_at ASC,source_event_id ASC LIMIT 1) first_feed ON true
          LEFT JOIN LATERAL (SELECT event_at FROM chat_membership_activity_feed_items f
            WHERE f.chat_id=c.id AND f.event_type IN ('user_added','user_removed') AND f.event_at<=${g.to}
            ORDER BY event_at DESC,source_event_id DESC LIMIT 1) last_feed ON true
          LEFT JOIN LATERAL (SELECT bucket_start FROM chat_membership_activity_rollups r
            WHERE r.chat_id=c.id AND r.bucket_start<=${g.to} ORDER BY bucket_start ASC LIMIT 1) first_rollup ON true
          LEFT JOIN LATERAL (SELECT bucket_start FROM chat_membership_activity_rollups r
            WHERE r.chat_id=c.id AND r.bucket_start<=${g.to} ORDER BY bucket_start DESC LIMIT 1) last_rollup ON true
          WHERE c.id IN (${selected})
        `;
          const names = await this.networks.readCommunityPresentations(tx, g.entityType, ids);
          return [
            audienceRead.rows,
            growth,
            views,
            scope,
            membershipCoverage,
            names,
            audienceRead.verifyAccess,
          ] as const;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
      );
    }
    if (verifyAudienceAccess) {
      try {
        // FLAG: Release the observation transaction's connection before the fresh
        // access check. Nested pool reservations can deadlock concurrent readers.
        await verifyAudienceAccess();
      } catch (error) {
        this.handleAudienceError(error);
        audienceRows = [];
      }
    }
    return this.present(
      g,
      audienceRows,
      growthRows,
      viewRows,
      scopeRows,
      membershipCoverageRows,
      titles,
    );
  }

  private async readAudience(
    g: Generation,
    ids: string[],
    tx: PrismaTypes.TransactionClient,
  ): Promise<AudienceRead> {
    if (!this.stats) return { rows: [] };
    const entities: StatsEntity[] = ids.map((maxId) => ({
      kind: g.entityType === 'chat' ? 'CHAT' : 'CHANNEL',
      maxId,
    }));
    try {
      // FLAG: Use the same snapshot and cutoff as the native interval metrics.
      // The central reader independently fences current native and peer authority.
      const result = await this.stats.localAudienceCurrent(entities, g.userId, g.to, tx);
      return {
        rows: result.rows.map((row) => ({
          chat_id: row.entity.maxId,
          participants_count: row.value,
          observed_at: row.observedAt,
        })),
        verifyAccess: result.verifyAccess,
      };
    } catch (error) {
      this.handleAudienceError(error);
      return { rows: [] };
    }
  }

  private handleAudienceError(error: unknown): void {
    if (error instanceof StatsFailure) {
      if (error.getStatus() === 503) return;
      if (error.getStatus() === 403 || error.getStatus() === 409)
        throw new ConflictException({
          code: 'NETWORK_STATISTICS_ACCESS_CHANGED',
          message: 'Доступ изменился. Обновите статистику сетки.',
        });
    }
    throw error;
  }

  private readViews(
    tx: PrismaTypes.TransactionClient,
    ids: string[],
    from: Date,
    to: Date,
    bucket: 'hour' | 'day',
  ) {
    return tx.$queryRaw<ViewRow[]>(networkViewIntervalsSql(ids, from, to, bucket));
  }

  private present(
    g: Generation,
    audiences: AudienceRow[],
    growth: GrowthRow[],
    views: ViewRow[],
    scope: ScopeRow[],
    membership: MembershipCoverageRow[],
    titles: Array<{ id: string; title: string | null }>,
  ): NetworkStatisticsResponse {
    const total = g.entityIds.length;
    const coverage = (
      included: number,
      from: Date | null,
      asOf: Date | null,
      complete = false,
      entityTotal = total,
    ): NetworkMetricCoverage => ({
      status:
        entityTotal === 0
          ? 'unavailable'
          : included === 0
            ? 'unavailable'
            : complete && included === entityTotal && g.next === total
              ? 'ready'
              : 'partial',
      includedEntities: included,
      totalEntities: entityTotal,
      observedFrom: iso(from),
      asOf: iso(asOf),
    });
    const values = new Map<string, { growth: number; views: number; viewUncertain: boolean }>();
    const starts = this.bucketStarts(g.from, g.to, false);
    const series = new Map(
      starts.map((at) => [
        at.toISOString(),
        {
          at: at.toISOString(),
          netGrowth: null as number | null,
          viewsGained: null as number | null,
          viewsComplete: false,
        },
      ]),
    );
    // FLAG: First/latest timestamps do not prove observations between them. Only
    // retained bucket/event rows can turn a missing daily value into observed zero.
    for (const row of growth) {
      const entry = values.get(row.chat_id) ?? { growth: 0, views: 0, viewUncertain: false };
      const delta = count(row.joined) - count(row.left_count);
      entry.growth += delta;
      values.set(row.chat_id, entry);
      const point = series.get(row.at.toISOString());
      if (point) point.netGrowth = (point.netGrowth ?? 0) + delta;
    }
    let unallocated = 0;
    const uncertainViewDays = new Set<string>();
    const observedViewEntities = new Set<string>();
    for (const row of views) {
      const entry = values.get(row.chat_id) ?? { growth: 0, views: 0, viewUncertain: false };
      entry.views += count(row.value);
      entry.viewUncertain ||= count(row.uncertain) > 0 || count(row.excluded) > 0;
      values.set(row.chat_id, entry);
      if (count(row.interval_count) > 0) observedViewEntities.add(row.chat_id);
      unallocated += count(row.value) - count(row.allocatable);
      const point = series.get(row.at.toISOString());
      if (count(row.uncertain) > 0 || count(row.excluded) > 0)
        uncertainViewDays.add(row.at.toISOString());
      if (point) point.viewsGained = (point.viewsGained ?? 0) + count(row.allocatable);
    }
    for (const at of uncertainViewDays) {
      const point = series.get(at);
      if (point) point.viewsGained = null;
    }
    const audienceById = new Map(audiences.map((row) => [row.chat_id, row]));
    const scopeById = new Map(scope.map((row) => [row.chat_id, row]));
    const membershipById = new Map(membership.map((row) => [row.chat_id, row]));
    const titleById = new Map(titles.map((row) => [row.id, row.title]));
    const items = [...g.allowed].map((entityId) => {
      const audience = audienceById.get(entityId);
      const observations = scopeById.get(entityId);
      const hasObservedViews = observedViewEntities.has(entityId);
      const memberObservations = membershipById.get(entityId);
      const hasMembership =
        memberObservations?.observed_from &&
        memberObservations.observed_at &&
        memberObservations.observed_from <= g.to &&
        memberObservations.observed_at >= g.from;
      return {
        entityId,
        title: titleById.get(entityId) ?? (g.entityType === 'chat' ? 'Чат' : 'Канал'),
        audience: audience?.participants_count ?? null,
        audienceObservedAt: iso(audience?.observed_at),
        netGrowth: hasMembership ? (values.get(entityId)?.growth ?? 0) : null,
        viewsGained:
          g.entityType === 'channel' && hasObservedViews
            ? (values.get(entityId)?.views ?? 0)
            : null,
        viewsCoverage:
          g.entityType === 'channel'
            ? coverage(
                hasObservedViews ? 1 : 0,
                observations?.first_baseline_at ?? null,
                observations?.last_observed_at ?? observations?.last_success_at ?? null,
                false,
                1,
              )
            : null,
      };
    });
    const datedAudience = audiences.map((row) => row.observed_at.getTime());
    const freshAudience =
      audiences.length > 0 &&
      audiences.every((row) => g.to.getTime() - row.observed_at.getTime() <= FRESH_MS);
    const includedViews = items.filter((item) => item.viewsGained !== null).length;
    const includedMembership = items.filter((item) => item.netGrowth !== null).length;
    const observedMembership = membership.filter(
      (row) =>
        row.observed_from &&
        row.observed_at &&
        row.observed_from <= g.to &&
        row.observed_at >= g.from,
    );
    return networkStatisticsResponseSchema.parse({
      entityType: g.entityType,
      favoriteType: g.favoriteType,
      label: g.label,
      compositionVersion: g.compositionVersion,
      period: {
        range: g.range,
        from: iso(g.from),
        to: iso(g.to),
        timezone: 'Europe/Moscow',
        bucket: 'day',
      },
      authorization: {
        checked: g.next,
        total,
        allowed: g.allowed.size,
        denied: g.denied,
        unavailable: g.unavailable,
      },
      audience: {
        value: audiences.length
          ? audiences.reduce((sum, row) => sum + row.participants_count, 0)
          : null,
        coverage: coverage(
          audiences.length,
          null,
          datedAudience.length ? new Date(Math.min(...datedAudience)) : null,
          freshAudience,
        ),
      },
      netGrowth: {
        value: includedMembership
          ? items.reduce((sum, item) => sum + (item.netGrowth ?? 0), 0)
          : null,
        coverage: coverage(
          includedMembership,
          minimumDate(observedMembership.map((row) => row.observed_from)),
          minimumDate(observedMembership.map((row) => row.observed_at)),
        ),
      },
      viewsGained:
        g.entityType === 'channel'
          ? {
              value: includedViews
                ? items.reduce((sum, item) => sum + (item.viewsGained ?? 0), 0)
                : null,
              coverage: coverage(
                includedViews,
                minimumDate(scope.map((row) => row.first_baseline_at)),
                minimumDate(scope.map((row) => row.last_observed_at ?? row.last_success_at)),
              ),
            }
          : null,
      series: [...series.values()],
      items,
      unallocatedViews: unallocated,
      nextCursor: g.next < total ? g.id : null,
      retryAfterMs: 500,
      method: 'current-composition-observed-intervals-v2',
    });
  }

  private bucketStarts(from: Date, to: Date, hourly: boolean): Date[] {
    const step = hourly ? HOUR_MS : 24 * HOUR_MS;
    const shift = hourly ? 0 : 3 * HOUR_MS;
    const start = Math.floor((from.getTime() + shift) / step) * step - shift;
    const result: Date[] = [];
    for (let at = start; at <= to.getTime(); at += step) result.push(new Date(at));
    return result;
  }
}
