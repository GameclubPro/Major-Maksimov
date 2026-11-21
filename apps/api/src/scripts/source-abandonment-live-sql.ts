import { Prisma } from '../prisma/prisma-client';
import {
  inspectSourceAbandonmentCandidate,
  inspectSourceAbandonmentReceiptCandidate,
} from '../webhook/webhook-source-abandonment';
import type {
  SourceAbandonmentCandidate,
  SourceAbandonmentDatabase,
} from '../webhook/webhook-source-abandonment.contract';
import type { LegacyRecoveryLivePlanProof } from './legacy-recovery-live-protocol';
import {
  SOURCE_INVENTORY_DATE_COLUMNS,
  SourceInventoryRefused,
  sourceInventoryPrismaRow,
} from './source-abandonment-sql-row';
export { SourceInventoryRefused } from './source-abandonment-sql-row';
import {
  SOURCE_ABANDONMENT_CHANNEL_MARKER_QUEUE,
  SOURCE_ABANDONMENT_OBSERVATION_QUEUE,
  isSourceAbandonmentIdentity,
  sourceAbandonmentDigest,
  sourceAbandonmentSelectedOwner,
  type SourceAbandonmentChildEvidence,
  type SourceAbandonmentLiveSelection,
} from './source-abandonment-live-protocol';

export type SourceInventoryAllowance = Readonly<{
  pages: number;
  rows: number;
  probes: number;
  bytes: number;
  deadlineAtMs: number;
}>;
const tables = new Set(Object.keys(SOURCE_INVENTORY_DATE_COLUMNS));
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

// FLAG: Metered SQL evidence is JSON plus decoded schema DateTime columns.
// Preserve Date identity in this realm for the existing strict authority readers.
function cloneCandidateEvidence<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(cloneCandidateEvidence) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneCandidateEvidence(item)]),
    ) as T;
  return value;
}

