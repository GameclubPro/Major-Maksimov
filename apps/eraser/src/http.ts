import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import { MaxError, type MaxTransport } from './max.js';
import type { CleanupRuntime } from './runtime.js';
import { Store } from './store.js';
import { readProtectionEvidence } from './protection-evidence.js';
import {
  ServiceError,
  hours,
  integer,
  parseMessage,
  record,
  validChat,
  type Protection,
  type UpdatePolicy,
  type PolicyActivationProof,
  type PolicyActivationGuard,
} from './types.js';

function equalSecret(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || !expected) return false;
  return timingSafeEqual(
    createHash('sha256').update(actual).digest(),
    createHash('sha256').update(expected).digest(),
  );
}
function fail(status: number, code: string, message: string): never {
  throw new ServiceError(status, code, message);
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) fail(413, 'BODY_TOO_LARGE', 'Слишком большой запрос.');
    chunks.push(chunk);
  }
  try {
    const value = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!value) throw new Error();
    return value;
  } catch {
    return fail(400, 'INVALID_BODY', 'Некорректный запрос.');
  }
}
function ids(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    value.some((item) => typeof item !== 'string' || !item || item.length > 256)
  )
    return fail(400, 'INVALID_PROTECTION', 'Некорректная защита сообщений.');
  return [...new Set(value as string[])];
}
export function protectionInput(value: Record<string, unknown>): Protection {
  if (
    !integer(value.sourceRevision) ||
    (value.complete !== undefined && typeof value.complete !== 'boolean') ||
    (value.completeThrough !== null &&
      (typeof value.completeThrough !== 'string' ||
        !Number.isFinite(Date.parse(value.completeThrough)) ||
        Date.parse(value.completeThrough) > Date.now() + 60_000)) ||
    (value.botHistoryCompleteFrom !== undefined &&
      value.botHistoryCompleteFrom !== null &&
      (typeof value.botHistoryCompleteFrom !== 'string' ||
        !Number.isFinite(Date.parse(value.botHistoryCompleteFrom)) ||
        Date.parse(value.botHistoryCompleteFrom) > Date.now() + 60_000))
  )
    return fail(400, 'INVALID_PROTECTION', 'Некорректная защита сообщений.');
  return {
    sourceRevision: value.sourceRevision,
    protectedMessageIds: ids(value.protectedMessageIds),
    protectedBotIds: ids(value.protectedBotIds),
    holdMessageIds: ids(value.holdMessageIds),
    holdAuthorIds: ids(value.holdAuthorIds ?? []),
    completeThrough: value.completeThrough as string | null,
    botHistoryCompleteFrom: (value.botHistoryCompleteFrom ?? null) as string | null,
    ...(value.complete === undefined ? {} : { complete: value.complete }),
    ...(value.evidence === undefined ? {} : { evidence: readProtectionEvidence(value.evidence) }),
  };
}
export function updateInput(value: Record<string, unknown>): UpdatePolicy {
  if (
    typeof value.enabled !== 'boolean' ||
    !hours(value.hours) ||
    !integer(value.expectedRevision) ||
    (value.connectWhenReady !== undefined && typeof value.connectWhenReady !== 'boolean') ||
    (value.connectWhenReady === true && value.enabled !== true) ||
    typeof value.operationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.operationId,
    ) ||
    typeof value.actorUserId !== 'string' ||
    !/^\d+$/.test(value.actorUserId)
  )
    return fail(400, 'INVALID_POLICY', 'Некорректные настройки удаления.');
  return {
    enabled: value.enabled,
    hours: value.hours,
    expectedRevision: value.expectedRevision,
    operationId: value.operationId,
    actorUserId: value.actorUserId,
    ...(value.connectWhenReady === true ? { connectWhenReady: true } : {}),
  };
}
export function createHttpServer(
  store: Store,
  max: MaxTransport,
  runtime: Pick<CleanupRuntime, 'health'>,
  config: Config,
  redisPing: () => Promise<unknown>,
) {
  const policyResponse = (value: Record<string, unknown>) => {
    const health = runtime.health();
    if (
      value.enabled !== true ||
      (health.schedulerHealthy && health.workers?.cleanup.healthy !== false)
    )
      return value;
    // FLAG: Unhealthy runtime means execution cannot be confirmed, not proof that every
    // effect stopped. Project availability without changing policy, journals or cached receipts.
    const coverage = record(value.coverage);
    return {
      ...value,
      status: 'unavailable',
      ...(coverage ? { coverage: { ...coverage, executionStopped: true } } : {}),
    };
  };
  const send = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(value));
  };
  return createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://eraser.internal');
        if (request.method === 'GET' && url.pathname === '/health') {
          await store.pool.query('SELECT 1');
          await redisPing();
          const health = runtime.health();
          return send(response, health.schedulerHealthy ? 200 : 503, {
            status: health.schedulerHealthy ? 'ok' : 'degraded',
            service: 'eraser',
            commitSha: config.commitSha,
            enabled: config.enabled,
            ...health,
          });
        }
        if (request.method === 'POST' && url.pathname === '/webhook') {
          if (
            !config.enabled ||
            !equalSecret(request.headers['x-max-bot-api-secret'], config.webhookSecret)
          )
            return send(response, 403, { code: 'FORBIDDEN' });
          const value = await body(request);
          const recipient = record(record(value.message)?.recipient);
          const chatId = String(recipient?.chat_id ?? '');
          const message =
            validChat(chatId) && value.update_type === 'message_created'
              ? (parseMessage(value.message, chatId) ?? undefined)
              : undefined;
          const key = createHash('sha256').update(JSON.stringify(value)).digest('hex');
          // FLAG: No diagnostics or permission probes are ever sent to a chat from this endpoint.
          await store.ingest(value, key, message);
          return send(response, 200, { success: true });
        }
        if (!equalSecret(request.headers.authorization, `Bearer ${config.controlToken}`))
          return send(response, 403, { code: 'FORBIDDEN' });
        if (request.method === 'PUT' && url.pathname === '/internal/v1/holds') {
          const value = await body(request);
          const messages = value.holdMessages ?? [];
          if (
            !Array.isArray(messages) ||
            messages.length > 1000 ||
            messages.some((message) => {
              const item = record(message);
              return (
                !item ||
                typeof item.chatId !== 'string' ||
                !validChat(item.chatId) ||
                typeof item.messageId !== 'string' ||
                !item.messageId ||
                item.messageId.length > 256
              );
            })
          )
            fail(400, 'INVALID_HOLDS', 'Некорректная защита сообщений.');
          await store.globalHolds(
            ids(value.holdAuthorIds),
            messages as Array<{ chatId: string; messageId: string }>,
          );
          return send(response, 200, { success: true });
        }
        if (request.method === 'GET' && url.pathname === '/internal/v1/runtime') {
          const after = url.searchParams.get('after');
          if (after !== null && !validChat(after))
            fail(400, 'INVALID_CURSOR', 'Некорректный курсор.');
          const selected = url.searchParams.get('chatIds');
          const chatIds = selected === null ? undefined : selected.split(',');
          if (
            chatIds &&
            (after !== null ||
              chatIds.length > 50 ||
              chatIds.some((id) => !validChat(id)) ||
              new Set(chatIds).size !== chatIds.length)
          )
            fail(400, 'INVALID_SELECTION', 'Некорректный список чатов.');
          const page = await store.runtimeDiagnostics(config.botId, { after, chatIds });
          return send(response, 200, {
            ...page,
            mode: config.enabled ? 'on' : 'off',
            quotas: [],
            health: runtime.health(),
            ...(max.metrics ? { transportMetrics: max.metrics() } : {}),
          });
        }
        const match =
          /^\/internal\/v1\/chats\/(-[1-9]\d*)\/(policy|bootstrap|protection|review|retry)$/.exec(
            url.pathname,
          );
        if (!match) return send(response, 404, { code: 'NOT_FOUND' });
        const chatId = match[1]!,
          route = match[2]!;
        if (route === 'policy' && request.method === 'GET')
          return send(response, 200, policyResponse(await store.snapshot(chatId)));
        if (route === 'bootstrap' && request.method === 'PUT') {
          const value = await body(request);
          if (!hours(value.hours)) fail(400, 'INVALID_POLICY', 'Некорректный срок.');
          await store.bootstrap(
            chatId,
            value.hours,
            value.sourceRevision === undefined ? undefined : protectionInput(value),
          );
          return send(response, 200, policyResponse(await store.snapshot(chatId)));
        }
        if (route === 'protection' && request.method === 'PUT') {
          await store.protect(chatId, protectionInput(await body(request)));
          return send(response, 200, { success: true });
        }
        if (route === 'policy' && request.method === 'PUT') {
          const input = updateInput(await body(request));
          const cached = await store.operation(chatId, input);
          if (cached) return send(response, 200, policyResponse(cached));
          let proof: PolicyActivationProof | undefined;
          if (input.enabled && !input.connectWhenReady) {
            if (!config.enabled) fail(503, 'ERASER_UNAVAILABLE', 'Ластик пока недоступен.');
            let guard: PolicyActivationGuard;
            try {
              guard = await store.activationGuard(chatId, input);
            } catch (error) {
              // FLAG: A concurrent exact operation may commit after the first receipt lookup.
              // Its revision advance must return that receipt without probing or reactivating.
              if (
                error instanceof ServiceError &&
                error.code === 'MESSAGE_RETENTION_REVISION_CONFLICT'
              ) {
                const committed = await store.operation(chatId, input);
                if (committed) return send(response, 200, policyResponse(committed));
              }
              throw error;
            }
            try {
              await max.rights(chatId, () => store.assertActivationGuard(guard));
              proof = { ...guard, expiresAt: new Date(Date.now() + 15_000) };
            } catch (error) {
              if (error instanceof ServiceError) {
                if (error.code === 'MESSAGE_RETENTION_REVISION_CONFLICT') {
                  const committed = await store.operation(chatId, input);
                  if (committed) return send(response, 200, policyResponse(committed));
                }
                throw error;
              }
              if (error instanceof MaxError && error.code === 'eraser_rights_missing') {
                await store.connection(chatId, 'no_access');
                fail(
                  409,
                  'ERASER_CONNECTION_REQUIRED',
                  'Добавьте Ластика администратором с правами чтения и удаления.',
                );
              }
              fail(
                503,
                'ERASER_ACCESS_CHECK_UNAVAILABLE',
                'Не удалось проверить права Ластика. Повторите сохранение позже.',
              );
            }
          }
          return send(response, 200, policyResponse(await store.update(chatId, input, proof)));
        }
        if (route === 'review' && request.method === 'GET')
          return send(response, 200, await review(store, chatId, url.searchParams.get('after')));
        if (route === 'retry' && request.method === 'POST') {
          const input = await body(request);
          if (
            !integer(input.expectedRevision) ||
            typeof input.activationId !== 'string' ||
            typeof input.messageId !== 'string' ||
            typeof input.intentId !== 'string' ||
            typeof input.expectedIntentUpdatedAt !== 'string' ||
            !integer(input.expectedAttemptCount)
          )
            fail(409, 'ERASER_RETRY_CONFLICT', 'Состояние удаления изменилось.');
          // FLAG: An uncertain/attempted DELETE cannot be replayed by the review endpoint.
          await store.retryReview(chatId, {
            expectedRevision: input.expectedRevision,
            activationId: input.activationId,
            messageId: input.messageId,
            intentId: input.intentId,
            expectedIntentUpdatedAt: input.expectedIntentUpdatedAt,
            expectedAttemptCount: input.expectedAttemptCount,
          });
          return send(response, 200, await review(store, chatId));
        }
        return send(response, 405, { code: 'METHOD_NOT_ALLOWED' });
      } catch (error) {
        if (error instanceof ServiceError)
          return send(response, error.status, { code: error.code, message: error.message });
        return send(response, 503, {
          code: 'ERASER_UNAVAILABLE',
          message: 'Ластик временно недоступен.',
        });
      }
    })();
  });
}
async function review(store: Store, chatId: string, cursor: string | null = null) {
  const policy = await store.policy(chatId);
  if (!policy) return fail(404, 'NOT_FOUND', 'Настройки удаления не найдены.');
  let after: string | null = null;
  if (cursor !== null) {
    let value: Record<string, unknown> | null = null;
    try {
      if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      value = record(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    } catch {
      fail(400, 'INVALID_CURSOR', 'Некорректный курсор.');
    }
    if (
      !value ||
      value.version !== 1 ||
      !['eraser', 'legacy'].includes(String(value.source)) ||
      typeof value.chatId !== 'string' ||
      !validChat(value.chatId) ||
      !integer(value.revision) ||
      typeof value.activationId !== 'string' ||
      !value.activationId ||
      value.activationId.length > 256 ||
      typeof value.messageId !== 'string' ||
      !value.messageId ||
      value.messageId.length > 256
    )
      return fail(400, 'INVALID_CURSOR', 'Некорректный курсор.');
    if (
      value.source !== 'eraser' ||
      value.chatId !== chatId ||
      value.revision !== policy.revision ||
      value.activationId !== policy.activation_id
    )
      return fail(409, 'ERASER_REVIEW_CONFLICT', 'Настройки изменились. Обновите список.');
    after = value.messageId;
  }
  const rows = (
    await store.pool.query<{
      message_id: string;
      author_id: string;
      source_ms: string;
      state: string;
      outcome_code: string | null;
      dispatch_id: string | null;
      intent_updated_at: string;
      attempt_count: number;
      overdue: boolean;
    }>(
      // FLAG: Preserve the exact PostgreSQL version through the operator round trip; JS Date
      // truncates microseconds and cannot safely represent this compare-and-swap token.
      `SELECT *,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS intent_updated_at,
        next_attempt_at<=statement_timestamp() AS overdue FROM (
        ${['review', 'uncertain', 'dispatching']
          .map(
            (state) => `(SELECT * FROM eraser_candidates
          WHERE chat_id=$1 AND state='${state}' AND ($2::text IS NULL OR message_id>$2)
          ORDER BY message_id LIMIT 21)`,
          )
          .join(' UNION ALL ')}
       ) states ORDER BY message_id LIMIT 21`,
      [chatId, after],
    )
  ).rows;
  const protectionState = (
    await store.pool.query<{ evidence: unknown }>(
      "SELECT CASE WHEN ready AND evidence->>'sourceRevision'=source_revision::text THEN evidence ELSE NULL END AS evidence FROM eraser_protection_state WHERE chat_id=$1",
      [chatId],
    )
  ).rows[0];
  return {
    chatId,
    revision: policy.revision,
    protectionEvidence: protectionState?.evidence ?? null,
    activationId: policy.activation_id,
    source: 'eraser',
    sourceStatus: 'available',
    incomplete: rows.length > 20,
    nextAfter:
      rows.length > 20
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              source: 'eraser',
              chatId,
              revision: policy.revision,
              activationId: policy.activation_id,
              messageId: rows[19]!.message_id,
            }),
          ).toString('base64url')
        : null,
    items: rows.slice(0, 20).map((row) => ({
      messageId: row.message_id,
      authorId: row.author_id,
      sourceAt: new Date(Number(row.source_ms)).toISOString(),
      dueAt: new Date(Number(row.source_ms) + policy.hours * 3_600_000).toISOString(),
      status: row.state,
      outcomeCode: row.outcome_code,
      intentId: row.dispatch_id ?? row.message_id,
      intentStatus:
        row.state === 'review'
          ? 'FAILED_TERMINAL'
          : row.state === 'dispatching' && !row.overdue
            ? 'IN_PROGRESS'
            : 'AMBIGUOUS',
      intentUpdatedAt: row.intent_updated_at,
      intentAttemptCount: row.attempt_count,
      reconcileAfter: null,
      retryAllowed: row.state === 'review' && row.attempt_count === 0 && row.dispatch_id === null,
    })),
  };
}
