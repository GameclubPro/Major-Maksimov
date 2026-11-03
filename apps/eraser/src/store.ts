import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { Housekeeping } from './housekeeping.js';
export {
  HOUSEKEEPING_INTERVAL_MS,
  TERMINAL_PURGE_BATCH,
  WEBHOOK_PURGE_BATCH,
} from './housekeeping.js';
import { readProtectionEvidence } from './protection-evidence.js';
import {
  ServiceError,
  type Candidate,
  type Lane,
  type Message,
  type Policy,
  type Protection,
  type UpdatePolicy,
  type Hours,
  type ConnectionRequest,
  type PendingConnectionRequest,
  type ConnectionProof,
  type PolicyActivationGuard,
  type PolicyActivationProof,
} from './types.js';

export const ERASER_CONNECTION_PROOF_READER_VERSION = 1;

function validConnectionProof(
  proof: ConnectionProof | undefined,
  chatId: string,
): proof is ConnectionProof {
  return (
    proof?.chatId === chatId &&
    typeof proof.connectionGeneration === 'string' &&
    /^\d+$/.test(proof.connectionGeneration) &&
    proof.expiresAt instanceof Date &&
    Number.isFinite(proof.expiresAt.getTime())
  );
}

const HOUR = 3_600_000;
const MINUTE = 60_000;
const NO_WORK_AT = new Date('9999-01-01T00:00:00.000Z');
const SAFETY_DELAYS = [15, 30, 60, 120, 240, 360].map((minutes) => minutes * MINUTE);
export type ScanPurpose = 'due' | 'safety';