// FLAG: A result limit is not a scan bound. Admit only an index condition covering
// every selected identity before execution; transfer each JSON page under a SQL byte cap.
export class SourceInventorySqlMeter {
  readonly cost = { pages: 0, rows: 0, probes: 0, bytes: 0 };
  readonly plans: LegacyRecoveryLivePlanProof[] = [];
  readonly snapshots: unknown[] = [];
  private readonly candidateReads = new Map<
    string,
    {
      value: unknown;
      digest: string;
      descriptor: string;
      read: () => Promise<unknown>;
      reused: boolean;
    }
  >();
  lastDescriptor = 'sql:inventory';
  constructor(
    readonly tx: Prisma.TransactionClient,
    readonly allowance: SourceInventoryAllowance,
    readonly lockRows = false,
  ) {}
  check(): void {
    if (Date.now() >= this.allowance.deadlineAtMs)
      throw new SourceInventoryRefused('sql_deadline_exceeded');
    for (const key of ['pages', 'rows', 'probes', 'bytes'] as const)
      if (!Number.isSafeInteger(this.cost[key]) || this.cost[key] > this.allowance[key])
        throw new SourceInventoryRefused('sql_budget_exceeded');
  }
  async read<T>(
    descriptor: string,
    statement: Prisma.Sql,
    identities: Readonly<Record<string, readonly string[]>>,
    maxRows: number,
    examinedRowsBound = maxRows,
    resultByteBound = 64 * 1024,
  ): Promise<T[]> {
    this.lastDescriptor = descriptor;
    this.check();
    if (
      this.cost.pages + 2 > this.allowance.pages ||
      this.cost.probes + 2 > this.allowance.probes ||
      this.cost.rows + examinedRowsBound + 1 > this.allowance.rows ||
      this.allowance.bytes - this.cost.bytes < 64 * 1024 + resultByteBound
    )
      throw new SourceInventoryRefused('sql_budget_exceeded');
    const explained = await this.tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
      Prisma.sql`EXPLAIN (FORMAT JSON) ${statement}`,
    );
    this.cost.pages++;
    this.cost.probes++;
    const plan = explained[0]?.['QUERY PLAN'];
    const planBytes = Buffer.byteLength(JSON.stringify(plan) ?? '');
    this.cost.bytes += planBytes;
    if (planBytes > 64 * 1024) throw new SourceInventoryRefused('sql_plan_oversize');
    const indexes = new Set<string>();
    const seen = new Set<string>();
    let nodes = 0;
    const walk = (value: unknown): void => {
      if (++nodes > 128) throw new SourceInventoryRefused('sql_plan_unproved');
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      const row = record(value);
      if (!row) throw new SourceInventoryRefused('sql_plan_unproved');
      if (
        row.Filter ||
        row['Join Filter'] ||
        /Sort|Seq Scan|Bitmap|Gather/u.test(String(row['Node Type'] ?? ''))
      )
        throw new SourceInventoryRefused('sql_residual_work_unproved');
      const relation = row['Relation Name'];
      if (typeof relation === 'string') {
        const keys = identities[relation];
        if (
          !keys ||
          typeof row['Index Name'] !== 'string' ||
          !String(row['Node Type']).startsWith('Index')
        )
          throw new SourceInventoryRefused('sql_selected_index_unproved');
        const condition = String(row['Index Cond'] ?? '');
        if (
          keys.some((key) =>
            key === '@source-family'
              ? row['Index Name'] !== 'webhook_events_source_family_pending_idx' ||
                !condition.includes("'chatId'") ||
                !condition.includes("'messageId'") ||
                (condition.match(/ = /gu)?.length ?? 0) < 2
              : !new RegExp(`\\b${key}\\b"?\\s*=`).test(condition),
          )
        )
          throw new SourceInventoryRefused('sql_selected_scope_unproved');
        if (
          descriptor === 'sql:claim-kind-prefix' &&
          !String(row['Index Name']).includes('kind_semantic')
        )
          throw new SourceInventoryRefused('sql_kind_prefix_unproved');
        indexes.add(row['Index Name']);
        seen.add(relation);
      }
      if (row.Plan) walk(row.Plan);
      if (Array.isArray(row.Plans)) walk(row.Plans);
    };
    walk(plan);
    if (Object.keys(identities).some((table) => !seen.has(table)))
      throw new SourceInventoryRefused('sql_selected_relation_unproved');
    this.check();
    const result = await this.tx.$queryRaw<T[]>(statement);
    this.cost.pages++;
    this.cost.probes++;
    this.cost.rows += result.length;
    const resultBytes = Buffer.byteLength(JSON.stringify(result));
    this.cost.bytes += resultBytes;
    this.check();
    if (resultBytes > resultByteBound) throw new SourceInventoryRefused('sql_result_oversize');
    if (result.length > maxRows) throw new SourceInventoryRefused('sql_result_saturated');
    this.plans.push({
      descriptor,
      querySha256: sourceAbandonmentDigest({ sql: statement.sql, values: statement.values }),
      planSha256: sourceAbandonmentDigest(plan),
      indexes: [...indexes].sort(),
      returnedRows: result.length,
      // Logical maximum admitted through an exact index seek, not an ANALYZE measurement.
      examinedRows: examinedRowsBound,
      probes: 2,
    });
    return result;
  }
  async rows<T>(
    table: string,
    predicate: Prisma.Sql,
    identityKeys: readonly string[],
    maximum: number,
    order = Prisma.empty,
  ): Promise<T[]> {
    if (!tables.has(table) || maximum > 200 || maximum < 1)
      throw new SourceInventoryRefused('sql_descriptor_invalid');
    // FLAG: Source eligibility consumes only these configured command names.
    // Do not serialize unrelated image/base64 settings into the bounded evidence
    // page. PostgreSQL's tuple version also fences changes to omitted settings;
    // it is read under the same indexed row lock and independently rechecked.
    const rowValue =
      table === 'chat_settings'
        ? Prisma.sql`jsonb_build_object(
            'chat_id', t.chat_id,
            'source_inventory_row_version', t.xmin::text || ':' || t.ctid::text,
            'admin_ban_command_name', t.admin_ban_command_name,
            'admin_ban_all_command_name', t.admin_ban_all_command_name,
            'admin_mute_command_name', t.admin_mute_command_name,
            'admin_permanent_mute_command_name', t.admin_permanent_mute_command_name,
            'admin_rules_command_name', t.admin_rules_command_name,
            'admin_silence_command_name', t.admin_silence_command_name,
            'admin_open_chat_command_name', t.admin_open_chat_command_name)`
        : Prisma.sql`to_jsonb(t)`;
    const rows = await this.read<{
      count: number;
      bytes: number;
      rows: Record<string, unknown>[] | null;
    }>(
      `sql:${table}`,
      Prisma.sql`WITH picked AS MATERIALIZED (
        SELECT ${rowValue} AS value FROM ${Prisma.raw(`"${table}"`)} t
        WHERE ${predicate} ${order} LIMIT ${maximum + 1} ${this.lockRows ? Prisma.sql`FOR SHARE` : Prisma.empty}
      ) SELECT count(*)::int AS count,
        coalesce(sum(octet_length(value::text)), 0)::int AS bytes,
        CASE WHEN coalesce(sum(octet_length(value::text)), 0) <= 524288
          THEN coalesce(jsonb_agg(value), '[]'::jsonb) ELSE NULL END AS rows FROM picked`,
      { [table]: identityKeys },
      1,
      maximum + 1,
      1024 * 1024,
    );
    const page = rows[0];
    if (
      !page ||
      !Array.isArray(page.rows) ||
      page.count !== page.rows.length ||
      page.count > maximum
    )
      throw new SourceInventoryRefused('sql_page_saturated_or_oversize');
    this.cost.rows += page.count;
    this.check();
    const result = page.rows
      .map((row) => sourceInventoryPrismaRow(table, row))
      .sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
    this.snapshots.push({ table, digest: sourceAbandonmentDigest(result) });
    return result as T[];
  }
  // FLAG: Reuse only detached candidate evidence within this meter invocation.
  // Claim readers append to returned arrays, so even the first result is cloned.
  // No source clock, family census, child resolver or write uses this memo.
  private async candidateRead<T>(key: readonly (string | undefined)[], read: () => Promise<T>) {
    const identity = JSON.stringify(key);
    let proof = this.candidateReads.get(identity);
    if (proof) {
      this.lastDescriptor = proof.descriptor;
      this.check();
      proof.reused = true;
    } else {
      const value = await read();
      proof = {
        value,
        digest: sourceAbandonmentDigest(value),
        descriptor: this.lastDescriptor,
        read,
        reused: false,
      };
      this.candidateReads.set(identity, proof);
    }
    return cloneCandidateEvidence(proof.value) as T;
  }

  // FLAG: Online admission is READ COMMITTED. Every reused fact, including a
  // missing claim and the end of the kind census, must be independently reread
  // with the original index/row/byte budgets before this inventory can succeed.
  // Never carry evidence into another inventory or a later store operation.
  async verifyCandidateReads(): Promise<void> {
    try {
      for (const proof of this.candidateReads.values()) {
        if (!proof.reused) continue;
        this.lastDescriptor = proof.descriptor;
        this.check();
        const fresh = await proof.read();
        if (sourceAbandonmentDigest(fresh) !== proof.digest)
          throw new SourceInventoryRefused('sql_candidate_proof_changed');
      }
    } finally {
      this.candidateReads.clear();
    }
  }

  candidateReader(): SourceAbandonmentDatabase {
    const rows = this.rows.bind(this);
    return {
      $executeRaw: async () => {
        throw new SourceInventoryRefused('sql_write_refused');
      },
      $queryRaw: async (statement: Prisma.Sql) => {
        if (statement.sql.includes('"_prisma_migrations"')) {
          // The Prisma migration catalog has no migration-name index. Bound its
          // entire physical relation before the one reviewed finite catalog query.
          const size = await this.tx.$queryRaw<Array<{ bytes: bigint }>>`
            SELECT pg_total_relation_size('public._prisma_migrations') AS bytes`;
          this.cost.pages++;
          this.cost.probes++;
          this.cost.bytes += 64;
          this.check();
          if (size.length !== 1 || BigInt(size[0]!.bytes) > 1024n * 1024n)
            throw new SourceInventoryRefused('sql_migration_catalog_unproved');
          const result = await this.tx.$queryRaw(statement);
          this.cost.pages++;
          this.cost.probes++;
          this.cost.bytes += Buffer.byteLength(JSON.stringify(result));
          this.check();
          return result;
        }
        return this.read('sql:source-size', statement, { webhook_events: ['id'] }, 1);
      },
      webhookEvent: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          this.candidateRead(
            ['event', where.id],
            async () =>
              (await rows('webhook_events', Prisma.sql`t.id = ${where.id}`, ['id'], 1))[0] ?? null,
          ),
      },
      chatSettings: {
        findUnique: async ({ where }: { where: { chatId: string } }) =>
          this.candidateRead(
            ['settings', where.chatId],
            async () =>
              (
                await rows('chat_settings', Prisma.sql`t.chat_id = ${where.chatId}`, ['chat_id'], 1)
              )[0] ?? null,
          ),
      },
      webhookExecutionClaim: {
        findMany: async ({ where }: { where: { webhookEventId: string } }) =>
          this.candidateRead(['event-claims', where.webhookEventId], () =>
            rows(
              'webhook_execution_claims',
              Prisma.sql`t.webhook_event_id = ${where.webhookEventId}`,
              ['webhook_event_id'],
              32,
            ),
          ),
        findUnique: async ({
          where,
        }: {
          where: { kind_semanticKey: { kind: string; semanticKey: string } };
        }) => {
          const key = where.kind_semanticKey;
          return this.candidateRead(
            ['semantic-claim', key.kind, key.semanticKey],
            async () =>
              (
                await rows(
                  'webhook_execution_claims',
                  Prisma.sql`t.kind = ${key.kind} AND t.semantic_key = ${key.semanticKey}`,
                  ['kind', 'semantic_key'],
                  1,
                )
              )[0] ?? null,
          );
        },
        findFirst: async ({ where }: { where: { kind?: { gt: string } } }) => {
          const after = where.kind?.gt;
          return this.candidateRead(['kind-prefix', after], async () => {
            const result = await this.read<{ kind: string }>(
              'sql:claim-kind-prefix',
              Prisma.sql`SELECT kind FROM webhook_execution_claims
              ${after === undefined ? Prisma.empty : Prisma.sql`WHERE kind > ${after}`}
              ORDER BY kind ASC LIMIT 1`,
              { webhook_execution_claims: [] },
              1,
            );
            return result[0] ?? null;
          });
        },
      },
    } as unknown as SourceAbandonmentDatabase;
  }
}

