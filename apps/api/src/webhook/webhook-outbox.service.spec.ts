import { WebhookStatus } from '../prisma/prisma-client';
import type { MaxUpdate } from '@maxim/contracts';
import { WebhookService } from './webhook.service';
import {
  WebhookPreparationAdmission,
  type WebhookPreparationSchedulingState,
} from './webhook-preparation-admission';
import { getQueueToken } from '@nestjs/bullmq';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import { WebhookOutboxService } from './webhook-outbox.service';
import { DeferredWebhookScopes } from './webhook-outbox-deferred-scopes';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import {
  isPendingWebhookTimeoutQuarantineMessage,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX,
} from './webhook-timeout-quarantine';
import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  extractWebhookType,
  JOIN_WEBHOOK_QUEUE_NAMES,
  resolveDefaultWebhookQueueNameForChatId,
  resolveJoinWebhookQueueNameForChatId,
  resolveWebhookQueueName,
  WEBHOOK_QUEUE_BACKGROUND,
} from './webhook-queues';

// Keep the existing in-memory persistence model at the writer boundary. Native tests
// cover PostgreSQL CAS races and verify that each new writer submits one statement.
jest.mock('./webhook-receipt-write', () => ({
  writeWebhookEnqueueState: (
    client: { webhookEvent: { updateMany: jest.Mock } },
    event: import('./webhook-receipt-write').WebhookEnqueueSnapshot,
    data: import('./webhook-receipt-write').WebhookEnqueueWrite,
  ) =>
    client.webhookEvent.updateMany({
      where: {
        id: event.id,
        status: event.status,
        queueName: event.queueName,
        enqueueAttempts: event.enqueueAttempts,
        queuedAt: event.queuedAt,
        nextEnqueueAt: event.nextEnqueueAt,
        timeoutQuarantineExpiresAt: event.timeoutQuarantineExpiresAt,
        errorMessage: event.errorMessage,
      },
      data,
    }),
}));

type JobMock = {
  getState: jest.Mock<Promise<string>, []>;
  retry: jest.Mock<Promise<void>, []>;
  remove: jest.Mock<Promise<void>, []>;
  failedReason?: string;
};

type QueueMock = {
  add: jest.Mock<Promise<void>, [string, { webhookEventId: string }, Record<string, unknown>]>;
  getJob: jest.Mock<Promise<JobMock | null | undefined>, [string]>;
};

type DefaultShardQueueMocks = Record<(typeof DEFAULT_WEBHOOK_QUEUE_NAMES)[number], QueueMock>;
type JoinShardQueueMocks = Record<(typeof JOIN_WEBHOOK_QUEUE_NAMES)[number], QueueMock>;
type QueueSet = {
  criticalQueue: QueueMock;
  backgroundQueue: QueueMock;
  legacyQueue: QueueMock;
} & DefaultShardQueueMocks &
  JoinShardQueueMocks;

type SqlQuery = {
  strings?: readonly string[];
  values?: readonly unknown[];
};

type RetentionInternals = {
  cleanupRetention: () => Promise<void>;
  runRetentionCleanupPhase: (phase: {
    name: string;
    maxBatches: number;
    deleteBatch: () => Promise<number | { removed: number; scanned: number }>;
  }) => Promise<{
    rows: number;
    scannedRows: number;
    batches: number;
    durationMs: number;
    budgetExhausted: boolean;
  }>;
  retentionBatchDelayMs: number;
  retentionMaintenanceDue: boolean;
  enabled: boolean;
  cleaning: boolean;
};

type EnqueueAdmissionInternals = {
  resolveEnqueueAdmission: (now: Date) => Promise<{
    batchSize: number;
    enqueueConcurrency: number;
    includeQueuedRepair: boolean;
  }>;
};

function extractSql(query: unknown): string {
  return ((query as SqlQuery | undefined)?.strings ?? []).join('?').replace(/\s+/g, ' ').trim();
}

type MockWebhookEventRow = {
  legacyDispositionId?: string | null;
  sourceDispositionId?: string | null;
  id: string;
  dedupKey: string | null;
  status: WebhookStatus;
  botId: string | null;
  queueName: string | null;
  enqueueAttempts: number;
  createdAt: Date;
  queuedAt: Date | null;
  nextEnqueueAt: Date | null;
  timeoutQuarantineExpiresAt: Date | null;
  errorMessage: string | null;
  processedAt: Date | null;
  normalizedPayload: unknown;
};

function resolveTestWebhookDedupKey(payload: unknown, rowBotId: string | null): string | null {
  const value =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  if (!value) {
    return null;
  }
  const updateId = typeof value.updateId === 'string' ? value.updateId.trim() : '';
  if (!updateId) {
    return null;
  }
  const botId =
    typeof value.botId === 'string' && value.botId.trim().length > 0
      ? value.botId.trim()
      : (rowBotId ?? '').trim();
  return botId ? `${botId}:${updateId}` : updateId;
}

function extractOrderedWebhookChatId(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return '';
  }

  const row = payload as { message?: { chatId?: unknown }; chatId?: unknown };
  for (const value of [row.message?.chatId, row.chatId]) {
    if (typeof value === 'string' || typeof value === 'number') {
      const normalized = String(value).trim();
      if (normalized) {
        return normalized;
      }
    }
  }
  return '';
}

function matchesDateFilter(value: Date | null, filter: unknown): boolean {
  if (filter === null) {
    return value === null;
  }
  if (filter instanceof Date) {
    return value?.getTime() === filter.getTime();
  }
  if (!(filter && typeof filter === 'object')) {
    return true;
  }

  const rowMs = value?.getTime() ?? null;
  if (rowMs === null) {
    return false;
  }

  const lte = (filter as { lte?: Date }).lte;
  if (lte instanceof Date && rowMs > lte.getTime()) {
    return false;
  }
  const gte = (filter as { gte?: Date }).gte;
  if (gte instanceof Date && rowMs < gte.getTime()) {
    return false;
  }

  return true;
}

function matchesScalarFilter<T>(value: T | null, filter: unknown): boolean {
  if (filter === undefined) {
    return true;
  }

  if (filter === null) {
    return value === null;
  }

  if (filter && typeof filter === 'object' && 'not' in (filter as Record<string, unknown>)) {
    return value !== ((filter as { not?: T | null }).not ?? null);
  }

  if (
    typeof value === 'string' &&
    filter &&
    typeof filter === 'object' &&
    typeof (filter as { startsWith?: unknown }).startsWith === 'string'
  ) {
    return value.startsWith((filter as { startsWith: string }).startsWith);
  }

  if (filter && typeof filter === 'object' && Array.isArray((filter as { in?: unknown }).in)) {
    return (filter as { in: unknown[] }).in.includes(value);
  }

  return value === filter;
}

function matchesWebhookEventWhere(
  row: MockWebhookEventRow,
  where: Record<string, unknown> | undefined,
): boolean {
  if (!where) {
    return true;
  }

  if (Array.isArray(where.AND)) {
    const andMatched = where.AND.every((entry) =>
      matchesWebhookEventWhere(row, entry as Record<string, unknown> | undefined),
    );
    if (!andMatched) {
      return false;
    }
  }

  if (Array.isArray(where.OR)) {
    const orMatched = where.OR.some((entry) =>
      matchesWebhookEventWhere(row, entry as Record<string, unknown> | undefined),
    );
    if (!orMatched) {
      return false;
    }
  }

  if (!matchesScalarFilter(row.status, where.status)) {
    return false;
  }

  if (!matchesScalarFilter(row.id, where.id)) {
    return false;
  }

  if (!matchesScalarFilter(row.dedupKey, where.dedupKey)) {
    return false;
  }

  if (!matchesScalarFilter(row.botId, where.botId)) {
    return false;
  }

  if (!matchesScalarFilter(row.queueName, where.queueName)) {
    return false;
  }

  if (!matchesScalarFilter(row.enqueueAttempts, where.enqueueAttempts)) {
    return false;
  }

  if (!matchesScalarFilter(row.processedAt, where.processedAt)) {
    return false;
  }

  if (!matchesScalarFilter(row.errorMessage, where.errorMessage)) {
    return false;
  }

  if (!matchesDateFilter(row.createdAt, where.createdAt)) {
    return false;
  }

  if (!matchesDateFilter(row.queuedAt, where.queuedAt)) {
    return false;
  }

  if (!matchesDateFilter(row.nextEnqueueAt, where.nextEnqueueAt)) {
    return false;
  }

  if (!matchesDateFilter(row.timeoutQuarantineExpiresAt, where.timeoutQuarantineExpiresAt)) {
    return false;
  }

  const normalizedPayloadFilter = where.normalizedPayload;
  if (
    normalizedPayloadFilter &&
    typeof normalizedPayloadFilter === 'object' &&
    'equals' in normalizedPayloadFilter &&
    JSON.stringify(row.normalizedPayload) !==
      JSON.stringify((normalizedPayloadFilter as { equals: unknown }).equals)
  ) {
    return false;
  }

  return true;
}

function createStatusAwareUpdateManyMock(
  eventId: string,
  readStatus: () => WebhookStatus,
  writeStatus: (status: WebhookStatus) => void,
) {
  return async (args?: { where?: Record<string, unknown>; data?: { status?: WebhookStatus } }) => {
    const matched =
      matchesScalarFilter(eventId, args?.where?.id) &&
      matchesScalarFilter(readStatus(), args?.where?.status);

    if (matched && args?.data?.status) {
      writeStatus(args.data.status);
    }

    return { count: matched ? 1 : 0 };
  };
}

function createWebhookEventUpdateManyMock(rows: MockWebhookEventRow[]) {
  return async (args?: {
    where?: Record<string, unknown>;
    data?: {
      status?: WebhookStatus;
      queueName?: string | null;
      queuedAt?: Date | null;
      nextEnqueueAt?: Date | null;
      timeoutQuarantineExpiresAt?: Date | null;
      processedAt?: Date | null;
      errorMessage?: string | null;
      enqueueAttempts?: { increment?: number };
    };
  }) => {
    const row = rows.find((candidate) => matchesWebhookEventWhere(candidate, args?.where));
    if (!row) {
      return { count: 0 };
    }

    const data = args?.data;
    if (data?.status !== undefined) {
      row.status = data.status;
    }
    if (data?.queueName !== undefined) {
      row.queueName = data.queueName;
    }
    if (data?.queuedAt !== undefined) {
      row.queuedAt = data.queuedAt;
    }
    if (data?.nextEnqueueAt !== undefined) {
      row.nextEnqueueAt = data.nextEnqueueAt;
    }
    if (data?.timeoutQuarantineExpiresAt !== undefined) {
      row.timeoutQuarantineExpiresAt = data.timeoutQuarantineExpiresAt;
    }
    if (data?.processedAt !== undefined) {
      row.processedAt = data.processedAt;
    }
    if (data?.errorMessage !== undefined) {
      row.errorMessage = data.errorMessage;
    }
    const attemptIncrement = data?.enqueueAttempts?.increment;
    if (typeof attemptIncrement === 'number') {
      row.enqueueAttempts += attemptIncrement;
    }

    return { count: 1 };
  };
}

function compareMockWebhookRows(
  left: Pick<MockWebhookEventRow, 'id' | 'createdAt'>,
  right: Pick<MockWebhookEventRow, 'id' | 'createdAt'>,
  direction: 'asc' | 'desc' = 'asc',
): number {
  const createdAtDiff = left.createdAt.getTime() - right.createdAt.getTime();
  const idDiff = left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  const comparison = createdAtDiff !== 0 ? createdAtDiff : idDiff;
  return direction === 'desc' ? -comparison : comparison;
}

function isOrderedMessageRow(row: MockWebhookEventRow): boolean {
  return (
    ['message_created', 'message_edited'].includes(extractWebhookType(row.normalizedPayload)) &&
    extractOrderedWebhookChatId(row.normalizedPayload).length > 0
  );
}

function isOrderedHeadStatus(row: MockWebhookEventRow): boolean {
  return (
    row.status === WebhookStatus.RECEIVED ||
    row.status === WebhookStatus.QUEUED ||
    (row.status === WebhookStatus.FAILED &&
      (row.nextEnqueueAt !== null || isPendingWebhookTimeoutQuarantineMessage(row.errorMessage)))
  );
}

function isMockEnqueueCandidateEligible(
  row: MockWebhookEventRow,
  now: Date,
  timeoutExecutionClaimCompleted: boolean,
): boolean {
  const isDue = (value: Date | null) => value === null || value <= now;
  if (row.status === WebhookStatus.RECEIVED) {
    return isDue(row.nextEnqueueAt);
  }
  if (row.status === WebhookStatus.FAILED) {
    return (
      (row.nextEnqueueAt !== null && row.nextEnqueueAt <= now) ||
      (row.nextEnqueueAt === null &&
        isPendingWebhookTimeoutQuarantineMessage(row.errorMessage) &&
        timeoutExecutionClaimCompleted)
    );
  }
  if (row.status !== WebhookStatus.QUEUED || row.processedAt !== null) {
    return false;
  }

  const background = row.queueName === WEBHOOK_QUEUE_BACKGROUND;
  const staleBefore = new Date(now.getTime() - (background ? 120_000 : 20_000));
  return (row.queuedAt ?? row.createdAt) <= staleBefore && isDue(row.nextEnqueueAt);
}

function selectFairEnqueueCandidatesForTest(
  rows: MockWebhookEventRow[],
  query: SqlQuery,
  timeoutExecutionClaimCompleted: boolean,
  selectionWindowSize: number,
): Array<MockWebhookEventRow & { isRecentReceipt: boolean }> {
  const selectionSql = extractSql(query);
  const values = query.values ?? [];
  const now = values
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => right.getTime() - left.getTime())[0];
  const limits = values.filter((value): value is number => typeof value === 'number');
  const overscanTake = Math.max(0, ...limits);
  if (!now || selectionWindowSize === 0) {
    return [];
  }

  const recentReceiptTake = Math.min(
    selectionWindowSize,
    Math.max(1, Math.ceil(selectionWindowSize * 0.25)),
  );
  const backlogReceiptTake = selectionWindowSize - recentReceiptTake;
  const staleUserFacingQueuedBefore = new Date(now.getTime() - 20_000);
  const staleBackgroundQueuedBefore = new Date(now.getTime() - 120_000);
  const isDue = (value: Date | null) => value === null || value <= now;
  const isReceived = (row: MockWebhookEventRow) =>
    row.status === WebhookStatus.RECEIVED && isDue(row.nextEnqueueAt);
  const isFailed = (row: MockWebhookEventRow) =>
    row.status === WebhookStatus.FAILED &&
    isMockEnqueueCandidateEligible(
      row,
      now,
      timeoutExecutionClaimCompleted && selectionSql.includes('semantic_owner'),
    );
  const isStaleQueued = (row: MockWebhookEventRow, queueKind: 'user-facing' | 'background') => {
    const background = row.queueName === WEBHOOK_QUEUE_BACKGROUND;
    const cutoff = background ? staleBackgroundQueuedBefore : staleUserFacingQueuedBefore;
    const staleReference = row.queuedAt ?? row.createdAt;
    return (
      row.status === WebhookStatus.QUEUED &&
      row.processedAt === null &&
      background === (queueKind === 'background') &&
      staleReference <= cutoff &&
      isDue(row.nextEnqueueAt)
    );
  };
  const select = (
    predicate: (row: MockWebhookEventRow) => boolean,
    take: number,
    scanDirection: 'asc' | 'desc' = 'asc',
    resultDirection: 'asc' | 'desc' = 'asc',
    isRecentReceipt = false,
  ) => {
    const boundedRows = rows
      .filter(predicate)
      .sort((left, right) => compareMockWebhookRows(left, right, scanDirection))
      .slice(0, overscanTake);
    const oldestByWorkUnit = new Map<string, MockWebhookEventRow>();
    for (const row of boundedRows) {
      const chatId = isOrderedMessageRow(row)
        ? extractOrderedWebhookChatId(row.normalizedPayload)
        : '';
      const workUnitKey = chatId ? `chat:${chatId}` : `event:${row.id}`;
      const existing = oldestByWorkUnit.get(workUnitKey);
      if (!existing || compareMockWebhookRows(row, existing) < 0) {
        oldestByWorkUnit.set(workUnitKey, row);
      }
    }

    return Array.from(oldestByWorkUnit.values())
      .sort((left, right) => compareMockWebhookRows(left, right, resultDirection))
      .slice(0, take)
      .map((row) => ({ ...row, isRecentReceipt }));
  };

  const queuedRepairDisabled = (cteName: string) => {
    const cteStart = selectionSql.indexOf(`${cteName} AS (`);
    if (cteStart < 0) {
      return false;
    }
    const nextCteName =
      cteName === 'stale_user_facing_queued_candidates'
        ? 'stale_background_queued_candidates AS ('
        : 'SELECT "id", "status", "bot_id" AS "botId"';
    const nextCteStart = selectionSql.indexOf(nextCteName, cteStart + cteName.length);
    const cteSql = selectionSql.slice(cteStart, nextCteStart < 0 ? undefined : nextCteStart);
    return cteSql.includes('WHERE FALSE');
  };

  return [
    ...select(isReceived, backlogReceiptTake),
    ...select(isReceived, recentReceiptTake, 'desc', 'desc', true),
    ...select(isFailed, selectionWindowSize),
    ...(queuedRepairDisabled('stale_user_facing_queued_candidates')
      ? []
      : select((row) => isStaleQueued(row, 'user-facing'), selectionWindowSize)),
    ...(queuedRepairDisabled('stale_background_queued_candidates')
      ? []
      : select((row) => isStaleQueued(row, 'background'), selectionWindowSize)),
  ];
}

function createService(params?: {
  findManyResult?: Array<{
    id: string;
    dedupKey?: string | null;
    status?: WebhookStatus;
    botId?: string | null;
    queueName?: string | null;
    enqueueAttempts: number;
    createdAt?: Date;
    queuedAt?: Date | null;
    nextEnqueueAt?: Date | null;
    timeoutQuarantineExpiresAt?: Date | null;
    processedAt?: Date | null;
    errorMessage?: string | null;
    normalizedPayload?: unknown;
  }>;
  manualCloseChatIds?: string[];
  addError?: Error | null;
  criticalJob?: JobMock | null;
  defaultJob?: JobMock | null;
  backgroundJob?: JobMock | null;
  legacyJob?: JobMock | null;
  undefinedJobs?: boolean;
  configOverrides?: Partial<Record<string, number | boolean>>;
  resolvedQueueName?: string;
  timeoutExecutionClaim?: {
    status: string;
    completedAt?: Date | null;
  } | null;
  selectedChatQueryError?: Error;
  systemMode?: 'normal' | 'degrade';
  prepareResult?: {
    canonical: boolean;
    prepared: boolean;
    normalizedPayload: unknown;
    executionBotId: string | null;
  };
}) {
  const webhookRows: MockWebhookEventRow[] = (params?.findManyResult ?? []).map((item) => ({
    ...item,
    legacyDispositionId: null,
    sourceDispositionId: null,
    dedupKey:
      item.dedupKey ??
      resolveTestWebhookDedupKey(item.normalizedPayload, item.botId ?? null) ??
      null,
    status: item.status ?? WebhookStatus.RECEIVED,
    botId: item.botId ?? null,
    queueName: item.queueName ?? null,
    createdAt: item.createdAt ?? new Date('2026-03-24T00:00:00.000Z'),
    queuedAt: item.queuedAt ?? null,
    nextEnqueueAt: item.nextEnqueueAt ?? null,
    timeoutQuarantineExpiresAt: item.timeoutQuarantineExpiresAt ?? null,
    processedAt: item.processedAt ?? null,
    errorMessage: item.errorMessage ?? null,
    normalizedPayload: item.normalizedPayload ?? null,
  }));

  const prisma = {
    $transaction: jest.fn(
      async (operation: (tx: unknown) => unknown): Promise<unknown> =>
        Array.isArray(operation) ? Promise.all(operation) : operation(prisma),
    ),
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockImplementation(async (query: SqlQuery) => {
      const values = query.values ?? [];
      if (extractSql(query).includes('finished_ordered_head_proofs')) return [];
      if (extractSql(query).includes('completed_ordered_head_mirrors')) return [];
      if (extractSql(query).includes('AS "commandId"')) return [];
      if (extractSql(query).includes('AS "scanned"'))
        return [{ removed: 0, scanned: 0, lastId: null, lastCreatedAt: null }];
      if (extractSql(query).includes('deferred_scope_raw_page')) {
        const first = { createdAt: values[0] as Date, id: values[1] as string };
        const last = { createdAt: values[2] as Date, id: values[3] as string };
        const after =
          values[4] instanceof Date ? { createdAt: values[4], id: values[5] as string } : null;
        return webhookRows
          .filter(
            (row) =>
              ['RECEIVED', 'FAILED', 'QUEUED'].includes(row.status) &&
              compareMockWebhookRows(row, first) >= 0 &&
              compareMockWebhookRows(row, last) <= 0 &&
              (!after || compareMockWebhookRows(row, after) > 0),
          )
          .sort(compareMockWebhookRows)
          .slice(0, 65)
          .map((row) => ({ ...row }));
      }
      if (extractSql(query).includes('fair_enqueue_candidates')) {
        return selectFairEnqueueCandidatesForTest(
          webhookRows,
          query,
          params?.timeoutExecutionClaim?.status === 'COMPLETED',
          (
            service as unknown as { resolvePrioritySelectionWindowSize: (size: number) => number }
          ).resolvePrioritySelectionWindowSize(
            params?.systemMode === 'degrade'
              ? Math.min(Number(configValues.ENQUEUE_BATCH_SIZE), 100)
              : Number(configValues.ENQUEUE_BATCH_SIZE),
          ),
        );
      }
      if (extractSql(query).includes('selected_chat_candidates')) {
        if (params?.selectedChatQueryError) {
          throw params.selectedChatQueryError;
        }
        const now = values
          .filter((value): value is Date => value instanceof Date)
          .sort((left, right) => right.getTime() - left.getTime())[0];
        const limits = values.filter((value): value is number => typeof value === 'number');
        const take = Math.max(0, ...limits);
        const perChatLimit = Math.min(...limits);
        if (!now || take === 0) {
          return [];
        }
        const headCounts = new Map<string, number>();
        return webhookRows
          .filter((row) => isOrderedMessageRow(row) && isOrderedHeadStatus(row))
          .sort((left, right) => compareMockWebhookRows(left, right))
          .filter((row) => {
            const chatId = extractOrderedWebhookChatId(row.normalizedPayload);
            if (!values.includes(chatId)) return false;
            const count = headCounts.get(chatId) ?? 0;
            headCounts.set(chatId, count + 1);
            return (
              count < perChatLimit &&
              isMockEnqueueCandidateEligible(
                row,
                now,
                params?.timeoutExecutionClaim?.status === 'COMPLETED' &&
                  extractSql(query).includes('semantic_owner'),
              )
            );
          })
          .sort((left, right) => compareMockWebhookRows(left, right))
          .slice(0, take)
          .map((row) => ({ ...row, isRecentReceipt: false }));
      }
      const findHead = (chatId: string, afterCreatedAt: Date | null, afterId: string | null) => {
        const rows = webhookRows
          .filter(
            (row) =>
              (row.status === WebhookStatus.RECEIVED ||
                row.status === WebhookStatus.QUEUED ||
                (row.status === WebhookStatus.FAILED &&
                  (row.nextEnqueueAt !== null ||
                    isPendingWebhookTimeoutQuarantineMessage(row.errorMessage)))) &&
              ['message_created', 'message_edited'].includes(
                extractWebhookType(row.normalizedPayload),
              ) &&
              extractOrderedWebhookChatId(row.normalizedPayload) === chatId,
          )
          .filter((row) => {
            if (!afterCreatedAt || !afterId) {
              return true;
            }
            const createdAtDiff = row.createdAt.getTime() - afterCreatedAt.getTime();
            return createdAtDiff > 0 || (createdAtDiff === 0 && row.id > afterId);
          })
          .sort((left, right) => {
            const createdAtDiff = left.createdAt.getTime() - right.createdAt.getTime();
            return createdAtDiff !== 0
              ? createdAtDiff
              : left.id < right.id
                ? -1
                : left.id > right.id
                  ? 1
                  : 0;
          });
        return rows[0] ?? null;
      };

      if (extractSql(query).includes('requested_chats')) {
        return values.flatMap((value) => {
          if (typeof value !== 'string') {
            return [];
          }
          const row = findHead(value, null, null);
          return row ? [{ chatId: value, id: row.id, createdAt: row.createdAt }] : [];
        });
      }

      const stringValues = values.filter(
        (value): value is string =>
          typeof value === 'string' && value !== `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`,
      );
      const chatId = stringValues[0] ?? '';
      const afterCreatedAt = values.find((value): value is Date => value instanceof Date) ?? null;
      const afterId = afterCreatedAt ? (stringValues.at(-1) ?? null) : null;
      const row = findHead(chatId, afterCreatedAt, afterId);
      return row ? [{ id: row.id, createdAt: row.createdAt }] : [];
    }),
    webhookEvent: {
      findMany: jest
        .fn()
        .mockImplementation(
          async (args?: {
            where?: Record<string, unknown>;
            take?: number;
            orderBy?:
              | { createdAt?: 'asc' | 'desc'; id?: 'asc' | 'desc' }
              | Array<{ createdAt?: 'asc' | 'desc'; id?: 'asc' | 'desc' }>;
          }) => {
            const orderBy = Array.isArray(args?.orderBy)
              ? args.orderBy
              : args?.orderBy
                ? [args.orderBy]
                : [];
            const createdAtDirection = orderBy.find((entry) => entry.createdAt)?.createdAt ?? 'asc';
            const idDirection = orderBy.find((entry) => entry.id)?.id ?? createdAtDirection;
            const rows = webhookRows
              .filter((row) => matchesWebhookEventWhere(row, args?.where))
              .sort((left, right) => {
                const createdAtDiff = left.createdAt.getTime() - right.createdAt.getTime();
                if (createdAtDiff !== 0) {
                  return createdAtDirection === 'desc' ? -createdAtDiff : createdAtDiff;
                }
                const idDiff = left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
                return idDirection === 'desc' ? -idDiff : idDiff;
              });
            return rows.slice(0, args?.take ?? Number.POSITIVE_INFINITY);
          },
        ),
      findFirst: jest
        .fn()
        .mockImplementation(
          async (args?: { where?: Record<string, unknown> }) =>
            webhookRows.find((row) => matchesWebhookEventWhere(row, args?.where)) ?? null,
        ),
      findUnique: jest
        .fn()
        .mockImplementation(
          async (args?: { where?: Record<string, unknown> }) =>
            webhookRows.find((row) => matchesWebhookEventWhere(row, args?.where)) ?? null,
        ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    webhookExecutionClaim: {
      findFirst: jest.fn().mockResolvedValue(params?.timeoutExecutionClaim ?? null),
    },
    chatSettings: {
      findMany: jest.fn().mockResolvedValue(
        (params?.manualCloseChatIds ?? []).map((chatId) => ({
          chatId,
        })),
      ),
    },
    moderationEvent: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    violation: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    moderationViolationMessageClaim: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    chatUserDisplayName: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };

  const createQueue = (
    addError: Error | null | undefined,
    job: JobMock | null | undefined,
  ): QueueMock => ({
    add: addError ? jest.fn().mockRejectedValue(addError) : jest.fn().mockResolvedValue(undefined),
    getJob: jest.fn().mockResolvedValue(params?.undefinedJobs ? undefined : (job ?? null)),
  });

  const criticalQueue = createQueue(params?.addError, params?.criticalJob);
  const joinShardQueues = Object.fromEntries(
    JOIN_WEBHOOK_QUEUE_NAMES.map((queueName) => [queueName, createQueue(params?.addError, null)]),
  ) as JoinShardQueueMocks;
  const defaultShardQueues = Object.fromEntries(
    DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName, index) => [
      queueName,
      createQueue(params?.addError, index === 0 ? params?.defaultJob : null),
    ]),
  ) as DefaultShardQueueMocks;
  const backgroundQueue = createQueue(params?.addError, params?.backgroundJob);
  const legacyQueue = createQueue(params?.addError, params?.legacyJob);
  const queueTokens = Object.fromEntries(
    [...JOIN_WEBHOOK_QUEUE_NAMES, ...DEFAULT_WEBHOOK_QUEUE_NAMES].map((queueName) => [
      getQueueToken(queueName),
      queueName in joinShardQueues
        ? joinShardQueues[queueName as keyof JoinShardQueueMocks]
        : defaultShardQueues[queueName as keyof DefaultShardQueueMocks],
    ]),
  );
  const moduleRef = {
    get: jest.fn((token: string) => queueTokens[token]),
  };

  const configValues: Record<string, number | boolean> = {
    ENQUEUE_POLL_INTERVAL_MS: 500,
    ENQUEUE_BATCH_SIZE: 200,
    ENQUEUE_CONCURRENCY: 25,
    ENQUEUE_MAX_ATTEMPTS: 120,
    WEBHOOK_RETENTION_DAYS: 7,
    WEBHOOK_FAILED_RETENTION_HOURS: 24,
    MODERATION_RETENTION_DAYS: 90,
    USER_DISPLAY_NAME_RETENTION_DAYS: 180,
    ...(params?.configOverrides ?? {}),
  };
  const config = {
    get: jest.fn((key: string, fallback?: number | boolean) =>
      key in configValues ? configValues[key] : fallback,
    ),
  };

  const queues: QueueSet = {
    criticalQueue,
    ...joinShardQueues,
    ...defaultShardQueues,
    backgroundQueue,
    legacyQueue,
  };
  const webhookRoutingService = {
    resolveQueueName: jest.fn(
      async (_eventId: string, payload: unknown) =>
        params?.resolvedQueueName ?? resolveWebhookQueueName(payload),
    ),
  };
  const canonicalEventBySemanticKey = new Map<string, string>();
  for (const row of webhookRows) {
    if (row.status === WebhookStatus.RECEIVED) {
      continue;
    }
    const semanticKey = buildWebhookSemanticEventKey(row.normalizedPayload);
    if (semanticKey && !canonicalEventBySemanticKey.has(semanticKey)) {
      canonicalEventBySemanticKey.set(semanticKey, row.id);
    }
  }
  const webhookService = {
    canPreparePersistedWebhookEvent: jest.fn((_update?: MaxUpdate) => true),
    webhookPreparationSchedulingState: jest.fn(
      (_update?: MaxUpdate): WebhookPreparationSchedulingState => 'available',
    ),
    nextPreparationCompletion: jest.fn<Promise<void> | null, []>(() => null),
    preparePersistedWebhookEvent: jest.fn(
      async (eventId: string, _fallbackUpdate?: MaxUpdate, _admissionUpdate?: MaxUpdate) => {
        const row = webhookRows.find((candidate) => candidate.id === eventId);
        if (params?.prepareResult) {
          return params.prepareResult;
        }
        const semanticKey = buildWebhookSemanticEventKey(row?.normalizedPayload);
        const canonicalEventId = semanticKey
          ? canonicalEventBySemanticKey.get(semanticKey)
          : undefined;
        if (semanticKey && !canonicalEventId) {
          canonicalEventBySemanticKey.set(semanticKey, eventId);
        }
        const canonical = !semanticKey || !canonicalEventId || canonicalEventId === eventId;
        if (!canonical) {
          await prisma.webhookEvent.updateMany({
            where: { id: eventId },
            data: {
              status: WebhookStatus.DUPLICATE,
            },
          });
        }
        return {
          canonical,
          prepared: true,
          normalizedPayload: row?.normalizedPayload ?? null,
          executionBotId:
            row?.normalizedPayload && typeof row.normalizedPayload === 'object'
              ? (((row.normalizedPayload as Record<string, unknown>).executionOwnerBotId as
                  | string
                  | null) ?? null)
              : null,
        };
      },
    ),
  };
  const systemModeService = {
    getEffectiveSnapshot: jest.fn().mockResolvedValue({ mode: params?.systemMode ?? 'normal' }),
    peekCachedSnapshot: jest
      .fn()
      .mockImplementation(() => ({ mode: params?.systemMode ?? 'normal' })),
  };

  const service = new WebhookOutboxService(
    prisma as never,
    config as never,
    moduleRef as never,
    webhookRoutingService as never,
    webhookService as never,
    criticalQueue as never,
    backgroundQueue as never,
    legacyQueue as never,
    systemModeService as never,
  );
  return {
    service,
    prisma,
    queues,
    webhookRoutingService,
    webhookService,
    systemModeService,
    webhookRows,
  };
}