function effectiveDueSql(hours: Hours): string {
  const age = { 24: 86_400_000, 48: 172_800_000, 168: 604_800_000 }[hours];
  if (!age) throw new Error('Invalid retention period');
  return `GREATEST(source_ms + ${age},CEIL(EXTRACT(EPOCH FROM (next_attempt_at AT TIME ZONE 'UTC')) * 1000)::bigint)`;
}
export const CHAT_BUFFER = 200;
export type PolicyRow = Policy & {
  normal_next_at: Date;
  live_due: boolean;
  due_floor: string | null;
  due_generation: string;
  safety_floor: string | null;
  safety_upper: string | null;
  safety_cursor: string | null;
  safety_signature: string | null;
  safety_had_messages: boolean;
  safety_gap: boolean;
  safety_gap_at: string | null;
  live_gap: boolean;
  live_gap_at: string | null;
  live_scan_purpose: ScanPurpose | null;
  live_scan_had_messages: boolean;
  lease_purpose: ScanPurpose;
  safety_next_at: Date;
  safety_empty_streak: number;
  last_live_completed_at: Date | null;
  scan_generation: string;
  last_operation_id: string | null;
  live_signature: string | null;
  history_signature: string | null;
  deferred_from: string | null;
  deferred_to: string | null;
  historical_deferred_from: string | null;
  historical_deferred_to: string | null;
};
type ProtectionState = {
  ready: boolean;
  complete_through: Date | null;
  bot_history_complete_from: Date | null;
};
type DiagnosticPolicy = PolicyRow & {
  connection_request:
    | (Omit<ConnectionRequest, 'expires_at' | 'next_attempt_at' | 'updated_at'> & {
        expires_at: string;
        next_attempt_at: string;
        updated_at: string;
      })
    | null;
  durable_cooldown: Date | null;
  observed_at: Date;
};
type DiagnosticCounts = {
  chat_id: string;
  pending: number;
  oldest: string | null;
  unknown: number;
  unknown_at: Date | null;
  eligible: number;
  eligible_at: string | null;
  review: boolean;
  dispatching: boolean;
};
const CONNECTION_ERRORS = new Set([
  'bot_removed',
  'eraser_rights_missing',
  'membership_unknown',
  'actor_rights_missing',
  'queue_race',
  'queue_unavailable',
  'connection_proof_stale',
  'connection_guard_changed',
  'connection_check_failed',
  'ERASER_CONNECTION_STOPPED',
  'transport_unknown',
  'malformed_response',
  'unknown',
]);
export function protectionGap(
  message: Pick<Message, 'isBot' | 'sourceMs'>,
  moduleBot: boolean,
  protection: ProtectionState | undefined,
): 'current' | 'history' | null {
  if (message.isBot === false) return null;
  if (
    !protection?.ready ||
    !protection.complete_through ||
    message.sourceMs > protection.complete_through.getTime()
  )
    return 'current';
  // FLAG: Historical module publications lack a trustworthy exact-ID inventory before this floor.
  if (
    moduleBot &&
    (!protection.bot_history_complete_from ||
      message.sourceMs < protection.bot_history_complete_from.getTime())
  )
    return 'history';
  return null;
}
export class Store {
  private readonly maintenance: Housekeeping;
  constructor(
    readonly pool: pg.Pool,
    readonly executionEnabled: boolean,
  ) {
    this.maintenance = new Housekeeping(pool, executionEnabled);
  }
  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN; SET LOCAL eraser.native_schedule='1'");
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  private async ensure(client: pg.PoolClient, chatId: string, hours: Hours = 48): Promise<void> {
    await client.query(
      'INSERT INTO eraser_policies(chat_id,hours,activation_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [chatId, hours, randomUUID()],
    );
  }
  async policy(chatId: string): Promise<PolicyRow | null> {
    return (
      (await this.pool.query<PolicyRow>('SELECT * FROM eraser_policies WHERE chat_id=$1', [chatId]))
        .rows[0] ?? null
    );
  }
  async globalHolds(
    authorIds: string[],
    messages: Array<{ chatId: string; messageId: string }> = [],
  ): Promise<void> {
    await this.transaction(async (client) => {
      // FLAG: Exclude final-guard transactions until the negative authority is durably installed.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('eraser:effect-holds:v1'))");
      await client.query(
        'INSERT INTO eraser_global_held_authors(author_id) SELECT id FROM unnest($1::text[]) id ON CONFLICT DO NOTHING',
        [authorIds],
      );
      await client.query(
        'INSERT INTO eraser_global_message_holds(chat_id,message_id) SELECT m.chat_id,m.message_id FROM jsonb_to_recordset($1::jsonb) AS m(chat_id text,message_id text) ON CONFLICT DO NOTHING',
        [
          JSON.stringify(
            messages.map((message) => ({ chat_id: message.chatId, message_id: message.messageId })),
          ),
        ],
      );
    });
    // FLAG: Preserve installed holds on refusal. An earlier authorized effect remains uncertain,
    // and its source writer must not claim the cold fence has been established yet.
    const authors = await this.pool.query(
      "SELECT 1 FROM eraser_candidates WHERE author_id=ANY($1::text[]) AND state IN ('dispatching','uncertain') LIMIT 1",
      [authorIds],
    );
    const exact = await this.pool.query(
      "SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS m(chat_id text,message_id text) JOIN eraser_candidates c ON c.chat_id=m.chat_id AND c.message_id=m.message_id WHERE c.state IN ('dispatching','uncertain') LIMIT 1",
      [
        JSON.stringify(
          messages.map((message) => ({ chat_id: message.chatId, message_id: message.messageId })),
        ),
      ],
    );
    if (authors.rowCount || exact.rowCount)
      throw new ServiceError(
        409,
        'ERASER_HOLD_EFFECT_PENDING',
        'Результат предыдущего удаления ещё не подтверждён.',
      );
  }
  async bootstrap(chatId: string, hours: Hours, protection?: Protection): Promise<void> {
    await this.transaction(async (client) => {
      await this.ensure(client, chatId, hours);
      if (protection) await this.applyProtection(client, chatId, protection);
    });
  }
  async protect(chatId: string, input: Protection): Promise<void> {
    await this.transaction(async (client) => {
      await this.ensure(client, chatId);
      await this.applyProtection(client, chatId, input);
    });
  }
  private async applyProtection(client: pg.PoolClient, chatId: string, input: Protection) {
    await client.query('SELECT chat_id FROM eraser_policies WHERE chat_id=$1 FOR UPDATE', [chatId]);
    const old = (
      await client.query<{
        source_revision: string;
        bot_history_complete_from: Date | null;
        history_anchor: Date | null;
      }>(
        'SELECT source_revision,bot_history_complete_from,history_anchor FROM eraser_protection_state WHERE chat_id=$1',
        [chatId],
      )
    ).rows[0];
    if (old && Number(old.source_revision) > input.sourceRevision)
      throw new ServiceError(
        409,
        'ERASER_PROTECTION_REVISION_CONFLICT',
        'Защита публикаций уже изменена.',
      );
    const evidence = input.evidence ? readProtectionEvidence(input.evidence) : null;
    const floor = input.botHistoryCompleteFrom ? Date.parse(input.botHistoryCompleteFrom) : null;
    if (
      evidence &&
      (input.complete === false ||
        evidence.chatId !== chatId ||
        evidence.sourceRevision !== input.sourceRevision ||
        evidence.completeFrom !== input.botHistoryCompleteFrom ||
        evidence.completeThrough !== input.completeThrough)
    )
      throw new ServiceError(
        409,
        'ERASER_PROTECTION_EVIDENCE_CONFLICT',
        'Подтверждение относится к другой версии защиты.',
      );
    // FLAG: Existing readers may refresh the same conservative floor. An earlier interval
    // requires a complete source certificate; neither an audit page nor a timestamp is proof.
    const anchor = old?.history_anchor ?? old?.bot_history_complete_from;
    if (
      anchor &&
      input.complete !== false &&
      floor !== null &&
      floor < anchor.getTime() &&
      !evidence
    )
      throw new ServiceError(
        409,
        'ERASER_PROTECTION_EVIDENCE_REQUIRED',
        'Исторический интервал ещё не подтверждён.',
      );
    for (const [kind, ids] of [
      ['protected', input.protectedMessageIds],
      ['hold', input.holdMessageIds],
    ] as const) {
      await client.query(
        `INSERT INTO eraser_protected_messages(chat_id,message_id,kind) SELECT $1,id,$3 FROM unnest($2::text[]) id ON CONFLICT(chat_id,message_id) DO UPDATE SET kind=CASE WHEN EXCLUDED.kind='hold' THEN 'hold' ELSE eraser_protected_messages.kind END`,
        [chatId, ids, kind],
      );
    }
    await client.query(
      'INSERT INTO eraser_held_authors(chat_id,author_id) SELECT $1,id FROM unnest($2::text[]) id ON CONFLICT DO NOTHING',
      [chatId, input.holdAuthorIds ?? []],
    );
    await client.query(
      'INSERT INTO eraser_protected_bots(chat_id,bot_id) SELECT $1,id FROM unnest($2::text[]) id ON CONFLICT DO NOTHING',
      [chatId, input.protectedBotIds],
    );
    await client.query(
      `INSERT INTO eraser_protection_state(chat_id,source_revision,complete_through,ready,bot_history_complete_from,evidence,history_anchor) VALUES($1,$2,$3,$4,$5,$6::jsonb,$5) ON CONFLICT(chat_id) DO UPDATE SET source_revision=EXCLUDED.source_revision,complete_through=EXCLUDED.complete_through,ready=EXCLUDED.ready,bot_history_complete_from=CASE WHEN EXCLUDED.ready THEN EXCLUDED.bot_history_complete_from ELSE eraser_protection_state.bot_history_complete_from END,evidence=CASE WHEN EXCLUDED.ready THEN EXCLUDED.evidence ELSE eraser_protection_state.evidence END,history_anchor=LEAST(COALESCE(eraser_protection_state.history_anchor,eraser_protection_state.bot_history_complete_from),EXCLUDED.history_anchor),updated_at=CURRENT_TIMESTAMP`,
      [
        chatId,
        input.sourceRevision,
        input.complete === false ? null : input.completeThrough,
        input.complete !== false,
        input.complete === false ? null : (input.botHistoryCompleteFrom ?? null),
        evidence ? JSON.stringify(evidence) : null,
      ],
    );
    // FLAG: Revisit deferred ranges only after a complete local protection snapshot exists.
    if (input.complete !== false && input.completeThrough !== null) {
      await client.query(
        `UPDATE eraser_policies SET scan_generation=scan_generation+1,history_cursor=GREATEST(COALESCE(history_cursor,0),deferred_to),history_complete=false,history_gap=false,history_signature=NULL,deferred_from=NULL,deferred_to=NULL,normal_next_at=CURRENT_TIMESTAMP,next_run_at=LEAST(CURRENT_TIMESTAMP,safety_next_at) WHERE chat_id=$1 AND deferred_to IS NOT NULL AND deferred_to <= $2`,
        [chatId, Date.parse(input.completeThrough)],
      );
    }
    // FLAG: An advancing current watermark cannot certify older module-bot publications.
    if (
      input.complete !== false &&
      floor !== null &&
      (!old?.bot_history_complete_from || floor < old.bot_history_complete_from.getTime())
    )
      await client.query(
        `UPDATE eraser_policies SET scan_generation=scan_generation+1,history_cursor=GREATEST(COALESCE(history_cursor,0),historical_deferred_to),history_complete=false,history_signature=NULL,historical_deferred_from=NULL,historical_deferred_to=NULL,normal_next_at=CURRENT_TIMESTAMP,next_run_at=LEAST(CURRENT_TIMESTAMP,safety_next_at) WHERE chat_id=$1 AND historical_deferred_to IS NOT NULL AND historical_deferred_to >= $2`,
        [chatId, floor],
      );
  }
  private async diagnosticPage(
    client: pg.Pool | pg.PoolClient,
    selection: { chatIds?: string[]; after?: string | null },
    botId = '',
  ) {
    if (selection.chatIds && selection.chatIds.length > 50)
      throw new Error('Diagnostic page too large');
    const rows = (
      await client.query<DiagnosticPolicy>(
        `WITH page AS MATERIALIZED (
        SELECT * FROM eraser_policies
        WHERE ($1::text[] IS NULL OR chat_id=ANY($1)) AND ($2::text IS NULL OR chat_id>$2)
        ORDER BY chat_id LIMIT 51
      ) SELECT page.*,row_to_json(request) AS connection_request,
        cooldown.not_before AS durable_cooldown,statement_timestamp() AS observed_at
      FROM (SELECT (SELECT not_before FROM eraser_rate_limits WHERE bot_id=$3) AS not_before) cooldown
      LEFT JOIN page ON true LEFT JOIN eraser_connection_requests request USING(chat_id)
      ORDER BY page.chat_id`,
        [selection.chatIds ?? null, selection.after ?? null, botId],
      )
    ).rows;
    const policies = rows.filter((row) => row.chat_id).slice(0, 50);
    const observedAt = rows[0]!.observed_at;
    const probes = policies.length
      ? (
          await client.query<DiagnosticCounts>(
            // FLAG: Bound each state/lane before aggregation. Retained journals and terminal history
            // must never turn an operator page into a ledger scan or displace another state's probe.
            `SELECT input.chat_id,pending.total AS pending,oldest.source_ms AS oldest,
        unknown.total AS unknown,unknown.oldest AS unknown_at,
        eligible.total AS eligible,eligible.oldest AS eligible_at,
        COALESCE((SELECT true FROM eraser_candidates WHERE chat_id=input.chat_id AND state='review'
          ORDER BY message_id LIMIT 1),false) AS review,
        COALESCE((SELECT true FROM eraser_candidates WHERE chat_id=input.chat_id AND state='dispatching'
          ORDER BY message_id LIMIT 1),false) AS dispatching
      FROM unnest($1::text[],$2::integer[]) AS input(chat_id,hours)
      CROSS JOIN LATERAL (SELECT COUNT(*)::int AS total FROM (
        SELECT 1 FROM eraser_candidates WHERE chat_id=input.chat_id AND state='pending'
        ORDER BY message_id LIMIT ${CHAT_BUFFER + 1}
      ) limited) pending
      LEFT JOIN LATERAL (
        SELECT candidate.source_ms::text FROM eraser_candidates candidate WHERE chat_id=input.chat_id AND state='pending'
        ORDER BY candidate.source_ms,candidate.message_id LIMIT 1
      ) oldest ON true
      CROSS JOIN LATERAL (SELECT COUNT(*)::int AS total,MIN(unknown_at) AS oldest FROM (
        SELECT unknown_at FROM (
          (SELECT updated_at AS unknown_at FROM eraser_candidates
            WHERE chat_id=input.chat_id AND state='uncertain'
            ORDER BY updated_at,message_id LIMIT ${CHAT_BUFFER + 1})
          UNION ALL
          (SELECT next_attempt_at AS unknown_at FROM eraser_candidates
            WHERE chat_id=input.chat_id AND state='dispatching' AND next_attempt_at<=$3
            ORDER BY next_attempt_at,message_id LIMIT ${CHAT_BUFFER + 1})
        ) states ORDER BY unknown_at LIMIT ${CHAT_BUFFER + 1}
      ) limited) unknown
      CROSS JOIN LATERAL (SELECT COUNT(*)::int AS total,MIN(due_at)::text AS oldest FROM (
        SELECT due_at FROM (
          ${([24, 48, 168] as const)
            .flatMap((period) =>
              (['live', 'history'] as const).map(
                (lane) =>
                  `(SELECT ${effectiveDueSql(period)} AS due_at FROM eraser_candidates
              WHERE input.hours=${period} AND chat_id=input.chat_id AND lane='${lane}' AND state='pending'
                AND ${effectiveDueSql(period)}<=$4
              ORDER BY ${effectiveDueSql(period)},source_ms,message_id LIMIT ${CHAT_BUFFER + 1})`,
              ),
            )
            .join(' UNION ALL ')}
        ) lanes ORDER BY due_at LIMIT ${CHAT_BUFFER + 1}
      ) limited) eligible`,
            [
              policies.map((row) => row.chat_id),
              policies.map((row) => row.hours),
              observedAt,
              observedAt.getTime(),
            ],
          )
        ).rows
      : [];
    return {
      policies,
      counts: new Map(probes.map((row) => [row.chat_id, row])),
      observedAt,
      durableUntil: rows[0]!.durable_cooldown?.toISOString() ?? null,
      nextAfter: rows.filter((row) => row.chat_id).length > 50 ? policies[49]!.chat_id : null,
    };
  }
  private projectSnapshot(policy: DiagnosticPolicy, counts: DiagnosticCounts) {
    const connection = policy.connection_request;
    const connectionStatus =
      connection?.status === 'pending'
        ? Date.parse(connection.expires_at) <= policy.observed_at.getTime()
          ? 'expired'
          : connection.policy_revision !== policy.revision
            ? 'cancelled'
            : 'pending'
        : connection?.status;
    const gap = policy.history_gap || policy.live_gap_at !== null || policy.safety_gap_at !== null;
    const protectedHistory = policy.historical_deferred_from !== null;
    const executionStopped =
      !this.executionEnabled ||
      !policy.enabled ||
      ['no_access', 'missing'].includes(policy.connection_status);
    const status = !this.executionEnabled
      ? 'unavailable'
      : !policy.enabled
        ? 'off'
        : ['no_access', 'missing'].includes(policy.connection_status)
          ? 'no_access'
          : counts.review
            ? 'error'
            : counts.unknown || policy.last_error || policy.deferred_from || protectedHistory || gap
              ? 'delayed'
              : 'running';
    const historyStatus = !policy.enabled
      ? 'off'
      : gap ||
          policy.deferred_from ||
          protectedHistory ||
          policy.last_error ||
          ['missing', 'no_access'].includes(policy.connection_status)
        ? 'blocked'
        : policy.history_complete &&
            counts.pending === 0 &&
            counts.unknown === 0 &&
            !counts.review &&
            !counts.dispatching
          ? 'complete'
          : Number(policy.scanned_count)
            ? 'running'
            : 'pending';
    return {
      initialized: true,
      enabled: policy.enabled,
      hours: policy.hours,
      revision: policy.revision,
      enabledAt: policy.enabled_at?.toISOString() ?? null,
      captureAfter: null,
      pausedAt: null,
      pendingCount: Math.min(CHAT_BUFFER, counts.pending),
      deletedCount: Number(policy.deleted_count),
      skippedCount: Number(policy.skipped_count),
      oldestDueAt: counts.oldest
        ? new Date(Number(counts.oldest) + policy.hours * HOUR).toISOString()
        : null,
      status,
      connectionStatus: policy.connection_status,
      historyStatus,
      historyScannedCount: Number(policy.scanned_count),
      connectionRequest:
        connection && connectionStatus !== 'activated'
          ? { status: connectionStatus, expiresAt: new Date(connection.expires_at).toISOString() }
          : null,
      progress: {
        pendingCountComplete: counts.pending <= CHAT_BUFFER,
        eligibleCount: Math.min(CHAT_BUFFER, counts.eligible),
        eligibleCountComplete: counts.eligible <= CHAT_BUFFER,
        oldestEligibleDueAt: counts.eligible_at
          ? new Date(Number(counts.eligible_at)).toISOString()
          : null,
        unknownCount: Math.min(CHAT_BUFFER, counts.unknown),
        unknownCountComplete: counts.unknown <= CHAT_BUFFER,
        // FLAG: Unknown age begins at the dispatch confirmation deadline or the recorded
        // uncertain transition, not at source-message age or a guessed original DELETE time.
        oldestUnknownAt: counts.unknown_at?.toISOString() ?? null,
      },
      coverage: {
        lastCompletedAt: policy.last_live_completed_at?.toISOString() ?? null,
        gap,
        protectedHistory,
        executionStopped,
      },
      ...(policy.last_operation_id ? { lastOperationId: policy.last_operation_id } : {}),
    };
  }
  async runtimeDiagnostics(
    botId: string,
    selection: { chatIds?: string[]; after?: string | null },
  ) {
    const page = await this.diagnosticPage(this.pool, selection, botId);
    const available = new Set(page.policies.map((row) => row.chat_id));
    const unavailableSources = (selection.chatIds ?? [])
      .filter((id) => !available.has(id))
      .map((chatId) => ({
        chatId,
        chatTitle: 'Чат',
        source: 'eraser',
        reason: 'not_initialized',
      }));
    return {
      generatedAt: page.observedAt.toISOString(),
      nextAfter: page.nextAfter,
      incomplete: unavailableSources.length > 0,
      unavailableSources,
      cooldown: { durableUntil: page.durableUntil },
      items: page.policies.map((policy) => {
        const counts = page.counts.get(policy.chat_id)!;
        const snapshot = this.projectSnapshot(policy, counts);
        const connection = policy.connection_request;
        return {
          ...snapshot,
          chatId: policy.chat_id,
          chatTitle: 'Чат',
          source: 'eraser',
          sourceStatus: 'available',
          activationId: policy.activation_id,
          nextRunAt: policy.next_run_at.toISOString(),
          hasTerminalReview: counts.review,
          hasUnresolvedReceipt: counts.unknown > 0,
          connectionRequest: connection
            ? {
                status: snapshot.connectionRequest?.status ?? 'activated',
                operationId: connection.operation_id,
                actorUserId: connection.actor_user_id,
                policyRevision: connection.policy_revision,
                expiresAt: new Date(connection.expires_at).toISOString(),
                nextAttemptAt:
                  snapshot.connectionRequest?.status === 'pending'
                    ? new Date(connection.next_attempt_at).toISOString()
                    : null,
                updatedAt: new Date(connection.updated_at).toISOString(),
                lastError:
                  connection.last_error === null
                    ? null
                    : CONNECTION_ERRORS.has(connection.last_error)
                      ? connection.last_error
                      : 'unknown',
              }
            : null,
          confirmationCounts: {
            historicalUnknown: Number(policy.deleted_historical_unknown_count),
            deleteAcknowledged: Number(policy.deleted_acknowledged_count),
            removalReceipt: Number(policy.deleted_removal_receipt_count),
          },
          diagnostics: {
            lastError: policy.last_error,
            historyBoundaryBlocked: snapshot.coverage.gap,
            awaitingCurrentProtection: policy.deferred_from !== null,
            awaitingHistoricalProtection: policy.historical_deferred_from !== null,
          },
          updatedAt: policy.updated_at.toISOString(),
        };
      }),
    };
  }
  async snapshot(
    chatId: string,
    client: pg.Pool | pg.PoolClient = this.pool,
  ): Promise<Record<string, unknown>> {
    const page = await this.diagnosticPage(client, { chatIds: [chatId] });
    const policy = page.policies[0];
    if (policy) return this.projectSnapshot(policy, page.counts.get(chatId)!);
    return {
      initialized: false,
      enabled: false,
      hours: 48,
      revision: 0,
      enabledAt: null,
      captureAfter: null,
      pausedAt: null,
      pendingCount: 0,
      deletedCount: 0,
      skippedCount: 0,
      oldestDueAt: null,
      status: this.executionEnabled ? 'off' : 'unavailable',
      connectionStatus: 'unknown',
      historyStatus: 'off',
      historyScannedCount: 0,
      connectionRequest: null,
    };
  }
  async operation(chatId: string, input: UpdatePolicy): Promise<Record<string, unknown> | null> {
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          enabled: input.enabled,
          hours: input.hours,
          expectedRevision: input.expectedRevision,
          actorUserId: input.actorUserId,
          ...(input.connectWhenReady === true ? { connectWhenReady: true } : {}),
        }),
      )
      .digest('hex');
    const row = (
      await this.pool.query<{ request_hash: string; response: Record<string, unknown> }>(
        'SELECT request_hash,response FROM eraser_operations WHERE chat_id=$1 AND operation_id=$2',
        [chatId, input.operationId],
      )
    ).rows[0];
    if (!row) return null;
    if (row.request_hash !== hash)
      throw new ServiceError(
        409,
        'ERASER_OPERATION_CONFLICT',
        'Идентификатор сохранения уже использован.',
      );
    return row.response;
  }
  async activationGuard(chatId: string, input: UpdatePolicy): Promise<PolicyActivationGuard> {
    return this.transaction(async (client) => {
      await this.ensure(client, chatId);
      const policy = (
        await client.query<PolicyRow>('SELECT * FROM eraser_policies WHERE chat_id=$1', [chatId])
      ).rows[0]!;
      if (policy.revision !== input.expectedRevision)
        throw new ServiceError(
          409,
          'MESSAGE_RETENTION_REVISION_CONFLICT',
          'Настройки уже изменены.',
        );
      // FLAG: Capture before MAX admission/HTTP; never refresh this generation after rights return.
      return {
        chatId,
        operationId: input.operationId,
        expectedRevision: input.expectedRevision,
        connectionGeneration: policy.connection_generation,
      };
    });
  }
  async assertActivationGuard(guard: PolicyActivationGuard): Promise<void> {
    const policy = await this.policy(guard.chatId);
    if (!policy || policy.revision !== guard.expectedRevision)
      throw new ServiceError(409, 'MESSAGE_RETENTION_REVISION_CONFLICT', 'Настройки уже изменены.');
    if (policy.connection_generation !== guard.connectionGeneration)
      throw new ServiceError(
        409,
        'ERASER_CONNECTION_GUARD_CHANGED',
        'Доступ Ластика изменился. Повторите сохранение.',
      );
  }
  async update(
    chatId: string,
    input: UpdatePolicy,
    proof?: PolicyActivationProof,
  ): Promise<Record<string, unknown>> {
    if (input.connectWhenReady && !input.enabled)
      throw new ServiceError(400, 'INVALID_POLICY', 'Подключение требует включения очистки.');
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          enabled: input.enabled,
          hours: input.hours,
          expectedRevision: input.expectedRevision,
          actorUserId: input.actorUserId,
          ...(input.connectWhenReady === true ? { connectWhenReady: true } : {}),
        }),
      )
      .digest('hex');
    return this.transaction(async (client) => {
      await this.ensure(client, chatId);
      const policy = (
        await client.query<PolicyRow>('SELECT * FROM eraser_policies WHERE chat_id=$1 FOR UPDATE', [
          chatId,
        ])
      ).rows[0]!;
      const previous = (
        await client.query<{ request_hash: string; response: Record<string, unknown> }>(
          'SELECT request_hash,response FROM eraser_operations WHERE chat_id=$1 AND operation_id=$2',
          [chatId, input.operationId],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== hash)
          throw new ServiceError(
            409,
            'ERASER_OPERATION_CONFLICT',
            'Идентификатор сохранения уже использован.',
          );
        return previous.response;
      }
      if (input.expectedRevision !== policy.revision)
        throw new ServiceError(
          409,
          'MESSAGE_RETENTION_REVISION_CONFLICT',
          'Настройки уже изменены.',
        );
      if (input.enabled) {
        if (!this.executionEnabled)
          throw new ServiceError(503, 'ERASER_UNAVAILABLE', 'Ластик пока недоступен.');
        const protection = (
          await client.query<{ ready: boolean }>(
            'SELECT ready FROM eraser_protection_state WHERE chat_id=$1',
            [chatId],
          )
        ).rows[0];
        if (!protection?.ready)
          throw new ServiceError(
            409,
            'ERASER_PROTECTION_PENDING',
            'Подготавливаем защиту правил и розыгрышей.',
          );
      }
      const now = Date.now(),
        cutoff = now - input.hours * HOUR;
      const enabled = input.enabled && !input.connectWhenReady;
      const restart = enabled && (!policy.enabled || input.hours !== policy.hours);
      if (
        enabled &&
        (!validConnectionProof(proof, chatId) ||
          proof.operationId !== input.operationId ||
          proof.expectedRevision !== input.expectedRevision ||
          proof.connectionGeneration !== policy.connection_generation)
      )
        throw new ServiceError(
          409,
          'ERASER_CONNECTION_GUARD_CHANGED',
          'Доступ Ластика изменился. Повторите сохранение.',
        );
      // FLAG: Positive connection authority and accepted policy share one transaction. A late
      // removal, stale operation or proof consumed by a lock wait cannot lift the durable fence.
      const updated = await client.query(
        `UPDATE eraser_policies SET enabled=$2,hours=$3,revision=revision+1,last_operation_id=$4,updated_at=CURRENT_TIMESTAMP,last_error=NULL,
        connection_status=CASE WHEN $2 THEN 'connected' ELSE connection_status END,
        activation_id=CASE WHEN enabled <> $2 THEN $5::uuid ELSE activation_id END,
        enabled_at=CASE WHEN NOT enabled AND $2 THEN CURRENT_TIMESTAMP ELSE enabled_at END,
        first_enabled_at=CASE WHEN $2 THEN COALESCE(first_enabled_at,CURRENT_TIMESTAMP) ELSE first_enabled_at END,
        live_floor=CASE WHEN $6 THEN LEAST($7,live_gap_at,safety_gap_at) ELSE live_floor END,live_upper=CASE WHEN $6 THEN NULL ELSE live_upper END,live_cursor=CASE WHEN $6 THEN NULL ELSE live_cursor END,
        history_cursor=CASE WHEN $6 THEN GREATEST(COALESCE(history_cursor,0),$8) ELSE history_cursor END,
        history_complete=CASE WHEN $6 THEN false ELSE history_complete END,history_gap=CASE WHEN $6 THEN false ELSE history_gap END,
        history_signature=CASE WHEN $6 THEN NULL ELSE history_signature END,live_signature=CASE WHEN $6 THEN NULL ELSE live_signature END,
        live_due=CASE WHEN $6 THEN false ELSE live_due END,live_gap=CASE WHEN $6 THEN false ELSE live_gap END,
        due_floor=CASE WHEN $6 THEN NULL ELSE due_floor END,due_generation=due_generation+CASE WHEN $6 THEN 1 ELSE 0 END,
        safety_floor=CASE WHEN $6 THEN LEAST($7,live_gap_at,safety_gap_at) ELSE safety_floor END,
        safety_upper=CASE WHEN $6 THEN NULL ELSE safety_upper END,safety_cursor=CASE WHEN $6 THEN NULL ELSE safety_cursor END,
        safety_signature=CASE WHEN $6 THEN NULL ELSE safety_signature END,
        safety_had_messages=CASE WHEN $6 THEN false ELSE safety_had_messages END,safety_gap=CASE WHEN $6 THEN false ELSE safety_gap END,
        live_scan_purpose=CASE WHEN $6 THEN NULL ELSE live_scan_purpose END,
        live_scan_had_messages=CASE WHEN $6 THEN false ELSE live_scan_had_messages END,
        safety_next_at=CASE WHEN $6 THEN CURRENT_TIMESTAMP ELSE safety_next_at END,normal_next_at=CURRENT_TIMESTAMP,next_run_at=CURRENT_TIMESTAMP
        WHERE chat_id=$1 AND revision=$9 AND (NOT $2 OR
          (connection_generation=$10::bigint AND $11::timestamptz>clock_timestamp())) RETURNING chat_id`,
        [
          chatId,
          enabled,
          input.hours,
          input.operationId,
          randomUUID(),
          restart,
          cutoff + 1,
          cutoff,
          input.expectedRevision,
          proof?.connectionGeneration ?? null,
          proof?.expiresAt ?? null,
        ],
      );
      if (!updated.rowCount)
        throw new ServiceError(
          409,
          'ERASER_CONNECTION_GUARD_CHANGED',
          'Доступ Ластика изменился. Повторите сохранение.',
        );
      if (enabled && input.hours > policy.hours)
        await this.parkYoungCandidates(client, chatId, input.hours, now);
      if (enabled && input.hours < policy.hours) {
        // FLAG: A shorter age may wake only never-issued age deferrals. Pin waits, rejected
        // rate limits and all effect journals keep their deadlines and dispatch identities.
        // Filter through the unissued-age index before the cap; late rejected attempts may
        // exceed the ordinary buffer but cannot displace any of its at-most-200 age deferrals.
        await client.query(
          `WITH pending AS MATERIALIZED (
            SELECT message_id FROM eraser_candidates WHERE chat_id=$1 AND state='pending'
              AND outcome_code='not_due' AND dispatch_id IS NULL AND attempt_count=0
              AND source_ms<=$2 ORDER BY source_ms,message_id LIMIT ${CHAT_BUFFER}
          ) UPDATE eraser_candidates candidate
            SET next_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
            FROM pending WHERE candidate.chat_id=$1 AND candidate.message_id=pending.message_id
              AND candidate.state='pending' AND candidate.outcome_code='not_due'
              AND candidate.dispatch_id IS NULL AND candidate.attempt_count=0
              AND candidate.source_ms<=$2 AND candidate.next_attempt_at>CURRENT_TIMESTAMP`,
          [chatId, cutoff],
        );
      }
      if (input.connectWhenReady) {
        await client.query(
          `INSERT INTO eraser_connection_requests(chat_id,operation_id,actor_user_id,policy_revision,status,expires_at)
           VALUES($1,$2,$3,$4,'pending',clock_timestamp()+INTERVAL '1 hour')
           ON CONFLICT(chat_id) DO UPDATE SET operation_id=EXCLUDED.operation_id,actor_user_id=EXCLUDED.actor_user_id,
           policy_revision=EXCLUDED.policy_revision,status='pending',expires_at=EXCLUDED.expires_at,
           next_attempt_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=clock_timestamp()`,
          [chatId, input.operationId, input.actorUserId, policy.revision + 1],
        );
      } else {
        // FLAG: Every ordinary revision-checked settings write revokes the outstanding opt-in.
        await client.query(
          `UPDATE eraser_connection_requests SET status='cancelled',lease_token=NULL,lease_until=NULL,
           updated_at=clock_timestamp() WHERE chat_id=$1 AND status IN ('pending','expired')`,
          [chatId],
        );
      }
      const response = await this.snapshot(chatId, client);
      await client.query(
        'INSERT INTO eraser_operations(chat_id,operation_id,request_hash,actor_user_id,response) VALUES($1,$2,$3,$4,$5)',
        [chatId, input.operationId, hash, input.actorUserId, response],
      );
      // FLAG: Candidate/request locks and response reads also consume the same proof budget.
      if (
        enabled &&
        !(
          await client.query<{ fresh: boolean }>(
            'SELECT $1::timestamptz>clock_timestamp() AS fresh',
            [proof!.expiresAt],
          )
        ).rows[0]?.fresh
      )
        throw new ServiceError(
          409,
          'ERASER_CONNECTION_GUARD_CHANGED',
          'Доступ Ластика изменился. Повторите сохранение.',
        );
      return response;
    });
  }
  async reserveConnections(limit: number): Promise<Array<{ chatId: string; leaseToken: string }>> {
    if (!this.executionEnabled) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16)
      throw new Error('Invalid connection reservation limit');
    return this.transaction(async (client) => {
      await client.query(
        `WITH expired AS (SELECT chat_id FROM eraser_connection_requests WHERE status='pending'
         AND expires_at<=CURRENT_TIMESTAMP ORDER BY expires_at,chat_id LIMIT 64 FOR UPDATE SKIP LOCKED)
         UPDATE eraser_connection_requests r SET status='expired',lease_token=NULL,lease_until=NULL,
         updated_at=clock_timestamp() FROM expired e WHERE r.chat_id=e.chat_id`,
      );
      const rows = (
        await client.query<{ chat_id: string }>(
          `SELECT chat_id FROM eraser_connection_requests WHERE status='pending'
           AND next_attempt_at<=CURRENT_TIMESTAMP
           AND (lease_until IS NULL OR lease_until<=CURRENT_TIMESTAMP)
           ORDER BY next_attempt_at,chat_id LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [limit],
        )
      ).rows;
      const reserved = [];
      for (const row of rows) {
        const leaseToken = randomUUID();
        const leased = await client.query(
          `UPDATE eraser_connection_requests SET lease_token=$2,
           lease_until=LEAST(expires_at,clock_timestamp()+INTERVAL '60 seconds')
           WHERE chat_id=$1 AND status='pending' AND expires_at>clock_timestamp() RETURNING chat_id`,
          [row.chat_id, leaseToken],
        );
        if (leased.rowCount) reserved.push({ chatId: row.chat_id, leaseToken });
        else
          await client.query(
            `UPDATE eraser_connection_requests SET status='expired',lease_token=NULL,lease_until=NULL,
           updated_at=clock_timestamp() WHERE chat_id=$1 AND status='pending' AND expires_at<=clock_timestamp()`,
            [row.chat_id],
          );
      }
      return reserved;
    });
  }
  async connectionRequest(
    chatId: string,
    leaseToken: string,
  ): Promise<PendingConnectionRequest | null> {
    if (!this.executionEnabled) return null;
    return (
      (
        await this.pool.query<PendingConnectionRequest>(
          `SELECT r.*,p.connection_generation FROM eraser_connection_requests r JOIN eraser_policies p USING(chat_id)
         WHERE r.chat_id=$1 AND r.lease_token=$2 AND r.status='pending' AND NOT p.enabled
         AND p.revision=r.policy_revision AND r.expires_at>clock_timestamp() AND r.lease_until>clock_timestamp()`,
          [chatId, leaseToken],
        )
      ).rows[0] ?? null
    );
  }
  async finishConnection(
    chatId: string,
    leaseToken: string,
    status: 'pending' | 'cancelled',
    code: string | null,
    waitMs: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE eraser_connection_requests SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE $3 END,
       next_attempt_at=LEAST(expires_at,clock_timestamp()+($5 * INTERVAL '1 millisecond')),
       lease_token=NULL,lease_until=NULL,last_error=$4,updated_at=clock_timestamp()
       WHERE chat_id=$1 AND lease_token=$2 AND status='pending'`,
      [chatId, leaseToken, status, code, Math.max(1000, waitMs)],
    );
  }
  async activateConnection(
    chatId: string,
    leaseToken: string,
    proof: ConnectionProof,
  ): Promise<boolean> {
    if (!this.executionEnabled || !validConnectionProof(proof, chatId)) return false;
    const proofExpiresAt = proof.expiresAt;
    return this.transaction(async (client) => {
      const policy = (
        await client.query<PolicyRow>('SELECT * FROM eraser_policies WHERE chat_id=$1 FOR UPDATE', [
          chatId,
        ])
      ).rows[0];
      if (!policy || policy.enabled || policy.connection_generation !== proof.connectionGeneration)
        return false;
      const request = (
        await client.query<ConnectionRequest>(
          `SELECT * FROM eraser_connection_requests WHERE chat_id=$1 AND lease_token=$2
           AND status='pending' AND policy_revision=$3 AND expires_at>clock_timestamp()
           AND lease_until>clock_timestamp() AND $4::timestamptz>clock_timestamp() FOR UPDATE`,
          [chatId, leaseToken, policy.revision, proofExpiresAt],
        )
      ).rows[0];
      if (!request) return false;
      const protection = (
        await client.query<{ ready: boolean }>(
          'SELECT ready FROM eraser_protection_state WHERE chat_id=$1',
          [chatId],
        )
      ).rows[0];
      if (!protection?.ready) return false;
      // FLAG: The final DB-clock predicate fences expiry during row-lock waits. The operation
      // identity and all protection/effect holds survive activation; only this request may enable.
      const result = await client.query(
        `UPDATE eraser_policies p SET enabled=true,revision=revision+1,connection_status='connected',
         activation_id=$3,enabled_at=clock_timestamp(),first_enabled_at=COALESCE(first_enabled_at,clock_timestamp()),
         live_floor=LEAST((EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint-hours*3600000::bigint+1,live_gap_at,safety_gap_at),
         live_upper=NULL,live_cursor=NULL,history_cursor=GREATEST(COALESCE(history_cursor,0),
           (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint-hours*3600000::bigint),
         history_complete=false,history_gap=false,live_gap=false,history_signature=NULL,live_signature=NULL,
         live_due=false,due_floor=NULL,due_generation=due_generation+1,
         safety_floor=LEAST((EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint-hours*3600000::bigint+1,live_gap_at,safety_gap_at),
         safety_upper=NULL,safety_cursor=NULL,safety_signature=NULL,safety_had_messages=false,safety_gap=false,
         live_scan_purpose=NULL,live_scan_had_messages=false,safety_next_at=clock_timestamp(),normal_next_at=clock_timestamp(),
         lease_token=NULL,lease_until=NULL,last_error=NULL,next_run_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE chat_id=$1 AND NOT enabled AND revision=$4 AND connection_generation=$6::bigint AND $5::timestamptz>clock_timestamp() AND EXISTS(
           SELECT 1 FROM eraser_connection_requests r WHERE r.chat_id=p.chat_id AND r.lease_token=$2
           AND r.status='pending' AND r.policy_revision=p.revision AND r.expires_at>clock_timestamp()
           AND r.lease_until>clock_timestamp()) RETURNING chat_id`,
        [
          chatId,
          leaseToken,
          randomUUID(),
          policy.revision,
          proofExpiresAt,
          proof.connectionGeneration,
        ],
      );
      if (!result.rowCount) return false;
      await client.query(
        `UPDATE eraser_connection_requests SET status='activated',lease_token=NULL,lease_until=NULL,
         last_error=NULL,updated_at=clock_timestamp() WHERE chat_id=$1 AND lease_token=$2`,
        [chatId, leaseToken],
      );
      return true;
    });
  }
  private async putFutureMinute(
    client: pg.PoolClient,
    chatId: string,
    sourceMs: number,
  ): Promise<void> {
    const hour = Math.floor(sourceMs / HOUR) * HOUR;
    const minute = Math.floor((sourceMs - hour) / MINUTE);
    await client.query(
      `INSERT INTO eraser_future_hours(chat_id,hour_ms,minutes) VALUES($1,$2,set_bit(B'0'::bit(60),$3,1))
       ON CONFLICT(chat_id,hour_ms) DO UPDATE SET minutes=eraser_future_hours.minutes | EXCLUDED.minutes
       WHERE get_bit(eraser_future_hours.minutes,$3)=0`,
      [chatId, hour, minute],
    );
  }

  private async firstFutureMinute(
    client: pg.Pool | pg.PoolClient,
    chatId: string,
    hours: Hours,
    after?: number,
  ) {
    const buckets = (
      await client.query<{ hour_ms: string; minutes: string }>(
        `SELECT hour_ms,minutes::text FROM eraser_future_hours WHERE chat_id=$1 AND hour_ms >= $2
       ORDER BY hour_ms LIMIT ${after === undefined ? 1 : 170}`,
        [chatId, after === undefined ? 0 : Math.floor(after / HOUR) * HOUR],
      )
    ).rows;
    for (const bucket of buckets) {
      for (let minute = 0; minute < 60; minute++) {
        const sourceMs = Number(bucket.hour_ms) + minute * MINUTE;
        if (
          bucket.minutes[minute] === '1' &&
          (after === undefined || sourceMs + MINUTE - 1 > after)
        )
          return { sourceMs, dueMs: sourceMs + MINUTE + hours * HOUR };
      }
    }
    return null;
  }

  private async compactExpiredHours(
    client: pg.PoolClient,
    policy: PolicyRow,
    now: number,
  ): Promise<void> {
    // FLAG: Expired bitmap rows become one durable due continuation before deletion. The
    // policy lock serializes ingestion, scan completion and period changes; no effect is replayed.
    const expired = (
      await client.query<{ hour_ms: string; minutes: string }>(
        'SELECT hour_ms,minutes::text FROM eraser_future_hours WHERE chat_id=$1 AND hour_ms<=$2 ORDER BY hour_ms LIMIT 32',
        [policy.chat_id, now - policy.hours * HOUR - HOUR],
      )
    ).rows;
    if (!expired.length) return;
    const first = expired[0]!;
    const floor = Number(first.hour_ms) + first.minutes.indexOf('1') * MINUTE;
    const wake =
      !policy.live_gap ||
      (policy.live_upper !== null &&
        expired.some(
          (bucket) =>
            Number(bucket.hour_ms) + (bucket.minutes.lastIndexOf('1') + 1) * MINUTE - 1 >
            Number(policy.live_upper),
        ));
    // FLAG: Transfer both the lower bound and its runnable wake before deleting bitmap rows.
    // Only an interval extending past the blocked upper can reopen the retained gap window.
    await client.query(
      `UPDATE eraser_policies SET live_floor=LEAST(COALESCE(live_floor,$2),$2),live_due=true,
       due_floor=LEAST(due_floor,$2),due_generation=due_generation+1,live_gap=CASE WHEN $3 THEN false ELSE live_gap END,
       live_upper=CASE WHEN $3 THEN NULL ELSE live_upper END,
       live_cursor=CASE WHEN $3 THEN NULL ELSE live_cursor END,
       live_scan_purpose=CASE WHEN $3 THEN NULL ELSE live_scan_purpose END,live_scan_had_messages=false,
       live_signature=CASE WHEN $3 THEN NULL ELSE live_signature END,
       normal_next_at=CASE WHEN $3 THEN LEAST(normal_next_at,CURRENT_TIMESTAMP) ELSE normal_next_at END,
       next_run_at=CASE WHEN $3 THEN LEAST(normal_next_at,safety_next_at,CURRENT_TIMESTAMP) ELSE next_run_at END
       WHERE chat_id=$1`,
      [policy.chat_id, floor, wake],
    );
    await client.query(
      'DELETE FROM eraser_future_hours WHERE chat_id=$1 AND hour_ms=ANY($2::bigint[])',
      [policy.chat_id, expired.map((row) => row.hour_ms)],
    );
  }

  private async clearCoveredMinutes(
    client: pg.PoolClient,
    chatId: string,
    lower: number,
    upper: number,
  ): Promise<void> {
    const rows = (
      await client.query<{ hour_ms: string; minutes: string }>(
        'SELECT hour_ms,minutes::text FROM eraser_future_hours WHERE chat_id=$1 AND hour_ms BETWEEN $2 AND $3 ORDER BY hour_ms LIMIT 170',
        [chatId, Math.floor(lower / HOUR) * HOUR, Math.floor(upper / HOUR) * HOUR],
      )
    ).rows;
    const changed: { hour_ms: string; minutes: string }[] = [];
    for (const row of rows) {
      const bits = [...row.minutes];
      for (let minute = 0; minute < 60; minute++) {
        const start = Number(row.hour_ms) + minute * MINUTE;
        if (start >= lower && start + MINUTE - 1 <= upper) bits[minute] = '0';
      }
      const minutes = bits.join('');
      if (minutes !== row.minutes) changed.push({ hour_ms: row.hour_ms, minutes });
    }
    if (!changed.length) return;
    await client.query(
      `UPDATE eraser_future_hours bucket SET minutes=page.minutes::bit(60)
       FROM jsonb_to_recordset($2::jsonb) AS page(hour_ms bigint,minutes text)
       WHERE bucket.chat_id=$1 AND bucket.hour_ms=page.hour_ms`,
      [chatId, JSON.stringify(changed)],
    );
    await client.query(
      "DELETE FROM eraser_future_hours WHERE chat_id=$1 AND hour_ms=ANY($2::bigint[]) AND minutes=B'0'::bit(60)",
      [chatId, changed.map((row) => row.hour_ms)],
    );
  }

  private async parkYoungCandidates(
    client: pg.PoolClient,
    chatId: string,
    hours: Hours,
    now: number,
  ): Promise<void> {
    const rows = (
      await client.query<{ message_id: string; source_ms: string }>(
        `SELECT message_id,source_ms FROM eraser_candidates WHERE chat_id=$1 AND state='pending'
       AND dispatch_id IS NULL AND attempt_count=0 AND source_ms>$2
       AND next_attempt_at<=to_timestamp((source_ms+$3::bigint)::double precision/1000)
       ORDER BY source_ms,message_id LIMIT ${CHAT_BUFFER} FOR UPDATE`,
        [chatId, now - hours * HOUR, hours * HOUR],
      )
    ).rows;
    const buckets = new Map<number, string[]>();
    for (const row of rows) {
      const source = Number(row.source_ms);
      const hour = Math.floor(source / HOUR) * HOUR;
      const bits = buckets.get(hour) ?? Array<string>(60).fill('0');
      bits[Math.floor((source - hour) / MINUTE)] = '1';
      buckets.set(hour, bits);
    }
    if (buckets.size)
      await client.query(
        `INSERT INTO eraser_future_hours(chat_id,hour_ms,minutes)
       SELECT $1,b.hour_ms,b.minutes::bit(60) FROM jsonb_to_recordset($2::jsonb) AS b(hour_ms bigint,minutes text)
       ON CONFLICT(chat_id,hour_ms) DO UPDATE SET minutes=eraser_future_hours.minutes | EXCLUDED.minutes
       WHERE eraser_future_hours.minutes <> (eraser_future_hours.minutes | EXCLUDED.minutes)`,
        [
          chatId,
          JSON.stringify(
            [...buckets].map(([hour_ms, bits]) => ({ hour_ms, minutes: bits.join('') })),
          ),
        ],
      );
    if (rows.length)
      await client.query(
        `DELETE FROM eraser_candidates WHERE chat_id=$1 AND message_id=ANY($2::text[])
       AND state='pending' AND dispatch_id IS NULL AND attempt_count=0`,
        [chatId, rows.map((row) => row.message_id)],
      );
  }

  private async reschedule(
    client: pg.PoolClient,
    policy: PolicyRow,
    error: string | null = null,
    waitMs = 1000,
  ): Promise<void> {
    const now = Date.now();
    const due = effectiveDueSql(policy.hours);
    const heads = (
      await client.query<{ due_ms: string }>(
        `(SELECT ${due}::text AS due_ms FROM eraser_candidates WHERE chat_id=$1 AND state='pending' AND lane='live' ORDER BY ${due},source_ms,message_id LIMIT 1)
       UNION ALL (SELECT ${due}::text AS due_ms FROM eraser_candidates WHERE chat_id=$1 AND state='pending' AND lane='history' ORDER BY ${due},source_ms,message_id LIMIT 1)`,
        [policy.chat_id],
      )
    ).rows;
    const future = await this.firstFutureMinute(
      client,
      policy.chat_id,
      policy.hours,
      policy.live_gap && policy.live_upper !== null ? Number(policy.live_upper) : undefined,
    );
    const capacity = (await this.bufferSize(policy.chat_id, client)) <= CHAT_BUFFER - 100;
    const dueScan =
      capacity &&
      ((!policy.history_complete && !policy.history_gap) ||
        (future !== null && future.dueMs <= now) ||
        (!policy.live_gap &&
          policy.due_floor !== null &&
          (policy.live_due || policy.live_cursor !== null)));
    const target = Math.min(
      ...heads.map((row) => Number(row.due_ms)),
      capacity && future ? future.dueMs : Infinity,
      dueScan ? now : Infinity,
    );
    let normalAt = Number.isFinite(target) ? Math.max(now + 1000, target) : NO_WORK_AT.getTime();
    let safetyAt = policy.safety_next_at.getTime();
    if (!capacity) safetyAt = Math.max(safetyAt, now + SAFETY_DELAYS[0]!);
    if (capacity && policy.safety_cursor !== null && !policy.safety_gap) safetyAt = now + 1000;
    if (error) {
      const retryAt = now + Math.max(1000, waitMs);
      normalAt = Math.max(normalAt, retryAt);
      safetyAt = Math.max(safetyAt, retryAt);
    }
    // FLAG: Repairing only the legacy projection is still a native write. The transaction
    // marker prevents a completed safety window from acquiring ordinary network quota.
    await client.query(
      `UPDATE eraser_policies SET normal_next_at=$2::timestamptz,safety_next_at=$3::timestamptz,next_run_at=LEAST($2::timestamptz,$3::timestamptz) WHERE chat_id=$1`,
      [policy.chat_id, new Date(normalAt), new Date(safetyAt)],
    );
  }

  async reserve(
    limit: number,
    purpose: ScanPurpose = 'due',
  ): Promise<Array<{ chatId: string; leaseToken: string; purpose: ScanPurpose }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > (purpose === 'safety' ? 2 : 64))
      throw new Error('Invalid reservation limit');
    const schedule = purpose === 'safety' ? 'safety_next_at' : 'normal_next_at';
    return this.transaction(async (client) => {
      const rows = (
        await client.query<{ chat_id: string }>(
          `SELECT chat_id FROM eraser_policies WHERE enabled AND connection_status NOT IN ('missing','no_access') AND ${schedule}<=CURRENT_TIMESTAMP AND (lease_until IS NULL OR lease_until<CURRENT_TIMESTAMP) ORDER BY ${schedule},chat_id LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [limit],
        )
      ).rows;
      const result = [];
      for (const row of rows) {
        const leaseToken = randomUUID();
        await client.query(
          "UPDATE eraser_policies SET lease_token=$2,lease_until=CURRENT_TIMESTAMP+INTERVAL '60 seconds',lease_purpose=$3 WHERE chat_id=$1",
          [row.chat_id, leaseToken, purpose],
        );
        result.push({ chatId: row.chat_id, leaseToken, purpose });
      }
      return result;
    });
  }
  async finishVisit(
    chatId: string,
    token: string,
    error: string | null = null,
    waitMs = 1000,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const policy = (
        await client.query<PolicyRow>(
          'SELECT * FROM eraser_policies WHERE chat_id=$1 AND lease_token=$2 FOR UPDATE',
          [chatId, token],
        )
      ).rows[0];
      if (!policy) return;
      // FLAG: Recompute from current durable inputs under the same lock used by ingress.
      // A stale visit cannot replace a newer event's due wake with its idle polling delay.
      await this.reschedule(client, policy, error, waitMs);
      await client.query(
        'UPDATE eraser_policies SET lease_token=NULL,lease_until=NULL,last_error=$3 WHERE chat_id=$1 AND lease_token=$2',
        [chatId, token, error],
      );
    });
  }
  async connection(chatId: string, status: 'connected' | 'no_access'): Promise<void> {
    // FLAG: Passive rights observations cannot undo an authenticated removal or proven denial.
    await this.pool.query(
      "UPDATE eraser_policies SET connection_status=$2,connection_generation=connection_generation+CASE WHEN $2='no_access' THEN 1 ELSE 0 END WHERE chat_id=$1 AND ($2<>'connected' OR connection_status NOT IN ('missing','no_access'))",
      [chatId, status],
    );
  }
  async active(chatId: string, token: string): Promise<PolicyRow | null> {
    return (
      (
        await this.pool.query<PolicyRow>(
          "SELECT * FROM eraser_policies WHERE chat_id=$1 AND enabled AND connection_status NOT IN ('missing','no_access') AND lease_token=$2 AND lease_until>CURRENT_TIMESTAMP",
          [chatId, token],
        )
      ).rows[0] ?? null
    );
  }
  async nextCandidates(chatId: string, hours?: Hours): Promise<Candidate[]> {
    const selectedHours = hours ?? (await this.policy(chatId))?.hours;
    if (!selectedHours) return [];
    const due = effectiveDueSql(selectedHours);
    return (
      await this.pool.query<Candidate>(
        `SELECT * FROM (
        (SELECT * FROM eraser_candidates WHERE chat_id=$1 AND state='pending' AND lane='live'
         AND ${due}<=$2 ORDER BY ${due},source_ms,message_id LIMIT 5)
        UNION ALL
        (SELECT * FROM eraser_candidates WHERE chat_id=$1 AND state='pending' AND lane='history'
         AND ${due}<=$2 ORDER BY ${due},source_ms,message_id LIMIT 5)
       ) selected ORDER BY CASE WHEN lane='live' THEN 0 ELSE 1 END,${due},source_ms,message_id LIMIT 5`,
        [chatId, Date.now()],
      )
    ).rows;
  }
  async reconciliation(chatId: string): Promise<Candidate | null> {
    return (
      (
        await this.pool.query<Candidate>(
          `SELECT * FROM eraser_candidates WHERE chat_id=$1 AND state IN ('uncertain','dispatching') AND next_attempt_at<=CURRENT_TIMESTAMP ORDER BY next_attempt_at,message_id LIMIT 1`,
          [chatId],
        )
      ).rows[0] ?? null
    );
  }
  async openScan(
    policy: PolicyRow,
    lane: Lane,
    purpose: ScanPurpose = 'due',
  ): Promise<{ upper: number; lower?: number } | null> {
    const now = Date.now();
    const cutoff = now - policy.hours * HOUR;
    if (lane === 'history')
      return purpose === 'safety' || policy.history_complete || policy.history_gap
        ? null
        : { upper: Number(policy.history_cursor ?? cutoff) };
    if (purpose === 'safety') {
      const floor = Number(policy.safety_floor ?? policy.live_floor ?? cutoff + 1);
      if (floor > cutoff) return null;
      if (policy.safety_cursor !== null && !policy.safety_gap)
        return { upper: Number(policy.safety_cursor), lower: floor };
      const opened = await this.pool.query(
        `UPDATE eraser_policies SET safety_floor=$6,safety_upper=$2,safety_cursor=$2,safety_signature=NULL,
         safety_had_messages=false,safety_gap=false WHERE chat_id=$1 AND lease_token=$3
         AND lease_until>clock_timestamp() AND enabled AND revision=$4 AND scan_generation=$5`,
        [
          policy.chat_id,
          cutoff,
          policy.lease_token,
          policy.revision,
          policy.scan_generation,
          floor,
        ],
      );
      return opened.rowCount ? { upper: cutoff, lower: floor } : null;
    }
    const future = await this.firstFutureMinute(
      this.pool,
      policy.chat_id,
      policy.hours,
      policy.live_gap && policy.live_upper !== null ? Number(policy.live_upper) : undefined,
    );
    if (policy.live_gap && (!future || future.dueMs > now)) return null;
    const knownDue =
      (policy.live_due && policy.due_floor !== null) || (future !== null && future.dueMs <= now);
    if (!knownDue && (policy.live_cursor === null || policy.due_floor === null)) return null;
    const floor = Math.min(
      policy.due_floor === null ? Infinity : Number(policy.due_floor),
      future?.sourceMs ?? Infinity,
    );
    if (floor > cutoff) return null;
    if (!policy.live_gap && policy.live_cursor !== null && policy.due_floor !== null)
      return { upper: Number(policy.live_cursor), lower: floor };
    const opened = await this.pool.query(
      `UPDATE eraser_policies SET due_floor=$6,live_floor=LEAST(live_floor,$6),live_upper=$2,live_cursor=$2,live_signature=NULL,
       live_scan_purpose='due',live_scan_had_messages=false,live_gap=false WHERE chat_id=$1 AND lease_token=$3
       AND lease_until>clock_timestamp() AND enabled AND revision=$4 AND scan_generation=$5 AND due_generation=$7`,
      [
        policy.chat_id,
        cutoff,
        policy.lease_token,
        policy.revision,
        policy.scan_generation,
        floor,
        policy.due_generation,
      ],
    );
    return opened.rowCount ? { upper: cutoff, lower: floor } : null;
  }
  async bufferSize(chatId: string, client: pg.Pool | pg.PoolClient = this.pool): Promise<number> {
    // FLAG: Accepted uncertain/issued/review journals remain unique and durable, but consume
    // no ordinary page capacity; unresolved effects cannot stop independent history progress.
    // The cap governs new intake: late known 429s retain retries even when they exceed that cap.
    return (
      await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM (SELECT 1 FROM eraser_candidates WHERE chat_id=$1 AND state='pending' LIMIT ${CHAT_BUFFER + 1}) c`,
        [chatId],
      )
    ).rows[0]!.count;
  }
  async savePage(
    policy: PolicyRow,
    lane: Lane,
    messages: Message[],
    purpose: ScanPurpose = 'due',
  ): Promise<void> {
    await this.transaction(async (client) => {
      const current = (
        await client.query<PolicyRow>(
          'SELECT * FROM eraser_policies WHERE chat_id=$1 AND enabled AND lease_token=$2 AND lease_until>CURRENT_TIMESTAMP FOR UPDATE',
          [policy.chat_id, policy.lease_token],
        )
      ).rows[0];
      // FLAG: A late webhook or protection rewind invalidates an in-flight page, including an
      // empty one. It must never certify completion or advance over the new work.
      if (
        !current ||
        current.revision !== policy.revision ||
        current.scan_generation !== policy.scan_generation ||
        (lane === 'live' && purpose === 'due' && current.due_generation !== policy.due_generation)
      )
        return;
      if ((await this.bufferSize(policy.chat_id, client)) > CHAT_BUFFER - 100) return;
      const protection = (
        await client.query<ProtectionState>(
          'SELECT ready,complete_through,bot_history_complete_from FROM eraser_protection_state WHERE chat_id=$1',
          [policy.chat_id],
        )
      ).rows[0];
      const signature = createHash('sha256')
        .update(messages.map((m) => `${m.id}:${m.sourceMs}`).join('|'))
        .digest('hex');
      const safety = lane === 'live' && purpose === 'safety';
      const previous = safety
        ? current.safety_signature
        : lane === 'live'
          ? current.live_signature
          : current.history_signature;
      const repeated = messages.length === 100 && signature === previous;
      let deferredFrom: number | null = null,
        deferredTo: number | null = null,
        historicalFrom: number | null = null,
        historicalTo: number | null = null;
      const exclusions = (
        await client.query<{ id: string; kind: string }>(
          "SELECT message_id AS id,'message' AS kind FROM eraser_protected_messages WHERE chat_id=$1 AND message_id=ANY($2::text[]) UNION ALL SELECT author_id AS id,'author' AS kind FROM eraser_held_authors WHERE chat_id=$1 AND author_id=ANY($3::text[]) UNION ALL SELECT author_id AS id,'author' AS kind FROM eraser_global_held_authors WHERE author_id=ANY($3::text[]) UNION ALL SELECT message_id AS id,'message' AS kind FROM eraser_global_message_holds WHERE chat_id=$1 AND message_id=ANY($2::text[]) UNION ALL SELECT bot_id AS id,'bot' AS kind FROM eraser_protected_bots WHERE chat_id=$1 AND bot_id=ANY($3::text[])",
          [
            policy.chat_id,
            messages.map((message) => message.id),
            messages.map((message) => message.authorId),
          ],
        )
      ).rows;
      const excludedMessages = new Set(
        exclusions.filter((row) => row.kind === 'message').map((row) => row.id),
      );
      const excludedAuthors = new Set(
        exclusions.filter((row) => row.kind === 'author').map((row) => row.id),
      );
      const moduleBots = new Set(
        exclusions.filter((row) => row.kind === 'bot').map((row) => row.id),
      );
      const admitted = [];
      for (const message of messages) {
        if (
          message.sourceMs + current.hours * HOUR > Date.now() ||
          excludedMessages.has(message.id) ||
          excludedAuthors.has(message.authorId)
        )
          continue;
        const gap = protectionGap(message, moduleBots.has(message.authorId), protection);
        if (gap === 'current') {
          deferredFrom = Math.min(deferredFrom ?? message.sourceMs, message.sourceMs);
          deferredTo = Math.max(deferredTo ?? message.sourceMs, message.sourceMs);
          continue;
        }
        if (gap === 'history') {
          historicalFrom = Math.min(historicalFrom ?? message.sourceMs, message.sourceMs);
          historicalTo = Math.max(historicalTo ?? message.sourceMs, message.sourceMs);
          continue;
        }
        admitted.push({
          message_id: message.id,
          author_id: message.authorId,
          is_bot: message.isBot,
          source_ms: message.sourceMs,
        });
      }
      await client.query(
        `INSERT INTO eraser_candidates(chat_id,message_id,author_id,is_bot,source_ms,lane)
        SELECT $1,m.message_id,m.author_id,m.is_bot,m.source_ms,$3 FROM jsonb_to_recordset($2::jsonb) AS m(message_id text,author_id text,is_bot boolean,source_ms bigint) ON CONFLICT DO NOTHING`,
        [policy.chat_id, JSON.stringify(admitted), lane],
      );
      await client.query(
        'UPDATE eraser_policies SET scanned_count=scanned_count+$2,deferred_from=CASE WHEN $3::bigint IS NULL THEN deferred_from ELSE LEAST(COALESCE(deferred_from,$3),$3) END,deferred_to=CASE WHEN $4::bigint IS NULL THEN deferred_to ELSE GREATEST(COALESCE(deferred_to,$4),$4) END,historical_deferred_from=CASE WHEN $5::bigint IS NULL THEN historical_deferred_from ELSE LEAST(COALESCE(historical_deferred_from,$5),$5) END,historical_deferred_to=CASE WHEN $6::bigint IS NULL THEN historical_deferred_to ELSE GREATEST(COALESCE(historical_deferred_to,$6),$6) END WHERE chat_id=$1',
        [policy.chat_id, messages.length, deferredFrom, deferredTo, historicalFrom, historicalTo],
      );
      const oldest = messages.at(-1)?.sourceMs;
      if (lane === 'history') {
        await client.query(
          'UPDATE eraser_policies SET history_cursor=COALESCE($2,history_cursor),history_complete=$3,history_gap=$4,history_signature=$5 WHERE chat_id=$1',
          [policy.chat_id, oldest ?? null, messages.length < 100, repeated, signature],
        );
      } else if (safety && messages.length < 100 && current.safety_upper !== null) {
        const empty = !current.safety_had_messages && messages.length === 0;
        const streak = empty ? Math.min(current.safety_empty_streak + 1, SAFETY_DELAYS.length) : 0;
        const delay = SAFETY_DELAYS[Math.max(0, streak - 1)]!;
        // FLAG: Only a complete independent safety window certifies broad coverage. Preserve
        // all known-due hints; ordinary work can continue even while this lane is unfinished.
        await client.query(
          `UPDATE eraser_policies SET live_floor=LEAST(safety_upper+1,due_floor),safety_floor=safety_upper+1,
           safety_gap_at=CASE WHEN safety_gap_at BETWEEN safety_floor AND safety_upper THEN NULL ELSE safety_gap_at END,
           live_gap=CASE WHEN live_gap_at BETWEEN safety_floor AND safety_upper THEN false ELSE live_gap END,
           live_gap_at=CASE WHEN live_gap_at BETWEEN safety_floor AND safety_upper THEN NULL ELSE live_gap_at END,
           safety_upper=NULL,safety_cursor=NULL,safety_signature=NULL,safety_gap=false,
           safety_had_messages=false,safety_empty_streak=$2,
           safety_next_at=clock_timestamp()+($3*INTERVAL '1 millisecond'),last_live_completed_at=clock_timestamp(),
           live_cursor=CASE WHEN due_floor IS NULL THEN NULL ELSE live_cursor END,
           live_upper=CASE WHEN due_floor IS NULL THEN NULL ELSE live_upper END,
           live_signature=CASE WHEN due_floor IS NULL THEN NULL ELSE live_signature END
           WHERE chat_id=$1`,
          [policy.chat_id, streak, delay],
        );
      } else if (safety) {
        await client.query(
          `UPDATE eraser_policies SET safety_cursor=$2,safety_signature=$3,safety_gap=safety_gap OR $4,
           safety_gap_at=CASE WHEN $4 THEN COALESCE(safety_gap_at,$2) ELSE safety_gap_at END,
           safety_had_messages=safety_had_messages OR $5,
           safety_next_at=CASE WHEN $4 THEN clock_timestamp()+INTERVAL '6 hours' ELSE safety_next_at END
           WHERE chat_id=$1`,
          [
            policy.chat_id,
            oldest ?? current.safety_cursor,
            signature,
            repeated,
            messages.length > 0,
          ],
        );
      } else if (
        messages.length < 100 &&
        current.live_upper !== null &&
        current.due_floor !== null
      ) {
        await this.clearCoveredMinutes(
          client,
          policy.chat_id,
          Number(current.due_floor),
          Number(current.live_upper),
        );
        await client.query(
          `UPDATE eraser_policies SET live_floor=COALESCE(safety_floor,live_floor),
           live_gap_at=CASE WHEN live_gap_at BETWEEN due_floor AND live_upper THEN NULL ELSE live_gap_at END,
           due_floor=NULL,live_upper=NULL,live_cursor=NULL,live_signature=NULL,live_due=false,live_gap=false,
           live_scan_purpose=NULL,live_scan_had_messages=false WHERE chat_id=$1`,
          [policy.chat_id],
        );
      } else {
        await client.query(
          `UPDATE eraser_policies SET live_cursor=$2,live_signature=$3,live_gap=live_gap OR $4,
           live_gap_at=CASE WHEN $4 THEN COALESCE(live_gap_at,$2) ELSE live_gap_at END,
           live_scan_purpose='due',live_scan_had_messages=live_scan_had_messages OR $5 WHERE chat_id=$1`,
          [policy.chat_id, oldest ?? current.live_cursor, signature, repeated, messages.length > 0],
        );
      }
      await client.query(
        `UPDATE eraser_policies SET ${lane === 'live' && purpose === 'due' ? 'due_generation=due_generation+1' : 'scan_generation=scan_generation+1'} WHERE chat_id=$1`,
        [policy.chat_id],
      );
    });
  }
  async assertAndMarkDispatch(
    candidate: Candidate,
    token: string,
    checkedAt: number,
    pinAt: number,
  ): Promise<string> {
    return this.transaction(async (client) => {
      // FLAG: A hold acknowledgement cannot pass an uncommitted final dispatch decision.
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('eraser:effect-holds:v1'))");
      const policy = (
        await client.query<PolicyRow & { lease_valid: boolean }>(
          'SELECT *,lease_until>CURRENT_TIMESTAMP AS lease_valid FROM eraser_policies WHERE chat_id=$1 FOR UPDATE',
          [candidate.chat_id],
        )
      ).rows[0];
      if (
        !this.executionEnabled ||
        !policy?.enabled ||
        ['missing', 'no_access'].includes(policy.connection_status) ||
        policy.lease_token !== token ||
        !policy.lease_valid ||
        !policy.lease_until ||
        policy.lease_until.getTime() <= Date.now() ||
        Date.now() - checkedAt >= 30_000 ||
        Date.now() - pinAt >= 5000
      )
        throw new ServiceError(409, 'ERASER_GUARD_CHANGED', 'Удаление отложено.');
      const row = (
        await client.query<Candidate>(
          'SELECT * FROM eraser_candidates WHERE chat_id=$1 AND message_id=$2 FOR UPDATE',
          [candidate.chat_id, candidate.message_id],
        )
      ).rows[0];
      if (
        !row ||
        row.state !== 'pending' ||
        row.dispatch_id !== candidate.dispatch_id ||
        row.next_attempt_at.getTime() > Date.now() ||
        Number(row.source_ms) + policy.hours * HOUR > Date.now()
      )
        throw new ServiceError(409, 'ERASER_GUARD_CHANGED', 'Срок ещё не наступил.');
      const protectedId = await client.query(
        'SELECT 1 FROM eraser_protected_messages WHERE chat_id=$1 AND message_id=$2 UNION ALL SELECT 1 FROM eraser_held_authors WHERE chat_id=$1 AND author_id=$3 UNION ALL SELECT 1 FROM eraser_global_held_authors WHERE author_id=$3 UNION ALL SELECT 1 FROM eraser_global_message_holds WHERE chat_id=$1 AND message_id=$2 LIMIT 1',
        [candidate.chat_id, candidate.message_id, row.author_id],
      );
      const protection = (
        await client.query<ProtectionState & { module_bot: boolean }>(
          'SELECT ready,complete_through,bot_history_complete_from,EXISTS(SELECT 1 FROM eraser_protected_bots WHERE chat_id=$1 AND bot_id=$2) AS module_bot FROM eraser_protection_state WHERE chat_id=$1',
          [candidate.chat_id, row.author_id],
        )
      ).rows[0];
      if (protectedId.rowCount)
        throw new ServiceError(409, 'ERASER_PROTECTED', 'Сообщение защищено.');
      if (
        protectionGap(
          { isBot: row.is_bot, sourceMs: Number(row.source_ms) },
          protection?.module_bot ?? false,
          protection,
        )
      )
        throw new ServiceError(409, 'ERASER_PROTECTION_PENDING', 'Ожидаем сведения о публикациях.');
      const dispatch = randomUUID();
      // FLAG: Row-lock waits and protection reads spend the same evidence/lease budget. Test
      // the DB clock again at the final write, after every awaited guard operation.
      const marked = await client.query(
        `UPDATE eraser_candidates SET state='dispatching',dispatch_id=$3,attempt_count=attempt_count+1,updated_at=clock_timestamp(),next_attempt_at=clock_timestamp()+INTERVAL '10 seconds'
         WHERE chat_id=$1 AND message_id=$2 AND $4::timestamptz>clock_timestamp()
           AND EXISTS(SELECT 1 FROM eraser_policies WHERE chat_id=$1 AND enabled AND lease_token=$5 AND lease_until>clock_timestamp())
         RETURNING message_id`,
        [
          candidate.chat_id,
          candidate.message_id,
          dispatch,
          new Date(Math.min(checkedAt + 30_000, pinAt + 5000)),
          token,
        ],
      );
      if (!marked.rowCount)
        throw new ServiceError(409, 'ERASER_GUARD_CHANGED', 'Удаление отложено.');
      return dispatch;
    });
  }
  async settle(
    candidate: Candidate,
    state: 'deleted' | 'protected' | 'review' | 'uncertain' | 'pending',
    code: string,
    waitMs = 1000,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await client.query('SELECT chat_id FROM eraser_policies WHERE chat_id=$1 FOR UPDATE', [
        candidate.chat_id,
      ]);
      const row = (
        await client.query<Candidate>(
          'SELECT * FROM eraser_candidates WHERE chat_id=$1 AND message_id=$2 FOR UPDATE',
          [candidate.chat_id, candidate.message_id],
        )
      ).rows[0];
      if (!row || row.state === 'deleted' || row.state === 'protected') return;
      // FLAG: Only the exact issued attempt can settle its effect or acknowledge a rejected
      // 429. A stale pre-dispatch decision cannot reopen, hide or confirm another journal.
      if (row.dispatch_id !== candidate.dispatch_id) return;
      const issued =
        candidate.dispatch_id !== null && ['dispatching', 'uncertain'].includes(candidate.state);
      if (issued) {
        if (
          !['dispatching', 'uncertain'].includes(row.state) ||
          state === 'protected' ||
          state === 'review'
        )
          return;
        if (state === 'pending' && (candidate.state !== 'dispatching' || code !== 'rate_limited'))
          return;
      } else if (
        row.state !== 'pending' ||
        candidate.state !== 'pending' ||
        !['pending', 'protected', 'review'].includes(state)
      )
        return;
      await client.query(
        "UPDATE eraser_candidates SET state=$3,outcome_code=$4,updated_at=CURRENT_TIMESTAMP,next_attempt_at=CURRENT_TIMESTAMP+($5 * INTERVAL '1 millisecond') WHERE chat_id=$1 AND message_id=$2",
        [candidate.chat_id, candidate.message_id, state, code, waitMs],
      );
      if (state === 'pending') {
        // FLAG: A proven rejection may arrive after its visit ended. Restore only this known
        // retry's due wake; an unresolved DELETE never enters the ordinary schedule.
        await client.query(
          `UPDATE eraser_policies policy SET
           normal_next_at=LEAST(normal_next_at,GREATEST(candidate.next_attempt_at,
             to_timestamp((candidate.source_ms+policy.hours*3600000::bigint)::double precision/1000))),
           next_run_at=LEAST(normal_next_at,safety_next_at,GREATEST(candidate.next_attempt_at,
             to_timestamp((candidate.source_ms+policy.hours*3600000::bigint)::double precision/1000)))
           FROM eraser_candidates candidate WHERE policy.chat_id=$1 AND candidate.chat_id=policy.chat_id
             AND candidate.message_id=$2 AND candidate.state='pending'`,
          [candidate.chat_id, candidate.message_id],
        );
      }
      if (state === 'deleted' || state === 'protected')
        await client.query(
          `UPDATE eraser_policies SET ${state === 'deleted' ? 'deleted_count=deleted_count+1,deleted_acknowledged_count=deleted_acknowledged_count+1' : 'skipped_count=skipped_count+1'} WHERE chat_id=$1`,
          [candidate.chat_id],
        );
    });
  }
  async retryReview(
    chatId: string,
    input: {
      messageId: string;
      expectedRevision: number;
      activationId: string;
      intentId: string;
      expectedIntentUpdatedAt: string;
      expectedAttemptCount: number;
    },
  ): Promise<void> {
    await this.transaction(async (client) => {
      const policy = (
        await client.query<PolicyRow>('SELECT * FROM eraser_policies WHERE chat_id=$1 FOR UPDATE', [
          chatId,
        ])
      ).rows[0];
      if (
        !policy ||
        policy.revision !== input.expectedRevision ||
        policy.activation_id !== input.activationId
      )
        throw new ServiceError(409, 'ERASER_RETRY_CONFLICT', 'Состояние удаления изменилось.');
      // FLAG: Only the exact unissued review intent may return to ordinary work. Policy
      // revision, activation and candidate identity are checked under the dispatch lock order.
      const retried = await client.query(
        `UPDATE eraser_candidates SET state='pending',next_attempt_at=clock_timestamp(),outcome_code=NULL,
         updated_at=clock_timestamp() WHERE chat_id=$1 AND message_id=$2 AND state='review'
         AND attempt_count=0 AND dispatch_id IS NULL AND updated_at=$3::timestamptz
         AND message_id=$4 AND attempt_count=$5`,
        [
          chatId,
          input.messageId,
          input.expectedIntentUpdatedAt,
          input.intentId,
          input.expectedAttemptCount,
        ],
      );
      if (!retried.rowCount)
        throw new ServiceError(409, 'ERASER_RETRY_UNSAFE', 'Удаление требует проверки результата.');
      await this.reschedule(client, policy);
    });
  }
  async defer(candidate: Candidate, code: string, waitMs: number): Promise<void> {
    // FLAG: Age is derived from the current policy; it must never overwrite a retry or pin deadline.
    if (code === 'not_due') return;
    await this.settle(candidate, 'pending', code, waitMs);
  }
  async deferProtection(candidate: Candidate): Promise<void> {
    await this.transaction(async (client) => {
      await client.query('SELECT chat_id FROM eraser_policies WHERE chat_id=$1 FOR UPDATE', [
        candidate.chat_id,
      ]);
      const row = (
        await client.query<Candidate>(
          "SELECT * FROM eraser_candidates WHERE chat_id=$1 AND message_id=$2 AND state='pending' FOR UPDATE",
          [candidate.chat_id, candidate.message_id],
        )
      ).rows[0];
      if (!row) return;
      const protection = (
        await client.query<ProtectionState & { module_bot: boolean }>(
          'SELECT ready,complete_through,bot_history_complete_from,EXISTS(SELECT 1 FROM eraser_protected_bots WHERE chat_id=$1 AND bot_id=$2) AS module_bot FROM eraser_protection_state WHERE chat_id=$1',
          [candidate.chat_id, row.author_id],
        )
      ).rows[0];
      const gap = protectionGap(
        { isBot: row.is_bot, sourceMs: Number(row.source_ms) },
        protection?.module_bot ?? false,
        protection,
      );
      if (!gap) return;
      const prefix = gap === 'history' ? 'historical_deferred' : 'deferred';
      // FLAG: Park only unissued candidates in a durable range; uncertain effects remain journals.
      await client.query(
        `UPDATE eraser_policies SET ${prefix}_from=LEAST(COALESCE(${prefix}_from,$2),$2),${prefix}_to=GREATEST(COALESCE(${prefix}_to,$2),$2) WHERE chat_id=$1`,
        [candidate.chat_id, row.source_ms],
      );
      await client.query('DELETE FROM eraser_candidates WHERE chat_id=$1 AND message_id=$2', [
        candidate.chat_id,
        candidate.message_id,
      ]);
    });
  }
  async ingest(raw: Record<string, unknown>, receiptKey: string, message?: Message): Promise<void> {
    await this.transaction(async (client) => {
      if (
        !(
          await client.query(
            'INSERT INTO eraser_webhook_receipts(receipt_key) VALUES($1) ON CONFLICT DO NOTHING RETURNING receipt_key',
            [receiptKey],
          )
        ).rowCount
      )
        return;
      if (message) {
        // FLAG: The policy lock orders bitmap writes and completed-window clearing. Future
        // events do not invalidate an unrelated in-flight page or create message-sized journals.
        const policy = (
          await client.query<PolicyRow>(
            'SELECT * FROM eraser_policies WHERE chat_id=$1 AND enabled FOR UPDATE',
            [message.chatId],
          )
        ).rows[0];
        if (policy) {
          const now = Date.now();
          await this.compactExpiredHours(client, policy, now);
          if (message.sourceMs + policy.hours * HOUR > now) {
            await this.putFutureMinute(client, message.chatId, message.sourceMs);
            const dueAt = new Date(
              (Math.floor(message.sourceMs / MINUTE) + 1) * MINUTE + policy.hours * HOUR,
            );
            await client.query(
              `UPDATE eraser_policies SET normal_next_at=LEAST(normal_next_at,$2),
               next_run_at=LEAST(normal_next_at,safety_next_at,$2)
               WHERE chat_id=$1 AND normal_next_at>$2 AND (NOT live_gap OR $3>live_upper)`,
              [message.chatId, dueAt, (Math.floor(message.sourceMs / MINUTE) + 1) * MINUTE - 1],
            );
          } else {
            await client.query(
              `UPDATE eraser_policies SET live_floor=LEAST(COALESCE(live_floor,$2),$2),live_due=true,
               due_floor=LEAST(due_floor,$2),due_generation=due_generation+1,
               normal_next_at=CURRENT_TIMESTAMP,next_run_at=CURRENT_TIMESTAMP,
               scan_generation=scan_generation+CASE WHEN $2 BETWEEN safety_floor AND safety_upper THEN 1 ELSE 0 END,
               safety_cursor=CASE WHEN $2 BETWEEN safety_floor AND safety_upper THEN safety_upper ELSE safety_cursor END,
               safety_signature=CASE WHEN $2 BETWEEN safety_floor AND safety_upper THEN NULL ELSE safety_signature END,
               safety_next_at=CASE WHEN $2 BETWEEN safety_floor AND safety_upper THEN CURRENT_TIMESTAMP ELSE safety_next_at END,
               safety_gap=CASE WHEN $2 BETWEEN safety_floor AND safety_upper THEN false ELSE safety_gap END,
               live_cursor=NULL,live_upper=NULL,live_signature=NULL,live_scan_purpose=NULL,
               live_gap=false,live_scan_had_messages=false WHERE chat_id=$1`,
              [message.chatId, message.sourceMs],
            );
          }
        }
      }
      if (
        raw.update_type === 'message_removed' &&
        typeof raw.message_id === 'string' &&
        raw.chat_id !== undefined
      ) {
        const chatId = String(raw.chat_id);
        // FLAG: Match the policy-before-candidate lock order used by dispatch and settlement.
        await client.query('SELECT chat_id FROM eraser_policies WHERE chat_id=$1 FOR UPDATE', [
          chatId,
        ]);
        const result = await client.query<{ previous_state: Candidate['state'] }>(
          `WITH prior AS MATERIALIZED (
             SELECT state FROM eraser_candidates WHERE chat_id=$1 AND message_id=$2 FOR UPDATE
           ) UPDATE eraser_candidates candidate SET state='deleted',outcome_code='removed_receipt',updated_at=CURRENT_TIMESTAMP
           FROM prior WHERE candidate.chat_id=$1 AND candidate.message_id=$2 AND prior.state NOT IN ('deleted','protected')
           RETURNING prior.state AS previous_state`,
          [chatId, raw.message_id],
        );
        if (result.rowCount)
          await client.query(
            'UPDATE eraser_policies SET deleted_count=deleted_count+1,deleted_removal_receipt_count=deleted_removal_receipt_count+1 WHERE chat_id=$1',
            [chatId],
          );
        // FLAG: Freeing ordinary page capacity may expose known due work after idle polling
        // has stopped. Unrelated receipts and uncertain journals do not create an extra wake.
        if (result.rows[0]?.previous_state === 'pending') {
          const current = (
            await client.query<PolicyRow>('SELECT * FROM eraser_policies WHERE chat_id=$1', [
              chatId,
            ])
          ).rows[0];
          if (current) await this.reschedule(client, current);
        }
      }
      if (raw.update_type === 'bot_removed' && raw.chat_id !== undefined)
        await client.query(
          "UPDATE eraser_policies SET connection_status='missing',connection_generation=connection_generation+1,last_error='bot_removed',next_run_at=CURRENT_TIMESTAMP+INTERVAL '5 minutes' WHERE chat_id=$1",
          [String(raw.chat_id)],
        );
    });
  }
  housekeepingHealth() {
    return this.maintenance.health();
  }
  async housekeeping(): Promise<void> {
    await this.maintenance.run();
  }
}