export function sourceAbandonmentFamilyPredicate(chatId: string, messageId: string): Prisma.Sql {
  return Prisma.sql`status IN ('RECEIVED', 'QUEUED', 'FAILED') AND processed_at IS NULL
    AND source_disposition_id IS NULL
    AND (normalized_payload->'message'->>'chatId') IS NOT NULL
    AND (normalized_payload->'message'->>'messageId') IS NOT NULL
    AND (normalized_payload->'message'->>'chatId') = ${chatId}
    AND (normalized_payload->'message'->>'messageId') = ${messageId}`;
}

// FLAG: Keep the family census as a strict indexed identity read. Installation
// locks every returned receipt by primary key before shared provenance inspection;
// row-locking this partial index adds PostgreSQL residual predicate rechecks.
export async function readSourceAbandonmentFamily(
  meter: SourceInventorySqlMeter,
  chatId: string,
  messageId: string,
  maximum: number,
): Promise<Array<{ id: string }>> {
  return meter.read(
    'sql:exact-source-family',
    Prisma.sql`
    SELECT id FROM webhook_events WHERE ${sourceAbandonmentFamilyPredicate(chatId, messageId)}
    ORDER BY created_at, id LIMIT ${maximum + 1}`,
    { webhook_events: ['@source-family'] },
    maximum + 1,
  );
}