type SemanticMirrorCasLoss = 'owner' | 'claim' | 'mirror';

function createCompletedSemanticOwnerFixture(options?: {
  ownerClaimStatus?: 'COMPLETED' | 'READY';
  invalidOwnerPayload?: boolean;
  casLoss?: SemanticMirrorCasLoss;
}) {
  const chatId = 'chat-completed-semantic-owner';
  const messageId = 'message-completed-semantic-owner';
  const mirrorId = 'evt-completed-semantic-mirror';
  const ownerId = 'evt-completed-semantic-owner';
  const ownerCompletedAt = new Date('2026-03-24T00:00:05.000Z');
  const ownerProcessedAt = new Date('2026-03-24T00:00:05.100Z');
  const pendingErrorMessage = `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-semantic-mirror: detached execution failed without a canonical claim`;
  const mirrorPayload = {
    updateId: 'update-mirror-bot',
    botId: 'bot-mirror',
    type: 'message_created',
    message: { chatId, messageId, senderId: 'user-1' },
  };
  const ownerPayload = {
    updateId: 'update-owner-bot',
    botId: 'bot-owner',
    type: 'message_created',
    message: {
      chatId,
      messageId: options?.invalidOwnerPayload ? 'different-owner-message' : messageId,
      senderId: 'user-1',
    },
  };
  const semanticKey = buildWebhookSemanticEventKey(mirrorPayload);
  if (!semanticKey) {
    throw new Error('Expected the mirror fixture to derive a semantic key');
  }

  const fixture = createService({
    // The selection mock uses this as the SQL-visible proof. Settlement reads are overridden below.
    timeoutExecutionClaim: { status: 'COMPLETED', completedAt: ownerCompletedAt },
    findManyResult: [
      {
        id: mirrorId,
        status: WebhookStatus.FAILED,
        botId: 'bot-mirror',
        queueName: resolveDefaultWebhookQueueNameForChatId(chatId),
        enqueueAttempts: 1,
        queuedAt: new Date('2026-03-24T00:00:10.000Z'),
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
        processedAt: null,
        errorMessage: pendingErrorMessage,
        createdAt: new Date('2026-03-24T00:00:01.000Z'),
        normalizedPayload: mirrorPayload,
      },
      {
        id: ownerId,
        status: WebhookStatus.PROCESSED,
        botId: 'bot-owner',
        queueName: resolveDefaultWebhookQueueNameForChatId(chatId),
        enqueueAttempts: 1,
        queuedAt: new Date('2026-03-24T00:00:02.000Z'),
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
        processedAt: ownerProcessedAt,
        errorMessage: null,
        createdAt: new Date('2026-03-24T00:00:00.000Z'),
        normalizedPayload: ownerPayload,
      },
    ],
  });
  const { prisma, webhookRows } = fixture;
  prisma.webhookExecutionClaim.findFirst.mockResolvedValue(null);

  const ownerClaim = {
    id: 'claim-completed-semantic-owner',
    semanticKey,
    webhookEventId: ownerId,
    executionBotId: 'bot-owner',
    enforced: false,
    status: options?.ownerClaimStatus ?? 'COMPLETED',
    preparedAt: new Date('2026-03-24T00:00:04.000Z'),
    completedAt: options?.ownerClaimStatus === 'READY' ? null : ownerCompletedAt,
    leaseToken: options?.ownerClaimStatus === 'READY' ? 'owner-lease' : null,
    leaseExpiresAt:
      options?.ownerClaimStatus === 'READY' ? new Date('2026-03-24T00:05:00.000Z') : null,
  };
  const claimFindUnique = jest.fn().mockImplementation(async () => ({ ...ownerClaim }));
  const claimUpdateMany = jest
    .fn()
    .mockImplementation(
      async (args?: { where?: Record<string, unknown>; data?: Partial<typeof ownerClaim> }) => {
        if (
          options?.casLoss === 'claim' ||
          args?.where?.id !== ownerClaim.id ||
          args.where.enforced !== ownerClaim.enforced ||
          args.where.status !== ownerClaim.status
        ) {
          return { count: 0 };
        }
        Object.assign(ownerClaim, args.data ?? {});
        return { count: 1 };
      },
    );
  Object.assign(prisma.webhookExecutionClaim, {
    findUnique: claimFindUnique,
    updateMany: claimUpdateMany,
  });

  const applyEventUpdate = createWebhookEventUpdateManyMock(webhookRows);
  prisma.webhookEvent.updateMany.mockImplementation(async (args) => {
    const where = (args as { where?: Record<string, unknown> } | undefined)?.where;
    const data = (args as { data?: { status?: WebhookStatus } } | undefined)?.data;
    if (
      (options?.casLoss === 'owner' && where?.id === ownerId) ||
      (options?.casLoss === 'mirror' &&
        where?.id === mirrorId &&
        data?.status === WebhookStatus.DUPLICATE)
    ) {
      return { count: 0 };
    }
    return applyEventUpdate(args);
  });

  const transaction = jest.fn(
    async (operation: (client: typeof prisma) => Promise<unknown>): Promise<unknown> => {
      const rowSnapshots = webhookRows.map((row) => ({ ...row }));
      const claimSnapshot = { ...ownerClaim };
      try {
        return await operation(prisma);
      } catch (error: unknown) {
        rowSnapshots.forEach((snapshot, index) => {
          Object.assign(webhookRows[index]!, snapshot);
        });
        Object.assign(ownerClaim, claimSnapshot);
        throw error;
      }
    },
  );
  Object.assign(prisma, { $transaction: transaction });

  return {
    ...fixture,
    mirror: webhookRows.find((row) => row.id === mirrorId)!,
    owner: webhookRows.find((row) => row.id === ownerId)!,
    ownerClaim,
    ownerCompletedAt,
    pendingErrorMessage,
    claimFindUnique,
    claimUpdateMany,
    transaction,
  };
}