export async function inventorySourceAbandonmentSql(
  tx: Prisma.TransactionClient,
  selection: SourceAbandonmentLiveSelection,
  allowance: SourceInventoryAllowance,
  lockRows = false,
  publisherBotId?: string,
) {
  const meter = new SourceInventorySqlMeter(tx, allowance, lockRows);
  const candidates: SourceAbandonmentCandidate[] = [];
  const children: SourceAbandonmentChildEvidence[] = [];
  const evidence: unknown[] = [];
  const issues: Array<{ code: string; descriptor: string }> = [];
  try {
    // Planner preferences expose the necessary indexes even in small native fixtures;
    // admission still rejects a missing index or a post-filtered identity.
    await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
    await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
    for (const ownerId of selection.ownerWebhookEventIds) {
      const candidate = await inspectSourceAbandonmentCandidate(
        meter.candidateReader(),
        ownerId,
        {
          majorBotIds: selection.majorBotIds,
          abandonBefore: new Date(selection.abandonBefore),
        },
        (code) => issues.push({ code, descriptor: 'sql:selected-source' }),
      );
      if (!candidate) throw new SourceInventoryRefused('source_candidate_unproved');
      candidates.push(candidate);
      const { chatId, messageId, userId } = candidate.source;
      const family = await readSourceAbandonmentFamily(meter, chatId, messageId, 200);
      if (!family.length || family.length > 200)
        throw new SourceInventoryRefused('source_family_saturated_or_missing');
      for (const receipt of family) {
        const proof = await inspectSourceAbandonmentReceiptCandidate(
          meter.candidateReader(),
          receipt.id,
          candidate,
          (code) => issues.push({ code, descriptor: 'sql:source-family' }),
          publisherBotId,
        );
        if (!proof) throw new SourceInventoryRefused('source_family_provenance_unproved');
        evidence.push({
          table: 'webhook_events',
          receiptId: receipt.id,
          sourceDigest: proof.sourceDigest,
          claimsDigest: sourceAbandonmentDigest(proof.claims),
          scopeKind: proof.scopeKind,
        });
      }
      const exact = Prisma.sql`t.chat_id = ${chatId} AND t.message_id = ${messageId}`;
      if ('sourceProfile' in candidate.source) {
        const markers = await meter.rows<{ id: string }>(
          'channel_auto_post_attach_markers',
          exact,
          ['chat_id', 'message_id'],
          1,
        );
        // FLAG: A missing channel author is never a participant identity. The
        // exact marker keeps its existing state, including unknown edit/send
        // outcomes, and contributes only its immutable child key to the hold.
        for (const marker of markers)
          children.push({
            jobKey: marker.id,
            queueName: SOURCE_ABANDONMENT_CHANNEL_MARKER_QUEUE,
            jobPayloadDigest: sourceAbandonmentDigest(marker),
            chatId,
            messageId,
          });
        evidence.push({
          table: 'channel_auto_post_attach_markers',
          ownerId,
          digest: sourceAbandonmentDigest(markers),
        });
      }
      for (const table of ['moderation_events', 'moderation_violation_message_claims']) {
        const rows = await meter.rows(table, exact, ['chat_id', 'message_id'], 64);
        evidence.push({ table, ownerId, digest: sourceAbandonmentDigest(rows) });
      }
      const intents = await meter.rows<{ id: string }>(
        'moderation_delete_intents',
        exact,
        ['chat_id', 'message_id'],
        1,
      );
      evidence.push({
        table: 'moderation_delete_intents',
        ownerId,
        digest: sourceAbandonmentDigest(intents),
      });
      for (const intent of intents) {
        for (const table of ['moderation_delete_intent_reasons', 'moderation_rule_followups']) {
          const rows = await meter.rows(
            table,
            Prisma.sql`t.intent_id = ${intent.id}`,
            ['intent_id'],
            64,
          );
          evidence.push({ table, ownerId, digest: sourceAbandonmentDigest(rows) });
        }
      }
      const observations = await meter.rows<{ id: string; userId: string }>(
        'spammer_observations',
        exact,
        ['chat_id', 'message_id'],
        64,
      );
      for (const row of observations) {
        if (row.userId !== userId) throw new SourceInventoryRefused('observation_source_conflict');
        children.push({
          jobKey: row.id,
          queueName: SOURCE_ABANDONMENT_OBSERVATION_QUEUE,
          jobPayloadDigest: sourceAbandonmentDigest(row),
          chatId,
          messageId,
          userId,
        });
      }
      evidence.push({
        table: 'spammer_observations',
        ownerId,
        digest: sourceAbandonmentDigest(observations),
      });
    }
    await meter.verifyCandidateReads();
  } catch (error) {
    issues.push({
      code: error instanceof SourceInventoryRefused ? error.code : 'sql_store_refused',
      descriptor: meter.lastDescriptor,
    });
  }
  return {
    candidates,
    selectedOwners: candidates.map(sourceAbandonmentSelectedOwner),
    children,
    stableDigest: sourceAbandonmentDigest({ evidence, snapshots: meter.snapshots }),
    plans: meter.plans,
    cost: meter.cost,
    issues,
  };
}

export type SourceAbandonmentSqlResolution = {
  rows: Array<{ key: string; row: Record<string, unknown> | null; digest: string }>;
  cost: { pages: number; rows: number; probes: number; bytes: number };
  plans: LegacyRecoveryLivePlanProof[];
  issue: { code: string; descriptor: string } | null;
};

export function sourceAbandonmentSqlResolver(tx: Prisma.TransactionClient) {
  return async (
    kind: 'action' | 'observation',
    keys: readonly string[],
    allowance: SourceInventoryAllowance,
  ): Promise<SourceAbandonmentSqlResolution> => {
    const meter = new SourceInventorySqlMeter(tx, allowance);
    try {
      meter.lastDescriptor = 'sql:resolver';
      if (
        !['action', 'observation'].includes(kind) ||
        !Array.isArray(keys) ||
        keys.length < 1 ||
        keys.length > 16 ||
        keys.some((key) => !isSourceAbandonmentIdentity(key, 512)) ||
        new Set(keys).size !== keys.length
      )
        throw new SourceInventoryRefused('sql_batch_request_invalid');
      const table = kind === 'action' ? 'max_action_ledger' : 'spammer_observations';
      const column = kind === 'action' ? 'job_id' : 'id';
      // FLAG: Each finite VALUES key drives its own indexed equality seek and
      // LIMIT 2 saturation sentinel. Do not replace this with an IN scan, omit a
      // missing-key result, or reuse mutable evidence in another batch/pass.
      // The window sum suppresses every payload before transfer if the complete
      // batch exceeds the existing SQL page byte cap; no ordering is required.
      const pages = await meter.read<{
        ordinal: number;
        key: string;
        count: number;
        bytes: number;
        rows: Record<string, unknown>[] | null;
      }>(
        `sql:${table}`,
        Prisma.sql`WITH requested(ordinal, key) AS (
          VALUES ${Prisma.join(keys.map((key, ordinal) => Prisma.sql`(${ordinal}::int, ${key}::text)`))}
        ) SELECT requested.ordinal, requested.key, page.count, page.bytes,
          CASE WHEN sum(page.bytes) OVER () <= 524288 THEN page.rows ELSE NULL END AS rows
        FROM requested CROSS JOIN LATERAL (
          WITH picked AS MATERIALIZED (
            SELECT to_jsonb(t) AS value FROM ${Prisma.raw(`"${table}"`)} t
            WHERE ${Prisma.raw(`t."${column}"`)} = requested.key LIMIT 2
          ) SELECT count(*)::int AS count,
            coalesce(sum(octet_length(value::text)), 0)::int AS bytes,
            CASE WHEN coalesce(sum(octet_length(value::text)), 0) <= 524288
              THEN coalesce(jsonb_agg(value), '[]'::jsonb) ELSE NULL END AS rows
          FROM picked
        ) page`,
        { [table]: [column] },
        keys.length,
        keys.length * 2,
        1024 * 1024,
      );
      if (pages.length !== keys.length)
        throw new SourceInventoryRefused('sql_batch_identity_unproved');
      const resolved = new Map<number, SourceAbandonmentSqlResolution['rows'][number]>();
      for (const page of pages) {
        if (
          !record(page) ||
          Object.keys(page).sort().join(',') !== 'bytes,count,key,ordinal,rows' ||
          !Number.isSafeInteger(page.ordinal) ||
          page.ordinal < 0 ||
          page.ordinal >= keys.length ||
          resolved.has(page.ordinal) ||
          page.key !== keys[page.ordinal]
        )
          throw new SourceInventoryRefused('sql_batch_identity_unproved');
        if (
          !Number.isSafeInteger(page.count) ||
          page.count < 0 ||
          page.count > 1 ||
          !Number.isSafeInteger(page.bytes) ||
          page.bytes < 0 ||
          page.bytes > 524288 ||
          !Array.isArray(page.rows) ||
          page.rows.length !== page.count ||
          (page.count === 0) !== (page.bytes === 0) ||
          page.rows.some((row) => !record(row))
        )
          throw new SourceInventoryRefused('sql_page_saturated_or_oversize');
        meter.cost.rows += page.count;
        meter.check();
        // FLAG: Decode only the existing schema DateTime columns in this realm;
        // [] and [decoded row] keep the original per-key proof digest semantics.
        const rows = page.rows.map((row) => sourceInventoryPrismaRow(table, row));
        if (rows[0] && rows[0][kind === 'action' ? 'jobId' : 'id'] !== page.key)
          throw new SourceInventoryRefused('sql_batch_identity_unproved');
        resolved.set(page.ordinal, {
          key: page.key,
          row: rows[0] ?? null,
          digest: sourceAbandonmentDigest(rows),
        });
      }
      return {
        rows: keys.map((_, ordinal) => resolved.get(ordinal)!),
        cost: meter.cost,
        plans: meter.plans,
        issue: null,
      };
    } catch (error) {
      // FLAG: A refused batch grants no rows, but its completed SQL reads still
      // consume the shared budget and retain their exact plan/descriptor evidence.
      return {
        rows: [],
        cost: meter.cost,
        plans: meter.plans,
        issue: {
          code: error instanceof SourceInventoryRefused ? error.code : 'sql_store_refused',
          descriptor: meter.lastDescriptor,
        },
      };
    }
  };
}