describe('WebhookOutboxService', () => {
  type CompletedHeadInternals = {
    recoverCompletedOrderedHeadMirrors: (
      heads: ReadonlyMap<string, { id: string; createdAt: Date }>,
      concurrency?: number,
    ) => Promise<number>;
    selectCompletedOrderedHeadMirrors: (
      ids: readonly string[],
    ) => Promise<Array<{ mirrorId: string }>>;
    activeEnqueueUnits: Map<string, Promise<void>>;
  };

  function completedHeadFixture(options?: { casLoss?: SemanticMirrorCasLoss }) {
    const fixture = createCompletedSemanticOwnerFixture(options);
    const { mirror, owner, ownerClaim, prisma, service } = fixture;
    const holds = { isUpdateHeld: jest.fn().mockResolvedValue(false) };
    Object.assign(service, { legacyHolds: holds });
    Object.assign(mirror, {
      status: WebhookStatus.RECEIVED,
      queueName: null,
      queuedAt: null,
      enqueueAttempts: 0,
      errorMessage: null,
      semanticKey: ownerClaim.semanticKey,
      legacyDispositionId: null,
      sourceDispositionId: null,
    });
    Object.assign(owner, { semanticKey: ownerClaim.semanticKey });
    ownerClaim.enforced = true;
    const originalQuery = prisma.$queryRaw.getMockImplementation()!;
    prisma.$queryRaw.mockImplementation(async (query) => {
      if (extractSql(query).includes('completed_ordered_head_mirrors'))
        return [{ mirrorId: mirror.id }];
      if (extractSql(query).includes('completed_ordered_head_mirror_guard'))
        return [{ id: mirror.id }];
      return originalQuery(query);
    });
    const heads = new Map([['chat-completed-semantic-owner', mirror]]);
    const internals = service as unknown as CompletedHeadInternals;
    return { ...fixture, holds, heads, internals };
  }

  it('settles a completed physical mirror before saturated shared preparation admission', async () => {
    const f = completedHeadFixture();
    f.webhookService.webhookPreparationSchedulingState.mockReturnValue('shared_capacity');
    await (f.service as unknown as { enqueueBatch(): Promise<void> }).enqueueBatch();
    expect(f.mirror).toMatchObject({
      status: WebhookStatus.DUPLICATE,
      processedAt: f.ownerCompletedAt,
      enqueueAttempts: 0,
    });
    expect(f.holds.isUpdateHeld).toHaveBeenCalledWith(f.mirror.normalizedPayload, f.prisma);
    expect(f.webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
    expect(Object.values(f.queues).flatMap((queue) => queue.add.mock.calls)).toHaveLength(0);
  });

  it.each(['owner', 'claim', 'mirror'] as const)(
    'preserves an early completed mirror after its %s proof CAS is lost',
    async (casLoss) => {
      const f = completedHeadFixture({ casLoss });
      const before = { ...f.mirror };
      expect(await f.internals.recoverCompletedOrderedHeadMirrors(f.heads)).toBe(0);
      expect(f.mirror).toEqual(before);
      expect(f.webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'attempts a guarded settlement after slow successful discovery (guard passes=%s)',
    async (guardPasses) => {
      jest.useFakeTimers();
      const f = completedHeadFixture();
      const before = { ...f.mirror };
      const transaction = f.transaction.getMockImplementation()!;
      f.transaction.mockImplementationOnce(async (operation) => {
        await new Promise((resolve) => setTimeout(resolve, 180));
        return transaction(operation);
      });
      const originalQuery = f.prisma.$queryRaw.getMockImplementation()!;
      const guarded = jest.fn();
      f.prisma.$queryRaw.mockImplementation(async (query) => {
        const sql = extractSql(query);
        if (sql.includes('completed_ordered_head_mirrors'))
          await new Promise((resolve) => setTimeout(resolve, 110));
        if (sql.includes('completed_ordered_head_mirror_guard')) {
          guarded();
          if (!guardPasses) return [];
        }
        return originalQuery(query);
      });
      try {
        const run = f.internals.recoverCompletedOrderedHeadMirrors(f.heads);
        await jest.advanceTimersByTimeAsync(290);
        expect(await run).toBe(guardPasses ? 1 : 0);
        expect(guarded).toHaveBeenCalledTimes(1);
        expect(f.prisma.$transaction).toHaveBeenCalledTimes(2);
        if (guardPasses) {
          expect(f.mirror).toMatchObject({
            status: WebhookStatus.DUPLICATE,
            processedAt: f.ownerCompletedAt,
            enqueueAttempts: 0,
          });
          expect(f.holds.isUpdateHeld).toHaveBeenCalledWith(f.mirror.normalizedPayload, f.prisma);
        } else {
          expect(f.mirror).toEqual(before);
          expect(f.holds.isUpdateHeld).not.toHaveBeenCalled();
        }
        expect(f.webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
        expect(Object.values(f.queues).flatMap((queue) => queue.add.mock.calls)).toHaveLength(0);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('does not attempt settlement when completed-mirror discovery fails', async () => {
    const f = completedHeadFixture();
    const before = { ...f.mirror };
    f.prisma.$transaction.mockRejectedValueOnce(new Error('Discovery unavailable'));
    expect(await f.internals.recoverCompletedOrderedHeadMirrors(f.heads)).toBe(0);
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(f.mirror).toEqual(before);
    expect(f.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(f.holds.isUpdateHeld).not.toHaveBeenCalled();
    expect(f.webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
  });

  it('rotates guarded attempts within each fresh budget after slow mirror discovery', async () => {
    jest.useFakeTimers();
    const f = completedHeadFixture();
    const mirrors = Array.from({ length: 6 }, (_, index) => ({ mirrorId: `bounded-${index}` }));
    jest.spyOn(f.internals, 'selectCompletedOrderedHeadMirrors').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 290));
      return [...mirrors];
    });
    const transaction = f.transaction.getMockImplementation()!;
    f.transaction.mockImplementation(async (operation) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return transaction(operation);
    });
    const attempted: string[] = [];
    let active = 0;
    let peak = 0;
    f.prisma.$queryRaw.mockImplementation(async (query) => {
      expect(extractSql(query)).toContain('completed_ordered_head_mirror_guard');
      attempted.push((query as { values: string[] }).values[0]!);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 240));
      active -= 1;
      return [];
    });
    const before = { ...f.mirror };
    try {
      for (let poll = 0; poll < 3; poll += 1) {
        const run = f.internals.recoverCompletedOrderedHeadMirrors(f.heads, 2);
        await jest.advanceTimersByTimeAsync(550);
        expect(await run).toBe(0);
        expect(attempted).toHaveLength((poll + 1) * 2);
        expect(active).toBe(0);
        await jest.advanceTimersByTimeAsync(450);
      }
      expect(attempted).toEqual(mirrors.map(({ mirrorId }) => mirrorId));
      expect(peak).toBe(2);
      expect(f.mirror).toEqual(before);
      expect(f.holds.isUpdateHeld).not.toHaveBeenCalled();
      expect(f.webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rotates a bounded completed-mirror probe window and excludes carried same-chat authority', async () => {
    jest.useFakeTimers();
    const { service } = createService();
    Object.assign(service, { legacyHolds: { isUpdateHeld: jest.fn() } });
    const internals = service as unknown as CompletedHeadInternals;
    const heads = new Map(
      Array.from({ length: 251 }, (_, index) => [
        `completed-chat-${index}`,
        { id: `completed-${index}`, createdAt: new Date(index) },
      ]),
    );
    const carried = Promise.resolve();
    internals.activeEnqueueUnits.set('chat:completed-chat-0', carried);
    const selector = jest
      .spyOn(internals, 'selectCompletedOrderedHeadMirrors')
      .mockResolvedValue([]);
    try {
      await internals.recoverCompletedOrderedHeadMirrors(heads);
      await internals.recoverCompletedOrderedHeadMirrors(heads);
      expect(selector).toHaveBeenCalledTimes(1);
      expect(selector.mock.calls[0]![0]).toHaveLength(200);
      expect(selector.mock.calls[0]![0]).not.toContain('completed-0');
      await jest.advanceTimersByTimeAsync(1_000);
      await internals.recoverCompletedOrderedHeadMirrors(heads);
      expect(selector.mock.calls[1]![0]).toHaveLength(200);
      expect(new Set(selector.mock.calls.flatMap(([ids]) => ids)).size).toBe(250);
      expect(internals.activeEnqueueUnits.get('chat:completed-chat-0')).toBe(carried);
    } finally {
      internals.activeEnqueueUnits.clear();
      jest.useRealTimers();
    }
  });

  it('retains bounded completed-mirror transactions until they finish after the scheduling budget', async () => {
    jest.useFakeTimers();
    const f = completedHeadFixture();
    const selector = jest
      .spyOn(f.internals, 'selectCompletedOrderedHeadMirrors')
      .mockResolvedValue(
        Array.from({ length: 10 }, (_, index) => ({ mirrorId: `bounded-${index}` })),
      );
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let peak = 0;
    f.prisma.$transaction.mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await pending;
      active -= 1;
      return false;
    });
    let completed = false;
    const run = f.internals.recoverCompletedOrderedHeadMirrors(f.heads, 32).then(() => {
      completed = true;
    });
    try {
      await jest.advanceTimersByTimeAsync(251);
      expect(selector).toHaveBeenCalledTimes(1);
      expect(peak).toBe(4);
      expect(active).toBe(4);
      expect(completed).toBe(false);
      release();
      await run;
      expect(f.prisma.$transaction).toHaveBeenCalledTimes(4);
      expect(active).toBe(0);
    } finally {
      release();
      await run;
      jest.useRealTimers();
    }
  });

  function finishedHeadSchedulingFixture(count: number) {
    const fixture = createService();
    const owners = Array.from({ length: count }, (_, index) => ({
      ownerId: `finished-scheduling-${index}`,
    }));
    const heads = new Map(
      owners.map(({ ownerId }, index) => [
        `finished-scheduling-chat-${index}`,
        { id: ownerId, createdAt: new Date(1_770_000_000_000 + index) },
      ]),
    );
    const internals = fixture.service as unknown as {
      recoverFinishedOrderedHeads: (
        heads: ReadonlyMap<string, { id: string; createdAt: Date }>,
        concurrency: number,
      ) => Promise<number>;
      selectFinishedOrderedHeadOwners: (ids: readonly string[]) => Promise<typeof owners>;
    };
    const selector = jest
      .spyOn(internals, 'selectFinishedOrderedHeadOwners')
      .mockResolvedValue(owners);
    return { ...fixture, heads, internals, selector };
  }

  it('keeps finished-owner recovery within the actual single-worker admission width', async () => {
    const f = finishedHeadSchedulingFixture(3);
    const monotonic = jest.spyOn(performance, 'now').mockReturnValue(0);
    let active = 0;
    let peak = 0;
    f.prisma.$transaction.mockImplementation(async (operation) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return await operation(f.prisma);
      } finally {
        active -= 1;
      }
    });
    try {
      await expect(f.internals.recoverFinishedOrderedHeads(f.heads, 1)).resolves.toBe(0);
      expect(f.prisma.$transaction).toHaveBeenCalledTimes(3);
      expect(peak).toBe(1);
      expect(active).toBe(0);
      expect(f.webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
      expect(Object.values(f.queues).flatMap((queue) => queue.add.mock.calls)).toHaveLength(0);
    } finally {
      monotonic.mockRestore();
      f.selector.mockRestore();
    }
  });

  it('stops admitting recovery after its monotonic budget and drains already started work', async () => {
    const f = finishedHeadSchedulingFixture(5);
    let now = 0;
    const monotonic = jest.spyOn(performance, 'now').mockImplementation(() => now);
    const gates = Array.from({ length: 2 }, () => {
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { waiting, release };
    });
    let started = 0;
    let active = 0;
    f.prisma.$transaction.mockImplementation(async (operation) => {
      const index = started++;
      active += 1;
      try {
        await gates[index]?.waiting;
        return await operation(f.prisma);
      } finally {
        active -= 1;
      }
    });
    let settled = false;
    const recovery = f.internals.recoverFinishedOrderedHeads(f.heads, 2).finally(() => {
      settled = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(started).toBe(2);
      expect(active).toBe(2);
      now = 251;
      gates[0]!.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(started).toBe(2);
      expect(active).toBe(1);
      expect(settled).toBe(false);
      gates[1]!.release();
      await expect(recovery).resolves.toBe(0);
      expect(active).toBe(0);
      expect(started).toBe(2);

      // A later pass visits the unattempted owner first without retaining a waiting task.
      now = 1_001;
      f.prisma.webhookEvent.findUnique.mockClear();
      f.prisma.$transaction.mockImplementation(async (operation) => operation(f.prisma));
      await expect(f.internals.recoverFinishedOrderedHeads(f.heads, 1)).resolves.toBe(0);
      expect(f.prisma.webhookEvent.findUnique.mock.calls[0]?.[0]?.where?.id).toBe(
        'finished-scheduling-2',
      );
    } finally {
      for (const gate of gates) gate.release();
      await recovery;
      monotonic.mockRestore();
      f.selector.mockRestore();
    }
  });

  it('admits guarded owner recovery after slow successful proof discovery', async () => {
    const f = finishedHeadSchedulingFixture(3);
    let now = 0;
    const monotonic = jest.spyOn(performance, 'now').mockImplementation(() => now);
    f.selector.mockImplementation(async () => {
      now = 251;
      return [{ ownerId: 'finished-scheduling-0' }];
    });
    try {
      await expect(f.internals.recoverFinishedOrderedHeads(f.heads, 1)).resolves.toBe(0);
      expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        maxWait: 1_000,
        timeout: 2_000,
      });
      expect(f.prisma.webhookEvent.findUnique).toHaveBeenCalledWith({
        where: { id: 'finished-scheduling-0' },
      });
      expect(f.prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
      expect(f.webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
      expect(Object.values(f.queues).flatMap((queue) => queue.add.mock.calls)).toHaveLength(0);
    } finally {
      monotonic.mockRestore();
      f.selector.mockRestore();
    }
  });

  it('rotates guarded owners within a fresh bounded budget after each slow discovery', async () => {
    jest.useFakeTimers();
    const f = finishedHeadSchedulingFixture(6);
    const owners = Array.from({ length: 6 }, (_, index) => ({
      ownerId: `finished-scheduling-${index}`,
    }));
    f.selector.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 290));
      return [...owners];
    });
    let active = 0;
    let peak = 0;
    f.prisma.$transaction.mockImplementation(async (operation) => {
      peak = Math.max(peak, ++active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 260));
        return await operation(f.prisma);
      } finally {
        active -= 1;
      }
    });
    try {
      for (let poll = 0; poll < 3; poll += 1) {
        const recovery = f.internals.recoverFinishedOrderedHeads(f.heads, 2);
        await jest.advanceTimersByTimeAsync(550);
        expect(await recovery).toBe(0);
        expect(f.prisma.webhookEvent.findUnique).toHaveBeenCalledTimes((poll + 1) * 2);
        expect(active).toBe(0);
        await jest.advanceTimersByTimeAsync(450);
      }
      expect(f.prisma.webhookEvent.findUnique.mock.calls.map(([query]) => query.where.id)).toEqual(
        owners.map(({ ownerId }) => ownerId),
      );
      expect(peak).toBe(2);
      expect(f.prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
      expect(f.webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
      expect(Object.values(f.queues).flatMap((queue) => queue.add.mock.calls)).toHaveLength(0);
    } finally {
      f.selector.mockRestore();
      jest.useRealTimers();
    }
  });

  it('paces finished proof selection and rotates its bounded head window after the interval', async () => {
    const f = finishedHeadSchedulingFixture(250);
    let now = 0;
    const monotonic = jest.spyOn(performance, 'now').mockImplementation(() => now);
    f.selector.mockResolvedValue([]);
    try {
      await expect(f.internals.recoverFinishedOrderedHeads(f.heads, 1)).resolves.toBe(0);
      expect(f.selector).toHaveBeenCalledTimes(1);
      const first = f.selector.mock.calls[0]![0];
      expect(first).toHaveLength(200);
      expect(first[0]).toBe('finished-scheduling-0');
      expect(first.at(-1)).toBe('finished-scheduling-199');

      now = 999;
      await expect(f.internals.recoverFinishedOrderedHeads(f.heads, 1)).resolves.toBe(0);
      expect(f.selector).toHaveBeenCalledTimes(1);
      now = 1_000;
      await expect(f.internals.recoverFinishedOrderedHeads(f.heads, 1)).resolves.toBe(0);
      expect(f.selector).toHaveBeenCalledTimes(2);
      const second = f.selector.mock.calls[1]![0];
      expect(second).toHaveLength(200);
      expect(second[0]).toBe('finished-scheduling-200');
      expect(second[49]).toBe('finished-scheduling-249');
      expect(second[50]).toBe('finished-scheduling-0');
      expect(second.at(-1)).toBe('finished-scheduling-149');
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
      expect(f.prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
    } finally {
      monotonic.mockRestore();
      f.selector.mockRestore();
    }
  });

  it('continues unrelated ordered admission after proof selection fails while preserving a blocked chat', async () => {
    const blockedChatId = 'finished-selector-blocked-chat';
    const f = createService({
      systemMode: 'degrade',
      configOverrides: { ENQUEUE_CONCURRENCY: 1 },
      findManyResult: [
        {
          id: 'finished-selector-fenced-owner',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 1,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: new Date(Date.now() + 60_000),
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:fixture: unknown`,
          createdAt: new Date('2026-09-02T08:00:00.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: blockedChatId, messageId: 'fenced-first' },
          },
        },
        {
          id: 'finished-selector-blocked-next',
          enqueueAttempts: 0,
          createdAt: new Date('2026-09-02T08:00:01.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: blockedChatId, messageId: 'blocked-next' },
          },
        },
        {
          id: 'finished-selector-unrelated',
          enqueueAttempts: 0,
          createdAt: new Date('2026-09-02T08:00:02.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: 'finished-selector-unrelated-chat', messageId: 'unrelated' },
          },
        },
      ],
    });
    const retained = { ...f.webhookRows[0]! };
    const originalQuery = f.prisma.$queryRaw.getMockImplementation()!;
    f.prisma.$queryRaw.mockImplementation(async (query) => {
      if (extractSql(query).includes('finished_ordered_head_proofs'))
        throw new Error('statement timeout');
      return originalQuery(query);
    });

    await expect(
      (f.service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch(),
    ).resolves.toBeUndefined();

    expect(
      f.prisma.$queryRaw.mock.calls.filter(([query]) =>
        extractSql(query).includes('finished_ordered_head_proofs'),
      ),
    ).toHaveLength(1);
    expect(f.webhookRows[0]).toEqual(retained);
    expect(f.webhookRows[1]).toMatchObject({
      status: WebhookStatus.RECEIVED,
      enqueueAttempts: 0,
      queueName: null,
    });
    expect(f.webhookService.preparePersistedWebhookEvent.mock.calls.map(([id]) => id)).toEqual([
      'finished-selector-unrelated',
    ]);
    expect(
      Object.values(f.queues).flatMap((queue) =>
        queue.add.mock.calls.map(([, job]) => job.webhookEventId),
      ),
    ).toEqual(['finished-selector-unrelated']);
  });

  function capacityFixture(
    count: number,
    prepare: (id: string) => Promise<void>,
    {
      poolMax = 4,
      enqueueConcurrency = 4,
      systemMode = 'degrade',
    }: {
      poolMax?: number;
      enqueueConcurrency?: number;
      systemMode?: 'normal' | 'degrade';
    } = {},
  ) {
    const fixture = createService({
      systemMode,
      configOverrides: { ENQUEUE_POLL_INTERVAL_MS: 200, ENQUEUE_CONCURRENCY: enqueueConcurrency },
      findManyResult: Array.from({ length: count }, (_, index) => ({
        id: `capacity-${index}`,
        enqueueAttempts: 0,
        createdAt: new Date(1_770_000_000_000 + index),
        normalizedPayload: {
          updateId: `capacity-${index}`,
          botId: 'same-bot',
          type: 'message_created',
          message: { chatId: `capacity-chat-${index}`, messageId: `capacity-message-${index}` },
        },
      })),
    });
    const metrics = jest.fn();
    const admission = new WebhookPreparationAdmission(poolMax, metrics);
    const boundary = Object.create(WebhookService.prototype) as WebhookService;
    const original = fixture.webhookService.preparePersistedWebhookEvent.getMockImplementation()!;
    Object.defineProperty(boundary, 'preparationAdmission', { value: admission });
    Object.defineProperty(boundary, 'preparePersistedWebhookEventAdmitted', {
      value: async (id: string) => {
        await prepare(id);
        return original(id);
      },
    });
    fixture.webhookService.canPreparePersistedWebhookEvent.mockImplementation((update) =>
      boundary.canPreparePersistedWebhookEvent(update),
    );
    fixture.webhookService.webhookPreparationSchedulingState.mockImplementation((update) =>
      boundary.webhookPreparationSchedulingState(update),
    );
    fixture.webhookService.nextPreparationCompletion.mockImplementation(() =>
      boundary.nextPreparationCompletion(),
    );
    fixture.webhookService.preparePersistedWebhookEvent.mockImplementation((...args) =>
      boundary.preparePersistedWebhookEvent(...args),
    );
    const run = () =>
      (fixture.service as unknown as { enqueueBatch(): Promise<void> }).enqueueBatch();
    const capacityWrites = () =>
      fixture.prisma.webhookEvent.updateMany.mock.calls.filter(([args]) =>
        args.data.errorMessage?.includes('preparation capacity'),
      );
    return { ...fixture, admission, metrics, run, capacityWrites };
  }

  it.each([6, 32])(
    'refills six preparation slots from carried owners at work-unit limit %i without another slow SQL selection',
    async (enqueueConcurrency) => {
      jest.useFakeTimers();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started: string[] = [];
      const fixture = capacityFixture(
        18,
        async (id) => {
          started.push(id);
          if (Number(id.split('-')[1]) < 6) await held;
        },
        { poolMax: 12, enqueueConcurrency, systemMode: 'normal' },
      );
      fixture.prisma.webhookEvent.updateMany.mockImplementation(
        createWebhookEventUpdateManyMock(fixture.webhookRows),
      );
      for (const [index, row] of fixture.webhookRows.entries()) {
        (row.normalizedPayload as MaxUpdate).botId = `carried-bot-${index % 3}`;
      }
      const internal = fixture.service as unknown as {
        selectEnqueueCandidates(...args: unknown[]): Promise<unknown[]>;
        activeEnqueueUnits: Map<string, Promise<void>>;
      };
      const select = internal.selectEnqueueCandidates.bind(internal);
      const selection = jest
        .spyOn(internal, 'selectEnqueueCandidates')
        .mockImplementation(async (...args) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 400));
          return select(...args);
        });
      try {
        const first = fixture.run();
        await jest.advanceTimersByTimeAsync(1_401);
        await first;
        expect(started).toHaveLength(6);
        expect(fixture.admission.snapshot().inFlight).toBe(6);
        const second = fixture.run();
        await jest.advanceTimersByTimeAsync(450);
        expect(started).toHaveLength(6);
        release();
        await jest.advanceTimersByTimeAsync(1);
        await second;
        expect(selection).toHaveBeenCalledTimes(2);
        expect(new Set(started).size).toBe(18);
        expect(started).toHaveLength(18);
        fixture.admission.flush();
        expect(fixture.metrics).toHaveBeenLastCalledWith(
          expect.objectContaining({ peakInFlight: 6 }),
        );
        expect(fixture.capacityWrites()).toHaveLength(0);
        expect(internal.activeEnqueueUnits.size).toBe(0);
      } finally {
        release();
        await jest.runOnlyPendingTimersAsync();
        await fixture.service.onModuleDestroy();
        jest.useRealTimers();
      }
    },
  );

  it('refills preparation from reloaded representatives while SQL selection is still running', async () => {
    jest.useFakeTimers();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const fixture = capacityFixture(
      18,
      async (id) => {
        started.push(id);
        if (Number(id.split('-')[1]) < 6) await held;
      },
      { poolMax: 12, enqueueConcurrency: 32, systemMode: 'normal' },
    );
    fixture.prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(fixture.webhookRows),
    );
    for (const [index, row] of fixture.webhookRows.entries()) {
      (row.normalizedPayload as MaxUpdate).botId = `overlap-bot-${index % 3}`;
    }
    const internal = fixture.service as unknown as {
      selectEnqueueCandidates(...args: unknown[]): Promise<unknown[]>;
      activeEnqueueUnits: Map<string, Promise<void>>;
      pendingEnqueueRepresentatives: Map<string, string>;
    };
    const select = internal.selectEnqueueCandidates.bind(internal);
    let selecting = 0;
    let peakSelecting = 0;
    const selection = jest
      .spyOn(internal, 'selectEnqueueCandidates')
      .mockImplementation(async (...args) => {
        selecting += 1;
        peakSelecting = Math.max(peakSelecting, selecting);
        try {
          const selected = (await select(...args)).map((candidate) => ({
            ...(candidate as Record<string, unknown>),
            isBacklogScan: true,
          }));
          await new Promise<void>((resolve) => setTimeout(resolve, 800));
          return selected;
        } finally {
          selecting -= 1;
        }
      });
    let second: Promise<void> | undefined;
    try {
      const first = fixture.run();
      await jest.advanceTimersByTimeAsync(1_801);
      await first;
      expect(started).toHaveLength(6);
      expect(fixture.admission.snapshot().inFlight).toBe(6);
      second = fixture.run();
      await jest.advanceTimersByTimeAsync(50);
      expect(selecting).toBe(1);
      release();
      await jest.advanceTimersByTimeAsync(50);
      expect(selecting).toBe(1);
      expect(started).toHaveLength(18);
      await jest.advanceTimersByTimeAsync(1_801);
      await second;
      expect(selection).toHaveBeenCalledTimes(2);
      expect(peakSelecting).toBe(1);
      expect(new Set(started).size).toBe(18);
      expect(internal.activeEnqueueUnits.size).toBe(0);
      expect(internal.pendingEnqueueRepresentatives.size).toBeLessThanOrEqual(100);
      fixture.admission.flush();
      expect(fixture.metrics).toHaveBeenLastCalledWith(
        expect.objectContaining({ peakInFlight: 6 }),
      );
      expect(fixture.capacityWrites()).toHaveLength(0);
    } finally {
      release();
      await jest.runOnlyPendingTimersAsync();
      await second;
      await fixture.service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('continues a fast ordered chat during slow selection while independent retained commands go first', async () => {
    jest.useFakeTimers();
    const chatId = '-continuation-chat';
    const f = createService({
      findManyResult: [
        ...Array.from({ length: 11 }, (_, index) => ({
          id: `continuation-${index}`,
          enqueueAttempts: 0,
          createdAt: new Date(1_770_000_000_000 + index),
          status: index === 0 ? WebhookStatus.PROCESSED : WebhookStatus.RECEIVED,
          processedAt: index === 0 ? new Date() : null,
          normalizedPayload: {
            type: 'message_created',
            botId: 'ordinary-bot',
            updateId: `continuation-${index}`,
            message: { chatId, messageId: `message-${index}` },
          },
        })),
        {
          id: 'independent-start',
          enqueueAttempts: 0,
          normalizedPayload: {
            type: 'message_created',
            botId: 'command-bot',
            updateId: 'independent-start',
            message: { chatId: '-independent-start', messageId: 'start', text: 'Старт' },
          },
        },
        {
          id: 'independent-lifecycle',
          enqueueAttempts: 0,
          normalizedPayload: {
            type: 'user_removed',
            botId: 'lifecycle-bot',
            updateId: 'independent-lifecycle',
            message: { chatId: '-independent-lifecycle', messageId: 'leave' },
          },
        },
      ],
    });
    f.prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(f.webhookRows),
    );
    const internals = f.service as unknown as {
      enqueueBatch(): Promise<void>;
      selectEnqueueCandidates(...args: unknown[]): Promise<unknown[]>;
      rememberEnqueuedChat(chatId: string, id: string): void;
      pendingEnqueueRepresentatives: Map<string, string>;
      activeEnqueueUnits: Map<string, Promise<void>>;
    };
    internals.rememberEnqueuedChat(chatId, 'continuation-0');
    internals.pendingEnqueueRepresentatives = new Map([
      ['chat:-independent-start', 'independent-start'],
      ['event:independent-lifecycle', 'independent-lifecycle'],
    ]);
    const select = internals.selectEnqueueCandidates.bind(internals);
    const selection = jest
      .spyOn(internals, 'selectEnqueueCandidates')
      .mockImplementation(async (...args) => {
        const rows = await select(...args);
        await new Promise((resolve) => setTimeout(resolve, 800));
        return rows;
      });
    const admitted: string[] = [];
    for (const queue of Object.values(f.queues))
      queue.add.mockImplementation(async (_, job) => {
        const row = f.webhookRows.find(({ id }) => id === job.webhookEventId)!;
        expect(row.status).toBe(WebhookStatus.QUEUED);
        if (row.id.startsWith('continuation-')) {
          const index = Number(row.id.split('-')[1]);
          expect(f.webhookRows[index - 1]!.status).toBe(WebhookStatus.PROCESSED);
        }
        admitted.push(row.id);
        setTimeout(() => {
          row.status = WebhookStatus.PROCESSED;
          row.processedAt = new Date();
        }, 50);
      });
    try {
      const poll = internals.enqueueBatch();
      await jest.advanceTimersByTimeAsync(799);
      expect(admitted.slice(0, 2).sort()).toEqual(['independent-lifecycle', 'independent-start']);
      expect(admitted.filter((id) => id.startsWith('continuation-'))).toEqual([
        'continuation-1',
        'continuation-2',
        'continuation-3',
        'continuation-4',
      ]);
      await jest.advanceTimersByTimeAsync(2);
      await poll;
      expect(selection).toHaveBeenCalledTimes(1);
      expect(new Set(admitted).size).toBe(admitted.length);
      expect(f.webhookRows[5]!.status).toBe(WebhookStatus.RECEIVED);
      expect(internals.activeEnqueueUnits.size).toBe(0);
    } finally {
      await jest.runOnlyPendingTimersAsync();
      await f.service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('keeps chat continuation hints bounded and refuses unfinished predecessors or newly deferred heads', async () => {
    const f = createService({
      findManyResult: [
        {
          id: 'continuation-before',
          enqueueAttempts: 0,
          status: WebhookStatus.QUEUED,
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: '-bounded', messageId: 'before' },
          },
        },
        {
          id: 'continuation-after',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-25'),
          nextEnqueueAt: new Date(Date.now() + 10_000),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: '-bounded', messageId: 'after' },
          },
        },
      ],
    });
    const internals = f.service as unknown as {
      rememberEnqueuedChat(chatId: string, id: string): void;
      readChatContinuations(now: Date, attempts: Map<string, number>): Promise<unknown[]>;
      recentEnqueuedChats: Map<string, { id: string; expiresAt: number }>;
    };
    for (let index = 0; index < 150; index++)
      internals.rememberEnqueuedChat(`-${index}`, `prior-${index}`);
    expect(internals.recentEnqueuedChats.size).toBe(100);
    for (let index = 0; index < 7; index++)
      await internals.readChatContinuations(new Date(), new Map());
    const probes = f.prisma.webhookEvent.findMany.mock.calls.map(
      ([query]) => (query?.where?.id as { in: string[] }).in,
    );
    expect(probes.every((ids) => ids.length <= 16)).toBe(true);
    expect(new Set(probes.flat()).size).toBe(100);
    internals.recentEnqueuedChats.clear();
    internals.rememberEnqueuedChat('-bounded', 'continuation-before');
    expect(await internals.readChatContinuations(new Date(), new Map())).toEqual([]);
    f.webhookRows[0]!.status = WebhookStatus.PROCESSED;
    f.webhookRows[0]!.processedAt = new Date();
    expect(await internals.readChatContinuations(new Date(), new Map())).toEqual([]);
    f.webhookRows[1]!.nextEnqueueAt = null;
    expect(await internals.readChatContinuations(new Date(), new Map())).toEqual([
      expect.objectContaining({ id: 'continuation-after' }),
    ]);
    expect(await internals.readChatContinuations(new Date(Date.now() + 30_001), new Map())).toEqual(
      [],
    );
    expect(internals.recentEnqueuedChats.size).toBe(0);
    expect(f.webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
  });

  it.each(['deadline', 'selection', 'shutdown'] as const)(
    'does not initiate continuation after %s changes during awaited discovery',
    async (stop) => {
      jest.useFakeTimers();
      const f = createService({
        findManyResult: [
          {
            id: 'late-continuation',
            enqueueAttempts: 0,
            normalizedPayload: {
              type: 'message_created',
              message: { chatId: '-late-continuation', messageId: 'next' },
            },
          },
        ],
      });
      const internal = f.service as unknown as {
        defaultEnqueueAdmission(): never;
        rememberEnqueuedChat(chatId: string, id: string): void;
        readChatContinuations(): Promise<unknown[]>;
        refillDuringSelection(
          rows: unknown[],
          admission: unknown,
          dispatched: Set<string>,
          done: () => boolean,
          finished: Promise<void>,
        ): Promise<unknown>;
        shuttingDown: boolean;
      };
      let done = false;
      internal.rememberEnqueuedChat('-late-continuation', 'finished-before');
      jest.spyOn(internal, 'readChatContinuations').mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, stop === 'deadline' ? 1_001 : 50));
        if (stop === 'selection') done = true;
        if (stop === 'shutdown') internal.shuttingDown = true;
        return f.webhookRows;
      });
      try {
        const refill = internal.refillDuringSelection(
          [],
          internal.defaultEnqueueAdmission(),
          new Set(),
          () => done,
          new Promise(() => undefined),
        );
        await jest.advanceTimersByTimeAsync(1_102);
        await refill;
        expect(f.webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
        expect(Object.values(f.queues).flatMap((queue) => queue.add.mock.calls)).toHaveLength(0);
      } finally {
        await f.service.onModuleDestroy();
        jest.useRealTimers();
      }
    },
  );

  it('caps continuation admission at sixteen and drains its already owned preparation on shutdown', async () => {
    jest.useFakeTimers();
    const f = createService({
      findManyResult: Array.from({ length: 20 }, (_, index) => [
        {
          id: `bulk-${index}-before`,
          enqueueAttempts: 0,
          status: WebhookStatus.PROCESSED,
          processedAt: new Date(),
          createdAt: new Date(1_760_000_000_000),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: `-bulk-${index}`, messageId: 'before' },
          },
        },
        {
          id: `bulk-${index}-next`,
          enqueueAttempts: 0,
          createdAt: new Date(1_760_000_000_001),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: `-bulk-${index}`, messageId: 'next' },
          },
        },
      ]).flat(),
    });
    f.prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(f.webhookRows),
    );
    const internal = f.service as unknown as {
      tick(): Promise<void>;
      selectEnqueueCandidates(): Promise<unknown[]>;
      rememberEnqueuedChat(chatId: string, id: string): void;
      activeEnqueueUnits: Map<string, Promise<void>>;
    };
    for (let index = 0; index < 20; index++)
      internal.rememberEnqueuedChat(`-bulk-${index}`, `bulk-${index}-before`);
    jest.spyOn(internal, 'selectEnqueueCandidates').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return [];
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepare = f.webhookService.preparePersistedWebhookEvent.getMockImplementation()!;
    f.webhookService.preparePersistedWebhookEvent.mockImplementation(async (...args) => {
      if (args[0] === 'bulk-0-next') await held;
      return prepare(...args);
    });
    let drained = false;
    let closing: Promise<void> | undefined;
    const poll = internal.tick();
    try {
      await jest.advanceTimersByTimeAsync(301);
      expect(f.webhookService.preparePersistedWebhookEvent).toHaveBeenCalledTimes(16);
      expect(Object.values(f.queues).flatMap((queue) => queue.add.mock.calls)).toHaveLength(15);
      expect(internal.activeEnqueueUnits.size).toBe(1);
      closing = f.service.onModuleDestroy().then(() => {
        drained = true;
      });
      await jest.advanceTimersByTimeAsync(600);
      await poll;
      expect(drained).toBe(false);
      release();
      await closing;
      expect(drained).toBe(true);
      expect(internal.activeEnqueueUnits.size).toBe(0);
      expect(f.webhookService.preparePersistedWebhookEvent).toHaveBeenCalledTimes(16);
      expect(Object.values(f.queues).flatMap((queue) => queue.add.mock.calls)).toHaveLength(16);
    } finally {
      release();
      await jest.runOnlyPendingTimersAsync();
      await poll;
      await closing;
      await f.service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('dispatches a successful selection when the concurrent retained refill fails', async () => {
    const fixture = capacityFixture(2, async () => undefined, {
      poolMax: 12,
      enqueueConcurrency: 32,
      systemMode: 'normal',
    });
    const internal = fixture.service as unknown as {
      findOrderedWebhookHeadsForChats(ids: string[]): Promise<unknown>;
      pendingEnqueueRepresentatives: Map<string, string>;
    };
    internal.pendingEnqueueRepresentatives = new Map([['chat:capacity-chat-0', 'capacity-0']]);
    jest
      .spyOn(internal, 'findOrderedWebhookHeadsForChats')
      .mockRejectedValueOnce(new Error('retained head lookup unavailable'));
    await fixture.run();
    expect(
      new Set(fixture.webhookService.preparePersistedWebhookEvent.mock.calls.map(([id]) => id)),
    ).toEqual(new Set(['capacity-0', 'capacity-1']));
    await fixture.service.onModuleDestroy();
  });

  it('drains retained preparation after SQL selection fails during shutdown', async () => {
    jest.useFakeTimers();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const fixture = capacityFixture(
      2,
      async (id) => {
        started.push(id);
        await held;
      },
      { poolMax: 12, enqueueConcurrency: 32, systemMode: 'normal' },
    );
    const internal = fixture.service as unknown as {
      tick(): Promise<void>;
      selectEnqueueCandidates(): Promise<unknown[]>;
      activeEnqueueUnits: Map<string, Promise<void>>;
      pendingEnqueueRepresentatives: Map<string, string>;
    };
    internal.pendingEnqueueRepresentatives = new Map([['chat:capacity-chat-0', 'capacity-0']]);
    jest.spyOn(internal, 'selectEnqueueCandidates').mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      throw new Error('selection unavailable');
    });
    let drain: Promise<void> | undefined;
    try {
      const tick = internal.tick();
      await jest.advanceTimersByTimeAsync(100);
      expect(started).toEqual(['capacity-0']);
      let drained = false;
      const [worker] = fixture.service.stopWorkerAdmission();
      drain = worker!.pause().then(() => {
        drained = true;
      });
      await jest.advanceTimersByTimeAsync(1_001);
      await tick;
      await internal.tick();
      expect(drained).toBe(false);
      expect(started).toEqual(['capacity-0']);
      expect(internal.activeEnqueueUnits.size).toBe(1);
      release();
      await drain;
      expect(drained).toBe(true);
      expect(internal.activeEnqueueUnits.size).toBe(0);
    } finally {
      release();
      await jest.runOnlyPendingTimersAsync();
      await drain;
      await fixture.service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('amortizes slow selection with one bounded second of six-slot dispatch', async () => {
    jest.useFakeTimers();
    const started: Array<{ id: string; at: number }> = [];
    const fixture = capacityFixture(
      120,
      async (id) => {
        started.push({ id, at: Date.now() });
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      },
      { poolMax: 12, enqueueConcurrency: 32, systemMode: 'normal' },
    );
    fixture.prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(fixture.webhookRows),
    );
    for (const [index, row] of fixture.webhookRows.entries()) {
      (row.normalizedPayload as MaxUpdate).botId = `pump-bot-${index % 3}`;
    }
    const internal = fixture.service as unknown as {
      selectEnqueueCandidates(...args: unknown[]): Promise<unknown[]>;
      activeEnqueueUnits: Map<string, Promise<void>>;
      pendingEnqueueRepresentatives: Map<string, string>;
    };
    const select = internal.selectEnqueueCandidates.bind(internal);
    const selection = jest
      .spyOn(internal, 'selectEnqueueCandidates')
      .mockImplementation(async (...args) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 400));
        return select(...args);
      });
    const began = Date.now();
    let finishedAt: number | undefined;
    try {
      const work = fixture.run().then(() => {
        finishedAt = Date.now();
      });
      await jest.advanceTimersByTimeAsync(1_401);
      await work;
      expect(selection).toHaveBeenCalledTimes(1);
      expect(started.length).toBeGreaterThanOrEqual(54);
      expect(started.some(({ at }) => at - began > 600)).toBe(true);
      expect(finishedAt! - began).toBe(1_400);
      fixture.admission.flush();
      expect(fixture.metrics).toHaveBeenLastCalledWith(
        expect.objectContaining({ peakInFlight: 6 }),
      );
      expect(internal.activeEnqueueUnits.size).toBeLessThanOrEqual(6);
      expect(internal.pendingEnqueueRepresentatives.size).toBeLessThanOrEqual(100);
      expect(fixture.capacityWrites()).toHaveLength(0);
    } finally {
      await jest.runOnlyPendingTimersAsync();
      await fixture.service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('admits a selected fresh independent receipt while old scan debt continuously fills the dispatch budget', async () => {
    jest.useFakeTimers();
    const started: string[] = [];
    const fixture = capacityFixture(
      401,
      async (id) => {
        started.push(id);
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
      },
      { poolMax: 24, enqueueConcurrency: 32, systemMode: 'normal' },
    );
    fixture.prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(fixture.webhookRows),
    );
    for (const [index, row] of fixture.webhookRows.entries()) {
      (row.normalizedPayload as MaxUpdate).botId = `reserve-bot-${index % 3}`;
    }
    const fresh = fixture.webhookRows[400]!;
    fresh.createdAt = new Date();
    type Candidate = MockWebhookEventRow & {
      isBacklogScan?: boolean;
      isRecentReceipt?: boolean;
      priority?: number;
    };
    const internal = fixture.service as unknown as {
      enqueueCandidates(candidates: Candidate[]): Promise<unknown>;
      pendingEnqueueRepresentatives: Map<string, string>;
      activeEnqueueUnits: Map<string, Promise<void>>;
    };
    try {
      for (let pass = 0; pass < 3; pass++) {
        const old = fixture.webhookRows
          .slice(0, 400)
          .filter((row) => row.status === WebhookStatus.RECEIVED)
          .slice(0, 100)
          .map((row) => ({ ...row, priority: 5, isBacklogScan: true }));
        expect(old).toHaveLength(100);
        const selected = [
          ...old,
          ...(fresh.status === WebhookStatus.RECEIVED
            ? [{ ...fresh, priority: 5, isRecentReceipt: true }]
            : []),
        ];
        const work = internal.enqueueCandidates(selected);
        await jest.advanceTimersByTimeAsync(1_001);
        await work;
        await jest.advanceTimersByTimeAsync(350);
        await Promise.all(internal.activeEnqueueUnits.values());
        expect(started).toContain(fresh.id);
      }
      expect(started).toContain(fresh.id);
      expect(started.filter((id) => id !== fresh.id).length).toBeGreaterThan(30);
      expect(fixture.admission.snapshot().inFlight).toBe(0);
      expect(internal.pendingEnqueueRepresentatives.size).toBeLessThanOrEqual(100);
      expect(fixture.capacityWrites()).toHaveLength(0);
      expect(fresh.status).toBe(WebhookStatus.QUEUED);
    } finally {
      await jest.runOnlyPendingTimersAsync();
      await fixture.service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('keeps an earlier same-chat head fenced while reserving dispatch for an independent fresh receipt', async () => {
    const fixture = capacityFixture(6, async () => undefined, {
      poolMax: 24,
      enqueueConcurrency: 32,
      systemMode: 'normal',
    });
    const blocked = fixture.webhookRows[4]!;
    (blocked.normalizedPayload as MaxUpdate).message!.chatId = 'capacity-chat-3';
    const internal = fixture.service as unknown as {
      enqueueCandidates(candidates: unknown[]): Promise<unknown>;
    };
    await internal.enqueueCandidates([
      ...fixture.webhookRows.slice(0, 3).map((row) => ({
        ...row,
        priority: 5,
        isBacklogScan: true,
      })),
      ...fixture.webhookRows.slice(4).map((row) => ({
        ...row,
        priority: 5,
        isRecentReceipt: true,
      })),
    ]);
    const started = fixture.webhookService.preparePersistedWebhookEvent.mock.calls.map(
      ([id]) => id,
    );
    expect(started).toEqual(
      expect.arrayContaining(['capacity-0', 'capacity-1', 'capacity-2', 'capacity-5']),
    );
    expect(started).not.toContain('capacity-3');
    expect(started).not.toContain(blocked.id);
    expect(started.indexOf('capacity-0')).toBeLessThan(started.indexOf('capacity-1'));
    expect(started.indexOf('capacity-1')).toBeLessThan(started.indexOf('capacity-2'));
    expect(blocked.status).toBe(WebhookStatus.RECEIVED);
    expect(fixture.capacityWrites()).toHaveLength(0);
  });

  it('dispatches scanned ordinary receipts during a sustained lifecycle stream at the real preparation cap', async () => {
    jest.useFakeTimers();
    const started: string[] = [];
    const fixture = capacityFixture(26, async (id) => {
      started.push(id);
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
    });
    fixture.prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(fixture.webhookRows),
    );
    for (const [index, row] of fixture.webhookRows.entries()) {
      Object.assign(row, { legacyDispositionId: null });
      const payload = row.normalizedPayload as MaxUpdate;
      payload.botId = index < 2 ? `ordinary-${index}` : `lifecycle-${index % 7}`;
      payload.type =
        index === 0 ? 'message_created' : index === 1 ? 'message_removed' : 'user_added';
    }
    type Candidate = MockWebhookEventRow & { isBacklogScan?: boolean; priority?: number };
    const internals = fixture.service as unknown as {
      readPendingEnqueueRepresentatives(now: Date, take: number): Promise<Candidate[]>;
      mergeEnqueueCandidates(candidates: Candidate[], take: number): Candidate[];
      prioritizeCandidates(candidates: Candidate[], now: Date, take: number): Promise<Candidate[]>;
      enqueueCandidates(
        candidates: Candidate[],
      ): Promise<{ preparationSharedCapacityBlocked: number }>;
      pendingEnqueueRepresentatives: Map<string, string>;
      activeEnqueueUnits: Map<string, Promise<void>>;
    };
    try {
      let sharedDeferrals = 0;
      for (let pass = 0; pass < 8; pass++) {
        const freshIds = new Set<string>();
        for (let index = 0; index < 12; index++) {
          const id = `lifecycle-stream-${pass}-${index}`;
          freshIds.add(id);
          const template = fixture.webhookRows[2]!;
          fixture.webhookRows.push({
            ...template,
            id,
            dedupKey: id,
            status: WebhookStatus.RECEIVED,
            enqueueAttempts: 0,
            queueName: null,
            queuedAt: null,
            createdAt: new Date(),
            normalizedPayload: {
              updateId: id,
              botId: `lifecycle-${index % 7}`,
              type: 'user_added',
              message: { chatId: id, messageId: id },
            },
          });
        }
        const pending = await internals.readPendingEnqueueRepresentatives(new Date(), 400);
        const source = fixture.webhookRows
          .filter((row) => row.status === WebhookStatus.RECEIVED)
          .map((row) => ({ ...row, isBacklogScan: pass === 0 || freshIds.has(row.id) }));
        const selected = await internals.prioritizeCandidates(
          internals.mergeEnqueueCandidates([...pending, ...source], 1000),
          new Date(),
          400,
        );
        const work = internals.enqueueCandidates(selected);
        await jest.advanceTimersByTimeAsync(1_001);
        sharedDeferrals += (await work).preparationSharedCapacityBlocked;
        expect(fixture.admission.snapshot().inFlight).toBeLessThanOrEqual(2);
        expect(internals.pendingEnqueueRepresentatives.size).toBeLessThanOrEqual(100);
        await jest.advanceTimersByTimeAsync(200);
        await Promise.all(internals.activeEnqueueUnits.values());
      }
      expect(sharedDeferrals).toBeGreaterThan(0);
      expect(started).toEqual(expect.arrayContaining(['capacity-0', 'capacity-1']));
      expect(started.filter((id) => id.startsWith('lifecycle-stream-')).length).toBeGreaterThan(0);
      expect(fixture.capacityWrites()).toHaveLength(0);
      expect(
        fixture.webhookRows
          .slice(0, 2)
          .map(({ id, status, errorMessage }) => ({ id, status, errorMessage })),
      ).toEqual([
        { id: 'capacity-0', status: WebhookStatus.QUEUED, errorMessage: null },
        { id: 'capacity-1', status: WebhookStatus.QUEUED, errorMessage: null },
      ]);
    } finally {
      await jest.runOnlyPendingTimersAsync();
      await Promise.all(internals.activeEnqueueUnits.values());
      jest.useRealTimers();
    }
  });

  it('reuses a released preparation slot within its bounded selected batch without retry writes', async () => {
    const started: string[] = [];
    const fixture = capacityFixture(8, async (id) => {
      started.push(id);
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    await fixture.run();
    fixture.admission.flush();
    expect(started).toHaveLength(8);
    expect(fixture.capacityWrites()).toHaveLength(0);
    expect(Object.values(fixture.queues).flatMap((queue) => queue.add.mock.calls)).toHaveLength(8);
    expect(fixture.metrics).toHaveBeenLastCalledWith(
      expect.objectContaining({
        peakInFlight: 1,
        pending: 0,
        deferred: { ordinary: 0, interactive: 0, lifecycle: 0 },
      }),
    );
  });

  it('yields undispatched receipts after one second of capacity contention without backoff churn', async () => {
    let now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const fixture = capacityFixture(8, async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        now += 1_000;
      });
      await fixture.run();
      expect(fixture.webhookService.preparePersistedWebhookEvent).toHaveBeenCalledTimes(1);
      expect(fixture.capacityWrites()).toHaveLength(0);
      expect(
        fixture.prisma.webhookEvent.updateMany.mock.calls.every(
          ([args]) => args.where.id === 'capacity-0',
        ),
      ).toBe(true);
      expect(fixture.admission.snapshot().inFlight).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  it('starts the next preparation when its slot frees while an earlier queue handoff is still running', async () => {
    const started: string[] = [];
    const fixture = capacityFixture(3, async (id) => {
      started.push(id);
    });
    let release!: () => void;
    const handoff = new Promise<void>((resolve) => {
      release = resolve;
    });
    const route = fixture.webhookRoutingService.resolveQueueName.getMockImplementation()!;
    fixture.webhookRoutingService.resolveQueueName.mockImplementation(async (id, payload) => {
      if (id === 'capacity-0') await handoff;
      return route(id, payload);
    });
    const work = fixture.run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const beforeRelease = [...started];
    release();
    await work;
    expect(beforeRelease).toEqual(['capacity-0', 'capacity-1', 'capacity-2']);
    expect(fixture.capacityWrites()).toHaveLength(0);
  });

  it('leaves receipts in SQL without waiting for preparation owned outside its batch', async () => {
    const fixture = capacityFixture(3, async () => undefined);
    let release!: () => void;
    const external = fixture.admission.run(
      'same-bot',
      'ordinary',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    try {
      await fixture.run();
      expect(fixture.webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
      expect(fixture.prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
    } finally {
      release();
      await external;
    }
  });

  it('releases shared pending slots for a blocked bot while admitting an independent bot', async () => {
    const fixture = capacityFixture(3, async () => undefined);
    (fixture.webhookRows[2]!.normalizedPayload as MaxUpdate).botId = 'independent-bot';
    const internals = fixture.service as unknown as {
      enqueueCandidates(candidates: unknown[]): Promise<unknown>;
      pendingEnqueueRepresentatives: Map<string, string>;
    };
    let release!: () => void;
    const external = fixture.admission.run(
      'same-bot',
      'ordinary',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    try {
      await internals.enqueueCandidates(
        fixture.webhookRows.map((row) => ({
          ...row,
          priority: 5,
          isBacklogScan: true,
        })),
      );
      expect(
        fixture.webhookService.preparePersistedWebhookEvent.mock.calls.map(([id]) => id),
      ).toEqual(['capacity-2']);
      expect(internals.pendingEnqueueRepresentatives.size).toBe(0);
      expect(fixture.admission.snapshot().inFlight).toBe(1);
      expect(fixture.capacityWrites()).toHaveLength(0);
    } finally {
      release();
      await external;
    }
  });

  it('pauses new scan cursors when pressure mode shrinks below the pending cohort', async () => {
    const fixture = createService({ configOverrides: { ENQUEUE_BATCH_SIZE: 1000 } });
    const internals = fixture.service as unknown as {
      pendingEnqueueRepresentatives: Map<string, string>;
      selectEnqueueCandidates(now: Date, admission: unknown): Promise<unknown>;
    };
    internals.pendingEnqueueRepresentatives = new Map(
      Array.from({ length: 246 }, (_, index) => [`chat:waiting-${index}`, `waiting-${index}`]),
    );
    const pressure = {
      degraded: true,
      batchSize: 100,
      enqueueConcurrency: 4,
      includeQueuedRepair: false,
      includeCompletedTimeoutRepair: false,
      expandSelectedChats: false,
    };
    await internals.selectEnqueueCandidates(new Date(), pressure);
    expect(extractSql(fixture.prisma.$queryRaw.mock.calls[0]![0])).not.toContain('page_pool');
    internals.pendingEnqueueRepresentatives.clear();
    await internals.selectEnqueueCandidates(new Date(), pressure);
    expect(extractSql(fixture.prisma.$queryRaw.mock.calls[1]![0])).toContain('page_pool');
  });

  it('retains scope overflow until admission while an independent bot keeps progressing', async () => {
    const started: string[] = [];
    const fixture = capacityFixture(
      8,
      async (id) => {
        started.push(id);
      },
      { poolMax: 12 },
    );
    fixture.prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(fixture.webhookRows),
    );
    (fixture.webhookRows[7]!.normalizedPayload as MaxUpdate).botId = 'independent-bot';
    const internal = fixture.service as unknown as {
      enqueueCandidates(candidates: unknown[]): Promise<unknown>;
      readDeferredEnqueueRepresentatives(now: Date, take: number): Promise<unknown[]>;
      deferredEnqueueScopes: DeferredWebhookScopes;
      pendingEnqueueRepresentatives: Map<string, string>;
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owners = [0, 1].map(() => fixture.admission.run('same-bot', 'ordinary', () => held));
    try {
      await internal.enqueueCandidates(
        fixture.webhookRows.map((row) => ({ ...row, priority: 5, isBacklogScan: true })),
      );
      expect(started).toEqual(['capacity-7']);
      expect(internal.pendingEnqueueRepresentatives.size).toBe(0);
      expect(internal.deferredEnqueueScopes.snapshot()).toEqual({
        scopes: 1,
        identities: 0,
        intervals: 2,
      });
      // Loading the first debt does not consume the shared discovery FIFO.
      await internal.readDeferredEnqueueRepresentatives(new Date(), 100);
      expect(internal.deferredEnqueueScopes.snapshot().identities).toBeLessThanOrEqual(2);
      release();
      await Promise.all(owners);
      for (let pass = 0; pass < 12 && started.length < 8; pass++) {
        const deferred = await internal.readDeferredEnqueueRepresentatives(new Date(), 100);
        await internal.enqueueCandidates(
          deferred.map((row) => ({ ...(row as object), priority: 5 })),
        );
        expect(internal.deferredEnqueueScopes.snapshot().identities).toBeLessThanOrEqual(2);
      }
      expect(new Set(started)).toEqual(new Set(fixture.webhookRows.map((row) => row.id)));
      expect(started).toHaveLength(8);
      expect(fixture.capacityWrites()).toHaveLength(0);
    } finally {
      release();
      await Promise.all(owners);
    }
  });

  it.each(['committed', 'thrown', 'cas-lost'] as const)(
    'preserves admission debt when a positive hint loses capacity (retry storage=%s)',
    async (storage) => {
      const fixture = capacityFixture(1, async () => undefined, { poolMax: 12 });
      fixture.webhookService.webhookPreparationSchedulingState.mockReturnValue('available');
      if (storage === 'thrown')
        fixture.prisma.webhookEvent.updateMany.mockRejectedValue(
          new Error('local retry storage unavailable'),
        );
      else if (storage === 'cas-lost')
        fixture.prisma.webhookEvent.updateMany.mockResolvedValue({ count: 0 });
      else
        fixture.prisma.webhookEvent.updateMany.mockImplementation(
          createWebhookEventUpdateManyMock(fixture.webhookRows),
        );
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const owners = [0, 1].map(() => fixture.admission.run('same-bot', 'ordinary', () => held));
      const internal = fixture.service as unknown as {
        enqueueCandidates(rows: unknown[]): Promise<unknown>;
        deferredEnqueueScopes: DeferredWebhookScopes;
      };
      try {
        await internal.enqueueCandidates(
          fixture.webhookRows.map((row) => ({ ...row, isBacklogScan: true, priority: 5 })),
        );
        if (storage !== 'committed') {
          expect(internal.deferredEnqueueScopes.snapshot()).toEqual({
            scopes: 1,
            identities: 0,
            intervals: 1,
          });
          expect(fixture.webhookRows[0]!.nextEnqueueAt).toBeNull();
        } else {
          expect(fixture.webhookRows[0]).toMatchObject({
            status: WebhookStatus.RECEIVED,
            enqueueAttempts: 0,
          });
          expect(fixture.webhookRows[0]!.nextEnqueueAt!.getTime()).toBeGreaterThan(Date.now());
          expect(fixture.capacityWrites()).toHaveLength(1);
          expect(internal.deferredEnqueueScopes.snapshot().scopes).toBe(0);
        }
      } finally {
        release();
        await Promise.all(owners);
      }
    },
  );

  it('retains exact debt when malformed preparation fails before admission and its retry CAS is lost', async () => {
    const fixture = capacityFixture(1, async () => undefined, { poolMax: 12 });
    Object.assign(fixture.webhookRows[0]!.normalizedPayload as object, { botId: 7 });
    fixture.prisma.webhookEvent.updateMany.mockImplementation(async () => {
      fixture.webhookRows[0]!.errorMessage = 'concurrent receipt metadata update';
      return { count: 0 };
    });
    const admission = jest.spyOn(fixture.admission, 'run');
    const internal = fixture.service as unknown as {
      enqueueCandidates(rows: unknown[]): Promise<unknown>;
      readDeferredEnqueueRepresentatives(now: Date, take: number): Promise<Array<{ id: string }>>;
      deferredEnqueueScopes: DeferredWebhookScopes;
    };
    await internal.enqueueCandidates(
      fixture.webhookRows.map((row) => ({ ...row, isBacklogScan: true, priority: 5 })),
    );
    expect(admission).not.toHaveBeenCalled();
    expect(fixture.webhookRows[0]).toMatchObject({
      status: WebhookStatus.RECEIVED,
      nextEnqueueAt: null,
      enqueueAttempts: 0,
    });
    expect(internal.deferredEnqueueScopes.snapshot()).toEqual({
      scopes: 1,
      identities: 0,
      intervals: 1,
    });
    expect(
      (await internal.readDeferredEnqueueRepresentatives(new Date(), 10)).map(({ id }) => id),
    ).toEqual([fixture.webhookRows[0]!.id]);
  });

  it.each(['admitted', 'terminal', 'held', 'future', 'active'] as const)(
    'preserves another bot receipt in the same chat when the earlier retained receipt is %s',
    async (earlierState) => {
      const fixture = createService({
        systemMode: 'degrade',
        findManyResult: [0, 1, 2].map((index) => ({
          id: `cross-scope-${index}`,
          enqueueAttempts: 0,
          createdAt: new Date(1_770_000_000_000 + index),
          normalizedPayload: {
            type: 'message_created',
            botId: index === 1 ? 'bot-b' : 'bot-a',
            message: {
              chatId: index === 2 ? 'interval-anchor' : 'cross-scope-chat',
              messageId: `message-${index}`,
            },
          },
        })),
      });
      fixture.prisma.webhookEvent.updateMany.mockImplementation(
        createWebhookEventUpdateManyMock(fixture.webhookRows),
      );
      const internal = fixture.service as unknown as {
        enqueueBatch(): Promise<void>;
        deferredEnqueueScopes: DeferredWebhookScopes;
        readDeferredEnqueueRepresentatives(now: Date, take: number): Promise<unknown[]>;
        selectEnqueueCandidates(): Promise<unknown[]>;
        activeEnqueueUnits: Map<string, Promise<void>>;
      };
      jest.spyOn(internal, 'selectEnqueueCandidates').mockResolvedValue([]);
      const scope = { botId: 'bot-a', workClass: 'ordinary' as const };
      internal.deferredEnqueueScopes.capture(scope, 'event:absent', {
        id: 'absent',
        createdAt: new Date(1_769_999_999_999),
      });
      internal.deferredEnqueueScopes.capture(
        scope,
        'chat:cross-scope-chat',
        fixture.webhookRows[0]!,
      );
      internal.deferredEnqueueScopes.capture(
        scope,
        'chat:interval-anchor',
        fixture.webhookRows[2]!,
      );
      // The broad fixed interval discovers bot B between its two bot A endpoints.
      for (let pass = 0; pass < 3; pass++)
        await internal.readDeferredEnqueueRepresentatives(new Date(), 10);
      expect(internal.deferredEnqueueScopes.snapshot()).toEqual({
        scopes: 2,
        identities: 3,
        intervals: 0,
      });
      const earlier = fixture.webhookRows[0]!;
      if (earlierState === 'terminal') earlier.status = WebhookStatus.PROCESSED;
      if (earlierState === 'held') earlier.legacyDispositionId = 'exact-held-proof';
      if (earlierState === 'future') earlier.nextEnqueueAt = new Date(Date.now() + 60_000);
      if (earlierState === 'active')
        internal.activeEnqueueUnits.set('chat:cross-scope-chat', Promise.resolve());
      if (earlierState === 'admitted') await internal.enqueueBatch();
      else await internal.readDeferredEnqueueRepresentatives(new Date(), 10);
      expect(internal.deferredEnqueueScopes.identities(10).map(({ id }) => id)).toContain(
        'cross-scope-1',
      );
      internal.activeEnqueueUnits.clear();
      earlier.status = WebhookStatus.PROCESSED;
      earlier.legacyDispositionId = null;
      earlier.nextEnqueueAt = null;
      for (let pass = 0; pass < 3; pass++) await internal.enqueueBatch();
      expect(
        fixture.webhookService.preparePersistedWebhookEvent.mock.calls.map(([id]) => id),
      ).toContain('cross-scope-1');
    },
  );

  it.each(['message_callback', 'bot_added', 'bot_started', 'user_removed'])(
    'keeps nonordered %s with a chat ID independent of ordered head debt',
    async (type) => {
      const fixture = createService({
        findManyResult: [
          {
            id: 'nonordered-scope-event',
            enqueueAttempts: 0,
            normalizedPayload: {
              type,
              botId: 'bot-a',
              message: { chatId: 'ordered-chat', messageId: 'event-message' },
            },
          },
        ],
      });
      const internal = fixture.service as unknown as {
        enqueueCandidates(rows: unknown[]): Promise<unknown>;
        deferredEnqueueScopes: DeferredWebhookScopes;
      };
      await internal.enqueueCandidates(
        fixture.webhookRows.map((row) => ({ ...row, priority: 5, isBacklogScan: true })),
      );
      expect(
        fixture.webhookService.preparePersistedWebhookEvent.mock.calls.map(([id]) => id),
      ).toEqual(['nonordered-scope-event']);
      expect(internal.deferredEnqueueScopes.snapshot().scopes).toBe(0);
    },
  );

  it('transfers a changed scheduling identity before its interval becomes an exact retained row', async () => {
    const fixture = createService({
      findManyResult: [
        {
          id: 'changed-before-read',
          enqueueAttempts: 0,
          normalizedPayload: {
            type: 'message_created',
            botId: 'old-bot',
            message: { chatId: 'changed-before-chat', messageId: 'changed-before-message' },
          },
        },
      ],
    });
    const internal = fixture.service as unknown as {
      deferredEnqueueScopes: DeferredWebhookScopes;
      readDeferredEnqueueRepresentatives(now: Date, take: number): Promise<unknown[]>;
    };
    const row = fixture.webhookRows[0]!;
    internal.deferredEnqueueScopes.capture(
      { botId: 'old-bot', workClass: 'ordinary' },
      'chat:changed-before-chat',
      row,
    );
    Object.assign(row.normalizedPayload as object, { type: 'bot_added', botId: 'new-bot' });
    expect(await internal.readDeferredEnqueueRepresentatives(new Date(), 10)).toEqual([]);
    expect(await internal.readDeferredEnqueueRepresentatives(new Date(), 10)).toHaveLength(1);
    expect(internal.deferredEnqueueScopes.snapshot()).toEqual({
      scopes: 1,
      identities: 1,
      intervals: 0,
    });
  });

  it.each(['terminal', 'held', 'future', 'deleted', 'changed-class', 'malformed'] as const)(
    'rechecks a deferred exact identity that becomes %s without unbounded retained state',
    async (change) => {
      const fixture = createService({
        findManyResult: [
          {
            id: 'deferred-change',
            enqueueAttempts: 0,
            normalizedPayload: {
              type: 'message_created',
              botId: 'old-bot',
              message: { chatId: 'change-chat', messageId: 'change-message' },
            },
          },
        ],
      });
      const internal = fixture.service as unknown as {
        deferredEnqueueScopes: DeferredWebhookScopes;
        readDeferredEnqueueRepresentatives(
          now: Date,
          take: number,
        ): Promise<Array<{ id: string; normalizedPayload: unknown }>>;
      };
      const row = fixture.webhookRows[0]!;
      internal.deferredEnqueueScopes.capture(
        { botId: 'old-bot', workClass: 'ordinary' },
        'chat:change-chat',
        row,
      );
      expect(await internal.readDeferredEnqueueRepresentatives(new Date(), 10)).toHaveLength(1);
      if (change === 'terminal') row.status = WebhookStatus.PROCESSED;
      if (change === 'held') row.legacyDispositionId = 'positive-held-proof';
      if (change === 'future') row.nextEnqueueAt = new Date(Date.now() + 60_000);
      if (change === 'deleted') fixture.webhookRows.splice(0, 1);
      if (change === 'changed-class')
        Object.assign(row.normalizedPayload as object, { type: 'bot_added', botId: 'new-bot' });
      if (change === 'malformed') row.normalizedPayload = { type: 7, botId: 12 };
      expect(await internal.readDeferredEnqueueRepresentatives(new Date(), 10)).toEqual([]);
      if (change === 'changed-class' || change === 'malformed') {
        expect(await internal.readDeferredEnqueueRepresentatives(new Date(), 10)).toHaveLength(1);
        expect(internal.deferredEnqueueScopes.snapshot().identities).toBe(1);
      } else
        expect(internal.deferredEnqueueScopes.snapshot()).toEqual({
          scopes: 0,
          identities: 0,
          intervals: 0,
        });
    },
  );

  it.each(['disabled', 'failed'] as const)(
    'retains an exact missing head when selected-chat expansion is %s',
    async (mode) => {
      const fixture = createService({
        systemMode: mode === 'disabled' ? 'degrade' : 'normal',
        selectedChatQueryError:
          mode === 'failed' ? new Error('bounded expansion timeout') : undefined,
        findManyResult: [0, 1].map((index) => ({
          id: `deferred-head-${index}`,
          enqueueAttempts: 0,
          createdAt: new Date(1_770_000_000_000 + index),
          normalizedPayload: {
            type: 'message_created',
            botId: 'same-bot',
            message: { chatId: 'deferred-head-chat', messageId: `message-${index}` },
          },
        })),
      });
      const internal = fixture.service as unknown as {
        enqueueBatch(): Promise<void>;
        deferredEnqueueScopes: DeferredWebhookScopes;
        pendingEnqueueRepresentatives: Map<string, string>;
      };
      const original = fixture.prisma.$queryRaw.getMockImplementation()!;
      fixture.prisma.$queryRaw.mockImplementation(async (query) => {
        if (extractSql(query).includes('fair_enqueue_candidates'))
          return [{ ...fixture.webhookRows[1]!, isBacklogScan: true }];
        return original(query);
      });
      await internal.enqueueBatch();
      expect(fixture.webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
      expect(internal.pendingEnqueueRepresentatives.size).toBe(0);
      expect(internal.deferredEnqueueScopes.snapshot()).toEqual({
        scopes: 1,
        identities: 0,
        intervals: 1,
      });
      await internal.enqueueBatch();
      expect(fixture.webhookService.preparePersistedWebhookEvent.mock.calls[0]?.[0]).toBe(
        'deferred-head-0',
      );
    },
  );

  it.each([
    ['another bot', 'bot-b', 'message_created', 'ordinary'],
    ['same-bot lifecycle', 'bot-a', 'bot_removed', 'lifecycle'],
    ['same-bot Start', 'bot-a', 'message_created', 'Старт'],
  ])(
    'preserves admission identity for %s while ordinary preparation is blocked',
    async (_label, botId, type, text) => {
      const first = {
        updateId: 'scope-a',
        botId: 'bot-a',
        type: 'message_created',
        message: { chatId: 'scope-chat-a', messageId: 'scope-message-a', text: 'ordinary' },
      };
      const second = {
        updateId: 'scope-b',
        botId,
        type,
        message: { chatId: 'scope-chat-b', messageId: 'scope-message-b', text },
      };
      const fixture = createService({
        findManyResult: [
          { id: 'scope-a', enqueueAttempts: 0, normalizedPayload: first },
          { id: 'scope-b', enqueueAttempts: 0, normalizedPayload: second },
        ],
      });
      const admission = new WebhookPreparationAdmission(4, jest.fn());
      const realBoundary = Object.create(WebhookService.prototype) as WebhookService;
      Object.defineProperty(realBoundary, 'preparationAdmission', { value: admission });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started: string[] = [];
      Object.defineProperty(realBoundary, 'preparePersistedWebhookEventAdmitted', {
        value: async (id: string) => {
          started.push(id);
          await gate;
          return {
            canonical: true,
            prepared: true,
            normalizedPayload: id === 'scope-a' ? first : second,
            executionBotId: null,
            enforced: false,
          };
        },
      });
      fixture.webhookService.preparePersistedWebhookEvent.mockImplementation((...args) =>
        realBoundary.preparePersistedWebhookEvent(...args),
      );
      fixture.webhookService.canPreparePersistedWebhookEvent.mockImplementation((update) =>
        realBoundary.canPreparePersistedWebhookEvent(update),
      );
      fixture.webhookService.webhookPreparationSchedulingState.mockImplementation((update) =>
        realBoundary.webhookPreparationSchedulingState(update),
      );
      fixture.webhookService.nextPreparationCompletion.mockImplementation(() =>
        realBoundary.nextPreparationCompletion(),
      );
      const work = (fixture.service as unknown as { enqueueBatch(): Promise<void> }).enqueueBatch();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const startedBeforeRelease = [...started];
      const active = admission.snapshot();
      release();
      await work;
      expect(startedBeforeRelease.sort()).toEqual(['scope-a', 'scope-b']);
      expect(active).toMatchObject({ inFlight: 2, pending: 0 });
      expect(admission.snapshot().inFlight).toBe(0);
      expect(
        fixture.prisma.webhookEvent.updateMany.mock.calls.some(([args]) =>
          args.data.errorMessage?.includes('preparation'),
        ),
      ).toBe(false);
    },
  );
  it('retains a privacy-safe failure diagnostic only after its retry state commits', async () => {
    const fixture = createService({
      findManyResult: [{ id: 'private-event', enqueueAttempts: 0 }],
    });
    const error = Object.assign(new Error('private-payload'), { code: 'P2003' });
    fixture.webhookService.preparePersistedWebhookEvent.mockRejectedValue(error);
    const warning = jest.spyOn((fixture.service as any).logger, 'warn').mockImplementation();
    const enqueueBatch = () =>
      (fixture.service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();
    try {
      await enqueueBatch();
      expect(warning).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: 'P2003',
          enqueueAttempts: 1,
          retryScheduled: true,
          retryDelaySec: 2,
        }),
        'Recorded webhook preparation failure',
      );
      expect(JSON.stringify(warning.mock.calls)).not.toMatch(/private-/u);
      warning.mockClear();
      fixture.prisma.webhookEvent.updateMany.mockResolvedValue({ count: 0 });
      await enqueueBatch();
      expect(warning).not.toHaveBeenCalledWith(
        expect.anything(),
        'Recorded webhook preparation failure',
      );
    } finally {
      warning.mockRestore();
    }
  });

  it('keeps preparation deferrals durable beyond the ordinary attempt ceiling', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-24T00:00:00.000Z'));
    try {
      const fixture = createService({
        findManyResult: [
          {
            id: 'evt-non-exhausting-publisher-defer',
            enqueueAttempts: 120,
            normalizedPayload: {
              updateId: 'publisher-update-1',
              botId: 'publik-bot',
              type: 'message_created',
              message: {
                chatId: 'chat-publisher-defer',
                messageId: 'message-publisher-defer',
                senderId: 'admin-1',
              },
            },
          },
        ],
      });
      fixture.prisma.webhookEvent.updateMany.mockImplementation(
        createWebhookEventUpdateManyMock(fixture.webhookRows),
      );
      fixture.webhookService.preparePersistedWebhookEvent.mockRejectedValue(
        new WebhookPreparationDeferredError('publisher durable enqueue pending', 1_000),
      );
      const row = fixture.webhookRows[0]!;

      for (let attempt = 0; attempt < 121; attempt += 1) {
        await (fixture.service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();
        expect(row.status).toBe(WebhookStatus.RECEIVED);
        expect(row.enqueueAttempts).toBe(120);
        expect(row.nextEnqueueAt).toBeInstanceOf(Date);
        jest.setSystemTime(new Date(row.nextEnqueueAt!.getTime() + 1));
      }

      expect(row.errorMessage).toContain('Webhook preparation deferred');
      expect(row.processedAt).toBeNull();
      for (const queue of Object.values(fixture.queues)) {
        expect(queue.add).not.toHaveBeenCalled();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('backs off an unprepared canonical mirror without consuming enqueue attempts', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-02T08:00:00.000Z'));
    try {
      const fixture = createService({
        findManyResult: [
          {
            id: 'evt-canonical-preparation-pending',
            enqueueAttempts: 17,
            normalizedPayload: {
              updateId: 'update-canonical-preparation-pending',
              botId: 'bot-mirror',
              type: 'user_removed',
              message: {
                chatId: 'chat-canonical-preparation-pending',
                messageId: 'user_removed:update-canonical-preparation-pending',
                senderId: 'user-1',
              },
            },
          },
        ],
      });
      fixture.prisma.webhookEvent.updateMany.mockImplementation(
        createWebhookEventUpdateManyMock(fixture.webhookRows),
      );
      fixture.webhookService.preparePersistedWebhookEvent.mockResolvedValue({
        canonical: true,
        prepared: false,
        normalizedPayload: fixture.webhookRows[0]!.normalizedPayload,
        executionBotId: 'bot-owner',
      });
      const row = fixture.webhookRows[0]!;

      await (fixture.service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

      expect(row.status).toBe(WebhookStatus.RECEIVED);
      expect(row.enqueueAttempts).toBe(17);
      expect(row.nextEnqueueAt).toEqual(new Date('2026-09-02T08:00:01.000Z'));
      expect(row.errorMessage).toContain('canonical webhook preparation is still pending');
      expect(fixture.webhookService.preparePersistedWebhookEvent).toHaveBeenCalledTimes(1);

      await (fixture.service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

      expect(fixture.webhookService.preparePersistedWebhookEvent).toHaveBeenCalledTimes(1);
      for (const queue of Object.values(fixture.queues)) {
        expect(queue.add).not.toHaveBeenCalled();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('requests FAILED candidates when due or when a completed timeout claim needs repair', async () => {
    const { service, prisma } = createService();

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const selectionSql = extractSql(prisma.$queryRaw.mock.calls[0]![0] as SqlQuery);
    expect(selectionSql).toContain(`SELECT DISTINCT ON ("work_unit_key") bounded_pool.*`);
    expect(selectionSql).toContain(`THEN CONCAT('chat:',`);
    expect(selectionSql).toContain(`ELSE CONCAT('event:', "webhook_events"."id")`);
    expect(selectionSql).not.toContain('LEFT JOIN LATERAL');
    expect(selectionSql).not.toContain('ordered_chat_head_event');
    expect(selectionSql).toContain(`"status" = 'FAILED'::"WebhookStatus"`);
    expect(selectionSql).toContain(`"next_enqueue_at" <= ?`);
    expect(selectionSql).toContain(`FROM "webhook_execution_claims"`);
    expect(selectionSql).toContain(`"kind" = 'EXECUTION'`);
    expect(selectionSql).toContain(`"status" = 'COMPLETED'::"WebhookExecutionClaimStatus"`);
    expect(selectionSql).toContain(`FROM "webhook_execution_claims" semantic_claim`);
    expect(selectionSql).toContain(`JOIN "webhook_events" semantic_owner`);
    expect(selectionSql).toContain(`semantic_claim."webhook_event_id" <> "webhook_events"."id"`);
    expect(selectionSql).toContain(`semantic_claim."prepared_at" IS NOT NULL`);
    expect(selectionSql).toContain(`semantic_claim."completed_at" IS NOT NULL`);
    expect(selectionSql).toContain(`semantic_claim."lease_token" IS NULL`);
    expect(selectionSql).toContain(`semantic_owner."status" = 'PROCESSED'::"WebhookStatus"`);
    const failedCandidatesIndex = selectionSql.indexOf(`failed_candidates AS (`);
    const staleQueuedCandidatesIndex = selectionSql.indexOf(
      `stale_user_facing_queued_candidates AS (`,
    );
    const failedCandidatesSql = selectionSql.slice(
      failedCandidatesIndex,
      staleQueuedCandidatesIndex,
    );
    const semanticOwnerPredicateIndex = failedCandidatesSql.indexOf(
      `FROM "webhook_execution_claims" semantic_claim`,
    );
    const failedCandidatesLimitIndex = failedCandidatesSql.indexOf(`LIMIT ?`);
    expect(failedCandidatesIndex).toBeGreaterThanOrEqual(0);
    expect(staleQueuedCandidatesIndex).toBeGreaterThan(failedCandidatesIndex);
    expect(semanticOwnerPredicateIndex).toBeGreaterThanOrEqual(0);
    expect(failedCandidatesLimitIndex).toBeLessThan(semanticOwnerPredicateIndex);
    expect(selectionSql).toContain(`"webhook_events"."normalized_payload"->'message'->>'chat_id'`);
    expect(selectionSql).toContain(
      `"webhook_events"."normalized_payload"->'message'->>'message_id'`,
    );
  });

  it('uses queuedAt as the stale reference and falls back to createdAt only when it is missing', async () => {
    const { service, prisma } = createService();

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const selectionSql = extractSql(prisma.$queryRaw.mock.calls[0]![0] as SqlQuery);
    expect(selectionSql).toContain(`"status" = 'QUEUED'::"WebhookStatus"`);
    expect(selectionSql).toContain(`"processed_at" IS NULL`);
    expect(selectionSql).toContain(
      `"queued_at" <= ? OR ("queued_at" IS NULL AND "created_at" <= ?)`,
    );
  });

  it('does not repeatedly repair a newly queued old event', async () => {
    const { service, queues, prisma } = createService({
      findManyResult: [
        {
          id: 'evt-old-but-freshly-queued',
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-default-0',
          createdAt: new Date(Date.now() - 60 * 60 * 1_000),
          queuedAt: new Date(),
          enqueueAttempts: 1,
          normalizedPayload: { type: 'message_created', message: { chatId: 'chat-1' } },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues['moderation-default-0'].add).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
  });

  it('reserves enqueue capacity for received events while repairing an old queue backlog', async () => {
    const receivedRows = Array.from({ length: 12 }, (_, index) => ({
      id: `evt-received-${index}`,
      status: WebhookStatus.RECEIVED,
      enqueueAttempts: 0,
      createdAt: new Date(Date.now() - (4 - index) * 1_000),
      normalizedPayload: {
        updateId: `received-${index}`,
        type: 'message_created',
        message: { chatId: `received-chat-${index}`, messageId: `received-message-${index}` },
      },
    }));
    const staleQueuedRows = Array.from({ length: 16 }, (_, index) => ({
      id: `evt-stale-${index}`,
      status: WebhookStatus.QUEUED,
      queueName: 'moderation-default-0',
      enqueueAttempts: 1,
      createdAt: new Date(Date.now() - (60 + index) * 1_000),
      queuedAt: new Date(Date.now() - 30_000),
      normalizedPayload: {
        updateId: `stale-${index}`,
        type: 'message_callback',
      },
    }));
    const { service, queues } = createService({
      findManyResult: [...receivedRows, ...staleQueuedRows],
      configOverrides: { ENQUEUE_BATCH_SIZE: 4 },
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const enqueuedIds = Object.values(queues).flatMap((queue) =>
      queue.add.mock.calls.map((call) => call[1].webhookEventId),
    );
    expect(enqueuedIds).toHaveLength(4);
    expect(enqueuedIds.filter((id) => id.startsWith('evt-received-'))).toHaveLength(3);
    expect(enqueuedIds.filter((id) => id.startsWith('evt-stale-'))).toHaveLength(1);
    expect(enqueuedIds).toContain('evt-received-0');
    expect(enqueuedIds).toContain('evt-received-9');
  });

  it('does not let one ordered chat consume the raw window ahead of lifecycle events', async () => {
    const poisonChatId = 'chat-poison-window';
    const poisonQueueName = resolveDefaultWebhookQueueNameForChatId(poisonChatId);
    const baseCreatedAt = new Date('2026-03-24T00:00:00.000Z');
    const poisonRows = Array.from({ length: 4_000 }, (_, index) => ({
      id: `evt-poison-${String(index).padStart(4, '0')}`,
      enqueueAttempts: 0,
      createdAt: new Date(baseCreatedAt.getTime() + index * 1_000),
      normalizedPayload: {
        updateId: `update-poison-${index}`,
        type: 'message_created',
        message: { chatId: poisonChatId, messageId: `message-poison-${index}` },
      },
    }));
    const { service, queues, webhookService } = createService({
      configOverrides: { ENQUEUE_BATCH_SIZE: 100 },
      findManyResult: [
        ...poisonRows,
        {
          id: 'evt-user-removed-middle',
          enqueueAttempts: 0,
          createdAt: new Date(baseCreatedAt.getTime() + 4_000_500),
          normalizedPayload: {
            updateId: 'update-user-removed-middle',
            type: 'user_removed',
            chatId: 'lifecycle-chat',
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[poisonQueueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-poison-0000',
    ]);
    expect(queues.backgroundQueue.add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-user-removed-middle',
    ]);
    expect(
      webhookService.preparePersistedWebhookEvent.mock.calls.filter(([eventId]) =>
        eventId.startsWith('evt-poison-'),
      ),
    ).toEqual([['evt-poison-0000', undefined, expect.any(Object)]]);
  });

  it('reserves one bounded slot for membership-leave lifecycle work under distinct-chat load', async () => {
    const baseCreatedAt = new Date('2026-03-24T00:00:00.000Z');
    const messageRows = Array.from({ length: 8 }, (_, index) => ({
      id: `evt-distinct-chat-${index}`,
      enqueueAttempts: 0,
      createdAt: new Date(baseCreatedAt.getTime() + index * 1_000),
      normalizedPayload: {
        updateId: `update-distinct-chat-${index}`,
        type: 'message_created',
        message: { chatId: `distinct-chat-${index}`, messageId: `message-${index}` },
      },
    }));
    const { service, queues } = createService({
      configOverrides: { ENQUEUE_BATCH_SIZE: 4 },
      findManyResult: [
        ...messageRows,
        {
          id: 'evt-user-removed-reserved',
          enqueueAttempts: 0,
          createdAt: new Date(baseCreatedAt.getTime() + 30_000),
          normalizedPayload: {
            updateId: 'update-user-removed-reserved',
            type: 'user_removed',
            chatId: 'lifecycle-reserved-chat',
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const enqueuedIds = Object.values(queues).flatMap((queue) =>
      queue.add.mock.calls.map((call) => call[1].webhookEventId),
    );
    expect(enqueuedIds).toHaveLength(4);
    expect(enqueuedIds).toContain('evt-user-removed-reserved');
    expect(enqueuedIds.filter((id) => id.startsWith('evt-distinct-chat-'))).toHaveLength(3);
  });

  it('falls back to selected heads when optional chat expansion fails', async () => {
    const { service, prisma, queues } = createService({
      selectedChatQueryError: new Error('selected chat expansion timed out'),
      findManyResult: [
        {
          id: 'evt-expansion-fallback-head',
          enqueueAttempts: 0,
          normalizedPayload: {
            updateId: 'update-expansion-fallback-head',
            type: 'message_created',
            message: { chatId: 'expansion-fallback-chat', messageId: 'message-1' },
          },
        },
      ],
    });
    const warning = jest.spyOn((service as any).logger, 'warn').mockImplementation();

    try {
      await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        maxWait: 1_000,
        timeout: 2_000,
      });
      expect(
        prisma.$executeRaw.mock.calls.some(([query]) =>
          extractSql(query).includes("SET LOCAL statement_timeout = '1000ms'"),
        ),
      ).toBe(true);
      expect(
        Object.values(queues).flatMap((queue) =>
          queue.add.mock.calls.map((call) => call[1].webhookEventId),
        ),
      ).toEqual(['evt-expansion-fallback-head']);
      expect(warning).toHaveBeenCalledWith(
        expect.objectContaining({
          err: 'selected chat expansion timed out',
          selectedCandidateCount: 1,
          selectedChatCount: 1,
        }),
        'Failed to expand selected webhook chats; enqueueing the selected heads only',
      );
    } finally {
      warning.mockRestore();
    }
  });

  it('repairs stale queued user-facing rows after the fast repair window', async () => {
    const { service, queues } = createService({
      findManyResult: [
        {
          id: 'evt-fast-default',
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-default-0',
          queuedAt: new Date(Date.now() - 30_000),
          createdAt: new Date(Date.now() - 30_000),
          enqueueAttempts: 1,
          normalizedPayload: { type: 'message_created', message: { chatId: 'chat-1' } },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues['moderation-default-0'].add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-fast-default' },
      expect.objectContaining({
        jobId: 'evt-fast-default',
        removeOnComplete: true,
        removeOnFail: {
          age: 7 * 24 * 60 * 60,
          count: 5_000,
        },
      }),
    );
  });

  it('does not repair queued background rows before the slower background repair window', async () => {
    const { service, queues, prisma } = createService({
      findManyResult: [
        {
          id: 'evt-background-too-fresh',
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-background',
          queuedAt: new Date(Date.now() - 30_000),
          createdAt: new Date(Date.now() - 30_000),
          enqueueAttempts: 1,
          normalizedPayload: { type: 'user_removed', chatId: 'chat-1' },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues.backgroundQueue.add).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
  });

  it('uses bounded fresh-receipt admission and throttles queued repair while system mode degrades', async () => {
    const receivedRows = Array.from({ length: 120 }, (_, index) => ({
      id: `evt-degraded-received-${index}`,
      enqueueAttempts: 0,
      createdAt: new Date(Date.now() - (120 - index) * 1_000),
      normalizedPayload: {
        updateId: `degraded-received-${index}`,
        type: 'message_created',
        message: { chatId: `degraded-chat-${index}`, messageId: `degraded-message-${index}` },
      },
    }));
    const { service, queues, prisma, systemModeService } = createService({
      systemMode: 'degrade',
      configOverrides: { ENQUEUE_BATCH_SIZE: 200, ENQUEUE_CONCURRENCY: 25 },
      findManyResult: [
        ...receivedRows,
        {
          id: 'evt-degraded-stale-queued',
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-default-0',
          enqueueAttempts: 1,
          queuedAt: new Date(Date.now() - 30_000),
          createdAt: new Date(Date.now() - 30_000),
          normalizedPayload: {
            updateId: 'degraded-stale-queued',
            type: 'message_created',
            message: { chatId: 'degraded-stale-chat', messageId: 'degraded-stale-message' },
          },
        },
      ],
    });

    const firstAdmission = await (
      service as unknown as EnqueueAdmissionInternals
    ).resolveEnqueueAdmission(new Date());
    expect(firstAdmission.includeQueuedRepair).toBe(true);
    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const enqueuedIds = Object.values(queues).flatMap((queue) =>
      queue.add.mock.calls.map((call) => call[1].webhookEventId),
    );
    expect(enqueuedIds).toHaveLength(100);
    expect(enqueuedIds).not.toContain('evt-degraded-stale-queued');
    expect(systemModeService.getEffectiveSnapshot).toHaveBeenCalledTimes(1);
    const selectionQuery = prisma.$queryRaw.mock.calls
      .map(([query]) => query as SqlQuery)
      .find((query) => extractSql(query).includes('fair_enqueue_candidates'));
    if (!selectionQuery) {
      throw new Error('Expected a webhook enqueue selection query');
    }
    const selectionSql = extractSql(selectionQuery);
    expect(selectionSql).toContain('stale_user_facing_queued_candidates AS ( SELECT');
    expect(selectionSql).toContain('stale_background_queued_candidates AS ( SELECT');
    expect(selectionSql).toContain('WHERE FALSE');
    expect((prisma.$queryRaw.mock.calls[0]![0] as SqlQuery).values).toContain(1_000);
    expect((prisma.$queryRaw.mock.calls[0]![0] as SqlQuery).values).not.toContain(5_000);
    expect(
      prisma.$queryRaw.mock.calls.some(([query]) =>
        extractSql(query as SqlQuery).includes('selected_chat_candidates'),
      ),
    ).toBe(false);
  });

  it('caches degraded admission, preserves it across a mode read failure, and spaces queued repair', async () => {
    const { service, systemModeService } = createService({ systemMode: 'degrade' });
    const internals = service as unknown as EnqueueAdmissionInternals;
    const startedAt = new Date('2026-03-24T00:00:10.000Z');

    const initial = await internals.resolveEnqueueAdmission(startedAt);
    const cached = await internals.resolveEnqueueAdmission(new Date(startedAt.getTime() + 1_000));
    systemModeService.getEffectiveSnapshot.mockResolvedValueOnce({ mode: 'normal' });
    systemModeService.peekCachedSnapshot.mockReturnValueOnce(null);
    const afterReadFailure = await internals.resolveEnqueueAdmission(
      new Date(startedAt.getTime() + 6_000),
    );

    expect(initial).toMatchObject({
      batchSize: 100,
      enqueueConcurrency: 4,
      includeQueuedRepair: true,
    });
    expect(cached).toMatchObject({ includeQueuedRepair: false });
    expect(afterReadFailure).toMatchObject({
      batchSize: 100,
      enqueueConcurrency: 4,
      includeQueuedRepair: true,
    });
    expect(systemModeService.getEffectiveSnapshot).toHaveBeenCalledTimes(2);
  });

  it.each([
    { source: 'auto', manualMode: null, condition: 'queue_backlog', expected: [400, 32] },
    { source: 'manual', manualMode: 'degrade', condition: 'queue_backlog', expected: [100, 4] },
    { source: 'auto', manualMode: 'degrade', condition: 'queue_backlog', expected: [100, 4] },
    { source: undefined, manualMode: null, condition: 'queue_backlog', expected: [100, 4] },
    { source: 'auto', manualMode: null, condition: 'mixed', expected: [100, 4] },
    { source: 'auto', manualMode: null, condition: 'max_api', expected: [100, 4] },
    { source: 'auto', manualMode: null, condition: 'unknown', expected: [100, 4] },
  ])(
    'isolates automatic queue lag while preserving $source/$condition admission authority',
    async ({ expected, ...snapshot }) => {
      const { service, systemModeService } = createService({
        systemMode: 'degrade',
        configOverrides: { ENQUEUE_BATCH_SIZE: 400, ENQUEUE_CONCURRENCY: 32 },
      });
      systemModeService.peekCachedSnapshot.mockReturnValueOnce({ mode: 'degrade', ...snapshot });
      await expect(
        (service as unknown as EnqueueAdmissionInternals).resolveEnqueueAdmission(new Date()),
      ).resolves.toMatchObject({ batchSize: expected[0], enqueueConcurrency: expected[1] });
    },
  );

  it('does not raise configured enqueue limits while system mode degrades', async () => {
    const { service } = createService({
      systemMode: 'degrade',
      configOverrides: { ENQUEUE_BATCH_SIZE: 50, ENQUEUE_CONCURRENCY: 3 },
    });

    await expect(
      (service as unknown as EnqueueAdmissionInternals).resolveEnqueueAdmission(new Date()),
    ).resolves.toMatchObject({
      batchSize: 50,
      enqueueConcurrency: 3,
    });
  });

  it.each(['normal', 'degrade'] as const)(
    'paces retained timeout scans without delaying due retries in %s mode',
    async (systemMode) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-14T09:00:00.000Z'));
      try {
        const { service, prisma, queues } = createService({
          systemMode,
          findManyResult: [
            {
              id: 'evt-due-retry',
              status: WebhookStatus.FAILED,
              enqueueAttempts: 1,
              nextEnqueueAt: new Date('2026-09-14T09:00:00.000Z'),
              normalizedPayload: {
                type: 'message_created',
                message: { chatId: 'due-retry-chat', messageId: 'due-retry-message' },
              },
            },
          ],
        });
        const internals = service as unknown as { enqueueBatch: () => Promise<void> };
        const selectionQueries = () =>
          prisma.$queryRaw.mock.calls
            .map(([query]) => extractSql(query))
            .filter((sql) => sql.includes('fair_enqueue_candidates'));

        await internals.enqueueBatch();
        expect(selectionQueries().at(-1)).toContain('semantic_owner');
        prisma.$queryRaw.mockClear();
        for (const queue of Object.values(queues)) queue.add.mockClear();

        jest.setSystemTime(new Date('2026-09-14T09:00:00.200Z'));
        await internals.enqueueBatch();

        expect(selectionQueries().at(-1)).toContain(`"next_enqueue_at" <= ?`);
        for (const [query] of prisma.$queryRaw.mock.calls) {
          const sql = extractSql(query);
          expect(sql).not.toContain('semantic_owner');
          if (sql.includes('finished_ordered_head_proofs')) {
            expect(sql).toContain('WHERE "id" = requested_heads."id"');
            expect(sql).toContain('"semantic_key" = head."semantic_key"');
            expect(sql).toContain('OFFSET 0');
            expect((query as SqlQuery).values).toContain('evt-due-retry');
          } else {
            expect(sql).not.toContain('webhook_execution_claims');
          }
        }
        expect(
          prisma.$queryRaw.mock.calls.filter(([query]) =>
            extractSql(query).includes('finished_ordered_head_proofs'),
          ),
        ).toHaveLength(0);
        expect(Object.values(queues).flatMap((queue) => queue.add.mock.calls)).toHaveLength(1);

        jest.setSystemTime(new Date('2026-09-14T09:00:05.000Z'));
        await internals.enqueueBatch();
        expect(selectionQueries().at(-1)).toContain('semantic_owner');
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    'leaves a full retry-free interval after slow timeout selection (failed=%s)',
    async (failed) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-14T09:00:00.000Z'));
      try {
        const { service, prisma } = createService({ systemMode: 'degrade' });
        const internals = service as unknown as { enqueueBatch: () => Promise<void> };
        prisma.$queryRaw.mockImplementationOnce(async () => {
          jest.setSystemTime(Date.now() + 6_000);
          if (failed) throw new Error('slow selection failed');
          return [];
        });
        if (failed) await expect(internals.enqueueBatch()).rejects.toThrow('slow selection failed');
        else await internals.enqueueBatch();
        expect(extractSql(prisma.$queryRaw.mock.calls[0]![0])).toContain('semantic_owner');
        prisma.$queryRaw.mockClear();

        jest.setSystemTime(Date.now() + 200);
        await internals.enqueueBatch();
        expect(extractSql(prisma.$queryRaw.mock.calls[0]![0])).not.toContain('semantic_owner');
        expect(extractSql(prisma.$queryRaw.mock.calls[0]![0])).toContain('"next_enqueue_at" <= ?');

        prisma.$queryRaw.mockClear();
        jest.setSystemTime(new Date('2026-09-14T09:00:11.000Z'));
        await internals.enqueueBatch();
        expect(extractSql(prisma.$queryRaw.mock.calls[0]![0])).toContain('semantic_owner');
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('reports slow enqueue stages with bounded identifier-free logging', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-14T09:00:00.000Z'));
    const { service, prisma } = createService();
    const warning = jest.spyOn((service as any).logger, 'warn').mockImplementation();
    try {
      prisma.$queryRaw.mockImplementation(async () => {
        jest.setSystemTime(Date.now() + 1_100);
        return [];
      });
      const internals = service as unknown as { enqueueBatch: () => Promise<void> };

      await internals.enqueueBatch();
      await internals.enqueueBatch();
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        {
          durationMs: 1_100,
          admissionMs: 0,
          selectionMs: 1_100,
          prioritizationMs: 0,
          enqueueMs: 0,
          candidateCount: 0,
          selectedCount: 0,
          degraded: false,
          completedTimeoutRepair: true,
          inFlightWorkUnits: 0,
          progress: {
            workUnits: 0,
            orderedHeadBlocked: 0,
            preparationBlocked: 0,
            preparationSharedCapacityBlocked: 0,
            preparationScopeBlocked: 0,
            prepared: 0,
            settled: 0,
            outstanding: 0,
            enqueueBlocked: 0,
            workUnitErrors: 0,
            quarantined: 0,
          },
        },
        'Slow webhook enqueue batch',
      );

      jest.setSystemTime(Date.now() + 30_000);
      await internals.enqueueBatch();
      expect(warning).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
      jest.useRealTimers();
    }
  });

  it('skips BullMQ lookups before activating a pristine received event', async () => {
    const chatId = 'chat-pristine-received';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, queues } = createService({
      findManyResult: [
        {
          id: 'evt-pristine-received',
          status: WebhookStatus.RECEIVED,
          queueName: null,
          enqueueAttempts: 0,
          queuedAt: null,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
          errorMessage: null,
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-pristine-received' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    for (const queue of Object.values(queues)) {
      expect(queue.getJob).not.toHaveBeenCalled();
    }
    expect(queues[queueName].add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-pristine-received' },
      expect.objectContaining({ jobId: 'evt-pristine-received' }),
    );
  });

  it('does not scan every BullMQ queue for pristine receipts settled during preparation', async () => {
    const { service, queues, webhookService } = createService({
      systemMode: 'degrade',
      findManyResult: Array.from({ length: 100 }, (_, index) => ({
        id: `evt-pristine-mirror-${index}`,
        enqueueAttempts: 0,
        normalizedPayload: { type: 'user_removed', chatId: `mirror-chat-${index}` },
      })),
      prepareResult: {
        canonical: false,
        prepared: true,
        normalizedPayload: {},
        executionBotId: 'owner-bot',
      },
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(webhookService.preparePersistedWebhookEvent).toHaveBeenCalledTimes(100);
    for (const queue of Object.values(queues)) {
      expect(queue.getJob).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    }
  });

  it.each(['waiting', 'active'])(
    'still reconciles a previously queued non-canonical receipt whose job is %s',
    async (state) => {
      const job: JobMock = {
        getState: jest.fn().mockResolvedValue(state),
        retry: jest.fn(),
        remove: jest.fn().mockResolvedValue(undefined),
      };
      const { service, queues } = createService({
        backgroundJob: job,
        findManyResult: [
          {
            id: 'evt-queued-mirror',
            status: WebhookStatus.QUEUED,
            queueName: 'moderation-background',
            enqueueAttempts: 1,
            queuedAt: new Date('2026-03-24T00:00:00.000Z'),
            normalizedPayload: { type: 'user_removed', chatId: 'queued-mirror-chat' },
          },
        ],
        prepareResult: {
          canonical: false,
          prepared: true,
          normalizedPayload: {},
          executionBotId: 'owner-bot',
        },
      });

      await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

      expect(queues.backgroundQueue.getJob).toHaveBeenCalledWith('evt-queued-mirror');
      expect(job.getState).toHaveBeenCalled();
      expect(job.remove).toHaveBeenCalledTimes(state === 'active' ? 0 : 1);
      for (const queue of Object.values(queues)) {
        expect(queue.add).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    {
      caseName: 'a prior enqueue attempt',
      patch: { enqueueAttempts: 1 },
    },
    {
      caseName: 'a stored queue',
      patch: { queueName: 'moderation-default-0' },
    },
    {
      caseName: 'a prior queued timestamp',
      patch: { queuedAt: new Date('2026-03-24T00:00:00.000Z') },
    },
    {
      caseName: 'a due retry timestamp',
      patch: { nextEnqueueAt: new Date('2026-03-24T00:00:00.000Z') },
    },
    {
      caseName: 'a prior enqueue error',
      patch: { errorMessage: 'prior enqueue failure' },
    },
    {
      caseName: 'a timeout quarantine timestamp',
      patch: { timeoutQuarantineExpiresAt: new Date('2026-03-24T00:00:00.000Z') },
    },
    {
      caseName: 'queued recovery state',
      patch: {
        status: WebhookStatus.QUEUED,
        queueName: 'moderation-default-0',
        enqueueAttempts: 1,
        queuedAt: new Date('2026-03-24T00:00:00.000Z'),
      },
    },
    {
      caseName: 'failed recovery state',
      patch: {
        status: WebhookStatus.FAILED,
        enqueueAttempts: 1,
        nextEnqueueAt: new Date('2026-03-24T00:00:00.000Z'),
        errorMessage: 'retryable enqueue failure',
      },
    },
  ])('keeps BullMQ reconciliation when $caseName is present', async ({ caseName, patch }) => {
    const { service, queues } = createService();
    const event = {
      id: `evt-recovery-${caseName.replaceAll(' ', '-')}`,
      status: WebhookStatus.RECEIVED,
      botId: null,
      queueName: null,
      enqueueAttempts: 0,
      createdAt: new Date('2026-03-24T00:00:01.000Z'),
      queuedAt: null,
      nextEnqueueAt: null,
      timeoutQuarantineExpiresAt: null,
      errorMessage: null,
      normalizedPayload: { type: 'message_created', message: { chatId: 'chat-recovery' } },
      ...patch,
    };

    await (
      service as unknown as {
        enqueueOne: (
          candidate: typeof event,
          priority: number,
          queueName: 'moderation-default-0',
        ) => Promise<unknown>;
      }
    ).enqueueOne(event, 5, 'moderation-default-0');

    expect(queues['moderation-default-0'].getJob).toHaveBeenCalledWith(event.id);
  });

  it('does not increment attempts when existing job is already waiting', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('waiting'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const { service, prisma } = createService({
      findManyResult: [{ id: 'evt-1', enqueueAttempts: 5 }],
      addError: new Error('Job evt-1 already exists'),
      defaultJob: job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const updateArg = prisma.webhookEvent.updateMany.mock.calls[0][0];
    expect(updateArg.data.status).toBe(WebhookStatus.QUEUED);
    expect(updateArg.data.queuedAt).toBeInstanceOf(Date);
    expect(updateArg.data.enqueueAttempts).toBeUndefined();
    expect(job.retry).not.toHaveBeenCalled();
  });

  it('does not refresh queuedAt when reconciling an already queued waiting job', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('waiting'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const { service, prisma } = createService({
      findManyResult: [
        {
          id: 'evt-queued-waiting',
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-default-0',
          queuedAt: new Date('2026-03-24T00:00:00.000Z'),
          enqueueAttempts: 5,
        },
      ],
      defaultJob: job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const updateArg = prisma.webhookEvent.updateMany.mock.calls[0][0];
    expect(updateArg.data.status).toBe(WebhookStatus.QUEUED);
    expect(updateArg.data.queuedAt).toBeUndefined();
    expect(updateArg.data.enqueueAttempts).toBeUndefined();
  });

  it('backs off repeated observation of an already queued delayed job', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-24T00:01:00.000Z'));
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('delayed'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const { service, prisma } = createService({
      findManyResult: [
        {
          id: 'evt-queued-delayed',
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-default-0',
          queuedAt: new Date('2026-03-24T00:00:00.000Z'),
          enqueueAttempts: 5,
        },
      ],
      defaultJob: job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const updateArg = prisma.webhookEvent.updateMany.mock.calls[0][0];
    expect(updateArg.data.status).toBe(WebhookStatus.QUEUED);
    expect(updateArg.data.queuedAt).toBeUndefined();
    expect(updateArg.data.nextEnqueueAt).toEqual(new Date('2026-03-24T00:01:20.000Z'));
    expect(updateArg.data.enqueueAttempts).toBeUndefined();
  });

  it('does not observe a delayed job again before its bounded backoff expires', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-24T00:01:00.000Z'));
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('delayed'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const { service, queues, prisma } = createService({
      findManyResult: [
        {
          id: 'evt-delayed-backoff',
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-default-0',
          queuedAt: new Date('2026-03-24T00:00:00.000Z'),
          nextEnqueueAt: new Date('2026-03-24T00:01:20.000Z'),
          enqueueAttempts: 5,
        },
      ],
      defaultJob: job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues['moderation-default-0'].getJob).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
  });

  it('repairs a missing delayed job after its observation backoff expires', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-24T00:01:21.000Z'));
    const { service, queues } = createService({
      findManyResult: [
        {
          id: 'evt-delayed-missing-after-backoff',
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-default-0',
          queuedAt: new Date('2026-03-24T00:00:00.000Z'),
          nextEnqueueAt: new Date('2026-03-24T00:01:20.000Z'),
          enqueueAttempts: 5,
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues['moderation-default-0'].getJob).toHaveBeenCalledWith(
      'evt-delayed-missing-after-backoff',
    );
    expect(queues['moderation-default-0'].add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-delayed-missing-after-backoff' },
      expect.objectContaining({ jobId: 'evt-delayed-missing-after-backoff' }),
    );
  });

  it('re-enqueues a stale queued event back into its stored queue to preserve ordering', async () => {
    const { service, queues } = createService({
      findManyResult: [
        {
          id: 'evt-stale-critical',
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-critical',
          queuedAt: new Date('2026-03-24T00:00:00.000Z'),
          enqueueAttempts: 1,
          normalizedPayload: { type: 'message_created', message: { chatId: 'chat-1' } },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues.criticalQueue.add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-stale-critical' },
      expect.objectContaining({
        jobId: 'evt-stale-critical',
      }),
    );
    expect(queues['moderation-default-0'].add).not.toHaveBeenCalled();
  });

  it('does not let ordinary enqueue mark a freshly failed event as queued', async () => {
    const chatId = 'race-chat';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    let storedStatus: WebhookStatus = WebhookStatus.RECEIVED;
    const { service, prisma, queues } = createService({
      findManyResult: [
        {
          id: 'evt-failed-after-add',
          status: WebhookStatus.RECEIVED,
          enqueueAttempts: 0,
          normalizedPayload: { type: 'message_created', message: { chatId } },
        },
      ],
    });
    queues[queueName].add.mockImplementation(async () => {
      storedStatus = WebhookStatus.FAILED;
    });
    prisma.webhookEvent.updateMany.mockImplementation(
      createStatusAwareUpdateManyMock(
        'evt-failed-after-add',
        () => storedStatus,
        (status) => {
          storedStatus = status;
        },
      ),
    );

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[queueName].add).toHaveBeenCalledTimes(1);
    const updateArg = prisma.webhookEvent.updateMany.mock.calls[0][0];
    expect(updateArg.where.status).toBe(WebhookStatus.RECEIVED);
    expect(storedStatus).toBe(WebhookStatus.FAILED);
  });

  it('does not overwrite a terminal worker failure after enqueueing a due FAILED event', async () => {
    const chatId = 'failed-retry-cas-chat';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const retryAt = new Date(Date.now() - 1_000);
    const { service, prisma, queues, webhookRows } = createService({
      findManyResult: [
        {
          id: 'evt-failed-retry-cas',
          status: WebhookStatus.FAILED,
          queueName: null,
          enqueueAttempts: 5,
          nextEnqueueAt: retryAt,
          normalizedPayload: { type: 'message_created', message: { chatId } },
        },
      ],
    });
    const row = webhookRows[0]!;
    prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(webhookRows),
    );
    queues[queueName].add.mockImplementation(async () => {
      row.status = WebhookStatus.FAILED;
      row.nextEnqueueAt = null;
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: WebhookStatus.FAILED,
          enqueueAttempts: 5,
          nextEnqueueAt: retryAt,
        }),
        data: expect.objectContaining({ status: WebhookStatus.QUEUED }),
      }),
    );
    expect(prisma.webhookEvent.findUnique).not.toHaveBeenCalled();
    expect(row.status).toBe(WebhookStatus.FAILED);
    expect(row.nextEnqueueAt).toBeNull();
    expect(row.enqueueAttempts).toBe(6);
  });

  it('does not let a late enqueue error overwrite a terminal worker outcome', async () => {
    const chatId = 'late-enqueue-error-cas-chat';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, prisma, queues, webhookRows } = createService({
      findManyResult: [
        {
          id: 'evt-late-enqueue-error-cas',
          status: WebhookStatus.RECEIVED,
          enqueueAttempts: 0,
          normalizedPayload: { type: 'message_created', message: { chatId } },
        },
      ],
    });
    const row = webhookRows[0]!;
    prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(webhookRows),
    );
    queues[queueName].add.mockImplementation(async () => {
      row.status = WebhookStatus.FAILED;
      row.nextEnqueueAt = null;
      throw new Error('Redis connection closed after worker terminal failure');
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: WebhookStatus.QUEUED,
          queueName,
          enqueueAttempts: 1,
          queuedAt: expect.any(Date),
          nextEnqueueAt: null,
        }),
        data: expect.objectContaining({ status: WebhookStatus.FAILED }),
      }),
    );
    expect(prisma.webhookEvent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'evt-late-enqueue-error-cas' } }),
    );
    expect(row.status).toBe(WebhookStatus.FAILED);
    expect(row.queueName).toBe(queueName);
    expect(row.enqueueAttempts).toBe(1);
    expect(row.nextEnqueueAt).toBeNull();
  });

  it('lets only one concurrent poller activate an event across different shards', async () => {
    const chatId = 'concurrent-poller-claim-chat';
    const firstQueueName = DEFAULT_WEBHOOK_QUEUE_NAMES[0]!;
    const secondQueueName = DEFAULT_WEBHOOK_QUEUE_NAMES[1]!;
    const { service, prisma, queues, webhookRows, webhookRoutingService } = createService({
      findManyResult: [
        {
          id: 'evt-concurrent-poller-claim',
          status: WebhookStatus.RECEIVED,
          enqueueAttempts: 0,
          normalizedPayload: {
            updateId: 'update-concurrent-poller-claim',
            type: 'message_created',
            message: { chatId, messageId: 'message-concurrent-poller-claim' },
          },
        },
      ],
    });
    prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(webhookRows),
    );
    webhookRoutingService.resolveQueueName
      .mockResolvedValueOnce(firstQueueName)
      .mockResolvedValueOnce(secondQueueName);

    await Promise.all([
      (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch(),
      (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch(),
    ]);

    const queueAdds = [firstQueueName, secondQueueName].flatMap((queueName) =>
      queues[queueName].add.mock.calls.map((call) => ({
        queueName,
        webhookEventId: call[1].webhookEventId,
      })),
    );
    expect(queueAdds).toHaveLength(1);
    expect(queueAdds[0]?.webhookEventId).toBe('evt-concurrent-poller-claim');
    expect(webhookRows[0]?.status).toBe(WebhookStatus.QUEUED);
    expect(webhookRows[0]?.queueName).toBe(queueAdds[0]?.queueName);
    expect(webhookRows[0]?.enqueueAttempts).toBe(1);
  });

  it('retries existing failed job and increments attempts once', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const { service, prisma } = createService({
      findManyResult: [{ id: 'evt-2', enqueueAttempts: 5 }],
      addError: new Error('Job evt-2 already exists'),
      defaultJob: job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(job.retry).toHaveBeenCalledTimes(1);
    const updateArg = prisma.webhookEvent.updateMany.mock.calls[0][0];
    expect(updateArg.data.status).toBe(WebhookStatus.QUEUED);
    expect(updateArg.data.enqueueAttempts).toEqual({ increment: 1 });
  });

  it('allows explicit failed job retry to mark a failed event queued', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    let storedStatus: WebhookStatus = WebhookStatus.FAILED;
    const { service, prisma } = createService({
      findManyResult: [
        {
          id: 'evt-explicit-failed-retry',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 5,
          nextEnqueueAt: new Date(Date.now() - 1_000),
        },
      ],
      defaultJob: job,
    });
    prisma.webhookEvent.updateMany.mockImplementation(
      createStatusAwareUpdateManyMock(
        'evt-explicit-failed-retry',
        () => storedStatus,
        (status) => {
          storedStatus = status;
        },
      ),
    );

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(job.retry).toHaveBeenCalledTimes(1);
    const updateArg = prisma.webhookEvent.updateMany.mock.calls[0][0];
    expect(updateArg.where.status).toBe(WebhookStatus.FAILED);
    expect(storedStatus).toBe(WebhookStatus.QUEUED);
  });

  it('retries an existing failed job before attempting duplicate add', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const { service, prisma, queues } = createService({
      findManyResult: [{ id: 'evt-2b', enqueueAttempts: 5 }],
      defaultJob: job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues['moderation-default-0'].getJob).toHaveBeenCalledWith('evt-2b');
    expect(queues['moderation-default-0'].add).not.toHaveBeenCalled();
    expect(job.retry).toHaveBeenCalledTimes(1);
    const updateArg = prisma.webhookEvent.updateMany.mock.calls[0][0];
    expect(updateArg.data.status).toBe(WebhookStatus.QUEUED);
    expect(updateArg.data.enqueueAttempts).toEqual({ increment: 1 });
  });

  it('marks event as FAILED without re-enqueue when max attempts is reached', async () => {
    const { service, prisma, queues } = createService();

    await (
      service as unknown as {
        enqueueOne: (
          event: {
            id: string;
            status: WebhookStatus;
            botId: string | null;
            queueName: string | null;
            enqueueAttempts: number;
            createdAt: Date;
            queuedAt: Date | null;
            nextEnqueueAt: Date | null;
            normalizedPayload: unknown;
          },
          priority: number,
          queueName: 'moderation-default-0',
        ) => Promise<void>;
      }
    ).enqueueOne(
      {
        id: 'evt-3',
        status: WebhookStatus.RECEIVED,
        botId: null,
        queueName: null,
        enqueueAttempts: 120,
        createdAt: new Date('2026-03-24T00:00:00.000Z'),
        queuedAt: null,
        nextEnqueueAt: null,
        normalizedPayload: { type: 'message_created', message: { chatId: 'chat-1' } },
      },
      6,
      'moderation-default-0',
    );

    expect(queues['moderation-default-0'].add).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.FAILED,
          nextEnqueueAt: null,
        }),
      }),
    );
  });

  it('keeps a live queued job outstanding even when its enqueue attempt cap is reached', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('waiting'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const { service, prisma, queues } = createService({
      findManyResult: [
        {
          id: 'evt-max-attempt-live-job',
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-default-0',
          enqueueAttempts: 120,
          queuedAt: new Date('2026-03-24T00:00:00.000Z'),
        },
      ],
      defaultJob: job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(job.getState).toHaveBeenCalledTimes(1);
    expect(job.retry).not.toHaveBeenCalled();
    expect(queues['moderation-default-0'].add).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: WebhookStatus.QUEUED }),
      }),
    );
    expect(
      prisma.webhookEvent.updateMany.mock.calls.some(
        ([args]) => args.data.status === WebhookStatus.FAILED,
      ),
    ).toBe(false);
  });

  it('does not terminalize a stale exhausted snapshot after another poller queues it', async () => {
    const retryAt = new Date('2026-03-24T00:00:02.000Z');
    const { service, prisma, queues, webhookRows } = createService({
      findManyResult: [
        {
          id: 'evt-stale-exhausted-cas',
          status: WebhookStatus.FAILED,
          queueName: null,
          enqueueAttempts: 120,
          queuedAt: null,
          nextEnqueueAt: retryAt,
        },
      ],
    });
    const row = webhookRows[0]!;
    const staleSnapshot = { ...row };
    row.status = WebhookStatus.QUEUED;
    row.queueName = 'moderation-default-0';
    row.queuedAt = new Date('2026-03-24T00:00:03.000Z');
    row.nextEnqueueAt = null;
    row.enqueueAttempts = 121;
    prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(webhookRows),
    );

    const outcome = await (
      service as unknown as {
        enqueueOne: (
          event: typeof staleSnapshot,
          priority: number,
          queueName: 'moderation-default-0',
        ) => Promise<string>;
      }
    ).enqueueOne(staleSnapshot, 6, 'moderation-default-0');

    expect(outcome).toBe('outstanding');
    expect(queues['moderation-default-0'].add).not.toHaveBeenCalled();
    expect(row.status).toBe(WebhookStatus.QUEUED);
    expect(row.queueName).toBe('moderation-default-0');
    expect(row.enqueueAttempts).toBe(121);
  });

  it('preserves the terminal BullMQ failure reason when a failed job exhausts retries', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      failedReason: 'Request failed with status code 503',
    };
    const { service, prisma } = createService();

    await (
      service as unknown as {
        retryFailedJob: (
          event: {
            id: string;
            status: WebhookStatus;
            botId: string | null;
            queueName: string | null;
            enqueueAttempts: number;
            createdAt: Date;
            queuedAt: Date | null;
            nextEnqueueAt: Date | null;
            normalizedPayload: unknown;
          },
          job: JobMock,
        ) => Promise<void>;
      }
    ).retryFailedJob(
      {
        id: 'evt-terminal-503',
        status: WebhookStatus.FAILED,
        botId: null,
        queueName: 'moderation-default-0',
        enqueueAttempts: 120,
        createdAt: new Date('2026-03-24T00:00:00.000Z'),
        queuedAt: new Date('2026-03-24T00:00:01.000Z'),
        nextEnqueueAt: new Date('2026-03-24T00:00:02.000Z'),
        normalizedPayload: null,
      },
      job,
    );

    expect(job.retry).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.FAILED,
          nextEnqueueAt: null,
          errorMessage: expect.stringContaining('Request failed with status code 503'),
        }),
      }),
    );
  });

  it('starts an overdue poll after its active batch drains without waiting for another timer slot', async () => {
    jest.useFakeTimers();
    const { service } = createService({ configOverrides: { ENQUEUE_POLL_INTERVAL_MS: 200 } });
    (service as unknown as RetentionInternals).enabled = true;
    const starts: number[] = [];
    let active = 0;
    let peak = 0;
    const batch = jest.spyOn(service as any, 'enqueueBatch').mockImplementation(async () => {
      starts.push(Date.now());
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => setTimeout(resolve, 450));
      active -= 1;
    });
    const began = Date.now();
    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(451);
      expect(starts[0]).toBe(began);
      expect(starts[1] - began).toBeGreaterThanOrEqual(450);
      expect(starts[1] - began).toBeLessThanOrEqual(451);
      expect(peak).toBe(1);
      expect(batch).toHaveBeenCalledTimes(2);
    } finally {
      service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(1_000);
      jest.useRealTimers();
    }
  });

  it('paces short polls and stops rearming after shutdown during an active batch', async () => {
    jest.useFakeTimers();
    const { service } = createService({ configOverrides: { ENQUEUE_POLL_INTERVAL_MS: 200 } });
    (service as unknown as RetentionInternals).enabled = true;
    const batch = jest.spyOn(service as any, 'enqueueBatch').mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    });
    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(199);
      expect(batch).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(batch).toHaveBeenCalledTimes(2);
      service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(batch).toHaveBeenCalledTimes(2);
    } finally {
      service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('smooths webhook retention every 30 seconds and defers maintenance for one hour', async () => {
    jest.useFakeTimers();
    const { service } = createService({
      configOverrides: { ENQUEUE_POLL_INTERVAL_MS: 2 * 60 * 60 * 1_000 },
    });
    const internals = service as unknown as RetentionInternals;
    internals.enabled = true;
    const tick = jest.spyOn(service as any, 'tick').mockResolvedValue(undefined);
    const cleanup = jest.spyOn(service as any, 'cleanupRetention').mockResolvedValue(undefined);

    service.onModuleInit();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    expect(internals.retentionMaintenanceDue).toBe(false);

    await jest.advanceTimersByTimeAsync(30 * 1_000 - 1);
    expect(cleanup).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(internals.retentionMaintenanceDue).toBe(false);

    await jest.advanceTimersByTimeAsync(60 * 60 * 1_000 - 30 * 1_000);
    expect(cleanup).toHaveBeenCalledTimes(120);
    expect(internals.retentionMaintenanceDue).toBe(true);

    service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('only purges one voice source page between maintenance ticks when webhook retention is disabled', async () => {
    const { service, prisma } = createService();
    const logger = jest.spyOn((service as any).logger, 'log');

    await (service as unknown as RetentionInternals).cleanupRetention();

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(extractSql(prisma.$executeRaw.mock.calls[0]![0])).toContain(
      'DELETE FROM "moderation_voice_sources"',
    );
    expect(logger).toHaveBeenCalled();
  });

  it('keeps hourly maintenance enabled when completed webhook retention is disabled', async () => {
    const { service, prisma } = createService();
    (service as unknown as RetentionInternals).retentionMaintenanceDue = true;

    await (service as unknown as RetentionInternals).cleanupRetention();

    const queries = prisma.$executeRaw.mock.calls.map(([query]) => extractSql(query));
    expect(queries).toHaveLength(5);
    expect(queries.join(' ')).not.toContain('DELETE FROM "webhook_events"');
    expect(queries.join(' ')).not.toContain(`'PROCESSED'::"WebhookStatus"`);
    expect(queries.join(' ')).not.toContain(`'DUPLICATE'::"WebhookStatus"`);
  });

  it('uses bounded ordered SQL for every sequential retention phase', async () => {
    const { service, prisma } = createService({
      configOverrides: {
        WEBHOOK_RETENTION_DAYS: 7,
        WEBHOOK_COMPLETED_RETENTION_ENABLED: true,
        WEBHOOK_FAILED_RETENTION_HOURS: 24,
        WEBHOOK_FAILED_RETENTION_ENABLED: true,
        MODERATION_RETENTION_DAYS: 90,
        USER_DISPLAY_NAME_RETENTION_DAYS: 180,
      },
    });
    (service as unknown as RetentionInternals).retentionMaintenanceDue = true;
    const logger = jest.spyOn((service as any).logger, 'log');

    await (service as unknown as RetentionInternals).cleanupRetention();

    const queries = [...prisma.$queryRaw.mock.calls, ...prisma.$executeRaw.mock.calls].map(
      ([query]) => ({
        sql: extractSql(query),
        values: (query as SqlQuery).values ?? [],
      }),
    );
    expect(queries).toHaveLength(11);
    const plannerSettings = queries.filter((query) => query.sql.startsWith('SET LOCAL'));
    expect(plannerSettings.map((query) => query.sql)).toEqual([
      'SET LOCAL enable_incremental_sort = off',
      'SET LOCAL enable_bitmapscan = off',
    ]);
    const startExpiryRead = queries[0]!;
    expect(startExpiryRead.sql).toContain('candidate_ids AS MATERIALIZED');
    expect(startExpiryRead.sql).toContain('AS "commandId"');
    expect(startExpiryRead.sql).toContain('ORDER BY');
    expect(startExpiryRead.sql).toContain('LIMIT ?');
    expect(startExpiryRead.values).toContain(500);
    expect(startExpiryRead.sql).not.toContain('UPDATE "webhook_execution_claims"');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const deleteQueries = queries.slice(1).filter((query) => !query.sql.startsWith('SET LOCAL'));
    for (const query of deleteQueries) {
      expect(query.sql).toMatch(/expired AS(?: MATERIALIZED)? \(/u);
      expect(query.sql).toContain('ORDER BY');
      expect(query.sql).toContain('LIMIT ?');
      expect(query.sql).toMatch(/FOR UPDATE(?: OF event)? SKIP LOCKED/u);
      expect(
        query.values.some((value) => typeof value === 'number' && value > 0 && value <= 500),
      ).toBe(true);
    }
    expect(deleteQueries[0]?.sql).toContain(
      `"status" IN ('PROCESSED'::"WebhookStatus", 'DUPLICATE'::"WebhookStatus")`,
    );
    expect(deleteQueries[1]?.values).toContain(WebhookStatus.FAILED);
    expect(deleteQueries[1]?.sql).toContain('"next_enqueue_at" IS NULL');
    expect(queries.map((query) => query.sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('DELETE FROM "moderation_events" target'),
        expect.stringContaining('DELETE FROM "violations" target'),
        expect.stringContaining('DELETE FROM "moderation_violation_message_claims" target'),
        expect.stringContaining('DELETE FROM "chat_user_display_names" target'),
      ]),
    );
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        phases: expect.objectContaining({
          webhookProcessedOrDuplicate: expect.objectContaining({
            rows: 0,
            batches: 1,
            durationMs: expect.any(Number),
            budgetExhausted: false,
          }),
          userDisplayNames: expect.objectContaining({ rows: 0, batches: 1 }),
        }),
      }),
      'Retention cleanup finished',
    );
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'webhookProcessedOrDuplicate',
        rows: 0,
        batches: 1,
        maxBatches: 1,
        batchSize: 500,
      }),
      'Retention cleanup phase finished',
    );
  });

  it('does not start the next retention phase before the current phase finishes', async () => {
    let resolveFirstBatch!: (rows: number) => void;
    const firstBatch = new Promise<number>((resolve) => {
      resolveFirstBatch = resolve;
    });
    const { service, prisma } = createService({
      configOverrides: { WEBHOOK_COMPLETED_RETENTION_ENABLED: true },
    });
    (service as unknown as RetentionInternals).retentionMaintenanceDue = true;
    prisma.$queryRaw.mockImplementationOnce(async () => {
      await firstBatch;
      return [];
    });

    const cleanup = (service as unknown as RetentionInternals).cleanupRetention();
    await Promise.resolve();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();

    resolveFirstBatch(0);
    await cleanup;
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(5);
  });

  it('retains successful cleanup batches when a later batch fails, without changing the error', async () => {
    const { service } = createService();
    const internals = service as unknown as RetentionInternals;
    internals.retentionBatchDelayMs = 0;
    const error = new Error('private-retention-failure');
    const deleteBatch = jest
      .fn()
      .mockResolvedValueOnce({ removed: 3, scanned: 500 })
      .mockRejectedValueOnce(error);
    await expect(
      internals.runRetentionCleanupPhase({
        name: 'webhookProcessedOrDuplicate',
        maxBatches: 10,
        deleteBatch,
      }),
    ).rejects.toBe(error);
    expect(deleteBatch).toHaveBeenCalledTimes(2);
    expect(service.getRuntimeSnapshot()).toMatchObject({
      retention: {
        config: { webhookCompletedRetentionEnabled: false, webhookFailedRetentionEnabled: false },
        phases: {
          webhookProcessedOrDuplicate: {
            calls: 1,
            errors: 1,
            removed: 3,
            scanned: 500,
            batches: 1,
            budgetHits: 0,
          },
        },
      },
    });
    expect(JSON.stringify(service.getRuntimeSnapshot())).not.toContain('private');
  });

  it('records an admission failure without reporting unreached stages as completed', async () => {
    const { service, prisma } = createService();
    const internals = service as unknown as EnqueueAdmissionInternals & {
      enqueueBatch: () => Promise<void>;
    };
    const error = new Error('private-admission-failure');
    jest.spyOn(internals, 'resolveEnqueueAdmission').mockRejectedValueOnce(error);
    await expect(internals.enqueueBatch()).rejects.toBe(error);
    expect(service.getRuntimeSnapshot()).toMatchObject({
      batch: { calls: 1, errors: 1 },
      stages: {
        admission: { calls: 1, errors: 1 },
        selection: { calls: 0 },
        refill: { calls: 0 },
        prioritization: { calls: 0 },
        enqueue: { calls: 0 },
      },
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('exports every empty batch independently of throttled progress logs', async () => {
    const { service } = createService();
    const internals = service as unknown as { enqueueBatch: () => Promise<void> };
    await internals.enqueueBatch();
    await internals.enqueueBatch();
    expect(service.getRuntimeSnapshot()).toMatchObject({
      batch: { calls: 2, errors: 0 },
      stages: {
        admission: { calls: 2 },
        selection: { calls: 2 },
        refill: { calls: 2 },
        prioritization: { calls: 2 },
        enqueue: { calls: 2 },
      },
      candidateCount: 0,
      selectedCount: 0,
    });
  });

  it('repeats full retention batches and stops after a partial batch', async () => {
    const { service } = createService();
    const internals = service as unknown as RetentionInternals;
    internals.retentionBatchDelayMs = 0;
    const deleteBatch = jest.fn().mockResolvedValueOnce(500).mockResolvedValueOnce(499);

    await expect(
      internals.runRetentionCleanupPhase({ name: 'test', maxBatches: 10, deleteBatch }),
    ).resolves.toEqual({
      rows: 999,
      scannedRows: 999,
      batches: 2,
      durationMs: expect.any(Number),
      budgetExhausted: false,
    });
    expect(deleteBatch).toHaveBeenCalledTimes(2);
  });

  it('limits processed and duplicate webhook retention to one batch per tick', async () => {
    const { service, prisma } = createService({
      configOverrides: { WEBHOOK_COMPLETED_RETENTION_ENABLED: true },
    });
    const internals = service as unknown as RetentionInternals;
    internals.retentionBatchDelayMs = 0;
    prisma.$queryRaw.mockImplementation(async (query: SqlQuery) => {
      const sql = extractSql(query);
      if (sql.includes('AS "commandId"')) return [];
      return sql.includes('"webhook_events"') &&
        sql.includes(`'PROCESSED'::"WebhookStatus"`) &&
        sql.includes(`'DUPLICATE'::"WebhookStatus"`)
        ? [{ removed: 500, scanned: 500, lastId: 'last', lastCreatedAt: new Date() }]
        : [{ removed: 0, scanned: 0, lastId: null, lastCreatedAt: null }];
    });

    await internals.cleanupRetention();

    const completedWebhookCalls = prisma.$queryRaw.mock.calls.filter(([query]) => {
      return (
        extractSql(query).includes('"webhook_events"') &&
        extractSql(query).includes('DELETE FROM "webhook_events"') &&
        extractSql(query).includes(`'PROCESSED'::"WebhookStatus"`) &&
        extractSql(query).includes(`'DUPLICATE'::"WebhookStatus"`)
      );
    });
    expect(completedWebhookCalls).toHaveLength(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(extractSql(prisma.$executeRaw.mock.calls[0][0])).toContain('"moderation_voice_sources"');
  });

  it('reports the failed retention phase and resets the cleaning guard', async () => {
    const { service, prisma } = createService({
      configOverrides: { WEBHOOK_COMPLETED_RETENTION_ENABLED: true },
    });
    const internals = service as unknown as RetentionInternals;
    internals.retentionMaintenanceDue = true;
    const logger = jest.spyOn((service as any).logger, 'warn');
    prisma.$queryRaw.mockRejectedValueOnce(new Error('retention database unavailable'));

    await internals.cleanupRetention();

    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'webhookProcessedOrDuplicate',
        rows: 0,
        batches: 0,
        err: 'retention database unavailable',
      }),
      'Retention cleanup phase failed',
    );
    expect(internals.cleaning).toBe(false);
    expect(internals.retentionMaintenanceDue).toBe(true);

    await internals.cleanupRetention();

    const retryQueries = prisma.$queryRaw.mock.calls.slice(1).map(([query]) => extractSql(query));
    expect(
      retryQueries.filter((sql) => sql.includes(`'NO_REPLAY_HELD'::"WebhookStatus"`)),
    ).toHaveLength(1);
    expect(retryQueries.some((sql) => sql.includes(`'PROCESSED'::"WebhookStatus"`))).toBe(false);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(5);
    expect(internals.cleaning).toBe(false);
    expect(internals.retentionMaintenanceDue).toBe(false);

    // FLAG: The failed completed turn must not starve held cleanup; the following tick
    // returns to completed receipts under the same one-page-per-tick budget.
    prisma.$queryRaw.mockClear();
    prisma.$executeRaw.mockClear();
    await internals.cleanupRetention();
    const nextQueries = prisma.$queryRaw.mock.calls.map(([query]) => extractSql(query));
    expect(
      nextQueries.filter(
        (sql) =>
          sql.includes(`'PROCESSED'::"WebhookStatus"`) &&
          sql.includes('DELETE FROM "webhook_events"'),
      ),
    ).toHaveLength(1);
    expect(nextQueries.filter((sql) => sql.includes('AS "commandId"'))).toHaveLength(1);
    expect(nextQueries.some((sql) => sql.includes(`'NO_REPLAY_HELD'::"WebhookStatus"`))).toBe(
      false,
    );
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(extractSql(prisma.$executeRaw.mock.calls[0][0])).toContain('"moderation_voice_sources"');
    expect(internals.cleaning).toBe(false);
  });

  it('skips overlapping retention cleanup runs', async () => {
    let resolveFirstBatch!: (rows: number) => void;
    const firstBatch = new Promise<number>((resolve) => {
      resolveFirstBatch = resolve;
    });
    const { service, prisma } = createService({
      configOverrides: { WEBHOOK_COMPLETED_RETENTION_ENABLED: true },
    });
    prisma.$queryRaw.mockImplementationOnce(async () => {
      await firstBatch;
      return [];
    });
    const internals = service as unknown as RetentionInternals;

    const firstCleanup = internals.cleanupRetention();
    await Promise.resolve();
    await internals.cleanupRetention();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();

    resolveFirstBatch(0);
    await firstCleanup;
  });

  it('preserves a new maintenance tick that arrives during cleanup', async () => {
    let resolveFirstBatch!: (rows: number) => void;
    const firstBatch = new Promise<number>((resolve) => {
      resolveFirstBatch = resolve;
    });
    const { service, prisma } = createService({
      configOverrides: { WEBHOOK_COMPLETED_RETENTION_ENABLED: true },
    });
    prisma.$queryRaw.mockImplementationOnce(async () => {
      await firstBatch;
      return [];
    });
    const internals = service as unknown as RetentionInternals;
    internals.retentionMaintenanceDue = true;

    const cleanup = internals.cleanupRetention();
    await Promise.resolve();
    expect(internals.retentionMaintenanceDue).toBe(false);

    internals.retentionMaintenanceDue = true;
    resolveFirstBatch(0);
    await cleanup;

    expect(internals.retentionMaintenanceDue).toBe(true);
  });

  it('assigns highest BullMQ priority to callback events', async () => {
    const { service, queues } = createService({
      findManyResult: [
        {
          id: 'evt-callback',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: { type: 'message_callback' },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues.criticalQueue.add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-callback' },
      expect.objectContaining({
        jobId: 'evt-callback',
        priority: 1,
      }),
    );
  });

  it('uses a wider priority selection window than the enqueue batch size', async () => {
    const { service, prisma } = createService({
      configOverrides: { ENQUEUE_BATCH_SIZE: 2 },
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const selectionQuery = prisma.$queryRaw.mock.calls[0]![0] as SqlQuery;
    const selectionSql = extractSql(selectionQuery);
    expect(selectionSql).toContain('fair_enqueue_candidates');
    expect(selectionSql).toContain('DISTINCT ON ("work_unit_key")');
    expect(selectionSql).not.toContain('LEFT JOIN LATERAL');
    expect(selectionQuery.values).toContain(5_000);
    expect(selectionSql).not.toContain('ordered_message_head_ids AS MATERIALIZED');
    expect(selectionQuery.values).toContain(3); // Each half retains part of the wider six-candidate lane.
  });

  it('continues other work units after a routing failure without dropping the failed receipt', async () => {
    const { service, webhookRoutingService, webhookRows, queues } = createService({
      systemMode: 'degrade',
      configOverrides: { ENQUEUE_CONCURRENCY: 1 },
      findManyResult: Array.from({ length: 3 }, (_, index) => ({
        id: `route-failure-${index}`,
        enqueueAttempts: 0,
        normalizedPayload: { type: 'message_created', message: { chatId: `route-chat-${index}` } },
      })),
    });
    webhookRoutingService.resolveQueueName.mockRejectedValueOnce(new Error('temporary failure'));

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const enqueuedIds = Object.values(queues).flatMap((queue) =>
      queue.add.mock.calls.map((call) => call[1].webhookEventId),
    );
    expect(enqueuedIds).toEqual(expect.arrayContaining(['route-failure-1', 'route-failure-2']));
    expect(enqueuedIds).not.toContain('route-failure-0');
    expect(webhookRows.find((row) => row.id === 'route-failure-0')?.status).toBe(
      WebhookStatus.RECEIVED,
    );
  });

  it('keeps the polling fence until concurrent work drains after another unit fails', async () => {
    const { service, webhookRoutingService, prisma } = createService({
      systemMode: 'degrade',
      configOverrides: { ENQUEUE_CONCURRENCY: 2 },
      findManyResult: Array.from({ length: 3 }, (_, index) => ({
        id: `drain-${index}`,
        enqueueAttempts: 0,
        normalizedPayload: { type: 'message_callback' },
      })),
    });
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    webhookRoutingService.resolveQueueName.mockImplementation(async (id: string) => {
      if (id === 'drain-0') throw new Error('temporary routing failure');
      if (id === 'drain-1') {
        started();
        await pending;
      }
      return 'moderation-critical';
    });
    const internals = service as unknown as { tick: () => Promise<void> };
    let finished = false;
    const firstTick = internals.tick().then(() => {
      finished = true;
    });
    try {
      await entered;
      // Let the failed worker's rejection propagate before probing the polling fence.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await internals.tick();
      expect(finished).toBe(false);
      expect(
        prisma.$queryRaw.mock.calls.filter(([query]) =>
          extractSql(query).includes('fair_enqueue_candidates'),
        ),
      ).toHaveLength(1);
    } finally {
      release();
      await firstTick;
    }
  });

  it('admits a fresh chat on the next poll while a slow prior unit retains its chat fence', async () => {
    jest.useFakeTimers();
    const { service, webhookRows, webhookService, webhookRoutingService, queues } = createService({
      configOverrides: { ENQUEUE_POLL_INTERVAL_MS: 200, ENQUEUE_CONCURRENCY: 2 },
      findManyResult: [
        {
          id: 'slow-head',
          enqueueAttempts: 0,
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: 'slow-chat', messageId: 'slow-head' },
          },
        },
      ],
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    webhookRoutingService.resolveQueueName.mockImplementation(async (id) => {
      if (id === 'slow-head') await blocked;
      return 'moderation-critical';
    });
    const internal = service as unknown as {
      tick(): Promise<void>;
      activeEnqueueUnits: Map<string, Promise<void>>;
    };
    const wallClock = jest.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const first = internal.tick();
      await jest.advanceTimersByTimeAsync(1_001);
      await first;
      wallClock.mockRestore();
      expect(internal.activeEnqueueUnits.size).toBe(1);
      const original = webhookRows[0]!;
      webhookRows.push(
        {
          ...original,
          id: 'same-chat-next',
          createdAt: new Date(original.createdAt.getTime() + 1),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: 'slow-chat', messageId: 'same-chat-next' },
          },
        },
        {
          ...original,
          id: 'fresh-chat',
          createdAt: new Date(),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: 'fresh-chat', messageId: 'fresh-chat' },
          },
        },
      );
      await internal.tick();
      expect(webhookService.preparePersistedWebhookEvent.mock.calls.map(([id]) => id)).toEqual([
        'slow-head',
        'fresh-chat',
      ]);
      expect(
        Object.values(queues).flatMap((queue) =>
          queue.add.mock.calls.map(([, job]) => job.webhookEventId),
        ),
      ).toEqual(['fresh-chat']);
      expect(internal.activeEnqueueUnits.size).toBe(1);
      let stopped = false;
      const [worker] = service.stopWorkerAdmission();
      const drain = worker!.pause().then(() => {
        stopped = true;
      });
      await internal.tick();
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(webhookService.preparePersistedWebhookEvent).toHaveBeenCalledTimes(2);
      release();
      await drain;
      expect(internal.activeEnqueueUnits.size).toBe(0);
      expect(stopped).toBe(true);
    } finally {
      release();
      await service.onModuleDestroy();
      wallClock.mockRestore();
      jest.useRealTimers();
    }
  });

  it('retains one global concurrency budget across timed-out polls until owned units finish', async () => {
    jest.useFakeTimers();
    const { service, webhookService, webhookRoutingService } = createService({
      configOverrides: { ENQUEUE_POLL_INTERVAL_MS: 200, ENQUEUE_CONCURRENCY: 2 },
      findManyResult: Array.from({ length: 6 }, (_, index) => ({
        id: `bounded-${index}`,
        enqueueAttempts: 0,
        normalizedPayload: {
          type: 'message_created',
          message: { chatId: `bounded-chat-${index}`, messageId: `bounded-${index}` },
        },
      })),
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    webhookRoutingService.resolveQueueName.mockImplementation(async () => {
      await blocked;
      return 'moderation-critical';
    });
    const internal = service as unknown as {
      tick(): Promise<void>;
      activeEnqueueUnits: Map<string, Promise<void>>;
    };
    try {
      const first = internal.tick();
      await jest.advanceTimersByTimeAsync(1_001);
      await first;
      for (let poll = 0; poll < 4; poll += 1) {
        const next = internal.tick();
        await jest.advanceTimersByTimeAsync(1_001);
        await next;
      }
      expect(internal.activeEnqueueUnits.size).toBe(2);
      expect(webhookService.preparePersistedWebhookEvent).toHaveBeenCalledTimes(2);
      release();
      await Promise.all(internal.activeEnqueueUnits.values());
      await internal.tick();
      expect(
        webhookService.preparePersistedWebhookEvent.mock.calls
          .map(([id]) => id)
          .filter((id) => !['bounded-0', 'bounded-1'].includes(id)),
      ).toEqual(['bounded-2', 'bounded-3', 'bounded-4', 'bounded-5']);
    } finally {
      release();
      await service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('admits aged low-priority receipts while a full window of newer joins keeps arriving', async () => {
    const now = Date.now();
    const { service, queues } = createService({
      systemMode: 'degrade',
      configOverrides: { ENQUEUE_BATCH_SIZE: 8 },
      findManyResult: [
        {
          id: 'aged-title-change',
          enqueueAttempts: 0,
          createdAt: new Date(now - 600_000),
          normalizedPayload: { type: 'chat_title_changed', chatId: 'aged-chat' },
        },
        ...Array.from({ length: 40 }, (_, index) => ({
          id: `recent-join-${index}`,
          enqueueAttempts: 0,
          createdAt: new Date(now - 40_000 + index * 100),
          normalizedPayload: { type: 'user_added', chatId: `join-chat-${index}` },
        })),
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const enqueuedIds = Object.values(queues).flatMap((queue) =>
      queue.add.mock.calls.map((call) => call[1].webhookEventId),
    );
    expect(enqueuedIds).toContain('aged-title-change');
    expect(enqueuedIds.filter((id) => id.startsWith('recent-join-')).length).toBeGreaterThanOrEqual(
      6,
    );
    expect(enqueuedIds).toHaveLength(8);
  });

  it('enqueues high-priority membership joins before older message_created events', async () => {
    const joinChatId = '-72826040868309';
    const joinQueueName = resolveJoinWebhookQueueNameForChatId(joinChatId);
    const { service, queues } = createService({
      findManyResult: [
        {
          id: 'evt-message',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: { type: 'message_created' },
        },
        {
          id: 'evt-user-added',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:05.000Z'),
          normalizedPayload: { type: 'user_added', message: { chatId: joinChatId } },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[joinQueueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-user-added',
    ]);
    expect(
      queues['moderation-default-0'].add.mock.calls.map((call) => call[1].webhookEventId),
    ).toEqual(['evt-message']);
  });

  it('prioritizes manual-close messages ahead of older regular messages', async () => {
    const { service, queues } = createService({
      configOverrides: { ENQUEUE_BATCH_SIZE: 1 },
      manualCloseChatIds: ['chat-manual'],
      findManyResult: [
        {
          id: 'evt-regular-message',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: 'chat-regular' },
          },
        },
        {
          id: 'evt-manual-close-message',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: 'chat-manual' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues.criticalQueue.add).toHaveBeenCalledTimes(1);
    expect(queues.criticalQueue.add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-manual-close-message' },
      expect.objectContaining({
        jobId: 'evt-manual-close-message',
        priority: 3,
      }),
    );
    expect(queues['moderation-default-0'].add).not.toHaveBeenCalled();
  });

  it('routes membership leave events into the background queue', async () => {
    const { service, queues } = createService({
      findManyResult: [
        {
          id: 'evt-user-removed',
          enqueueAttempts: 0,
          normalizedPayload: { type: 'user_removed' },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues.backgroundQueue.add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-user-removed' },
      expect.objectContaining({
        jobId: 'evt-user-removed',
      }),
    );
  });

  it('retries existing jobs found in the legacy queue before scheduling new work', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const { service, queues } = createService({
      findManyResult: [{ id: 'evt-legacy', enqueueAttempts: 1 }],
      legacyJob: job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues.legacyQueue.getJob).toHaveBeenCalledWith('evt-legacy');
    expect(job.retry).toHaveBeenCalledTimes(1);
    expect(queues['moderation-default-0'].add).not.toHaveBeenCalled();
  });

  it('treats undefined BullMQ lookups as missing jobs and enqueues normally', async () => {
    const { service, queues } = createService({
      findManyResult: [{ id: 'evt-undefined', enqueueAttempts: 0 }],
      undefinedJobs: true,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues['moderation-default-0'].add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-undefined' },
      expect.objectContaining({
        jobId: 'evt-undefined',
      }),
    );
  });

  it('shards message_created events by chatId across default queues', async () => {
    const { service, queues } = createService({
      findManyResult: [
        {
          id: 'evt-chat-a',
          enqueueAttempts: 0,
          normalizedPayload: { type: 'message_created', message: { chatId: 'a' } },
        },
        {
          id: 'evt-chat-b',
          enqueueAttempts: 0,
          normalizedPayload: { type: 'message_created', message: { chatId: 'b' } },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const shardAdds = DEFAULT_WEBHOOK_QUEUE_NAMES.flatMap((queueName) =>
      queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId),
    );
    const queueForChatA = resolveDefaultWebhookQueueNameForChatId('a');
    const queueForChatB = resolveDefaultWebhookQueueNameForChatId('b');

    expect(shardAdds.sort()).toEqual(['evt-chat-a', 'evt-chat-b']);
    expect(queues[queueForChatA].add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-chat-a' },
      expect.objectContaining({ jobId: 'evt-chat-a' }),
    );
    expect(queues[queueForChatB].add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-chat-b' },
      expect.objectContaining({ jobId: 'evt-chat-b' }),
    );
    expect(new Set([queueForChatA, queueForChatB]).size).toBeGreaterThan(1);
  });

  it('does not prepare a newer chat event after the older event becomes outstanding', async () => {
    const chatId = 'chat-serial-preparation';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, queues, webhookService } = createService({
      configOverrides: { ENQUEUE_CONCURRENCY: 8 },
      findManyResult: [
        {
          id: 'evt-chat-older-slow',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            updateId: 'update-chat-older-slow',
            type: 'message_created',
            message: { chatId, messageId: 'message-chat-older-slow' },
          },
        },
        {
          id: 'evt-chat-newer-fast',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            updateId: 'update-chat-newer-fast',
            type: 'message_created',
            message: { chatId, messageId: 'message-chat-newer-fast' },
          },
        },
      ],
    });
    const prepareImplementation =
      webhookService.preparePersistedWebhookEvent.getMockImplementation()!;
    let releaseOlder!: () => void;
    const olderPreparationGate = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    webhookService.preparePersistedWebhookEvent.mockImplementation(async (eventId: string) => {
      if (eventId === 'evt-chat-older-slow') {
        await olderPreparationGate;
      }
      return prepareImplementation(eventId);
    });

    const enqueuePromise = (
      service as unknown as { enqueueBatch: () => Promise<void> }
    ).enqueueBatch();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(webhookService.preparePersistedWebhookEvent.mock.calls).toEqual([
      [
        'evt-chat-older-slow',
        undefined,
        expect.objectContaining({ updateId: 'update-chat-older-slow' }),
      ],
    ]);
    expect(queues[queueName].add).not.toHaveBeenCalled();

    releaseOlder();
    await enqueuePromise;

    expect(
      webhookService.preparePersistedWebhookEvent.mock.calls.map(([eventId]) => eventId),
    ).toEqual(['evt-chat-older-slow']);
    expect(queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-chat-older-slow',
    ]);
  });

  it('uses the event id as a deterministic same-chat tie-breaker for equal createdAt values', async () => {
    const chatId = 'chat-created-at-tie';
    const createdAt = new Date('2026-03-24T00:00:00.000Z');
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, queues, webhookService } = createService({
      findManyResult: [
        {
          id: 'evt-tie-z',
          enqueueAttempts: 0,
          createdAt,
          normalizedPayload: {
            updateId: 'update-tie-z',
            type: 'message_created',
            message: { chatId, messageId: 'message-tie-z' },
          },
        },
        {
          id: 'evt-tie-a',
          enqueueAttempts: 0,
          createdAt,
          normalizedPayload: {
            updateId: 'update-tie-a',
            type: 'message_created',
            message: { chatId, messageId: 'message-tie-a' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-tie-a',
    ]);
    expect(webhookService.preparePersistedWebhookEvent).toHaveBeenCalledTimes(1);
    expect(webhookService.preparePersistedWebhookEvent).toHaveBeenCalledWith(
      'evt-tie-a',
      undefined,
      expect.any(Object),
    );
  });

  it('retains bounded preparation concurrency between different chats', async () => {
    const chatIds = ['chat-parallel-a', 'chat-parallel-b', 'chat-parallel-c'];
    const { service, prisma, webhookService } = createService({
      configOverrides: { ENQUEUE_CONCURRENCY: 2 },
      findManyResult: chatIds.map((chatId, index) => ({
        id: `evt-parallel-${index}`,
        enqueueAttempts: 0,
        createdAt: new Date(`2026-03-24T00:00:0${index}.000Z`),
        normalizedPayload: {
          updateId: `update-parallel-${index}`,
          type: 'message_created',
          message: { chatId, messageId: `message-parallel-${index}` },
        },
      })),
    });
    const prepareImplementation =
      webhookService.preparePersistedWebhookEvent.getMockImplementation()!;
    let activePreparations = 0;
    let maxActivePreparations = 0;
    const startedEventIds: string[] = [];
    let releaseFirstWorkers!: () => void;
    const firstWorkersGate = new Promise<void>((resolve) => {
      releaseFirstWorkers = resolve;
    });
    webhookService.preparePersistedWebhookEvent.mockImplementation(async (eventId: string) => {
      activePreparations += 1;
      maxActivePreparations = Math.max(maxActivePreparations, activePreparations);
      startedEventIds.push(eventId);
      if (startedEventIds.length <= 2) {
        await firstWorkersGate;
      }
      try {
        return await prepareImplementation(eventId);
      } finally {
        activePreparations -= 1;
      }
    });

    const enqueuePromise = (
      service as unknown as { enqueueBatch: () => Promise<void> }
    ).enqueueBatch();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(startedEventIds).toHaveLength(2);
    expect(activePreparations).toBe(2);

    releaseFirstWorkers();
    await enqueuePromise;

    expect(startedEventIds).toHaveLength(3);
    expect(maxActivePreparations).toBe(2);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
    expect(
      prisma.$queryRaw.mock.calls.filter(([query]) =>
        extractSql(query).includes('finished_ordered_head_proofs'),
      ),
    ).toHaveLength(1);
    const orderedHeadsQuery = prisma.$queryRaw.mock.calls
      .map(([query]) => query as SqlQuery)
      .find((query) => extractSql(query).includes('WITH requested_chats'))!;
    const orderedHeadsSql = extractSql(orderedHeadsQuery);
    const quarantineMarker = `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`;
    expect(orderedHeadsSql).toContain('requested_chats');
    expect(orderedHeadsSql).toContain('JOIN LATERAL');
    expect(orderedHeadsSql).not.toContain('CROSS JOIN LATERAL');
    expect(orderedHeadsSql).toContain(
      `LEFT(COALESCE("error_message", ''), 37) = '${quarantineMarker}'`,
    );
    expect(orderedHeadsQuery.values).not.toContain(37);
    expect(orderedHeadsQuery.values).not.toContain(quarantineMarker);
    expect(orderedHeadsQuery.values).toEqual(expect.arrayContaining(chatIds));
  });

  it('keeps the partial-index predicate literal while binding a single-chat head cursor', async () => {
    const { service, prisma } = createService();
    const chatId = 'chat-ordered-head-sql-shape';
    const after = {
      id: 'evt-ordered-head-cursor',
      createdAt: new Date('2026-08-15T12:30:00.000Z'),
    };

    await (
      service as unknown as {
        findOrderedWebhookHeadForChat: (
          targetChatId: string,
          cursor: { id: string; createdAt: Date },
        ) => Promise<unknown>;
      }
    ).findOrderedWebhookHeadForChat(chatId, after);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const orderedHeadQuery = prisma.$queryRaw.mock.calls[0]![0] as SqlQuery;
    const orderedHeadSql = extractSql(orderedHeadQuery);
    const quarantineMarker = `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`;
    expect(orderedHeadSql).toContain(
      `LEFT(COALESCE("error_message", ''), 37) = '${quarantineMarker}'`,
    );
    expect(orderedHeadQuery.values).not.toContain(37);
    expect(orderedHeadQuery.values).not.toContain(quarantineMarker);
    expect(orderedHeadQuery.values).toEqual(
      expect.arrayContaining([chatId, after.createdAt, after.id]),
    );
  });

  it('enqueues a due retryable same-chat failure before a newer receipt', async () => {
    const chatId = 'chat-due-retry-barrier';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, queues, webhookRows } = createService({
      findManyResult: [
        {
          id: 'evt-due-retry-older',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 1,
          nextEnqueueAt: new Date(Date.now() - 1_000),
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            updateId: 'update-due-retry-older',
            type: 'message_created',
            message: { chatId, messageId: 'message-due-retry-older' },
          },
        },
        {
          id: 'evt-due-retry-newer',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            updateId: 'update-due-retry-newer',
            type: 'message_created',
            message: { chatId, messageId: 'message-due-retry-newer' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-due-retry-older',
    ]);

    const olderRow = webhookRows.find((row) => row.id === 'evt-due-retry-older')!;
    olderRow.status = WebhookStatus.PROCESSED;
    olderRow.nextEnqueueAt = null;

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-due-retry-older',
      'evt-due-retry-newer',
    ]);
  });

  it('does not let an older terminal failure block a newer distinct message', async () => {
    const chatId = 'chat-terminal-failure-release';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, queues, webhookService } = createService({
      findManyResult: [
        {
          id: 'evt-terminal-failure-older',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 120,
          nextEnqueueAt: null,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            updateId: 'update-terminal-failure-older',
            type: 'message_created',
            message: { chatId, messageId: 'message-terminal-failure-older' },
          },
        },
        {
          id: 'evt-after-terminal-failure',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            updateId: 'update-after-terminal-failure',
            type: 'message_created',
            message: { chatId, messageId: 'message-after-terminal-failure' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(webhookService.preparePersistedWebhookEvent).toHaveBeenCalledTimes(1);
    expect(webhookService.preparePersistedWebhookEvent).toHaveBeenCalledWith(
      'evt-after-terminal-failure',
      undefined,
      expect.any(Object),
    );
    expect(queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-after-terminal-failure',
    ]);
  });

  it('keeps a newer same-chat message behind a live timeout quarantine', async () => {
    const chatId = 'chat-live-timeout-quarantine';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, queues, webhookService } = createService({
      findManyResult: [
        {
          id: 'evt-live-timeout-a',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 1,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: new Date(Date.now() + 60_000),
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-a: still running`,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-live-timeout-a' },
          },
        },
        {
          id: 'evt-live-timeout-b',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-live-timeout-b' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
    expect(queues[queueName].add).not.toHaveBeenCalled();
  });

  it('keeps an expired timeout quarantine fenced without replaying or advancing the chat head', async () => {
    const chatId = 'chat-expired-timeout-quarantine';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, prisma, queues, webhookRows } = createService({
      findManyResult: [
        {
          id: 'evt-expired-timeout-a',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 1,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: new Date(Date.now() - 1_000),
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-a: crashed`,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-expired-timeout-a' },
          },
        },
        {
          id: 'evt-expired-timeout-b',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-expired-timeout-b' },
          },
        },
      ],
    });
    prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(webhookRows),
    );

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[queueName].add).not.toHaveBeenCalled();
    expect(queues[queueName].add).not.toHaveBeenCalledWith(
      expect.anything(),
      { webhookEventId: 'evt-expired-timeout-a' },
      expect.anything(),
    );
    const expiredRow = webhookRows[0]!;
    expect(expiredRow.status).toBe(WebhookStatus.FAILED);
    expect(expiredRow.nextEnqueueAt).toBeNull();
    expect(expiredRow.timeoutQuarantineExpiresAt?.getTime()).toBeLessThan(Date.now());
    expect(expiredRow.errorMessage).toMatch(
      new RegExp(`^${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`),
    );
  });

  it('repairs a timeout quarantine only from a durably completed claim', async () => {
    const chatId = 'chat-completed-timeout-quarantine';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const completedAt = new Date('2026-03-24T00:00:05.000Z');
    const { service, prisma, queues, webhookRows } = createService({
      timeoutExecutionClaim: { status: 'COMPLETED', completedAt },
      findManyResult: [
        {
          id: 'evt-completed-timeout-a',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 1,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: new Date(Date.now() - 1_000),
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-a: completion write interrupted`,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-completed-timeout-a' },
          },
        },
        {
          id: 'evt-completed-timeout-b',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-completed-timeout-b' },
          },
        },
      ],
    });
    prisma.webhookExecutionClaim.findFirst.mockResolvedValue({
      id: 'completed-timeout-claim',
      webhookEventId: 'evt-completed-timeout-a',
      semanticKey: buildWebhookSemanticEventKey(webhookRows[0]!.normalizedPayload),
      enforced: true,
      status: 'COMPLETED',
      preparedAt: new Date('2026-03-24T00:00:01.000Z'),
      completedAt,
      leaseToken: null,
      leaseExpiresAt: null,
    } as never);
    Object.assign(prisma.webhookExecutionClaim, {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    });
    prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(webhookRows),
    );

    await expect(
      (
        service as unknown as {
          settlePendingTimeoutQuarantine: (event: MockWebhookEventRow) => Promise<string>;
        }
      ).settlePendingTimeoutQuarantine(webhookRows[0]!),
    ).resolves.toBe('terminal');
    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(webhookRows[0]).toEqual(
      expect.objectContaining({
        status: WebhookStatus.PROCESSED,
        processedAt: completedAt,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
        errorMessage: null,
      }),
    );
    expect(queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-completed-timeout-b',
    ]);
  });

  it('converges a retained no-claim mirror with a different bot envelope on its completed owner', async () => {
    const {
      service,
      queues,
      webhookService,
      mirror,
      owner,
      ownerClaim,
      ownerCompletedAt,
      claimUpdateMany,
    } = createCompletedSemanticOwnerFixture();

    expect(mirror.normalizedPayload).not.toEqual(owner.normalizedPayload);
    expect(buildWebhookSemanticEventKey(mirror.normalizedPayload)).toBe(
      buildWebhookSemanticEventKey(owner.normalizedPayload),
    );

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(mirror).toEqual(
      expect.objectContaining({
        status: WebhookStatus.DUPLICATE,
        processedAt: ownerCompletedAt,
        queueName: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
        errorMessage: null,
      }),
    );
    expect(owner.status).toBe(WebhookStatus.PROCESSED);
    expect(ownerClaim.enforced).toBe(true);
    expect(claimUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: ownerClaim.id,
          webhookEventId: owner.id,
          status: 'COMPLETED',
          leaseToken: null,
          leaseExpiresAt: null,
        }),
        data: expect.objectContaining({ enforced: true, status: 'COMPLETED' }),
      }),
    );
    expect(webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
    for (const queue of Object.values(queues)) {
      expect(queue.add).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      caseName: 'the semantic owner claim is transitional',
      options: { ownerClaimStatus: 'READY' as const },
    },
    {
      caseName: 'the completed owner payload is invalid',
      options: { invalidOwnerPayload: true },
    },
  ])('keeps the retained mirror blocked when $caseName', async ({ options }) => {
    const {
      service,
      prisma,
      queues,
      webhookService,
      mirror,
      ownerClaim,
      pendingErrorMessage,
      claimUpdateMany,
    } = createCompletedSemanticOwnerFixture(options);

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(mirror).toEqual(
      expect.objectContaining({
        status: WebhookStatus.FAILED,
        processedAt: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
        errorMessage: pendingErrorMessage,
      }),
    );
    expect(ownerClaim.enforced).toBe(false);
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
    expect(claimUpdateMany).not.toHaveBeenCalled();
    expect(webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
    for (const queue of Object.values(queues)) {
      expect(queue.add).not.toHaveBeenCalled();
    }
  });

  it.each(['owner', 'claim', 'mirror'] as const)(
    'leaves the retained mirror fenced when the %s CAS is lost',
    async (casLoss) => {
      const {
        service,
        prisma,
        queues,
        webhookService,
        mirror,
        ownerClaim,
        pendingErrorMessage,
        transaction,
      } = createCompletedSemanticOwnerFixture({ casLoss });
      const originalQueueName = mirror.queueName;

      await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

      expect(transaction).toHaveBeenCalledTimes(3);
      expect(
        prisma.$queryRaw.mock.calls.filter(([query]) =>
          extractSql(query).includes('finished_ordered_head_proofs'),
        ),
      ).toHaveLength(1);
      expect(mirror).toEqual(
        expect.objectContaining({
          status: WebhookStatus.FAILED,
          processedAt: null,
          queueName: originalQueueName,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
          errorMessage: pendingErrorMessage,
        }),
      );
      expect(ownerClaim.enforced).toBe(false);
      expect(webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
      for (const queue of Object.values(queues)) {
        expect(queue.add).not.toHaveBeenCalled();
      }
    },
  );

  it('never releases an expired timeout quarantine without a completed claim', async () => {
    const chatId = 'chat-timeout-heartbeat-race';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, prisma, queues, webhookRows } = createService({
      findManyResult: [
        {
          id: 'evt-heartbeat-race-a',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 1,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: new Date(Date.now() - 1_000),
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-a: running`,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-heartbeat-race-a' },
          },
        },
        {
          id: 'evt-heartbeat-race-b',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-heartbeat-race-b' },
          },
        },
      ],
    });
    prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(webhookRows),
    );

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();
    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(webhookRows[0]!.nextEnqueueAt).toBeNull();
    expect(webhookRows[0]!.timeoutQuarantineExpiresAt!.getTime()).toBeLessThan(Date.now());
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
    expect(queues[queueName].add).not.toHaveBeenCalled();
  });

  it('keeps a legacy null-deadline timeout quarantine fenced indefinitely', async () => {
    const chatId = 'chat-legacy-timeout-quarantine';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, prisma, queues, webhookRows } = createService({
      findManyResult: [
        {
          id: 'evt-legacy-timeout-a',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 1,
          nextEnqueueAt: null,
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}: detached work unresolved`,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-legacy-timeout-a' },
          },
        },
        {
          id: 'evt-legacy-timeout-b',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            type: 'message_created',
            message: { chatId, messageId: 'message-legacy-timeout-b' },
          },
        },
      ],
    });
    prisma.webhookEvent.updateMany.mockImplementation(
      createWebhookEventUpdateManyMock(webhookRows),
    );

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();
    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(webhookRows[0]!.nextEnqueueAt).toBeNull();
    expect(webhookRows[0]!.timeoutQuarantineExpiresAt).toBeNull();
    expect(webhookRows[0]!.errorMessage).toMatch(
      new RegExp(`^${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`),
    );
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
    expect(queues[queueName].add).not.toHaveBeenCalled();
  });

  it('advances past a canonical duplicate to the next distinct message in one batch', async () => {
    const chatId = 'chat-canonical-duplicate-release';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, queues, webhookService, webhookRows } = createService({
      findManyResult: [
        {
          id: 'evt-canonical-duplicate-older',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            updateId: 'update-canonical-duplicate-older',
            type: 'message_created',
            message: { chatId, messageId: 'message-canonical-duplicate-older' },
          },
        },
        {
          id: 'evt-after-canonical-duplicate',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            updateId: 'update-after-canonical-duplicate',
            type: 'message_created',
            message: { chatId, messageId: 'message-after-canonical-duplicate' },
          },
        },
      ],
    });
    const prepareImplementation =
      webhookService.preparePersistedWebhookEvent.getMockImplementation()!;
    webhookService.preparePersistedWebhookEvent.mockImplementation(async (eventId: string) => {
      if (eventId === 'evt-canonical-duplicate-older') {
        webhookRows[0]!.status = WebhookStatus.DUPLICATE;
        webhookRows[0]!.processedAt = new Date();
        return {
          canonical: false,
          prepared: true,
          normalizedPayload: webhookRows[0]!.normalizedPayload,
          executionBotId: null,
          enforced: true,
        };
      }
      return prepareImplementation(eventId);
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(
      webhookService.preparePersistedWebhookEvent.mock.calls.map(([eventId]) => eventId),
    ).toEqual(['evt-canonical-duplicate-older', 'evt-after-canonical-duplicate']);
    expect(queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-after-canonical-duplicate',
    ]);
  });

  it('blocks a newer high BullMQ priority behind the older same-chat head', async () => {
    const chatId = 'chat-priority-order';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const createdAt = new Date('2026-03-24T00:00:00.000Z');
    const priorityRows = [
      {
        id: 'evt-priority-newer',
        enqueueAttempts: 0,
        createdAt: new Date(createdAt.getTime() + 1_000),
        normalizedPayload: {
          updateId: 'update-priority-newer',
          type: 'message_created',
          message: { chatId, messageId: 'message-priority-newer' },
        },
      },
      {
        id: 'evt-priority-older',
        enqueueAttempts: 0,
        createdAt,
        normalizedPayload: {
          updateId: 'update-priority-older',
          type: 'message_created',
          message: { chatId, messageId: 'message-priority-older' },
        },
      },
    ];
    const { service, queues } = createService({ findManyResult: priorityRows });
    const baseCandidate = {
      status: WebhookStatus.RECEIVED,
      botId: null,
      queueName: null,
      enqueueAttempts: 0,
      createdAt,
      queuedAt: null,
    };

    await (
      service as unknown as {
        enqueueCandidates: (candidates: unknown[]) => Promise<void>;
      }
    ).enqueueCandidates([
      {
        ...baseCandidate,
        id: 'evt-priority-newer',
        priority: 1,
        createdAt: new Date(createdAt.getTime() + 1_000),
        normalizedPayload: priorityRows[0]!.normalizedPayload,
      },
      {
        ...baseCandidate,
        id: 'evt-priority-older',
        priority: 5,
        normalizedPayload: priorityRows[1]!.normalizedPayload,
      },
    ]);

    expect(
      queues[queueName].add.mock.calls.map((call) => ({
        webhookEventId: call[1].webhookEventId,
        priority: call[2].priority,
      })),
    ).toEqual([{ webhookEventId: 'evt-priority-older', priority: 5 }]);
  });

  it('selects the ordered chat head before applying the recent-receipt reserve', async () => {
    const chatId = 'chat-omitted-head';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, queues, webhookService } = createService({
      findManyResult: [
        {
          id: 'evt-omitted-older',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            updateId: 'update-omitted-older',
            type: 'message_created',
            message: { chatId, messageId: 'message-omitted-older' },
          },
        },
        {
          id: 'evt-selected-newer',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            updateId: 'update-selected-newer',
            type: 'message_created',
            message: { chatId, messageId: 'message-selected-newer' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(webhookService.preparePersistedWebhookEvent).toHaveBeenCalledTimes(1);
    expect(webhookService.preparePersistedWebhookEvent).toHaveBeenCalledWith(
      'evt-omitted-older',
      undefined,
      expect.any(Object),
    );
    expect(queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-omitted-older',
    ]);
  });

  it('keeps a newer manual-close receipt behind an older queued event from a prior poll', async () => {
    const chatId = 'chat-manual-transition';
    const priorQueueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const now = new Date();
    const { service, queues, webhookRoutingService, webhookService, webhookRows } = createService({
      manualCloseChatIds: [chatId],
      findManyResult: [
        {
          id: 'evt-prior-normal-queued',
          status: WebhookStatus.QUEUED,
          queueName: priorQueueName,
          enqueueAttempts: 1,
          createdAt: new Date(now.getTime() - 60_000),
          queuedAt: now,
          normalizedPayload: {
            updateId: 'update-prior-normal-queued',
            type: 'message_created',
            message: { chatId, messageId: 'message-prior-normal-queued' },
          },
        },
        {
          id: 'evt-newer-manual-close',
          enqueueAttempts: 0,
          createdAt: new Date(now.getTime() - 1_000),
          normalizedPayload: {
            updateId: 'update-newer-manual-close',
            type: 'message_created',
            message: { chatId, messageId: 'message-newer-manual-close' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
    expect(webhookRoutingService.resolveQueueName).not.toHaveBeenCalled();
    expect(queues.criticalQueue.add).not.toHaveBeenCalled();

    const priorRow = webhookRows.find((row) => row.id === 'evt-prior-normal-queued')!;
    priorRow.queuedAt = new Date(now.getTime() - 30_000);

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(
      webhookService.preparePersistedWebhookEvent.mock.calls.map(([eventId]) => eventId),
    ).toEqual(['evt-prior-normal-queued']);
    expect(queues.criticalQueue.add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-prior-normal-queued',
    ]);
  });

  it('does not enqueue B after queued A later becomes retryable FAILED', async () => {
    const chatId = 'chat-failure-after-enqueue';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, queues, webhookService, webhookRows } = createService({
      findManyResult: [
        {
          id: 'evt-sequence-a',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:00.000Z'),
          normalizedPayload: {
            updateId: 'update-sequence-a',
            type: 'message_created',
            message: { chatId, messageId: 'message-sequence-a' },
          },
        },
        {
          id: 'evt-sequence-b',
          enqueueAttempts: 0,
          createdAt: new Date('2026-03-24T00:00:01.000Z'),
          normalizedPayload: {
            updateId: 'update-sequence-b',
            type: 'message_created',
            message: { chatId, messageId: 'message-sequence-b' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const firstRow = webhookRows.find((row) => row.id === 'evt-sequence-a')!;
    firstRow.status = WebhookStatus.FAILED;
    firstRow.queueName = null;
    firstRow.nextEnqueueAt = new Date(Date.now() + 30_000);

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId)).toEqual([
      'evt-sequence-a',
    ]);
    expect(
      webhookService.preparePersistedWebhookEvent.mock.calls.map(([eventId]) => eventId),
    ).toEqual(['evt-sequence-a']);
  });

  it('enqueues standby-only shared-chat message_created events as recovery deliveries', async () => {
    const chatId = '-100123';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, prisma, queues } = createService({
      findManyResult: [
        {
          id: 'evt-standby-message',
          enqueueAttempts: 0,
          botId: 'id613002203036_4_bot',
          normalizedPayload: {
            updateId: 'u-standby-message-only',
            type: 'message_created',
            botId: 'id613002203036_4_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: { chatId, messageId: 'mid-owner-retryable' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[queueName].add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-standby-message' },
      expect.objectContaining({ jobId: 'evt-standby-message' }),
    );
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.QUEUED,
          queueName,
        }),
      }),
    );
  });

  it('skips standby shared-chat events while the owner failed delivery is retryable', async () => {
    const chatId = '-100123';
    const retryAt = new Date(Date.now() + 15_000);
    const { service, prisma, queues, webhookService } = createService({
      findManyResult: [
        {
          id: 'evt-owner-retryable-failed',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 1,
          botId: 'id613002203036_bot',
          nextEnqueueAt: retryAt,
          normalizedPayload: {
            updateId: 'u-owner-retryable-failed',
            type: 'message_created',
            botId: 'id613002203036_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: { chatId, messageId: 'mid-owner-retryable' },
          },
        },
        {
          id: 'evt-standby-owner-retryable',
          enqueueAttempts: 0,
          botId: 'id613002203036_4_bot',
          normalizedPayload: {
            updateId: 'u-owner-retryable-failed',
            type: 'message_created',
            botId: 'id613002203036_4_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: { chatId, messageId: 'mid-owner-retryable' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const queuedIds = DEFAULT_WEBHOOK_QUEUE_NAMES.flatMap((queueName) =>
      queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId),
    );
    const duplicateIds = prisma.webhookEvent.updateMany.mock.calls
      .filter(([args]) => args.data.status === WebhookStatus.DUPLICATE)
      .map(([args]) => args.where.id);

    expect(queuedIds).toEqual([]);
    expect(duplicateIds).toEqual([]);
    expect(webhookService.preparePersistedWebhookEvent).not.toHaveBeenCalled();
  });

  it('skips standby shared-chat events with different update ids when the owner has the same message', async () => {
    const chatId = '-100123';
    const { service, prisma, queues } = createService({
      findManyResult: [
        {
          id: 'evt-owner-same-message',
          status: WebhookStatus.QUEUED,
          enqueueAttempts: 0,
          botId: 'id613002203036_bot',
          normalizedPayload: {
            updateId: 'u-owner-same-message',
            type: 'message_created',
            botId: 'id613002203036_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: {
              chatId,
              messageId: 'mid-shared-semantic-1',
            },
          },
        },
        {
          id: 'evt-standby-same-message',
          enqueueAttempts: 0,
          botId: 'id613002203036_4_bot',
          normalizedPayload: {
            updateId: 'u-standby-same-message',
            type: 'message_created',
            botId: 'id613002203036_4_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: {
              chatId,
              messageId: 'mid-shared-semantic-1',
            },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const queuedIds = DEFAULT_WEBHOOK_QUEUE_NAMES.flatMap((queueName) =>
      queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId),
    );
    const duplicateIds = prisma.webhookEvent.updateMany.mock.calls
      .filter(([args]) => args.data.status === WebhookStatus.DUPLICATE)
      .map(([args]) => args.where.id);

    expect(queuedIds).toEqual(['evt-owner-same-message']);
    expect(duplicateIds).toEqual([]);
  });

  it('does not execute a mirrored receipt after the canonical claim failed terminally', async () => {
    const chatId = '-100123';
    const { service, queues } = createService({
      findManyResult: [
        {
          id: 'evt-owner-terminal-failed',
          status: WebhookStatus.FAILED,
          enqueueAttempts: 120,
          botId: 'id613002203036_bot',
          nextEnqueueAt: null,
          normalizedPayload: {
            updateId: 'u-owner-terminal-failed',
            type: 'message_created',
            botId: 'id613002203036_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: { chatId, messageId: 'mid-owner-terminal' },
          },
        },
        {
          id: 'evt-standby-owner-terminal',
          enqueueAttempts: 0,
          botId: 'id613002203036_4_bot',
          normalizedPayload: {
            updateId: 'u-owner-terminal-failed',
            type: 'message_created',
            botId: 'id613002203036_4_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: { chatId, messageId: 'mid-owner-terminal' },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    for (const queueName of DEFAULT_WEBHOOK_QUEUE_NAMES) {
      expect(queues[queueName].add).not.toHaveBeenCalled();
    }
  });

  it('holds N-way mirrored message receipts behind the outstanding owner', async () => {
    const chatId = '-100123';
    const ownerBotId = 'bot-1';
    const botIds = ['bot-1', 'bot-2', 'bot-3', 'bot-4', 'bot-5', 'bot-6'];
    const ownerEventId = 'evt-mirrored-bot-1';
    const ownerQueueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, prisma, queues, webhookService } = createService({
      configOverrides: {
        ENQUEUE_CONCURRENCY: 6,
      },
      findManyResult: botIds.map((botId, index) => ({
        id: `evt-mirrored-${botId}`,
        enqueueAttempts: 0,
        botId,
        createdAt: new Date(`2026-03-24T00:00:0${index}.000Z`),
        normalizedPayload: {
          updateId: 'u-mirrored-message',
          type: 'message_created',
          botId,
          executionOwnerBotId: ownerBotId,
          message: {
            chatId,
            messageId: 'mid-mirrored-shared',
          },
        },
      })),
    });
    const prepareImplementation =
      webhookService.preparePersistedWebhookEvent.getMockImplementation()!;
    let activePreparations = 0;
    let maxActivePreparations = 0;
    webhookService.preparePersistedWebhookEvent.mockImplementation(async (eventId: string) => {
      activePreparations += 1;
      maxActivePreparations = Math.max(maxActivePreparations, activePreparations);
      await Promise.resolve();
      try {
        return await prepareImplementation(eventId);
      } finally {
        activePreparations -= 1;
      }
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    const defaultQueueAdds = DEFAULT_WEBHOOK_QUEUE_NAMES.flatMap((queueName) =>
      queues[queueName].add.mock.calls.map((call) => call[1].webhookEventId),
    );
    const duplicateIds = prisma.webhookEvent.updateMany.mock.calls
      .filter(([args]) => args.data.status === WebhookStatus.DUPLICATE)
      .map(([args]) => args.where.id)
      .sort();
    const queuedIds = prisma.webhookEvent.updateMany.mock.calls
      .filter(([args]) => args.data.status === WebhookStatus.QUEUED)
      .map(([args]) => args.where.id)
      .sort();

    expect(defaultQueueAdds).toEqual([ownerEventId]);
    expect(queues[ownerQueueName].add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: ownerEventId },
      expect.objectContaining({
        jobId: ownerEventId,
        priority: 5,
      }),
    );
    expect(duplicateIds).toEqual([]);
    expect(queuedIds).toEqual([ownerEventId]);
    expect(prisma.webhookEvent.findFirst).not.toHaveBeenCalled();
    expect(maxActivePreparations).toBe(1);
    expect(webhookService.preparePersistedWebhookEvent).toHaveBeenCalledTimes(1);
  });

  it('enqueues standby-only shared-chat message_edited events as recovery deliveries', async () => {
    const chatId = '-100123';
    const queueName = resolveDefaultWebhookQueueNameForChatId(chatId);
    const { service, prisma, queues } = createService({
      findManyResult: [
        {
          id: 'evt-standby-edited-message',
          enqueueAttempts: 0,
          botId: 'id613002203036_4_bot',
          normalizedPayload: {
            updateId: 'u-standby-edited-only',
            type: 'message_edited',
            botId: 'id613002203036_4_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: { chatId },
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[queueName].add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-standby-edited-message' },
      expect.objectContaining({ jobId: 'evt-standby-edited-message' }),
    );
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.QUEUED,
          queueName,
        }),
      }),
    );
  });

  it('enqueues standby-only shared-chat user_added events as recovery deliveries', async () => {
    const chatId = '-100123';
    const queueName = resolveJoinWebhookQueueNameForChatId(chatId);
    const { service, prisma, queues } = createService({
      findManyResult: [
        {
          id: 'evt-standby-user-added',
          enqueueAttempts: 0,
          botId: 'id613002203036_4_bot',
          normalizedPayload: {
            updateId: 'u-standby-user-added-only',
            type: 'user_added',
            botId: 'id613002203036_4_bot',
            executionOwnerBotId: 'id613002203036_bot',
            user: { chatId },
            chatId,
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues[queueName].add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-standby-user-added' },
      expect.objectContaining({ jobId: 'evt-standby-user-added' }),
    );
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.QUEUED,
          queueName,
        }),
      }),
    );
  });

  it('enqueues standby-only shared-chat user_removed events as recovery deliveries', async () => {
    const chatId = '-100123';
    const { service, prisma, queues } = createService({
      findManyResult: [
        {
          id: 'evt-standby-user-removed',
          enqueueAttempts: 0,
          botId: 'id613002203036_4_bot',
          normalizedPayload: {
            updateId: 'u-standby-user-removed-only',
            type: 'user_removed',
            botId: 'id613002203036_4_bot',
            executionOwnerBotId: 'id613002203036_bot',
            user: { chatId },
            chatId,
          },
        },
      ],
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues.backgroundQueue.add).toHaveBeenCalledWith(
      'process-webhook-event',
      { webhookEventId: 'evt-standby-user-removed' },
      expect.objectContaining({ jobId: 'evt-standby-user-removed' }),
    );
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-background',
        }),
      }),
    );
  });

  it('removes queued standby shared-chat jobs and marks them processed', async () => {
    const job: JobMock = {
      getState: jest.fn().mockResolvedValue('prioritized'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const { service, prisma, queues } = createService({
      findManyResult: [
        {
          id: 'evt-owner-processed',
          enqueueAttempts: 0,
          status: WebhookStatus.DUPLICATE,
          processedAt: new Date('2026-03-24T00:00:02.000Z'),
          botId: 'id613002203036_bot',
          normalizedPayload: {
            updateId: 'u-standby-queued',
            type: 'message_created',
            botId: 'id613002203036_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: { chatId: '-100123', messageId: 'mid-standby-queued' },
          },
        },
        {
          id: 'evt-standby-queued',
          enqueueAttempts: 2,
          status: WebhookStatus.QUEUED,
          queueName: 'moderation-default-0',
          botId: 'id613002203036_4_bot',
          normalizedPayload: {
            updateId: 'u-standby-queued',
            type: 'message_created',
            botId: 'id613002203036_4_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: { chatId: '-100123', messageId: 'mid-standby-queued' },
          },
        },
      ],
      defaultJob: job,
    });

    await (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();

    expect(queues['moderation-default-0'].getJob).toHaveBeenCalledWith('evt-standby-queued');
    expect(job.remove).toHaveBeenCalledTimes(1);
    expect(queues['moderation-default-0'].add).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.DUPLICATE,
        }),
      }),
    );
  });
});