export async function inventorySourceAbandonmentChildSql(
  tx: Prisma.TransactionClient,
  children: readonly SourceAbandonmentChildEvidence[],
  allowance: SourceInventoryAllowance,
  lockRows = false,
) {
  const meter = new SourceInventorySqlMeter(tx, allowance, lockRows);
  const issues: Array<{ code: string; descriptor: string }> = [];
  try {
    for (const child of [...children].sort(
      (a, b) => a.queueName.localeCompare(b.queueName) || a.jobKey.localeCompare(b.jobKey),
    )) {
      if (child.queueName === SOURCE_ABANDONMENT_OBSERVATION_QUEUE) continue;
      if (child.queueName === SOURCE_ABANDONMENT_CHANNEL_MARKER_QUEUE) {
        const markers = await meter.rows<Record<string, unknown>>(
          'channel_auto_post_attach_markers',
          Prisma.sql`t.id = ${child.jobKey}`,
          ['id'],
          1,
        );
        if (
          markers.length !== 1 ||
          markers[0]!.chatId !== child.chatId ||
          markers[0]!.messageId !== child.messageId ||
          child.userId !== undefined ||
          sourceAbandonmentDigest(markers[0]) !== child.jobPayloadDigest
        )
          throw new SourceInventoryRefused('channel_marker_source_changed');
        continue;
      }
      await meter.rows('max_action_ledger', Prisma.sql`t.job_id = ${child.jobKey}`, ['job_id'], 1);
    }
  } catch (error) {
    issues.push({
      code: error instanceof SourceInventoryRefused ? error.code : 'sql_child_refused',
      descriptor: meter.lastDescriptor,
    });
  }
  return {
    stableDigest: sourceAbandonmentDigest(meter.snapshots),
    cost: meter.cost,
    plans: meter.plans,
    issues,
  };
}
