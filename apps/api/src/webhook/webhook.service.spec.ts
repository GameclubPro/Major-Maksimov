import type { MaxUpdate } from '@maxim/contracts';
import { ConfigService } from '@nestjs/config';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import type { WebhookCanonicalExecutionService } from '../moderation/webhook-canonical-execution.service';
import {
  ChatEntityType,
  type Prisma,
  type WebhookEvent,
  type WebhookExecutionClaim,
  WebhookExecutionClaimStatus,
  WebhookStatus,
} from '../prisma/prisma-client';
import { WebhookParser } from './webhook.parser';
import { WebhookService } from './webhook.service';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';

// Persistence is mocked in this suite; native outbox tests exercise the single-statement writer.
jest.mock('./webhook-payload-write', () => {
  const actual =
    jest.requireActual<typeof import('./webhook-payload-write')>('./webhook-payload-write');
  return {
    ...actual,
    writeWebhookPayload: (
      client: { webhookEvent: { updateMany: jest.Mock } },
      id: string,
      payload: Parameters<typeof actual.webhookPayloadChange>[1],
    ) => client.webhookEvent.updateMany(actual.webhookPayloadChange(id, payload)),
  };
});

const claimModels = new WeakMap<object, object>();
const productionClaimModel = (
  WebhookService.prototype as unknown as { getWebhookExecutionClaimModel: () => object | null }
).getWebhookExecutionClaimModel;
type FixtureRow = Record<string, unknown>;
type SemanticFixtureSql = {
  readonly strings: Readonly<Prisma.Sql['strings']>;
  readonly values: Readonly<Prisma.Sql['values']>;
};
type CanonicalStartedOwner = Parameters<
  NonNullable<
    Parameters<
      typeof WebhookCanonicalExecutionService.transitionLiveUnstartedOwnerWithClient
    >[1]['captureStartedOwner']
  >
>[0];
type CanonicalTransitionOwnerFixture = Pick<
  WebhookExecutionClaim,
  | 'semanticKey'
  | 'webhookEventId'
  | 'executionBotId'
  | 'preparedAt'
  | 'businessStartedAt'
  | 'leaseToken'
  | 'leaseExpiresAt'
  | 'commandResult'
>;
// FLAG: The same SQL also returns READY preparation, whose business lease fields are null.
type CanonicalTransitionSnapshotFixture = Omit<
  CanonicalStartedOwner,
  keyof CanonicalTransitionOwnerFixture
> &
  CanonicalTransitionOwnerFixture;
type SemanticClaimModel = {
  createMany: jest.Mock;
  findUnique: jest.Mock;
  updateMany: jest.Mock;
};
type SemanticFixtureDatabase = {
  webhookEvent: {
    create?: jest.Mock;
    createMany?: jest.Mock;
    findFirst?: jest.Mock;
    findUnique?: jest.Mock;
    updateMany?: jest.Mock;
  };
  chat?: { createMany: jest.Mock };
  chatMembershipActivityEvent?: { createMany: jest.Mock };
  webhookExecutionClaim?: SemanticClaimModel;
  $queryRaw?: jest.Mock;
  $executeRaw?: jest.Mock;
  $transaction?: jest.Mock;
  semanticClaimWrite?: jest.Mock;
};

function coherentSemanticClaims(service: object) {
  const existing = claimModels.get(service);
  if (existing) return existing;
  const prisma = (service as { prisma: SemanticFixtureDatabase }).prisma;
  const supplied = productionClaimModel.call(service) ? prisma.webhookExecutionClaim : null;
  const claims = new Map<string, Record<string, unknown>>();
  const model = (supplied ?? {
    createMany: jest.fn(
      async (args: {
        data: Array<{
          kind: string;
          semanticKey: string;
          webhookEventId: string;
          enforced: boolean;
        }>;
      }) => {
        let count = 0;
        for (const input of args.data) {
          const key = `${input.kind}:${input.semanticKey}`;
          if (claims.has(key)) continue;
          claims.set(key, {
            ...input,
            id: `claim-${claims.size}`,
            status: 'PENDING',
            executionBotId: null,
            leaseToken: null,
            leaseExpiresAt: null,
            preparedAt: null,
            completedAt: null,
            businessStartedAt: null,
            commandResult: null,
            createdAt: new Date(),
          });
          count += 1;
        }
        return { count };
      },
    ),
    findUnique: jest.fn(async (args: { where: FixtureRow }) => {
      const key = args.where.kind_semanticKey as { kind: string; semanticKey: string } | undefined;
      return key
        ? (claims.get(`${key.kind}:${key.semanticKey}`) ?? null)
        : ([...claims.values()].find((claim) => claim.id === args.where.id) ?? null);
    }),
    updateMany: jest.fn(
      async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const claim = [...claims.values()].find((candidate) => candidate.id === args.where.id);
        if (
          !claim ||
          Object.entries(args.where).some(
            ([key, value]) =>
              key !== 'OR' &&
              (value instanceof Date
                ? (claim[key] as Date | null)?.getTime() !== value.getTime()
                : claim[key] !== value),
          )
        )
          return { count: 0 };
        const alternatives = args.where.OR as Array<Record<string, unknown>> | undefined;
        if (
          alternatives &&
          !alternatives.some((where) =>
            Object.entries(where).every(([key, value]) =>
              value === null
                ? claim[key] === null
                : (claim[key] as Date)?.getTime() < (value as { lt: Date }).lt.getTime(),
            ),
          )
        )
          return { count: 0 };
        Object.assign(claim, args.data);
        return { count: 1 };
      },
    ),
  }) as SemanticClaimModel;
  claimModels.set(service, model);
  const claimRows = new Map<string, FixtureRow>();
  const claimFind = model.findUnique;
  model.findUnique = jest.fn(async (...args: unknown[]) => {
    const row = (await claimFind(...args)) as FixtureRow | null;
    if (!row) return row;
    // FLAG: Fill only fields omitted by shallow positive fixtures. Explicit null/old birth and
    // missing supplied authority remain unchanged so negative proof tests cannot become grants.
    for (const [key, value] of Object.entries({
      kind: 'EXECUTION',
      createdAt: new Date(),
      businessStartedAt: null,
      commandResult: null,
      completedAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    })) {
      if (!(key in row)) row[key] = value;
    }
    claimRows.set(String(row.id), row);
    if (typeof row.webhookEventId === 'string') await readReceipt(row.webhookEventId);
    return row;
  });
  const claimUpdate = model.updateMany;
  model.updateMany = jest.fn(async (args: { where: FixtureRow; data: FixtureRow }) => {
    const result = await claimUpdate(args);
    if (result?.count === 1) {
      for (const row of claimRows.values()) {
        if (
          (args.where.id === undefined || args.where.id === row.id) &&
          (args.where.webhookEventId === undefined ||
            args.where.webhookEventId === row.webhookEventId)
        )
          Object.assign(row, args.data);
      }
    }
    return result;
  });
  prisma.webhookExecutionClaim = model;
  const receipts = new Map<string, FixtureRow>();
  const missingReceipts = new Set<string>();
  const receiptWrites = new Map<string, FixtureRow>();
  const receiptFind = prisma.webhookEvent.findUnique;
  const receiptUpdate = prisma.webhookEvent.updateMany;
  const normalizeReceipt = (id: string, source: FixtureRow) => {
    const payload = source.normalizedPayload as MaxUpdate | undefined;
    // FLAG: These shallow positive domain fixtures represent parser-normalized input.
    // Keep explicitly untrusted, raw and invalid source fixtures unchanged.
    if (
      payload &&
      payload.eventTimestampSource === undefined &&
      payload.raw === undefined &&
      payload.message?.createdAt &&
      Number.isFinite(Date.parse(payload.message.createdAt))
    )
      payload.eventTimestampSource = 'payload';
    const row = {
      status: 'RECEIVED',
      errorMessage: null,
      nextEnqueueAt: null,
      timeoutQuarantineExpiresAt: null,
      executionDeadlineAt: null,
      legacyDispositionId: null,
      legacyDispositionReceiptId: null,
      sourceDispositionId: null,
      sourceDispositionReceiptId: null,
      createdAt: new Date(),
      ...source,
      ...receiptWrites.get(id),
      id,
    };
    receipts.set(id, row);
    return row;
  };
  const readReceipt = async (id: string): Promise<FixtureRow | null> => {
    if (missingReceipts.has(id)) return null;
    let row = receipts.get(id);
    if (!row) {
      // Receipt loading occurs before claim-model admission. Reuse completed mock reads and
      // persisted writes without introducing an extra read or resurrecting a deleted receipt.
      for (let index = 0; index < (receiptFind?.mock.calls.length ?? 0); index += 1) {
        const args = receiptFind!.mock.calls[index]?.[0] as { where?: { id?: string } } | undefined;
        if (args?.where?.id !== id) continue;
        const result = (await Promise.resolve(receiptFind!.mock.results[index]?.value).catch(
          () => null,
        )) as FixtureRow | null;
        if (result?.id === id) row = normalizeReceipt(id, result);
      }
      for (const create of [prisma.webhookEvent.create, prisma.webhookEvent.createMany]) {
        for (let index = 0; index < (create?.mock.calls.length ?? 0); index += 1) {
          const data = create!.mock.calls[index]?.[0]?.data as
            | FixtureRow
            | FixtureRow[]
            | undefined;
          const mutation = create!.mock.results[index];
          if (mutation?.type === 'throw') continue;
          const result = (await Promise.resolve(mutation?.value).catch(() => null)) as
            | FixtureRow
            | null
            | undefined;
          if (result === null) continue;
          for (const source of Array.isArray(data) ? data : data ? [data] : []) {
            if (source.id === id || result?.id === id) row = normalizeReceipt(id, source);
          }
        }
      }
    }
    for (let index = 0; index < (receiptUpdate?.mock.calls.length ?? 0); index += 1) {
      const call = receiptUpdate!.mock.calls[index]!;
      const mutation = receiptUpdate!.mock.results[index];
      if (mutation?.type === 'throw') continue;
      const result = (await Promise.resolve(mutation?.value).catch(() => null)) as
        | { count?: number }
        | null
        | undefined;
      if (result === null) continue;
      if (result?.count === 0) continue;
      const args = call[0] as { where?: { id?: string }; data?: FixtureRow };
      if (args.where?.id === id && args.data) {
        receiptWrites.set(id, { ...receiptWrites.get(id), ...args.data });
      }
    }
    const writes = receiptWrites.get(id);
    return row || writes?.normalizedPayload ? normalizeReceipt(id, { ...row, ...writes }) : null;
  };
  prisma.webhookEvent.findFirst ??= jest.fn(
    async (args: {
      where: { semanticKey?: string; createdAt?: { lte: Date }; id?: { in: string[] } };
    }) => {
      if (args.where.id) await Promise.all(args.where.id.in.map(readReceipt));
      const older = [...receipts.values()]
        .filter((row) =>
          args.where.id
            ? args.where.id.in.includes(String(row.id))
            : row.semanticKey === args.where.semanticKey &&
              row.createdAt instanceof Date &&
              Boolean(
                args.where.createdAt &&
                row.createdAt.getTime() <= args.where.createdAt.lte.getTime(),
              ),
        )
        .sort(
          (left, right) =>
            (left.createdAt as Date).getTime() - (right.createdAt as Date).getTime() ||
            String(left.id).localeCompare(String(right.id)),
        );
      return older.length ? { id: older[0]!.id } : null;
    },
  );
  if (receiptFind) {
    prisma.webhookEvent.findUnique = jest.fn(async (...args: unknown[]) => {
      const row = (await receiptFind(...args)) as FixtureRow | null;
      const id = (args[0] as { where?: { id?: string } } | undefined)?.where?.id;
      if (id) {
        if (row) missingReceipts.delete(id);
        else {
          missingReceipts.add(id);
          receipts.delete(id);
          receiptWrites.delete(id);
        }
      }
      return row ? normalizeReceipt(String(row.id), row) : row;
    });
  } else {
    prisma.webhookEvent.findUnique = jest.fn(async (args: { where: { id: string } }) =>
      readReceipt(args.where.id),
    );
  }
  prisma.webhookEvent.updateMany = jest.fn(
    async (args: { where: FixtureRow; data: FixtureRow }) => {
      const result = (await receiptUpdate?.(args)) ?? { count: 1 };
      if (result.count === 1 && typeof args.where.id === 'string')
        receiptWrites.set(args.where.id, { ...receiptWrites.get(args.where.id), ...args.data });
      return result;
    },
  );
  const adaptQueryRaw = (
    queryRaw?: jest.Mock,
    mutateRaw?: (query: SemanticFixtureSql) => Promise<number>,
  ) =>
    jest.fn(async (...args: unknown[]) => {
      const query = args[0] as {
        strings?: readonly string[];
        values?: readonly unknown[];
        join?: (separator: string) => string;
      };
      const sql = query?.strings?.join(' ') ?? query?.join?.(' ') ?? '';
      if (sql.includes('RETURNING claim."id" AS "claimId"')) {
        if (!mutateRaw || !query.strings || !query.values)
          throw new Error('Canonical transition requires its transaction fixture');
        const statement = query as SemanticFixtureSql;
        if ((await mutateRaw(statement)) !== 1) return [];
        const id = String(
          statement.values[statement.strings.findIndex((part) => part.includes('claim."id" = '))],
        );
        const owner = claimRows.get(id) as CanonicalTransitionOwnerFixture | undefined;
        if (!owner) throw new Error('Canonical transition lost its persisted fixture owner');
        const snapshot: CanonicalTransitionSnapshotFixture = {
          claimId: id,
          semanticKey: owner.semanticKey,
          webhookEventId: owner.webhookEventId,
          executionBotId: owner.executionBotId,
          preparedAt: owner.preparedAt,
          businessStartedAt: owner.businessStartedAt,
          leaseToken: owner.leaseToken,
          leaseExpiresAt: owner.leaseExpiresAt,
          commandResult: owner.commandResult,
          commandResultIsSqlNull: owner.commandResult === null,
        };
        return [snapshot];
      }
      if (sql.includes('WITH authority_ids AS MATERIALIZED')) return [];
      if (sql.includes('SELECT claim.id, claim.webhook_event_id AS "ownerId"')) return [];
      if (sql.includes('pg_try_advisory_xact_lock')) return [{ locked: true }];
      // Claim admission rereads the persisted fixture under its receipt lock.
      if (
        sql.includes('legacy_disposition_id AS "legacyDispositionId"') &&
        sql.includes('FROM webhook_events') &&
        sql.includes('FOR UPDATE')
      ) {
        const receipt = await readReceipt(String(query.values?.[0]));
        return receipt ? [receipt] : [];
      }
      if (sql.includes("migration_name = '20261005020000_add_multibot_order_fences'"))
        return [{ finishedAt: new Date(0) }];
      if (
        /SELECT "id" FROM "webhook_(?:execution_claims|events)" .* FOR UPDATE/u.test(
          sql.replace(/\s+/gu, ' '),
        )
      )
        return [];
      return queryRaw ? queryRaw(...args) : [];
    });
  prisma.$queryRaw = adaptQueryRaw(prisma.$queryRaw);
  const adaptedClients = new WeakMap<object, SemanticFixtureDatabase>();
  const adaptClient = (source: SemanticFixtureDatabase) => {
    const existing = adaptedClients.get(source);
    if (existing) return existing;
    // Keep transaction-only raw methods off the root client: shallow domain fixtures rely on
    // their original ORM capabilities and must not switch to unrelated SQL paths.
    const client = { ...source };
    adaptedClients.set(source, client);
    client.webhookEvent ??= prisma.webhookEvent;
    client.webhookExecutionClaim ??= model;
    client.chat ??= { createMany: jest.fn().mockResolvedValue({ count: 0 }) };
    const executeRaw = client.$executeRaw;
    client.$executeRaw = jest.fn(
      async (query: { strings: readonly string[]; values: readonly unknown[] }) => {
        const sql = query.strings.join('?');
        const valueAfter = (fragment: string) =>
          query.values[query.strings.findIndex((part) => part.includes(fragment))];
        const expiry = sql.includes('SET "status" = \'COMPLETED\', "prepared_at" = COALESCE');
        const transition =
          sql.includes('SET "execution_bot_id" = ') && sql.includes('"business_started_at" = ');
        if (!expiry && !transition) {
          if (executeRaw) return executeRaw(query);
          if (sql.includes('INSERT INTO "chat_membership_activity_events"')) {
            const fields = [
              'id',
              'dedupeKey',
              'botId',
              'chatId',
              'eventType',
              'userId',
              'senderName',
              'eventAt',
              'createdAt',
            ];
            const data: FixtureRow[] = [];
            for (let index = 0; index < query.values.length; index += fields.length)
              data.push(
                Object.fromEntries(
                  fields.map((field, offset) => [field, query.values[index + offset]]),
                ),
              );
            // No Chat lock was granted by this fallback client, so only the original
            // projection write is simulated; access reset/allowlist mutation cannot run.
            await prisma.chatMembershipActivityEvent?.createMany({
              data,
              skipDuplicates: true,
            });
            return 1;
          }
          throw new Error('Unknown semantic fixture SQL mutation');
        }
        const claim = claimRows.get(String(valueAfter('claim."id" = ')));
        const eventId = String(valueAfter('event."id" = '));
        const event = await readReceipt(eventId);
        const ready = sql.includes('"business_started_at" = NULL');
        const deadline = valueAfter(
          expiry
            ? 'event."execution_deadline_at" = '
            : 'event."execution_deadline_at" IS NOT DISTINCT FROM ',
        );
        const marker = valueAfter('claim."command_result" @> ');
        const waiting = typeof marker === 'string' ? (JSON.parse(marker) as FixtureRow) : null;
        const result = claim?.commandResult as FixtureRow | null;
        const matchesWaiting =
          waiting &&
          result &&
          Object.entries(waiting).every(([key, value]) => result[key] === value);
        const sameDeadline =
          event?.executionDeadlineAt instanceof Date && deadline instanceof Date
            ? event.executionDeadlineAt.getTime() === deadline.getTime()
            : event?.executionDeadlineAt === deadline;
        const now = new Date();
        if (
          !claim ||
          !event ||
          claim.kind !== 'EXECUTION' ||
          claim.semanticKey !== valueAfter('claim."semantic_key" = ') ||
          claim.webhookEventId !== eventId ||
          claim.status !== valueAfter('claim."status"::text = ') ||
          claim.businessStartedAt !== null ||
          claim.completedAt !== null ||
          claim.leaseToken !== valueAfter('claim."lease_token" = ') ||
          !(claim.leaseExpiresAt instanceof Date) ||
          claim.leaseExpiresAt.getTime() <= now.getTime() ||
          (!ready && !claim.enforced) ||
          ['PROCESSED', 'DUPLICATE'].includes(String(event.status)) ||
          event.timeoutQuarantineExpiresAt !== null ||
          String(event.errorMessage ?? '').includes('WEBHOOK_HOT_PATH_TIMEOUT_') ||
          String(event.errorMessage ?? '')
            .toLowerCase()
            .includes('ambiguous') ||
          !sameDeadline ||
          (expiry &&
            (!matchesWaiting ||
              !(deadline instanceof Date) ||
              deadline.getTime() > now.getTime())) ||
          (!expiry &&
            matchesWaiting &&
            (!(deadline instanceof Date) || deadline.getTime() <= now.getTime()))
        )
          return 0;
        const changed = (await prisma.semanticClaimWrite?.(query)) ?? 1;
        if (changed !== 1) return changed;
        Object.assign(
          claim,
          expiry
            ? {
                status: 'COMPLETED',
                preparedAt: claim.preparedAt ?? now,
                completedAt: now,
                leaseToken: null,
                leaseExpiresAt: null,
              }
            : {
                executionBotId: valueAfter('SET "execution_bot_id" = '),
                enforced: Boolean(
                  claim.enforced || valueAfter('"enforced" = claim."enforced" OR '),
                ),
                status: 'READY',
                preparedAt: ready ? now : claim.preparedAt,
                businessStartedAt: ready ? null : now,
                leaseToken: ready ? null : claim.leaseToken,
                leaseExpiresAt: ready ? null : claim.leaseExpiresAt,
              },
        );
        return 1;
      },
    );
    client.$queryRaw = adaptQueryRaw(
      client.$queryRaw,
      async (query) => await client.$executeRaw!(query),
    );
    return client;
  };
  const transaction = prisma.$transaction;
  prisma.$transaction = jest.fn(async (operation: (client: SemanticFixtureDatabase) => unknown) =>
    transaction
      ? transaction((client: SemanticFixtureDatabase) => operation(adaptClient(client)))
      : operation(adaptClient(prisma)),
  );
  return model;
}

function persistedReceipt(id: string, update: MaxUpdate, extra: Record<string, unknown> = {}) {
  return {
    id,
    dedupKey: `${update.botId}:${update.updateId}`,
    botId: update.botId,
    status: WebhookStatus.RECEIVED,
    semanticKey: buildWebhookSemanticEventKey(update),
    executionDeadlineAt: null,
    normalizedPayload: update,
    createdAt: new Date(update.message?.createdAt ?? '2026-09-02T08:00:00.000Z'),
    errorMessage: null,
    nextEnqueueAt: null,
    timeoutQuarantineExpiresAt: null,
    processedAt: null,
    queueName: null,
    ...extra,
  };
}

function mockedReceiptStore(rows: ReturnType<typeof persistedReceipt>[]) {
  const events = new Map(rows.map((event) => [event.id, event]));
  return {
    events,
    findUnique: jest.fn(
      async ({ where }: { where: { id: string } }) => events.get(where.id) ?? null,
    ),
    updateMany: jest.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
      const event = events.get(where.id);
      if (!event) return { count: 0 };
      Object.assign(event, data);
      return { count: 1 };
    }),
  };
}

describe('WebhookService', () => {
  it('does not execute the outbox admission snapshot after its durable receipt disappears', async () => {
    const prisma = { webhookEvent: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new WebhookService(prisma as never, new ConfigService(), {} as never);
    const update = {
      updateId: 'deleted-receipt',
      botId: 'bot-a',
      type: 'bot_removed',
    } as MaxUpdate;
    await expect(
      service.preparePersistedWebhookEvent('deleted-receipt', undefined, update),
    ).resolves.toMatchObject({ canonical: false, prepared: false, normalizedPayload: null });
    expect(prisma.webhookEvent.findUnique).toHaveBeenCalledTimes(1);
  });
  const flushDeferredWebhookWork = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const extractSqlText = (query: unknown): string => {
    const strings = (query as { strings?: unknown[] } | null)?.strings;
    return Array.isArray(strings) ? strings.map(String).join(' ') : String(query);
  };
  const extractSqlValues = (query: unknown): unknown[] => {
    const values = (query as { values?: unknown[] } | null)?.values;
    return Array.isArray(values) ? values : [];
  };
  const buildMembershipUpdate = (params: {
    updateId: string;
    type: 'user_added' | 'user_removed';
    createdAt: string;
    userIds?: string[];
  }): MaxUpdate => {
    const userIds = params.userIds ?? ['user-1'];
    return {
      updateId: params.updateId,
      type: params.type,
      botId: 'id613002203036_bot',
      message: {
        messageId: `${params.type}:${params.updateId}`,
        chatId: '-100-membership',
        chatTitle: 'Membership chat',
        entityType: 'chat',
        senderId: userIds[0],
        text: '',
        createdAt: params.createdAt,
      },
      membership: {
        action: params.type === 'user_removed' ? 'removed' : 'added',
        memberUserIds: userIds,
      },
    };
  };
  const createAtomicMembershipFixture = (options?: {
    newerGrantedUserIds?: string[];
    newerAdminUserIds?: string[];
  }) => {
    const operations: string[] = [];
    let receiptSequence = 0;
    const tx = {
      chat: {
        createMany: jest.fn(async () => {
          operations.push('chat:create');
          return { count: 0 };
        }),
      },
      $queryRaw: jest.fn(async () => {
        operations.push('chat:lock');
        return [{ id: '-100-membership' }];
      }),
      $executeRaw: jest.fn(async (_query: unknown) => {
        operations.push('activity:upsert');
        return 1;
      }),
      managedEntityAccessEdge: {
        updateMany: jest.fn(async () => {
          operations.push('edge:deny');
          return { count: 1 };
        }),
        findMany: jest.fn(async () => {
          operations.push('edge:newer');
          return (options?.newerGrantedUserIds ?? []).map((userId) => ({ userId }));
        }),
      },
      managedEntityAdminMember: {
        deleteMany: jest.fn(async () => {
          operations.push('admin:delete');
          return { count: 1 };
        }),
        findMany: jest.fn(async () => {
          operations.push('admin:newer');
          return (options?.newerAdminUserIds ?? []).map((userId) => ({ userId }));
        }),
      },
      chatAdminAllowlist: {
        deleteMany: jest.fn(async () => {
          operations.push('allowlist:delete');
          return { count: 1 };
        }),
      },
    };
    const prisma = {
      webhookEvent: {
        create: jest.fn(async () => {
          receiptSequence += 1;
          return {
            id:
              receiptSequence === 1
                ? 'evt-atomic-membership'
                : `evt-atomic-membership-${receiptSequence}`,
          };
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
        operations.push('transaction:start');
        const result = await callback(tx);
        operations.push('transaction:commit');
        return result;
      }),
    };
    return { operations, prisma, tx };
  };

  const maxBotLinkService = {
    bindChatToBot: jest.fn().mockResolvedValue(undefined),
    bindDiscoveredChatBots: jest.fn().mockResolvedValue(null),
    ensureChatForAccessProbe: jest.fn().mockResolvedValue(true),
    getStoredChatPrimaryBotId: jest.fn().mockResolvedValue(null),
    observeStoredChatBotWebhook: jest.fn().mockResolvedValue(undefined),
    markChatBotRemoved: jest.fn().mockResolvedValue(undefined),
    recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    reconcileChatPrimaryByAccess: jest.fn().mockResolvedValue(null),
  };
  const maxChatAdminRosterSyncService = {
    scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
  };

  beforeEach(() => {
    jest
      .spyOn(WebhookService.prototype as never, 'getWebhookExecutionClaimModel' as never)
      .mockImplementation(function (this: object) {
        return coherentSemanticClaims(this);
      } as never);
    jest.clearAllMocks();
    maxBotLinkService.bindChatToBot.mockReset();
    maxBotLinkService.bindChatToBot.mockResolvedValue(undefined);
    maxBotLinkService.bindDiscoveredChatBots.mockReset();
    maxBotLinkService.bindDiscoveredChatBots.mockResolvedValue(null);
    maxBotLinkService.ensureChatForAccessProbe.mockReset();
    maxBotLinkService.ensureChatForAccessProbe.mockResolvedValue(true);
    maxBotLinkService.getStoredChatPrimaryBotId.mockReset();
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValue(null);
    maxBotLinkService.observeStoredChatBotWebhook.mockReset();
    maxBotLinkService.observeStoredChatBotWebhook.mockResolvedValue(undefined);
    maxBotLinkService.markChatBotRemoved.mockReset();
    maxBotLinkService.markChatBotRemoved.mockResolvedValue(undefined);
    maxBotLinkService.recordBotAccessProbe.mockReset();
    maxBotLinkService.recordBotAccessProbe.mockResolvedValue(true);
    maxBotLinkService.reconcileChatPrimaryByAccess.mockReset();
    maxBotLinkService.reconcileChatPrimaryByAccess.mockResolvedValue(null);
    maxChatAdminRosterSyncService.scheduleChatAdminRosterSync.mockReset();
    maxChatAdminRosterSyncService.scheduleChatAdminRosterSync.mockResolvedValue(true);
  });

  it('stores new webhook event in RECEIVED state', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-1' }),
        updateMany: jest.fn(),
      },
    };

    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const result = await service.ingest(
      {
        updateId: 'u-1',
        type: 'message',
      },
      '127.0.0.1',
    );

    expect(result).toEqual({ accepted: true, duplicate: false });
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
  });

  it('stores same logical update id separately for different webhook bots', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-shared' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const baseUpdate = {
      updateId: 'u-shared-1',
      type: 'message_created',
      message: {
        messageId: 'm-shared-1',
        chatId: '-100',
        chatTitle: 'Shared chat',
        senderId: 'user-1',
        text: 'hello',
        createdAt: '2026-06-20T12:00:00.000Z',
      },
    };

    await expect(
      service.ingest({ ...baseUpdate, botId: 'standby-bot' } as never, '127.0.0.1'),
    ).resolves.toEqual({ accepted: true, duplicate: false });
    await expect(
      service.ingest({ ...baseUpdate, botId: 'owner-bot' } as never, '127.0.0.1'),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.webhookEvent.create.mock.calls.map(([args]) => args.data.dedupKey)).toEqual([
      'standby-bot:u-shared-1',
      'owner-bot:u-shared-1',
    ]);
  });

  it('keeps one canonical execution and selects the stored owner when its receipt arrives late', async () => {
    const ownerBotId = 'id613002203036_bot';
    const standbyBotId = 'id613002203036_4_bot';
    const events = new Map([
      [
        'evt-standby-first',
        {
          id: 'evt-standby-first',
          dedupKey: `${standbyBotId}:u-standby-first`,
          botId: standbyBotId,
          status: 'RECEIVED',
          createdAt: new Date('2026-07-10T12:00:00.123Z'),
          errorMessage: null,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
          processedAt: null,
          normalizedPayload: {
            updateId: 'u-standby-first',
            type: 'message_created',
            botId: standbyBotId,
            message: {
              chatId: '-100-owner-late',
              messageId: 'mid-owner-late',
              senderId: 'user-1',
              text: 'hello',
              createdAt: '2026-07-10T12:00:00.123Z',
            },
          },
        },
      ],
      [
        'evt-owner-late',
        {
          id: 'evt-owner-late',
          dedupKey: `${ownerBotId}:u-owner-late`,
          botId: ownerBotId,
          status: 'RECEIVED',
          createdAt: new Date('2026-07-10T12:00:01.123Z'),
          errorMessage: null,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
          processedAt: null,
          normalizedPayload: {
            updateId: 'u-owner-late',
            type: 'message_created',
            botId: ownerBotId,
            message: {
              chatId: '-100-owner-late',
              messageId: 'mid-owner-late',
              senderId: 'user-1',
              text: 'hello',
              createdAt: '2026-07-10T12:00:00.123Z',
            },
          },
        },
      ],
    ]);
    const claims = new Map<string, Record<string, unknown>>();
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn(async ({ where }: { where: { id?: string } }) =>
          where.id ? (events.get(where.id) ?? null) : null,
        ),
        updateMany: jest.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
          const event = events.get(where.id);
          if (!event) {
            return { count: 0 };
          }
          Object.assign(event, data);
          return { count: 1 };
        }),
      },
      webhookExecutionClaim: {
        createMany: jest.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
          const row = data[0]!;
          const key = `${row.kind}:${row.semanticKey}`;
          if (claims.has(key)) {
            return { count: 0 };
          }
          claims.set(key, {
            id: 'claim-owner-late',
            status: 'PENDING',
            executionBotId: null,
            leaseToken: null,
            leaseExpiresAt: null,
            preparedAt: null,
            completedAt: null,
            businessStartedAt: null,
            ...row,
          });
          return { count: 1 };
        }),
        findUnique: jest.fn(
          async ({ where }: { where: Record<string, Record<string, string>> }) => {
            const key = where.kind_semanticKey!;
            return claims.get(`${key.kind}:${key.semanticKey}`) ?? null;
          },
        ),
        updateMany: jest.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
          const claim = [...claims.values()].find((candidate) => candidate.id === where.id);
          if (!claim) {
            return { count: 0 };
          }
          Object.assign(claim, data);
          return { count: 1 };
        }),
      },
      chatBotMembership: {
        findUnique: jest.fn().mockResolvedValue({
          permissionsSnapshot: {
            checkedAt: '2026-07-10T11:59:00.000Z',
            isAdmin: true,
            isOwner: false,
            permissions: ['write'],
          },
        }),
      },
    };
    Object.assign(prisma, {
      $transaction: jest.fn(async (work: (tx: object) => unknown) => work(prisma)),
    });
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValue(ownerBotId);
    const service = new WebhookService(
      prisma as never,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'WEBHOOK_CANONICAL_EXECUTION_MODE' ? 'on' : (fallback ?? 1),
        ),
      } as never,
      maxBotLinkService as never,
    );

    await expect(service.preparePersistedWebhookEvent('evt-standby-first')).resolves.toEqual(
      expect.objectContaining({
        canonical: true,
        prepared: true,
        executionBotId: ownerBotId,
      }),
    );
    await expect(service.preparePersistedWebhookEvent('evt-owner-late')).resolves.toEqual(
      expect.objectContaining({
        canonical: false,
        prepared: true,
        executionBotId: ownerBotId,
      }),
    );

    expect(events.get('evt-standby-first')?.normalizedPayload).toEqual(
      expect.objectContaining({ executionOwnerBotId: ownerBotId }),
    );
    expect(events.get('evt-owner-late')?.status).toBe('DUPLICATE');
    expect(events.get('evt-owner-late')).toEqual(
      expect.objectContaining({
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      }),
    );
    expect(maxBotLinkService.observeStoredChatBotWebhook).toHaveBeenCalledTimes(2);
  });

  it('keeps an enforced claim sticky on rollback and touches a route-gap mirrored membership', async () => {
    const update = {
      updateId: 'u-route-gap-mirror',
      type: 'message_created',
      botId: 'bot-5',
      message: {
        chatId: '-100-route-gap',
        messageId: 'mid-route-gap',
        senderId: 'user-1',
        text: 'hello',
        createdAt: '2026-07-10T12:00:00.123Z',
      },
    };
    const receiptStore = mockedReceiptStore([
      persistedReceipt(
        'evt-route-gap-canonical',
        { ...update, botId: 'bot-owner' },
        { createdAt: new Date('2026-07-10T12:00:00.123Z') },
      ),
      persistedReceipt('evt-route-gap-mirror', update, {
        createdAt: new Date('2026-07-10T12:00:01.123Z'),
      }),
    ]);
    const prisma = {
      webhookEvent: receiptStore,
      webhookExecutionClaim: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'claim-route-gap',
          kind: 'EXECUTION',
          semanticKey: 'message:message_created:-100-route-gap:mid-route-gap',
          webhookEventId: 'evt-route-gap-canonical',
          executionBotId: null,
          enforced: true,
          status: 'READY',
          leaseToken: null,
          leaseExpiresAt: null,
          preparedAt: new Date(),
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    Object.assign(prisma, {
      $transaction: jest.fn(async (work: (tx: object) => unknown) => work(prisma)),
    });
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValue(null);
    const service = new WebhookService(
      prisma as never,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'WEBHOOK_CANONICAL_EXECUTION_MODE' ? 'shadow' : (fallback ?? 1),
        ),
      } as never,
      maxBotLinkService as never,
    );

    await expect(service.preparePersistedWebhookEvent('evt-route-gap-mirror')).resolves.toEqual(
      expect.objectContaining({ canonical: false, prepared: true }),
    );

    expect(maxBotLinkService.observeStoredChatBotWebhook).toHaveBeenCalledWith({
      chatId: '-100-route-gap',
      botId: 'bot-5',
      observedAt: expect.any(Date),
    });
    expect(maxBotLinkService.getStoredChatPrimaryBotId).not.toHaveBeenCalled();
  });

  it('waits for canonical preparation and settles a later shadow mirror without business replay', async () => {
    const update = {
      updateId: 'membership-mirror',
      type: 'user_removed',
      botId: 'bot-mirror',
      message: {
        chatId: '-100-membership-mirror',
        messageId: 'membership-message',
        senderId: 'user-1',
        text: '',
        createdAt: '2026-09-02T08:00:00.000Z',
      },
      membership: { action: 'removed', memberUserIds: ['user-1'] },
    } as MaxUpdate;
    const store = mockedReceiptStore([
      persistedReceipt('owner', { ...update, botId: 'bot-owner' }),
      persistedReceipt('mirror', update, { createdAt: new Date('2026-09-02T08:00:01.000Z') }),
    ]);
    const claim = {
      id: 'claim',
      createdAt: new Date(),
      kind: 'EXECUTION',
      semanticKey: buildWebhookSemanticEventKey(update),
      webhookEventId: 'owner',
      executionBotId: 'bot-owner',
      enforced: true,
      status: 'PENDING',
      preparedAt: null as Date | null,
      completedAt: null,
      leaseToken: 'live-preparation' as string | null,
      leaseExpiresAt: new Date(Date.now() + 30_000) as Date | null,
    };
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ finishedAt: new Date('2020-01-01T00:00:00Z') }]),
      webhookEvent: store,
      webhookExecutionClaim: {
        createMany: jest.fn(),
        findUnique: jest.fn(async () => claim),
        updateMany: jest.fn(async ({ data }: { data: object }) => {
          if ('enforced' in data) {
            Object.assign(claim, data);
            return { count: 1 };
          }
          return { count: 0 };
        }),
      },
    };
    Object.assign(prisma, {
      $transaction: jest.fn(async (work: (tx: object) => unknown) => work(prisma)),
    });
    const service = new WebhookService(
      prisma as never,
      new ConfigService({ WEBHOOK_CANONICAL_EXECUTION_MODE: 'shadow' }),
      maxBotLinkService as never,
    );
    const core = jest.spyOn(service as never, 'prepareWebhookEventCore' as never);
    await expect(service.preparePersistedWebhookEvent('mirror')).rejects.toBeInstanceOf(
      WebhookPreparationDeferredError,
    );
    expect(core).not.toHaveBeenCalled();
    Object.assign(claim, {
      status: 'READY',
      preparedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
    });
    await expect(service.preparePersistedWebhookEvent('mirror')).resolves.toMatchObject({
      canonical: false,
      prepared: true,
      executionBotId: 'bot-owner',
      enforced: true,
    });
    expect(store.events.get('mirror')?.status).toBe(WebhookStatus.DUPLICATE);
    expect(core).not.toHaveBeenCalled();
  });

  it('retains a terminal canonical membership owner rather than replaying it through a shadow mirror', async () => {
    const update = {
      updateId: 'terminal-owner',
      type: 'user_removed',
      botId: 'bot-mirror',
      message: {
        chatId: '-100-terminal-owner',
        messageId: 'membership-message',
        senderId: 'user-1',
        text: '',
        createdAt: '2026-09-02T08:00:00.000Z',
      },
      membership: { action: 'removed', memberUserIds: ['user-1'] },
    } as MaxUpdate;
    const store = mockedReceiptStore([
      persistedReceipt(
        'owner',
        { ...update, botId: 'bot-owner' },
        { status: WebhookStatus.FAILED },
      ),
      persistedReceipt('mirror', update),
    ]);
    const claim = {
      id: 'claim',
      createdAt: new Date(),
      kind: 'EXECUTION',
      semanticKey: buildWebhookSemanticEventKey(update),
      webhookEventId: 'owner',
      executionBotId: 'bot-owner',
      enforced: true,
      status: 'PENDING',
      preparedAt: null,
      completedAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const claimUpdate = jest.fn(async ({ data }: { data: object }) => {
      Object.assign(claim, data);
      return { count: 1 };
    });
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ finishedAt: new Date('2020-01-01T00:00:00Z') }]),
      webhookEvent: store,
      webhookExecutionClaim: {
        createMany: jest.fn(),
        findUnique: jest.fn(async () => claim),
        updateMany: claimUpdate,
      },
    };
    const service = new WebhookService(
      prisma as never,
      new ConfigService({ WEBHOOK_CANONICAL_EXECUTION_MODE: 'shadow' }),
      maxBotLinkService as never,
    );
    const core = jest.spyOn(service as never, 'prepareWebhookEventCore' as never);
    await expect(service.preparePersistedWebhookEvent('mirror')).rejects.toThrow(
      'Terminal canonical owner requires proof recovery',
    );
    expect(core).not.toHaveBeenCalled();
    expect(claim.webhookEventId).toBe('owner');
    expect(claimUpdate).not.toHaveBeenCalled();
  });

  it('helps the later owner prepare when the older ordered mirror is the chat head', async () => {
    const update = {
      updateId: 'older-message-mirror',
      type: 'message_created',
      botId: 'bot-mirror',
      message: {
        chatId: '-100-ordered-mirror',
        messageId: 'message-ordered-mirror',
        senderId: 'user-1',
        text: 'hello',
        createdAt: '2026-09-02T08:00:00.000Z',
      },
    } as MaxUpdate;
    const ownerUpdate = { ...update, botId: 'bot-owner' };
    const store = mockedReceiptStore([
      persistedReceipt('mirror', update),
      persistedReceipt('owner', ownerUpdate, { createdAt: new Date('2026-09-02T08:00:01.000Z') }),
    ]);
    const claim = {
      id: 'claim',
      createdAt: new Date(),
      kind: 'EXECUTION',
      semanticKey: buildWebhookSemanticEventKey(update),
      webhookEventId: 'owner',
      executionBotId: 'bot-owner',
      enforced: true,
      status: 'PENDING',
      preparedAt: null,
      completedAt: null,
      businessStartedAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ finishedAt: new Date('2020-01-01T00:00:00Z') }]),
      webhookEvent: store,
      webhookExecutionClaim: {
        createMany: jest.fn(),
        findUnique: jest.fn(async () => claim),
        updateMany: jest.fn(async ({ data }: { data: object }) => {
          Object.assign(claim, data);
          return { count: 1 };
        }),
      },
    };
    const service = new WebhookService(
      prisma as never,
      new ConfigService({ WEBHOOK_CANONICAL_EXECUTION_MODE: 'shadow' }),
      maxBotLinkService as never,
    );
    const core = jest
      .spyOn(service as never, 'prepareWebhookEventCore' as never)
      .mockResolvedValue({ update: ownerUpdate, executionBotId: 'bot-owner' } as never);
    await expect(service.preparePersistedWebhookEvent('mirror')).resolves.toMatchObject({
      canonical: true,
      prepared: true,
      normalizedPayload: ownerUpdate,
      executionBotId: 'bot-owner',
      enforced: true,
      canonicalWebhookEventId: 'owner',
    });
    expect(core).toHaveBeenCalledTimes(1);
    expect(core).toHaveBeenCalledWith('owner', ownerUpdate);
    expect(store.events.get('mirror')?.status).toBe(WebhookStatus.RECEIVED);
  });

  it.each<[mode: 'on' | 'shadow' | 'off', enforced: boolean, eventStatus: WebhookStatus]>([
    ['on', true, WebhookStatus.QUEUED],
    ['on', true, WebhookStatus.FAILED],
    ['shadow', false, WebhookStatus.QUEUED],
    ['shadow', false, WebhookStatus.FAILED],
    ['off', true, WebhookStatus.QUEUED],
    ['off', false, WebhookStatus.FAILED],
  ])(
    'converges a completed owning claim without replaying webhook preparation (mode=%s, enforced=%s, status=%s)',
    async (mode, enforced, eventStatus) => {
      const completedAt = new Date('2026-08-31T09:40:00.000Z');
      const update = {
        updateId: 'synthetic:user_added:completed-owner',
        type: 'user_added',
        botId: 'bot-1',
        message: {
          chatId: '-100-completed-owner',
          messageId: 'user_added:completed-owner',
          senderId: 'user-1',
          text: '',
          createdAt: '2026-08-31T09:39:59.000Z',
        },
        membership: {
          action: 'added',
          memberUserIds: ['user-1'],
        },
      };
      const prisma = {
        webhookEvent: {
          findUnique: jest.fn().mockResolvedValue(
            persistedReceipt('evt-completed-owner', update as MaxUpdate, {
              status: eventStatus,
              queueName: 'moderation-default-3',
            }),
          ),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        webhookExecutionClaim: {
          createMany: jest.fn().mockResolvedValue({ count: 0 }),
          findUnique: jest.fn().mockResolvedValue({
            id: 'claim-completed-owner',
            kind: 'EXECUTION',
            semanticKey: buildWebhookSemanticEventKey(update as MaxUpdate),
            webhookEventId: 'evt-completed-owner',
            executionBotId: 'bot-1',
            enforced,
            status: WebhookExecutionClaimStatus.COMPLETED,
            leaseToken: null,
            leaseExpiresAt: null,
            preparedAt: new Date('2026-08-31T09:39:58.000Z'),
            completedAt,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      Object.assign(prisma, {
        $transaction: jest.fn(async (work: (tx: object) => unknown) => work(prisma)),
      });
      const service = new WebhookService(
        prisma as never,
        {
          get: jest.fn((key: string, fallback?: unknown) =>
            key === 'WEBHOOK_CANONICAL_EXECUTION_MODE' ? mode : (fallback ?? 1),
          ),
        } as never,
        maxBotLinkService as never,
        undefined,
        undefined,
        maxChatAdminRosterSyncService as never,
      );

      await expect(service.preparePersistedWebhookEvent('evt-completed-owner')).resolves.toEqual({
        canonical: false,
        prepared: true,
        normalizedPayload: update,
        executionBotId: 'bot-1',
        enforced: true,
      });
      expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'evt-completed-owner',
            status: eventStatus,
            normalizedPayload: { equals: update },
            timeoutQuarantineExpiresAt: null,
          }),
          data: expect.objectContaining({
            status: WebhookStatus.PROCESSED,
            processedAt: completedAt,
          }),
        }),
      );
      expect(prisma.webhookExecutionClaim.createMany).not.toHaveBeenCalled();
      expect(prisma.webhookExecutionClaim.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'claim-completed-owner',
            status: 'COMPLETED',
            preparedAt: expect.any(Date),
            completedAt,
            leaseToken: null,
            leaseExpiresAt: null,
          }),
          data: { enforced: true },
        }),
      );
      expect(maxBotLinkService.observeStoredChatBotWebhook).not.toHaveBeenCalled();
      expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).not.toHaveBeenCalled();
    },
  );

  it('prepares a fresh keyless shadow receipt without quarantining its unenforced claim', async () => {
    const update = {
      updateId: 'fresh-keyless-shadow',
      type: 'bot_started',
      botId: 'bot-1',
    } as MaxUpdate;
    expect(buildWebhookSemanticEventKey(update)).toBeNull();
    const store = mockedReceiptStore([
      persistedReceipt('evt-keyless-shadow', update, { createdAt: new Date() }),
    ]);
    const prisma = { webhookEvent: store };
    const service = new WebhookService(
      prisma as never,
      new ConfigService({ WEBHOOK_CANONICAL_EXECUTION_MODE: 'shadow' }),
      maxBotLinkService as never,
    );

    await expect(service.preparePersistedWebhookEvent('evt-keyless-shadow')).resolves.toEqual({
      canonical: true,
      prepared: true,
      normalizedPayload: update,
      executionBotId: null,
      enforced: false,
    });
    const model = (prisma as SemanticFixtureDatabase).webhookExecutionClaim!;
    expect(model.createMany).toHaveBeenCalledWith({
      data: [
        {
          kind: 'EXECUTION',
          semanticKey: 'receipt:bot-1:fresh-keyless-shadow',
          webhookEventId: 'evt-keyless-shadow',
          enforced: false,
        },
      ],
      skipDuplicates: true,
    });
    await expect(
      model.findUnique({
        where: {
          kind_semanticKey: {
            kind: 'EXECUTION',
            semanticKey: 'receipt:bot-1:fresh-keyless-shadow',
          },
        },
      }),
    ).resolves.toMatchObject({
      status: 'READY',
      enforced: false,
      businessStartedAt: null,
      commandResult: null,
    });
    expect(store.events.get('evt-keyless-shadow')?.errorMessage).toBeNull();
  });

  it('does not publish READY after losing the webhook preparation lease', async () => {
    const update = {
      updateId: 'u-preparation-lease-lost',
      type: 'message_created',
      botId: 'bot-1',
      message: {
        chatId: '-100-preparation-lease',
        messageId: 'mid-preparation-lease',
        senderId: 'user-1',
        text: 'hello',
        createdAt: '2026-07-10T12:00:00.123Z',
      },
    };
    const claim = {
      id: 'claim-preparation-lease',
      kind: 'EXECUTION',
      semanticKey: 'message:message_created:-100-preparation-lease:mid-preparation-lease',
      webhookEventId: 'evt-preparation-lease',
      executionBotId: null,
      enforced: true,
      status: 'PENDING',
      leaseToken: null,
      leaseExpiresAt: null,
      preparedAt: null,
    };
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'evt-preparation-lease',
          dedupKey: 'bot-1:u-preparation-lease-lost',
          botId: 'bot-1',
          status: 'RECEIVED',
          normalizedPayload: update,
          createdAt: new Date(),
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      webhookExecutionClaim: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue(claim),
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
      },
      semanticClaimWrite: jest.fn().mockResolvedValue(0),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('bot-1');
    const service = new WebhookService(
      prisma as never,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'WEBHOOK_CANONICAL_EXECUTION_MODE' ? 'on' : (fallback ?? 1),
        ),
      } as never,
      maxBotLinkService as never,
    );

    await expect(service.preparePersistedWebhookEvent('evt-preparation-lease')).rejects.toThrow(
      'Webhook preparation lease was lost before READY',
    );
    expect(prisma.webhookExecutionClaim.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.semanticClaimWrite).toHaveBeenCalledTimes(1);
    for (const call of prisma.webhookExecutionClaim.updateMany.mock.calls) {
      expect(call[0].where).toMatchObject({
        id: claim.id,
        webhookEventId: 'evt-preparation-lease',
      });
    }
  });

  it('treats a fresh same-bot legacy unscoped dedup key as duplicate for bot-scoped retries', async () => {
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'evt-legacy',
          createdAt: new Date(),
          botId: 'owner-bot',
        }),
        create: jest.fn().mockResolvedValue({ id: 'evt-new' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.storeReceipt(
        {
          updateId: 'u-legacy-cutover',
          botId: 'owner-bot',
          type: 'message_created',
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: true, webhookEventId: null });

    expect(prisma.webhookEvent.findUnique).toHaveBeenCalledWith({
      where: {
        dedupKey: 'u-legacy-cutover',
      },
      select: {
        id: true,
        createdAt: true,
        botId: true,
      },
    });
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it('does not treat another bot legacy unscoped dedup row as duplicate', async () => {
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'evt-legacy-standby',
          createdAt: new Date(),
          botId: 'standby-bot',
        }),
        create: jest.fn().mockResolvedValue({ id: 'evt-owner' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-legacy-owner-delivery',
          botId: 'owner-bot',
          type: 'message_created',
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dedupKey: 'owner-bot:u-legacy-owner-delivery',
        }),
      }),
    );
  });

  it('defers the Старт handshake after storing the webhook event', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-start' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(0),
    };
    const handshake = {
      handleWebhookUpdate: jest.fn().mockResolvedValue('connected'),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      handshake as never,
    );
    const update = {
      updateId: 'u-start-1',
      botId: 'bot-1',
      type: 'message_created',
      message: {
        messageId: 'm-start-1',
        chatId: '-100',
        chatTitle: 'Команда MAX',
        senderId: 'admin-1',
        text: 'Старт',
        createdAt: '2026-06-20T12:00:00.000Z',
      },
    };

    await expect(service.ingest(update, '127.0.0.1')).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    await flushDeferredWebhookWork();

    expect(handshake.handleWebhookUpdate).toHaveBeenCalledWith(update);
  });

  it('leaves forwarded recovery to the durable webhook worker', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-forwarded-recovery' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(0),
    };
    const handshake = {
      handleWebhookUpdate: jest.fn().mockResolvedValue('connected'),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      handshake as never,
    );
    const update: MaxUpdate = {
      updateId: 'u-forwarded-recovery-worker-1',
      botId: 'bot-1',
      type: 'message_created',
      message: {
        messageId: 'm-forwarded-recovery-worker-1',
        chatId: '152517912',
        senderId: '195714583',
        text: 'Исходная публикация',
        createdAt: '2026-08-01T10:00:00.000Z',
      },
      raw: {
        update_type: 'message_created',
        timestamp: Date.parse('2026-08-01T10:00:00.000Z'),
        message: {
          sender: { user_id: 195714583 },
          recipient: { chat_id: 152517912, chat_type: 'dialog' },
          body: {
            mid: 'm-forwarded-recovery-worker-1',
            seq: 1,
            text: null,
            attachments: null,
          },
          link: {
            type: 'forward',
            chat_id: -70000000000001,
            message: { mid: 'mid-forwarded-source-worker-1' },
          },
        },
      },
    };

    await expect(service.ingest(update, '127.0.0.1')).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    await flushDeferredWebhookWork();

    expect(handshake.handleWebhookUpdate).not.toHaveBeenCalled();
  });

  it('persists Start bootstrap before preparation completes', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-start-bootstrap' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(0),
    };
    const chatContextCache = {
      upsertManagedEntitiesRecentBootstrap: jest.fn().mockResolvedValue(undefined),
    };
    const handshake = {
      handleWebhookUpdate: jest.fn().mockResolvedValue('connected'),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
      handshake as never,
    );
    const update: MaxUpdate = {
      updateId: 'u-start-bootstrap-1',
      botId: 'bot-1',
      type: 'message_created',
      message: {
        messageId: 'm-start-bootstrap-1',
        chatId: '-100',
        chatTitle: 'Команда MAX',
        entityType: 'chat',
        senderId: 'admin-1',
        text: 'Старт',
        createdAt: '2026-06-20T12:00:00.000Z',
      },
    };

    await expect(service.ingest(update, '127.0.0.1')).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });

    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);

    expect(chatContextCache.upsertManagedEntitiesRecentBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '-100',
        title: 'Команда MAX',
        entityType: 'chat',
        primaryBotId: 'bot-1',
      }),
      expect.any(Number),
      'admin-1',
    );
    expect(handshake.handleWebhookUpdate).toHaveBeenCalledWith(update);
  });

  it('accepts duplicate events without mutating the original webhook state', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const result = await service.ingest(
      {
        updateId: 'u-1',
        type: 'message',
      },
      '127.0.0.1',
    );

    expect(result).toEqual({ accepted: true, duplicate: true });
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
  });

  it('accepts duplicate events from skip-duplicates inserts without raising a database error', async () => {
    const prisma = {
      webhookEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(),
        updateMany: jest.fn(),
      },
    };

    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const result = await service.ingest(
      {
        updateId: 'u-skip-duplicate',
        type: 'message',
      },
      '127.0.0.1',
    );

    expect(result).toEqual({ accepted: true, duplicate: true });
    expect(prisma.webhookEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          dedupKey: 'u-skip-duplicate',
          status: 'RECEIVED',
        }),
      ],
      skipDuplicates: true,
    });
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
  });

  it('retries webhook storage with sanitized payload when Prisma rejects malformed JSON input', async () => {
    const prisma = {
      webhookEvent: {
        create: jest
          .fn()
          .mockRejectedValueOnce({
            code: 'InvalidArg',
            message: 'unexpected end of hex escape at line 1 column 581',
          })
          .mockResolvedValueOnce({ id: 'evt-2' }),
        updateMany: jest.fn(),
      },
    };

    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const result = await service.ingest(
      {
        updateId: 'u-2',
        type: 'message_callback',
        message: {
          messageId: 'mid-1',
          chatId: 'chat-1',
          senderId: 'user-1',
          text: 'broken-\ud800-text',
          createdAt: new Date('2026-03-26T12:00:00.000Z').toISOString(),
        },
        raw: {
          timestamp: Date.parse('2026-03-26T12:00:00.000Z'),
          callback: {
            callback_id: 'callback-1',
            payload: 'action|sample-1|1|0',
            user: {
              user_id: 'user-1',
            },
          },
          weird: 'broken-\ud800-text',
        },
      },
      '127.0.0.1',
    );

    expect(result).toEqual({ accepted: true, duplicate: false });
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.webhookEvent.create.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            message: expect.objectContaining({
              text: 'broken-\ufffd-text',
            }),
            raw: expect.objectContaining({
              weird: 'broken-\ufffd-text',
            }),
          }),
        }),
      }),
    );
  });

  it('sanitizes normalized raw payload before the first webhook storage attempt', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-sanitized-first' }),
        updateMany: jest.fn(),
      },
    };

    const config = {
      get: jest.fn().mockReturnValue(0),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const result = await service.ingest(
      {
        updateId: 'u-sanitized-first',
        type: 'message_created',
        message: {
          messageId: 'mid-sanitized-first',
          chatId: 'chat-1',
          senderId: 'user-1',
          text: 'clean text',
          createdAt: new Date('2026-03-26T12:00:00.000Z').toISOString(),
        },
        raw: {
          timestamp: Date.parse('2026-03-26T12:00:00.000Z'),
          message: {
            body: {
              text: 'bad-\ud800-json\u0000',
            },
          },
          weird: 'bad-\ud800-json\u0000',
        },
      },
      '127.0.0.1',
    );

    expect(result).toEqual({ accepted: true, duplicate: false });
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rawPayload: {},
          normalizedPayload: expect.objectContaining({
            message: expect.objectContaining({
              text: 'clean text',
            }),
            raw: expect.objectContaining({
              message: expect.objectContaining({
                body: expect.objectContaining({
                  text: 'bad-\ufffd-json',
                }),
              }),
              weird: 'bad-\ufffd-json',
            }),
          }),
        }),
      }),
    );
  });

  it('retries webhook storage with sanitized payload on Prisma json syntax errors', async () => {
    const prisma = {
      webhookEvent: {
        create: jest
          .fn()
          .mockRejectedValueOnce({
            code: 'P2007',
            message: 'Invalid input value: invalid input syntax for type json',
          })
          .mockResolvedValueOnce({ id: 'evt-2b' }),
        updateMany: jest.fn(),
      },
    };

    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const result = await service.ingest(
      {
        updateId: 'u-2b',
        type: 'message_created',
        message: {
          messageId: 'mid-2',
          chatId: 'chat-1',
          senderId: 'user-1',
          text: 'bad-\ud800-json',
          createdAt: new Date('2026-03-26T12:00:00.000Z').toISOString(),
        },
      },
      '127.0.0.1',
    );

    expect(result).toEqual({ accepted: true, duplicate: false });
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.webhookEvent.create.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            message: expect.objectContaining({
              text: 'bad-\ufffd-json',
            }),
          }),
        }),
      }),
    );
  });

  it('persists the ACK receipt without waiting for membership or read-model preparation', async () => {
    const neverSettles = new Promise<never>(() => undefined);
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-3' }),
        updateMany: jest.fn(),
      },
      managedEntityLocalActivity: {
        upsert: jest.fn().mockReturnValue(neverSettles),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const membershipLookup = {
      invalidateMemberships: jest.fn().mockReturnValue(neverSettles),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      membershipLookup as never,
    );

    await expect(
      Promise.race([
        service
          .storeReceipt(
            {
              updateId: 'u-join-1',
              type: 'user_added',
              botId: 'id613002203036_bot',
              message: {
                messageId: 'user_added:u-join-1',
                chatId: '-100200',
                chatTitle: 'Новый чат',
                entityType: 'chat',
                senderId: 'user-10',
                text: '',
                createdAt: new Date('2026-03-29T12:00:00.000Z').toISOString(),
              },
              membership: {
                action: 'added',
                memberUserIds: ['user-10'],
              },
            },
            '127.0.0.1',
          )
          .then((result) => ({ kind: 'accepted', result })),
        new Promise((resolve) => {
          setTimeout(() => resolve({ kind: 'timeout' }), 25);
        }),
      ]),
    ).resolves.toEqual({
      kind: 'accepted',
      result: { accepted: true, webhookEventId: 'evt-3', duplicate: false },
    });

    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
    expect(membershipLookup.invalidateMemberships).not.toHaveBeenCalled();
    expect(prisma.managedEntityLocalActivity.upsert).not.toHaveBeenCalled();
  });

  it('retains duplicate repair admission until the membership transaction settles after a name write fails', async () => {
    const fixture = createAtomicMembershipFixture();
    const failure = new Error('display name unavailable');
    let unlock!: () => void;
    const lock = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    fixture.tx.$queryRaw.mockImplementationOnce(async () => {
      await lock;
      return [{ id: '-100-membership' }];
    });
    const prisma = {
      ...fixture.prisma,
      chatUserDisplayName: {},
      $executeRaw: jest.fn().mockRejectedValue(failure),
    };
    const service = new WebhookService(
      prisma as never,
      new ConfigService(),
      maxBotLinkService as never,
    );
    const update = buildMembershipUpdate({
      updateId: 'duplicate-under-lock',
      type: 'user_added',
      createdAt: '2026-07-20T10:05:00.000Z',
    });
    update.message!.senderName = 'Member';
    const outcome = service
      .repairDuplicateReceiptReadModels(update)
      .catch((error: unknown) => error);
    try {
      await flushDeferredWebhookWork();
      expect(prisma.$executeRaw).toHaveBeenCalled();
      expect(fixture.tx.$queryRaw).toHaveBeenCalled();
      expect(service.nextPreparationCompletion()).not.toBeNull();
    } finally {
      unlock();
    }
    await expect(outcome).resolves.toBe(failure);
    expect(service.nextPreparationCompletion()).toBeNull();
  });

  it('repairs membership activity projection when MAX redelivers a duplicate join event', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
        updateMany: jest.fn(),
      },
      chatMembershipActivityEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-duplicate-join-1',
          type: 'user_added',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-duplicate-join-1',
            chatId: '-100200',
            chatTitle: 'Новый чат',
            entityType: 'channel',
            senderId: 'user-77',
            senderName: 'Пользователь',
            text: '',
            createdAt: new Date('2026-04-06T00:00:00.000Z').toISOString(),
          },
          membership: {
            action: 'added',
            memberUserIds: ['user-77'],
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: true });

    expect(prisma.chatMembershipActivityEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: 'u-duplicate-join-1',
          dedupeKey: 'membership:user_added:-100200:user-77:2026-04-06T00:00:00.000Z',
          chatId: '-100200',
          eventType: 'user_added',
          userId: 'user-77',
          senderName: 'Пользователь',
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('repairs blank membership names and snapshots service-event targets on duplicate delivery', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
        updateMany: jest.fn(),
      },
      chatUserDisplayName: {},
      $executeRaw: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-duplicate-service-membership-name',
          type: 'message_created',
          message: {
            messageId: 'mid-duplicate-service-membership-name',
            chatId: '-100200',
            senderId: 'admin-1',
            senderName: 'Админ',
            text: '',
            createdAt: new Date('2026-07-14T10:00:00.000Z').toISOString(),
          },
          membership: {
            action: 'added',
            memberUserIds: ['user-1001'],
          },
          raw: {
            message: {
              new_members: [
                {
                  user_id: 'user-1001',
                  display_name: 'Первый участник',
                },
              ],
            },
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: true });

    const queries = prisma.$executeRaw.mock.calls.map(([query]) => query);
    const membershipQuery = queries.find((query) =>
      extractSqlText(query).includes('INSERT INTO "chat_membership_activity_events"'),
    );
    const snapshotQuery = queries.find((query) =>
      extractSqlText(query).includes('INSERT INTO "chat_user_display_names"'),
    );

    expect(membershipQuery).toBeDefined();
    const membershipSql = extractSqlText(membershipQuery);
    const compactMembershipSql = membershipSql.replace(/\s+/gu, ' ').trim();
    expect(membershipSql).toContain('WITH incoming');
    expect(membershipSql).toContain('ON CONFLICT ("dedupe_key") DO UPDATE SET');
    expect(membershipSql).toContain("COALESCE(BTRIM(existing.\"sender_name\"), '') = ''");
    expect(membershipSql).toContain('GREATEST(existing."event_at", EXCLUDED."event_at")');
    expect(compactMembershipSql).toContain(
      'existing."bot_id" IS NULL AND EXCLUDED."bot_id" IS NOT NULL',
    );
    expect(compactMembershipSql).toContain(
      "COALESCE(BTRIM(existing.\"sender_name\"), '') = '' AND COALESCE(BTRIM(EXCLUDED.\"sender_name\"), '') <> ''",
    );
    expect(compactMembershipSql).toContain('existing."event_at" < EXCLUDED."event_at"');
    expect(membershipSql).toMatch(/::timestamp\(3\)[\s\S]*::timestamp\(3\)/u);
    expect(snapshotQuery).toBeDefined();
    expect(extractSqlValues(snapshotQuery)).toEqual(
      expect.arrayContaining([
        '-100200',
        'user-1001',
        'Первый участник',
        'u-duplicate-service-membership-name',
        'membership:added',
      ]),
    );
  });

  it('best-effort invalidates remote membership lookups for join and leave events', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn(async ({ data }: { data: FixtureRow }) => ({ id: data.id })),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const membershipLookup = {
      invalidateMemberships: jest.fn().mockResolvedValue(undefined),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      membershipLookup as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-join-1',
          type: 'user_added',
          message: {
            messageId: 'user_added:u-join-1',
            chatId: 'chat-1',
            senderId: 'user-10',
            text: '',
            createdAt: new Date('2026-03-29T12:00:00.000Z').toISOString(),
          },
          membership: {
            action: 'added',
            memberUserIds: ['user-10'],
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });
    await expect(
      service.ingest(
        {
          updateId: 'u-leave-1',
          type: 'user_removed',
          message: {
            messageId: 'user_removed:u-leave-1',
            chatId: 'chat-1',
            senderId: 'user-10',
            text: '',
            createdAt: new Date('2026-03-29T12:00:01.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    await flushDeferredWebhookWork();

    expect(membershipLookup.invalidateMemberships).toHaveBeenNthCalledWith(1, 'chat-1', [
      'user-10',
    ]);
    expect(membershipLookup.invalidateMemberships).toHaveBeenNthCalledWith(2, 'chat-1', [
      'user-10',
    ]);
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(2);
  });

  it('keeps a committed denial recoverable when downstream membership cache invalidation fails', async () => {
    const fixture = createAtomicMembershipFixture();
    const lookup = {
      invalidateMemberships: jest.fn().mockRejectedValue(new Error('Redis unavailable')),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      lookup as never,
    );
    const update = buildMembershipUpdate({
      updateId: 'cache-recovery',
      type: 'user_removed',
      createdAt: '2026-07-20T10:00:00.123Z',
    });
    await expect(service.ingest(update, '127.0.0.1')).rejects.toMatchObject({
      code: 'WEBHOOK_PREPARATION_DEFERRED',
    });
    expect(fixture.operations).toContain('transaction:commit');
    expect(fixture.tx.managedEntityAccessEdge.updateMany).toHaveBeenCalled();
    lookup.invalidateMemberships.mockResolvedValue(undefined);
    expect(
      (await service.preparePersistedWebhookEvent('evt-atomic-membership', update)).prepared,
    ).toBe(true);
    await service.onModuleDestroy();
  });

  it('commits membership activity, denial, and allowlist cleanup before publishing cache epochs', async () => {
    const fixture = createAtomicMembershipFixture();
    const eventAt = new Date('2026-07-20T10:00:00.123Z');
    const chatContextCache = {
      invalidateLocal: jest.fn((chatId: string) => {
        fixture.operations.push(`cache-local:${chatId}`);
      }),
      applyAdminAccessEpochMutation: jest.fn(async ({ userId }: { userId: string }) => {
        fixture.operations.push(`cache:${userId}`);
        return true;
      }),
    };
    const webhookIngressMetricsService = {
      recordMembershipCacheMutation: jest.fn(),
      recordMembershipCacheBudget: jest.fn(),
      recordMembershipCacheDetachedWork: jest.fn(),
      recordMembershipAccessEdgeAdvance: jest.fn(),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      webhookIngressMetricsService as never,
    );

    await expect(
      service.ingest(
        buildMembershipUpdate({
          updateId: 'u-atomic-remove',
          type: 'user_removed',
          createdAt: eventAt.toISOString(),
        }),
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(fixture.operations).toEqual([
      'transaction:start',
      'transaction:commit',
      'transaction:start',
      'chat:create',
      'chat:lock',
      'activity:upsert',
      'edge:deny',
      'admin:delete',
      'edge:newer',
      'admin:newer',
      'allowlist:delete',
      'transaction:commit',
      'cache-local:-100-membership',
      'cache:user-1',
      'cache:iduser-1',
      'transaction:start',
      'transaction:commit',
    ]);
    expect(fixture.tx.managedEntityAccessEdge.updateMany).toHaveBeenCalledWith({
      where: {
        chatId: '-100-membership',
        userId: { in: ['user-1', 'iduser-1'] },
        OR: [
          { checkedAt: { lt: eventAt } },
          {
            checkedAt: eventAt,
            OR: [
              { state: { not: 'USER_DENIED' } },
              { userRole: { not: 'MEMBER' } },
              { botRole: { not: 'UNKNOWN' } },
              { expiresAt: { not: null } },
              { deniedReason: null },
              { deniedReason: { not: 'webhook_user_removed' } },
              { source: { not: 'webhook_user_removed' } },
            ],
          },
        ],
      },
      data: expect.objectContaining({
        state: 'USER_DENIED',
        checkedAt: eventAt,
        deniedReason: 'webhook_user_removed',
      }),
    });
    expect(fixture.tx.managedEntityAdminMember.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: '-100-membership',
        userId: { in: ['user-1', 'iduser-1'] },
        checkedAt: { lte: eventAt },
      },
    });
    expect(fixture.tx.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: '-100-membership',
        userId: { in: ['user-1', 'iduser-1'] },
      },
    });
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenNthCalledWith(
      1,
      {
        chatId: '-100-membership',
        userId: 'user-1',
        state: 'user_denied',
        eventAt,
      },
      {
        precheckSupersededEpoch: true,
        recordMetric: expect.any(Function),
      },
    );
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenNthCalledWith(
      2,
      {
        chatId: '-100-membership',
        userId: 'iduser-1',
        state: 'user_denied',
        eventAt,
      },
      {
        precheckSupersededEpoch: true,
        recordMetric: expect.any(Function),
      },
    );
    expect(webhookIngressMetricsService.recordMembershipAccessEdgeAdvance).toHaveBeenCalledWith({
      affectedRows: 1,
      durationMs: expect.any(Number),
    });
    expect(webhookIngressMetricsService.recordMembershipCacheBudget).toHaveBeenCalledWith({
      outcome: 'completed',
      durationMs: expect.any(Number),
    });
    expect(webhookIngressMetricsService.recordMembershipCacheDetachedWork).toHaveBeenCalledWith({
      outcome: 'completed',
      inFlight: 0,
    });
    expect(
      JSON.stringify(webhookIngressMetricsService.recordMembershipCacheBudget.mock.calls),
    ).not.toMatch(/u-atomic-remove|-100-membership|user-1/u);
  });

  it('preserves allowlist and cache state for every alias family with newer granted evidence', async () => {
    const fixture = createAtomicMembershipFixture({
      newerGrantedUserIds: ['iduser-1'],
      newerAdminUserIds: ['user-2'],
    });
    const eventAt = new Date('2026-07-20T10:01:00.000Z');
    const chatContextCache = {
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
    );

    await service.ingest(
      buildMembershipUpdate({
        updateId: 'u-old-remove',
        type: 'user_removed',
        createdAt: eventAt.toISOString(),
        userIds: ['user-1', 'user-2', 'user-3'],
      }),
      '127.0.0.1',
    );

    const allVariants = ['user-1', 'iduser-1', 'user-2', 'iduser-2', 'user-3', 'iduser-3'];
    expect(fixture.tx.managedEntityAccessEdge.findMany).toHaveBeenCalledWith({
      where: {
        chatId: '-100-membership',
        userId: { in: allVariants },
        state: 'GRANTED',
        checkedAt: { gt: eventAt },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    expect(fixture.tx.managedEntityAdminMember.findMany).toHaveBeenCalledWith({
      where: {
        chatId: '-100-membership',
        userId: { in: allVariants },
        checkedAt: { gt: eventAt },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    expect(fixture.tx.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: '-100-membership',
        userId: { in: ['user-3', 'iduser-3'] },
      },
    });
    expect(
      chatContextCache.applyAdminAccessEpochMutation.mock.calls.map(([args]) => args.userId),
    ).toEqual(['user-3', 'iduser-3']);
  });

  it('keeps committed membership denial when cache epoch publication fails', async () => {
    const fixture = createAtomicMembershipFixture();
    const chatContextCache = {
      invalidateLocal: jest.fn(),
      applyAdminAccessEpochMutation: jest.fn().mockRejectedValue(new Error('redis unavailable')),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
    );

    await expect(
      service.ingest(
        buildMembershipUpdate({
          updateId: 'u-remove-cache-failure',
          type: 'user_removed',
          createdAt: '2026-07-20T10:02:00.000Z',
        }),
        '127.0.0.1',
      ),
    ).rejects.toThrow('Committed membership denial cache publication failed');

    expect(fixture.operations).toContain('transaction:commit');
    expect(fixture.tx.managedEntityAccessEdge.updateMany).toHaveBeenCalledTimes(1);
    expect(fixture.tx.chatAdminAllowlist.deleteMany).toHaveBeenCalledTimes(1);
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(2);
  });

  it('retries only failed cache mutations after a partial publication failure', async () => {
    const fixture = createAtomicMembershipFixture();
    let aliasAttempts = 0;
    const chatContextCache = {
      invalidateLocal: jest.fn(),
      applyAdminAccessEpochMutation: jest.fn(
        async ({ userId }: { userId: string }): Promise<boolean> => {
          if (userId === 'iduser-1' && aliasAttempts++ === 0) {
            throw new Error('redis unavailable');
          }
          return true;
        },
      ),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
    );
    const createdAt = '2026-07-20T10:02:00.500Z';

    await expect(
      service.ingest(
        buildMembershipUpdate({
          updateId: 'u-remove-cache-partial-failure',
          type: 'user_removed',
          createdAt,
        }),
        '127.0.0.1',
      ),
    ).rejects.toThrow('Committed membership denial cache publication failed');

    await expect(
      service.ingest(
        buildMembershipUpdate({
          updateId: 'u-remove-cache-partial-failure-retry',
          type: 'user_removed',
          createdAt,
        }),
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(
      chatContextCache.applyAdminAccessEpochMutation.mock.calls.map(
        ([mutation]) => mutation.userId,
      ),
    ).toEqual(['user-1', 'iduser-1', 'iduser-1']);
  });

  it('fails retryably at the cache wait budget and drains late work during shutdown', async () => {
    const fixture = createAtomicMembershipFixture();
    let resolveMutation!: (value: boolean) => void;
    const pendingMutation = new Promise<boolean>((resolve) => {
      resolveMutation = resolve;
    });
    const chatContextCache = {
      invalidateLocal: jest.fn(),
      applyAdminAccessEpochMutation: jest.fn().mockReturnValue(pendingMutation),
    };
    const webhookIngressMetricsService = {
      recordMembershipCacheMutation: jest.fn(),
      recordMembershipCacheBudget: jest.fn(),
      recordMembershipCacheDetachedWork: jest.fn(),
      recordMembershipAccessEdgeAdvance: jest.fn(),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      webhookIngressMetricsService as never,
    );

    const timedOut = service.ingest(
      buildMembershipUpdate({
        updateId: 'u-remove-pending-cache',
        type: 'user_removed',
        createdAt: '2026-07-20T10:02:01.000Z',
      }),
      '127.0.0.1',
    );
    await expect(timedOut).rejects.toThrow(
      'Committed membership denial cache publication exceeded its wait budget',
    );
    await expect(timedOut).rejects.toMatchObject({
      code: 'WEBHOOK_PREPARATION_DEFERRED',
      retryAfterMs: 1_000,
    });
    expect(fixture.operations).toContain('transaction:commit');
    expect(chatContextCache.invalidateLocal).toHaveBeenCalledWith('-100-membership');
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(2);
    expect(webhookIngressMetricsService.recordMembershipCacheBudget).toHaveBeenCalledWith({
      outcome: 'timeout',
      durationMs: expect.any(Number),
    });
    expect(webhookIngressMetricsService.recordMembershipCacheDetachedWork).toHaveBeenCalledWith({
      outcome: 'timeout',
      inFlight: 2,
    });

    for (let retry = 0; retry < 5; retry += 1) {
      await expect(
        service.ingest(
          buildMembershipUpdate({
            updateId: `u-remove-pending-cache-retry-${retry}`,
            type: 'user_removed',
            createdAt: '2026-07-20T10:02:01.000Z',
          }),
          '127.0.0.1',
        ),
      ).rejects.toMatchObject({
        code: 'WEBHOOK_PREPARATION_DEFERRED',
        retryAfterMs: 1_000,
      });
    }
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(2);
    expect(
      webhookIngressMetricsService.recordMembershipCacheBudget.mock.calls.filter(
        ([metric]) => metric.outcome === 'timeout',
      ),
    ).toHaveLength(1);

    const shutdown = service.onModuleDestroy();
    resolveMutation(true);
    await shutdown;
    await flushDeferredWebhookWork();

    expect(webhookIngressMetricsService.recordMembershipCacheDetachedWork).toHaveBeenCalledWith({
      outcome: 'completed',
      inFlight: 0,
    });

    await expect(
      service.ingest(
        buildMembershipUpdate({
          updateId: 'u-remove-during-shutdown',
          type: 'user_removed',
          createdAt: '2026-07-20T10:02:02.000Z',
        }),
        '127.0.0.1',
      ),
    ).rejects.toThrow('Webhook preparation capacity unavailable');
    expect(chatContextCache.invalidateLocal).toHaveBeenCalledTimes(6);
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(2);
  });

  it('observes a late cache publication coordinator rejection after the wait budget', async () => {
    const fixture = createAtomicMembershipFixture();
    const chatContextCache = {
      invalidateLocal: jest.fn(),
      applyAdminAccessEpochMutation: jest.fn(),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      { get: jest.fn().mockReturnValue(2) } as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
    );
    let rejectPublication!: (error: Error) => void;
    const latePublication = new Promise<never>((_resolve, reject) => {
      rejectPublication = reject;
    });
    const runPublication = jest
      .spyOn(service as any, 'runMembershipDenialCachePublication')
      .mockReturnValue(latePublication);
    const warn = jest.spyOn((service as any).logger, 'warn');

    await expect(
      service.ingest(
        buildMembershipUpdate({
          updateId: 'u-remove-late-cache-coordinator-failure',
          type: 'user_removed',
          createdAt: '2026-07-20T10:02:01.500Z',
        }),
        '127.0.0.1',
      ),
    ).rejects.toThrow('Committed membership denial cache publication exceeded its wait budget');

    for (let retry = 0; retry < 5; retry += 1) {
      await expect(
        service.ingest(
          buildMembershipUpdate({
            updateId: `u-remove-late-cache-coordinator-failure-retry-${retry}`,
            type: 'user_removed',
            createdAt: '2026-07-20T10:02:01.500Z',
          }),
          '127.0.0.1',
        ),
      ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
    }
    expect(runPublication).toHaveBeenCalledTimes(1);

    rejectPublication(new Error('coordinator failed late'));
    await flushDeferredWebhookWork();

    const lateFailureLogs = warn.mock.calls.filter(
      ([, message]) =>
        message === 'Committed membership denial cache publication failed after its wait budget',
    );
    expect(lateFailureLogs).toEqual([
      [
        {
          type: 'user_removed',
          err: 'coordinator failed late',
        },
        'Committed membership denial cache publication failed after its wait budget',
      ],
    ]);
    await service.onModuleDestroy();
  });

  it('canonicalizes shared pending publications and bounds distinct subset coordinators', async () => {
    const fixture = createAtomicMembershipFixture();
    const neverSettles = new Promise<boolean>(() => undefined);
    const chatContextCache = {
      invalidateLocal: jest.fn(),
      applyAdminAccessEpochMutation: jest.fn().mockReturnValue(neverSettles),
    };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === 'WEBHOOK_MEMBERSHIP_CACHE_MAX_IN_FLIGHT' ? 6 : fallback,
      ),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
    );
    const runPublication = jest.spyOn(service as any, 'runMembershipDenialCachePublication');
    const createdAt = '2026-07-20T10:02:01.750Z';

    await expect(
      service.ingest(
        buildMembershipUpdate({
          updateId: 'u-remove-shared-pending-full',
          type: 'user_removed',
          createdAt,
          userIds: ['user-1', 'user-2', 'user-3'],
        }),
        '127.0.0.1',
      ),
    ).rejects.toThrow('Committed membership denial cache publication exceeded its wait budget');
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(6);

    await expect(
      service.ingest(
        buildMembershipUpdate({
          updateId: 'u-remove-shared-pending-reordered',
          type: 'user_removed',
          createdAt,
          userIds: ['user-3', 'user-2', 'user-1'],
        }),
        '127.0.0.1',
      ),
    ).rejects.toThrow('Committed membership denial cache publication exceeded its wait budget');
    expect(runPublication).toHaveBeenCalledTimes(1);
    expect((service as any).membershipDenialCachePendingPublicationCount).toBe(1);

    const admittedSubsets = [
      ['user-1'],
      ['user-2'],
      ['user-3'],
      ['user-1', 'user-2'],
      ['user-1', 'user-3'],
    ];
    const subsetOutcomes: unknown[] = [];
    // Each timed-out publication remains pending in the existing denial coordinator.
    // Sequential admission isolates its six-entry bound from the outer preparation bound.
    for (const [index, userIds] of admittedSubsets.entries()) {
      subsetOutcomes.push(
        await service
          .ingest(
            buildMembershipUpdate({
              updateId: `u-remove-shared-pending-subset-${index}`,
              type: 'user_removed',
              createdAt,
              userIds,
            }),
            '127.0.0.1',
          )
          .catch((error: unknown) => error),
      );
    }
    expect(subsetOutcomes).toHaveLength(5);
    for (const outcome of subsetOutcomes) {
      expect(outcome).toBeInstanceOf(WebhookPreparationDeferredError);
    }
    expect((service as any).membershipDenialCachePendingPublicationCount).toBe(6);
    expect((service as any).membershipDenialCachePublications).toHaveProperty('size', 6);
    expect(runPublication).toHaveBeenCalledTimes(6);

    await expect(
      service.ingest(
        buildMembershipUpdate({
          updateId: 'u-remove-shared-pending-over-cap',
          type: 'user_removed',
          createdAt,
          userIds: ['user-2', 'user-3'],
        }),
        '127.0.0.1',
      ),
    ).rejects.toThrow('Committed membership denial cache publication capacity is unavailable');
    expect((service as any).membershipDenialCachePendingPublicationCount).toBe(6);
    expect((service as any).membershipDenialCachePublications).toHaveProperty('size', 6);
    expect(runPublication).toHaveBeenCalledTimes(6);
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(6);
  });

  it('bounds a burst and rejects excess cache work for durable webhook retry', async () => {
    const fixture = createAtomicMembershipFixture();
    const mutationResolvers: Array<(value: boolean) => void> = [];
    const chatContextCache = {
      invalidateLocal: jest.fn(),
      applyAdminAccessEpochMutation: jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            mutationResolvers.push(resolve);
          }),
      ),
    };
    const webhookIngressMetricsService = {
      recordMembershipCacheMutation: jest.fn(),
      recordMembershipCacheBudget: jest.fn(),
      recordMembershipCacheDetachedWork: jest.fn(),
      recordMembershipAccessEdgeAdvance: jest.fn(),
    };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === 'WEBHOOK_MEMBERSHIP_CACHE_MAX_IN_FLIGHT' ? 2 : fallback,
      ),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      webhookIngressMetricsService as never,
    );

    const firstOutcome = service
      .ingest(
        buildMembershipUpdate({
          updateId: 'u-remove-burst-first',
          type: 'user_removed',
          createdAt: '2026-07-20T10:03:00.000Z',
        }),
        '127.0.0.1',
      )
      .catch((error: unknown) => error);
    await flushDeferredWebhookWork();
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(2);

    const rejected = service.ingest(
      buildMembershipUpdate({
        updateId: 'u-remove-burst-rejected',
        type: 'user_removed',
        createdAt: '2026-07-20T10:03:01.000Z',
      }),
      '127.0.0.1',
    );
    await expect(rejected).rejects.toThrow(
      'Committed membership denial cache publication capacity is unavailable',
    );
    await expect(rejected).rejects.toBeInstanceOf(WebhookPreparationDeferredError);

    expect(chatContextCache.invalidateLocal).toHaveBeenCalledTimes(2);
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(2);
    expect(webhookIngressMetricsService.recordMembershipCacheDetachedWork).toHaveBeenCalledWith({
      outcome: 'rejected',
      count: 2,
      inFlight: 2,
    });
    await expect(firstOutcome).resolves.toBeInstanceOf(Error);

    for (const resolve of mutationResolvers) {
      resolve(true);
    }
    await flushDeferredWebhookWork();
    await service.onModuleDestroy();
  });

  it('publishes an oversized membership event in bounded waves and reuses its settled result', async () => {
    const fixture = createAtomicMembershipFixture();
    let activeMutationCount = 0;
    let peakMutationCount = 0;
    const pendingMutations: Array<{ resolve: () => void }> = [];
    const chatContextCache = {
      invalidateLocal: jest.fn(),
      applyAdminAccessEpochMutation: jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            activeMutationCount += 1;
            peakMutationCount = Math.max(peakMutationCount, activeMutationCount);
            pendingMutations.push({
              resolve: () => {
                activeMutationCount -= 1;
                resolve(true);
              },
            });
          }),
      ),
    };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === 'WEBHOOK_MEMBERSHIP_CACHE_MAX_IN_FLIGHT' ? 2 : fallback,
      ),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
    );
    const createdAt = '2026-07-20T10:04:00.000Z';
    const oversized = service.ingest(
      buildMembershipUpdate({
        updateId: 'u-remove-oversized',
        type: 'user_removed',
        createdAt,
        userIds: ['user-1', 'user-2'],
      }),
      '127.0.0.1',
    );

    await flushDeferredWebhookWork();
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(2);
    expect(peakMutationCount).toBe(2);

    for (const mutation of pendingMutations.splice(0)) {
      mutation.resolve();
    }
    await flushDeferredWebhookWork();
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(4);
    expect(peakMutationCount).toBe(2);

    for (const mutation of pendingMutations.splice(0)) {
      mutation.resolve();
    }
    await expect(oversized).resolves.toEqual({ accepted: true, duplicate: false });
    expect(activeMutationCount).toBe(0);

    await expect(
      service.ingest(
        buildMembershipUpdate({
          updateId: 'u-remove-oversized-retry',
          type: 'user_removed',
          createdAt,
          userIds: ['user-1', 'user-2'],
        }),
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(4);

    const later = service.ingest(
      buildMembershipUpdate({
        updateId: 'u-remove-after-settled-cache',
        type: 'user_removed',
        createdAt: '2026-07-20T10:04:01.000Z',
      }),
      '127.0.0.1',
    );
    await flushDeferredWebhookWork();
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(6);
    for (const mutation of pendingMutations.splice(0)) {
      mutation.resolve();
    }
    await expect(later).resolves.toEqual({ accepted: true, duplicate: false });
    expect(peakMutationCount).toBe(2);
  });

  it('resets prior admin evidence when user_added starts a new membership session', async () => {
    const fixture = createAtomicMembershipFixture();
    const chatContextCache = {
      applyAdminAccessEpochMutation: jest.fn(async ({ userId }: { userId: string }) => {
        fixture.operations.push(`cache:${userId}`);
        return true;
      }),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
    );

    await service.ingest(
      buildMembershipUpdate({
        updateId: 'u-atomic-add',
        type: 'user_added',
        createdAt: '2026-07-20T10:03:00.000Z',
      }),
      '127.0.0.1',
    );

    expect(fixture.operations).toEqual([
      'transaction:start',
      'transaction:commit',
      'transaction:start',
      'chat:create',
      'chat:lock',
      'activity:upsert',
      'edge:deny',
      'admin:delete',
      'edge:newer',
      'admin:newer',
      'allowlist:delete',
      'transaction:commit',
      'cache:user-1',
      'cache:iduser-1',
      'transaction:start',
      'transaction:commit',
    ]);
    expect(fixture.tx.managedEntityAccessEdge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'USER_DENIED',
          deniedReason: 'webhook_user_added',
          source: 'webhook_user_added',
        }),
      }),
    );
    expect(fixture.tx.managedEntityAdminMember.deleteMany).toHaveBeenCalledTimes(1);
    expect(fixture.tx.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: '-100-membership',
        userId: { in: ['user-1', 'iduser-1'] },
      },
    });
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(2);
  });

  it('preserves a grant newer than user_added for the full MAX id alias family', async () => {
    const fixture = createAtomicMembershipFixture({
      newerGrantedUserIds: ['iduser-1'],
    });
    const chatContextCache = {
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
    );

    await service.ingest(
      buildMembershipUpdate({
        updateId: 'u-add-before-newer-grant',
        type: 'user_added',
        createdAt: '2026-07-20T10:03:01.000Z',
      }),
      '127.0.0.1',
    );

    expect(fixture.tx.chatAdminAllowlist.deleteMany).not.toHaveBeenCalled();
    expect(chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
  });

  it('advances the shared semantic removal row across rapid remove-add-remove updates', async () => {
    const fixture = createAtomicMembershipFixture();
    const service = new WebhookService(
      fixture.prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
    );

    await service.ingest(
      buildMembershipUpdate({
        updateId: 'u-rapid-remove-1',
        type: 'user_removed',
        createdAt: '2026-07-20T10:04:00.100Z',
      }),
      '127.0.0.1',
    );
    await service.ingest(
      buildMembershipUpdate({
        updateId: 'u-rapid-add',
        type: 'user_added',
        createdAt: '2026-07-20T10:04:00.500Z',
      }),
      '127.0.0.1',
    );
    await service.ingest(
      buildMembershipUpdate({
        updateId: 'u-rapid-remove-2',
        type: 'user_removed',
        createdAt: '2026-07-20T10:04:00.900Z',
      }),
      '127.0.0.1',
    );

    const projectionQueries = fixture.tx.$executeRaw.mock.calls.map(([query]) => query);
    const projectionValues = projectionQueries.map(extractSqlValues);
    expect(projectionValues.map((values) => values[1])).toEqual([
      'membership:user_removed:-100-membership:user-1:2026-07-20T10:04:00.000Z',
      'membership:user_added:-100-membership:user-1:2026-07-20T10:04:00.000Z',
      'membership:user_removed:-100-membership:user-1:2026-07-20T10:04:00.000Z',
    ]);
    expect(projectionValues.map((values) => values[7])).toEqual([
      new Date('2026-07-20T10:04:00.100Z'),
      new Date('2026-07-20T10:04:00.500Z'),
      new Date('2026-07-20T10:04:00.900Z'),
    ]);
    expect(projectionQueries.every((query) => extractSqlText(query).includes('GREATEST'))).toBe(
      true,
    );
  });

  it('repairs duplicate user_removed receipts through the atomic denial transition', async () => {
    const fixture = createAtomicMembershipFixture();
    fixture.prisma.webhookEvent.create.mockRejectedValueOnce({ code: 'P2002' });
    const chatContextCache = {
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
    };
    const service = new WebhookService(
      fixture.prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      chatContextCache as never,
    );

    await expect(
      service.ingest(
        buildMembershipUpdate({
          updateId: 'u-duplicate-remove',
          type: 'user_removed',
          createdAt: '2026-07-20T10:05:00.000Z',
        }),
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: true });

    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(fixture.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(fixture.tx.managedEntityAccessEdge.updateMany).toHaveBeenCalledTimes(1);
    expect(fixture.tx.chatAdminAllowlist.deleteMany).toHaveBeenCalledTimes(1);
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(2);
  });

  it('persists admin read models for membership and managed-entities activity when projection tables are available', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn(async ({ data }: { data: FixtureRow }) => ({ id: data.id })),
        updateMany: jest.fn(),
      },
      chatMembershipActivityEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedEntityLocalActivity: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-read-models-1',
          type: 'user_added',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-read-models-1',
            chatId: '-100200',
            chatTitle: 'Новый чат',
            entityType: 'channel',
            senderId: 'user-77',
            senderName: 'Пользователь',
            text: '',
            createdAt: new Date('2026-04-06T00:00:00.000Z').toISOString(),
          },
          membership: {
            action: 'added',
            memberUserIds: ['user-77'],
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });
    await expect(
      service.ingest(
        {
          updateId: 'u-read-models-2',
          type: 'message_created',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-read-models-2',
            chatId: '-100200',
            chatTitle: 'Новый чат',
            entityType: 'channel',
            senderId: 'user-77',
            senderName: 'Пользователь',
            text: 'hello',
            createdAt: new Date('2026-04-06T00:01:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    await flushDeferredWebhookWork();

    expect(prisma.chatMembershipActivityEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: 'u-read-models-1',
          dedupeKey: 'membership:user_added:-100200:user-77:2026-04-06T00:00:00.000Z',
          chatId: '-100200',
          eventType: 'user_added',
          userId: 'user-77',
          senderName: 'Пользователь',
        }),
      ],
      skipDuplicates: true,
    });
    expect(prisma.managedEntityLocalActivity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_chatId: {
            userId: 'user-77',
            chatId: '-100200',
          },
        },
        create: expect.objectContaining({
          sourceEventType: 'user_added',
        }),
      }),
    );
    expect(prisma.managedEntityLocalActivity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_chatId: {
            userId: 'user-77',
            chatId: '-100200',
          },
        },
        create: expect.objectContaining({
          sourceEventType: 'message_created',
        }),
      }),
    );
  });

  it('uses an atomic SQL upsert for managed-entities activity on real Prisma clients', async () => {
    const eventAt = new Date('2026-04-06T00:03:00.000Z');
    const prisma = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-managed-raw-upsert' }),
        updateMany: jest.fn(),
      },
      managedEntityLocalActivity: {
        updateMany: jest.fn(),
        create: jest.fn(),
        upsert: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-managed-raw-upsert-1',
          type: 'message_created',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-managed-raw-upsert-1',
            chatId: '-100201',
            chatTitle: 'Новый чат',
            entityType: 'channel',
            senderId: 'user-raw',
            senderName: 'Пользователь',
            text: 'hello',
            createdAt: eventAt.toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    await flushDeferredWebhookWork();

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.managedEntityLocalActivity.updateMany).not.toHaveBeenCalled();
    expect(prisma.managedEntityLocalActivity.create).not.toHaveBeenCalled();
    expect(prisma.managedEntityLocalActivity.upsert).not.toHaveBeenCalled();

    const rawQuery = prisma.$executeRaw.mock.calls[0]?.[0];
    const sql = extractSqlText(rawQuery).replace(/\s+/g, ' ');
    expect(sql).toContain('INSERT INTO managed_entity_local_activities');
    expect(sql).toContain('ON CONFLICT (user_id, chat_id) DO UPDATE SET');
    expect(sql).toContain(
      'chat_title = COALESCE(EXCLUDED.chat_title, managed_entity_local_activities.chat_title)',
    );
    expect(sql).toContain(
      'WHERE managed_entity_local_activities.last_event_at < EXCLUDED.last_event_at',
    );
    expect(extractSqlValues(rawQuery)).toEqual([
      'user-raw',
      '-100201',
      'CHANNEL',
      'Новый чат',
      'message_created',
      'id613002203036_bot',
      eventAt,
    ]);
  });

  it('persists managed-entities activity for chat_title_changed updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-title-activity' }),
        updateMany: jest.fn(),
      },
      managedEntityLocalActivity: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const eventAt = new Date('2026-04-06T00:02:00.000Z');

    await expect(
      service.ingest(
        {
          updateId: 'u-title-activity-1',
          type: 'chat_title_changed',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'chat_title_changed:u-title-activity-1',
            chatId: '-100200',
            chatTitle: 'Новое название',
            entityType: 'chat',
            senderId: 'user-title-77',
            senderName: 'Редактор',
            text: '',
            createdAt: eventAt.toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    await flushDeferredWebhookWork();

    expect(prisma.managedEntityLocalActivity.upsert).toHaveBeenCalledWith({
      where: {
        userId_chatId: {
          userId: 'user-title-77',
          chatId: '-100200',
        },
      },
      create: {
        userId: 'user-title-77',
        chatId: '-100200',
        entityType: 'CHAT',
        chatTitle: 'Новое название',
        sourceEventType: 'chat_title_changed',
        botId: 'id613002203036_bot',
        lastEventAt: eventAt,
      },
      update: {
        entityType: 'CHAT',
        chatTitle: 'Новое название',
        sourceEventType: 'chat_title_changed',
        botId: 'id613002203036_bot',
        lastEventAt: eventAt,
      },
    });
  });

  it('persists service message membership collections as per-member activity events', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-service-membership' }),
        updateMany: jest.fn(),
      },
      chatMembershipActivityEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      managedEntityLocalActivity: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-service-membership-1',
          type: 'message_created',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-service-membership-1',
            chatId: '-100200',
            chatTitle: 'Новый чат',
            entityType: 'chat',
            senderId: 'admin-1',
            senderName: 'Админ',
            text: '',
            createdAt: new Date('2026-04-06T02:00:00.000Z').toISOString(),
          },
          membership: {
            action: 'added',
            memberUserIds: ['user-1001', 'user-1002'],
          },
          raw: {
            update_type: 'message_created',
            timestamp: Date.parse('2026-04-06T02:00:00.000Z'),
            message: {
              new_members: [
                {
                  user_id: 'user-1001',
                  display_name: 'Первый участник',
                  name: 'Первый',
                },
                {
                  user: {
                    user_id: 'user-1002',
                    first_name: 'Второй',
                    last_name: 'Участник',
                    name: 'Второй',
                  },
                },
              ],
            },
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(prisma.chatMembershipActivityEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: 'u-service-membership-1:user_added:user-1001',
          dedupeKey: 'membership:user_added:-100200:user-1001:2026-04-06T02:00:00.000Z',
          eventType: 'user_added',
          userId: 'user-1001',
          senderName: 'Первый участник',
        }),
        expect.objectContaining({
          id: 'u-service-membership-1:user_added:user-1002',
          dedupeKey: 'membership:user_added:-100200:user-1002:2026-04-06T02:00:00.000Z',
          eventType: 'user_added',
          userId: 'user-1002',
          senderName: 'Второй Участник',
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('persists service message removals as left membership activity events', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-service-membership-left' }),
        updateMany: jest.fn(),
      },
      chatMembershipActivityEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-service-membership-left-1',
          type: 'message_created',
          message: {
            messageId: 'mid-service-membership-left-1',
            chatId: '-100200',
            entityType: 'channel',
            senderId: 'admin-1',
            text: '',
            createdAt: new Date('2026-04-06T02:01:00.000Z').toISOString(),
          },
          membership: {
            action: 'removed',
            memberUserIds: ['user-1003'],
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(prisma.chatMembershipActivityEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: 'u-service-membership-left-1',
          dedupeKey: 'membership:user_removed:-100200:user-1003:2026-04-06T02:01:00.000Z',
          eventType: 'user_removed',
          userId: 'user-1003',
          senderName: null,
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('keeps the membership projection dedupe key stable across distinct millisecond updates from different bots', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn(async ({ data }: { data: FixtureRow }) => ({ id: data.id })),
        updateMany: jest.fn(),
      },
      chatMembershipActivityEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedEntityLocalActivity: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await service.ingest(
      {
        updateId: 'u-membership-dedupe-1',
        type: 'user_added',
        botId: 'id613002203036_bot',
        message: {
          messageId: 'mid-membership-dedupe-1',
          chatId: '-100333',
          senderId: 'user-88',
          senderName: 'Ольга',
          text: '',
          createdAt: new Date('2026-04-06T01:00:00.000Z').toISOString(),
        },
        membership: {
          action: 'added',
          memberUserIds: ['user-88'],
        },
      },
      '127.0.0.1',
    );

    await flushDeferredWebhookWork();

    await service.ingest(
      {
        updateId: 'u-membership-dedupe-2',
        type: 'user_added',
        botId: 'id613002203036_4_bot',
        message: {
          messageId: 'mid-membership-dedupe-2',
          chatId: '-100333',
          senderId: 'user-88',
          senderName: 'Ольга',
          text: '',
          createdAt: new Date('2026-04-06T01:00:00.001Z').toISOString(),
        },
        membership: {
          action: 'added',
          memberUserIds: ['user-88'],
        },
      },
      '127.0.0.1',
    );

    await flushDeferredWebhookWork();

    const firstCall = prisma.chatMembershipActivityEvent.createMany.mock.calls[0]?.[0];
    const secondCall = prisma.chatMembershipActivityEvent.createMany.mock.calls[1]?.[0];
    expect(firstCall?.data?.[0]?.dedupeKey).toBe(
      'membership:user_added:-100333:user-88:2026-04-06T01:00:00.000Z',
    );
    expect(secondCall?.data?.[0]?.dedupeKey).toBe(
      'membership:user_added:-100333:user-88:2026-04-06T01:00:00.000Z',
    );
    expect(prisma.chatMembershipActivityEvent.createMany).toHaveBeenCalledTimes(2);
  });

  it('marks bot membership removed instead of rebinding it on bot_removed updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-4' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-removed-1',
          type: 'bot_removed',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'bot_removed:u-bot-removed-1',
            chatId: '-100123',
            chatTitle: 'Shared chat',
            entityType: 'channel',
            senderId: 'id613002203036_4_bot',
            text: '',
            createdAt: new Date('2026-03-30T12:00:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.markChatBotRemoved).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100123',
        title: 'Shared chat',
        entityType: 'CHANNEL',
        botId: 'id613002203036_4_bot',
      }),
    );
    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100123',
        botId: 'id613002203036_4_bot',
      }),
    );
  });

  it('routes a trusted bot removal through access-loss cleanup without marking it twice', async () => {
    const lifecycleEventAt = new Date('2026-08-20T12:00:00.123Z');
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-removal-cleanup' }),
        updateMany: jest.fn(),
      },
    };
    const managedEntityAccessLossService = {
      recordManagedEntityAccessLost: jest.fn().mockResolvedValue({
        nextOwnerBotId: 'bot-2',
      }),
    };
    const service = new WebhookService(
      prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
      undefined,
      undefined,
      managedEntityAccessLossService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-removed-cleanup',
          type: 'bot_removed',
          botId: 'bot-1',
          eventTimestampSource: 'payload',
          message: {
            messageId: 'bot_removed:u-bot-removed-cleanup',
            chatId: '-100-removal-cleanup',
            chatTitle: 'Shared chat',
            entityType: 'chat',
            senderId: 'admin-1',
            text: '',
            createdAt: lifecycleEventAt.toISOString(),
          },
        } as MaxUpdate,
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(managedEntityAccessLossService.recordManagedEntityAccessLost).toHaveBeenCalledTimes(1);
    expect(managedEntityAccessLossService.recordManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: '-100-removal-cleanup',
      title: 'Shared chat',
      entityType: ChatEntityType.CHAT,
      botId: 'bot-1',
      reason: 'bot_removed',
      source: 'webhook_bot_removed',
      lifecycleEventAt,
      lifecycleEventType: 'bot_removed',
      lifecycleSource: 'webhook',
      cachePublicationWaitMs: 100,
    });
    expect(maxBotLinkService.markChatBotRemoved).not.toHaveBeenCalled();
    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100-removal-cleanup',
        botIds: ['bot-1'],
        source: 'webhook_bot_removed',
      }),
    );
  });

  it('keeps a lifecycle receipt retryable when removal persistence fails', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-removal-db-failure' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    maxBotLinkService.markChatBotRemoved.mockRejectedValueOnce(
      new Error('temporary membership write failure'),
    );
    const service = new WebhookService(
      prisma as never,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'WEBHOOK_CANONICAL_EXECUTION_MODE' ? 'off' : (fallback ?? 1),
        ),
      } as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-removal-db-failure',
          type: 'bot_removed',
          botId: 'bot-1',
          message: {
            messageId: 'bot_removed:u-removal-db-failure',
            chatId: '-100-removal-db-failure',
            chatTitle: 'Shared chat',
            entityType: 'chat',
            senderId: 'bot-1',
            text: '',
            createdAt: '2026-07-10T12:00:00.123Z',
          },
        },
        '127.0.0.1',
      ),
    ).rejects.toThrow('temporary membership write failure');

    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
  });

  it('does not apply a terminal lifecycle transition without a trusted event timestamp', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-untrusted-removal' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('owner-bot');
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-removed-without-event-time',
          type: 'bot_removed',
          botId: 'standby-bot',
          eventTimestampSource: 'ingress',
          message: {
            messageId: 'bot_removed:u-bot-removed-without-event-time',
            chatId: '-100-untrusted-removal',
            chatTitle: 'Shared chat',
            entityType: 'chat',
            senderId: 'standby-bot',
            text: '',
            createdAt: new Date().toISOString(),
          },
        } as MaxUpdate,
        '127.0.0.1',
      ),
    ).rejects.toThrow('Legacy semantic execution requires exact proof recovery');

    expect(maxBotLinkService.markChatBotRemoved).not.toHaveBeenCalled();
    expect(maxBotLinkService.getStoredChatPrimaryBotId).not.toHaveBeenCalled();
    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          errorMessage: expect.stringContaining('LEGACY_EXECUTION_UNVERIFIED'),
        }),
      }),
    );
  });

  it('parses an official bot_removed actor payload and removes the authenticated ingress bot', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-4b' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    maxBotLinkService.markChatBotRemoved.mockResolvedValueOnce('id613002203036_bot');
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );
    const update = new WebhookParser().parse(
      {
        update_id: 'u-bot-removed-official-1',
        update_type: 'bot_removed',
        chat_id: -73729721862151,
        chat: {
          chat_id: -73729721862151,
          chat_type: 'chat',
          title: 'Пантера',
        },
        user: {
          user_id: 900001,
          first_name: 'Иван',
          last_name: 'Администратор',
        },
        timestamp: '2026-05-10T02:10:01.411Z',
      },
      { botId: 'id613002203036_bot' },
    );

    expect(update.message).toEqual(
      expect.objectContaining({
        senderId: '900001',
        senderName: 'Иван Администратор',
      }),
    );
    expect(update.membership).toEqual({
      action: 'removed',
      memberUserIds: ['id613002203036_bot'],
    });
    await expect(service.ingest(update, '127.0.0.1')).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });

    expect(maxBotLinkService.markChatBotRemoved).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
        title: 'Пантера',
        entityType: 'CHAT',
        botId: 'id613002203036_bot',
      }),
    );
    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
        botIds: ['id613002203036_bot'],
        source: 'webhook_bot_removed',
      }),
    );
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            botId: 'id613002203036_bot',
            executionOwnerBotId: 'id613002203036_bot',
            message: expect.objectContaining({ senderId: '900001' }),
          }),
        }),
      }),
    );
  });

  it('does not let a bot-like human actor redirect bot_removed away from the ingress bot', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-4bb' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    maxBotLinkService.markChatBotRemoved.mockResolvedValueOnce(null);
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-removed-actor-looks-like-bot',
          type: 'bot_removed',
          botId: 'bot-1',
          message: {
            messageId: 'bot_removed:u-bot-removed-actor-looks-like-bot',
            chatId: '-73729721862152',
            chatTitle: 'Shared N-way chat',
            entityType: 'chat',
            senderId: '5005',
            senderName: 'Human actor',
            text: '',
            createdAt: new Date('2026-05-10T02:12:01.411Z').toISOString(),
          },
          raw: {
            update_type: 'bot_removed',
            timestamp: Date.parse('2026-05-10T02:12:01.411Z'),
            chat_id: -73729721862152,
            user: {
              id: 'bot-5-contact',
              user_id: '5005',
              username: 'bot-5',
              name: 'Bot Five',
              is_bot: false,
            },
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.markChatBotRemoved).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.markChatBotRemoved).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862152',
        title: 'Shared N-way chat',
        entityType: 'CHAT',
        botId: 'bot-1',
      }),
    );
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            botId: 'bot-1',
          }),
        }),
      }),
    );
  });

  it('uses the authenticated bot subject even when bot_removed actor details are sparse', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-4c' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-removed-ambiguous-1',
          type: 'bot_removed',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'bot_removed:u-bot-removed-ambiguous-1',
            chatId: '-73729721862151',
            chatTitle: 'Пантера',
            entityType: 'chat',
            senderId: 'unknown-service-user',
            text: '',
            createdAt: new Date('2026-05-10T02:10:01.411Z').toISOString(),
          },
          raw: {
            update_type: 'bot_removed',
            timestamp: Date.parse('2026-05-10T02:10:01.411Z'),
            chat_id: -73729721862151,
            user: {
              user_id: 999999,
              is_bot: true,
            },
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.markChatBotRemoved).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
        title: 'Пантера',
        entityType: 'CHAT',
        botId: 'id613002203036_bot',
      }),
    );
  });

  it('observes extended terminal lifecycle updates without enforcing them in shadow mode', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-shadow-bot-stopped' }),
        updateMany: jest.fn(),
      },
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('bot-1');
    const service = new WebhookService(
      prisma as never,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'MAX_EXTENDED_WEBHOOK_LIFECYCLE_MODE' ? 'shadow' : fallback,
        ),
      } as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-shadow-bot-stopped',
          type: 'bot_stopped',
          botId: 'bot-1',
          eventTimestampSource: 'payload',
          message: {
            messageId: 'bot_stopped:u-shadow-bot-stopped',
            chatId: '-100-shadow-lifecycle',
            entityType: 'chat',
            senderId: 'user-1',
            text: '',
            createdAt: '2026-07-10T12:00:00.123Z',
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.markChatBotRemoved).not.toHaveBeenCalled();
    expect(maxBotLinkService.getStoredChatPrimaryBotId).toHaveBeenCalledWith(
      '-100-shadow-lifecycle',
      { bypassCache: true },
    );
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'evt-shadow-bot-stopped' }),
      }),
    );
  });

  it('requires fresh live probes before cached snapshots can fail over the execution owner', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-5' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['delete_messages'],
        }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');
    maxBotLinkService.bindChatToBot.mockResolvedValueOnce('id613002203036_4_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    (service as any).botSelfAccessCache.set('-100123:id613002203036_bot', {
      canHandleUserFacing: false,
      expiresAtMs: Date.now() + 60_000,
    });
    (service as any).botSelfAccessCache.set('-100123:id613002203036_4_bot', {
      canHandleUserFacing: true,
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      service.ingest(
        {
          updateId: 'u-failover-1',
          type: 'message_created',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-1',
            chatId: '-100123',
            chatTitle: 'Тестовый чат',
            senderId: 'user-1',
            text: 'https://spam.example',
            createdAt: new Date('2026-03-31T20:00:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(prisma.webhookEvent.create.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.getCurrentChatMemberAccess.mock.invocationCallOrder[0]!,
    );
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_4_bot',
          }),
        }),
      }),
    );

    await flushDeferredWebhookWork();

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.bindChatToBot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chatId: '-100123',
        botId: 'id613002203036_4_bot',
        allowReassign: true,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      }),
    );
  });

  it('runs a second accepted live probe after storing the binding lifecycle watermark', async () => {
    const chatId = '-100-live-probe-recovery';
    const botId = 'id613002203036_4_bot';
    const eventOrder: string[] = [];
    let confirmedAfterLifecycle = false;
    let routingState = 'NO_ELIGIBLE_BOT';
    let lifecycleEventAt: Date | null = null;
    let persistedAccessData: Record<string, unknown> | null = null;
    let probeCount = 0;
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-live-probe-recovery' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn(async () => {
        probeCount += 1;
        eventOrder.push(`probe-${probeCount}`);
        return {
          userId: botId,
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        };
      }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce(null);
    maxBotLinkService.ensureChatForAccessProbe.mockImplementationOnce(async () => {
      eventOrder.push('ensure-parent');
      return true;
    });
    maxBotLinkService.bindChatToBot.mockImplementationOnce(async (params) => {
      eventOrder.push('bind-lifecycle');
      lifecycleEventAt = params.lifecycleEventAt;
      return botId;
    });
    maxBotLinkService.recordBotAccessProbe.mockImplementation(
      async ({ access, checkedAt, source }) => {
        eventOrder.push(lifecycleEventAt ? 'persist-confirmed-access' : 'persist-before-bind');
        if (lifecycleEventAt) {
          persistedAccessData = {
            botAccessState: access ? 'CONFIRMED_ADMIN' : 'DENIED',
            botAccessCheckedAt: checkedAt,
            botAccessExpiresAt: new Date(checkedAt.getTime() + 60_000),
            botAccessSource: source,
          };
          confirmedAfterLifecycle =
            access !== null &&
            lifecycleEventAt instanceof Date &&
            checkedAt.getTime() >= lifecycleEventAt.getTime();
        }
        return true;
      },
    );
    maxBotLinkService.reconcileChatPrimaryByAccess.mockImplementation(async () => {
      eventOrder.push('reconcile-route');
      if (confirmedAfterLifecycle) {
        routingState = 'READY';
        return botId;
      }
      return null;
    });

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-live-probe-recovery',
          type: 'message_created',
          botId,
          message: {
            messageId: 'mid-live-probe-recovery',
            chatId,
            chatTitle: 'Lifecycle recovery',
            entityType: 'chat',
            senderId: 'user-1',
            text: 'hello',
            createdAt: new Date('2026-07-10T12:00:00.123Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId,
        botId,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      }),
    );
    expect(eventOrder.slice(0, 7)).toEqual([
      'ensure-parent',
      'probe-1',
      'persist-before-bind',
      'bind-lifecycle',
      'probe-2',
      'persist-confirmed-access',
      'reconcile-route',
    ]);
    expect(maxBotLinkService.bindDiscoveredChatBots).not.toHaveBeenCalled();
    expect(persistedAccessData).toEqual(
      expect.objectContaining({
        botAccessState: 'CONFIRMED_ADMIN',
        botAccessCheckedAt: expect.any(Date),
        botAccessExpiresAt: expect.any(Date),
        botAccessSource: 'webhook_owner_failover',
      }),
    );
    expect(routingState).toBe('READY');
  });

  it.each([
    { status: 401, code: 'chat.denied' },
    { status: 403, code: undefined },
    { status: 404, code: undefined },
    { status: 404, code: 'user.not.found' },
    { status: 503, code: 'chat.not.found' },
    { status: undefined, code: 'chat.denied' },
  ])(
    'keeps an opaque self-access failure unknown without persisting denial: %j',
    async ({ status, code }) => {
      const maxClient: Pick<
        import('../max/max-client.service').MaxClientService,
        'getCurrentChatMemberAccess'
      > = {
        getCurrentChatMemberAccess: jest.fn().mockRejectedValue({
          response: { status, data: { code, message: 'bot is not a chat member' } },
          message: 'not accessible',
        }),
      };
      const service = new WebhookService(
        { webhookEvent: {} } as never,
        { get: jest.fn() } as never,
        maxBotLinkService as never,
        undefined,
        maxClient as never,
      );
      const selfAccess = service as unknown as {
        getBotSelfModerationAccessState(
          chatId: string,
          botId: string,
          options: { bypassCache: boolean },
        ): Promise<boolean | null>;
      };

      await expect(
        selfAccess.getBotSelfModerationAccessState('chat-opaque', 'bot-opaque', {
          bypassCache: true,
        }),
      ).resolves.toBeNull();
      await expect(
        selfAccess.getBotSelfModerationAccessState('chat-opaque', 'bot-opaque', {
          bypassCache: true,
        }),
      ).resolves.toBeNull();
      expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
      expect(maxBotLinkService.recordBotAccessProbe).not.toHaveBeenCalled();
      expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
    },
  );

  it('suppresses repeated route-gap probes after a terminal bot access denial', async () => {
    const chatId = '-100-live-probe-denied';
    const botId = 'id613002203036_4_bot';
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockRejectedValue({
        response: { status: 403, data: { code: 'chat.denied' } },
        message: 'chat denied',
      }),
    };
    maxBotLinkService.recordBotAccessProbe.mockResolvedValue(false);
    const service = new WebhookService(
      { webhookEvent: {} } as never,
      { get: jest.fn() } as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    const update = {
      updateId: 'u-live-probe-denied',
      type: 'message_created',
      botId,
      message: {
        messageId: 'mid-live-probe-denied',
        chatId,
        chatTitle: 'Denied route',
        entityType: 'chat',
        senderId: 'user-1',
        text: 'hello',
        createdAt: '2026-07-10T12:00:00.123Z',
      },
    } satisfies MaxUpdate;

    await expect(
      (service as any).bindIncomingBotAfterLiveProbe(update, chatId, ChatEntityType.CHAT),
    ).resolves.toBeNull();
    await expect(
      (service as any).bindIncomingBotAfterLiveProbe(update, chatId, ChatEntityType.CHAT),
    ).resolves.toBeNull();

    expect(maxBotLinkService.ensureChatForAccessProbe).toHaveBeenCalledTimes(1);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.bindDiscoveredChatBots).not.toHaveBeenCalled();
    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();

    (service as any).botSelfAccessBackoffUntilMs.set(`${chatId}:${botId}`, Date.now() - 1);
    await expect(
      (service as any).bindIncomingBotAfterLiveProbe(update, chatId, ChatEntityType.CHAT),
    ).resolves.toBeNull();

    expect(maxBotLinkService.ensureChatForAccessProbe).toHaveBeenCalledTimes(2);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent route-gap recovery without collapsing the post-lifecycle probe', async () => {
    const chatId = '-100-live-probe-single-flight';
    const botId = 'id613002203036_4_bot';
    let releaseFirstProbe!: (access: {
      userId: string;
      isAdmin: boolean;
      isOwner: boolean;
      permissions: string[];
    }) => void;
    const firstProbe = new Promise<{
      userId: string;
      isAdmin: boolean;
      isOwner: boolean;
      permissions: string[];
    }>((resolve) => {
      releaseFirstProbe = resolve;
    });
    const grantedAccess = {
      userId: botId,
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockImplementationOnce(() => firstProbe)
        .mockResolvedValueOnce(grantedAccess),
    };
    maxBotLinkService.bindChatToBot.mockResolvedValue(botId);
    maxBotLinkService.recordBotAccessProbe.mockResolvedValue(true);
    maxBotLinkService.reconcileChatPrimaryByAccess.mockResolvedValue(botId);
    const service = new WebhookService(
      { webhookEvent: {} } as never,
      { get: jest.fn() } as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    const update = {
      updateId: 'u-live-probe-single-flight',
      type: 'message_created',
      botId,
      message: {
        messageId: 'mid-live-probe-single-flight',
        chatId,
        chatTitle: 'Single flight route',
        entityType: 'chat',
        senderId: 'user-1',
        text: 'hello',
        createdAt: '2026-07-10T12:00:00.123Z',
      },
    } satisfies MaxUpdate;

    const first = (service as any).bindIncomingBotAfterLiveProbe(
      update,
      chatId,
      ChatEntityType.CHAT,
    );
    const concurrent = (service as any).bindIncomingBotAfterLiveProbe(
      update,
      chatId,
      ChatEntityType.CHAT,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(maxBotLinkService.ensureChatForAccessProbe).toHaveBeenCalledTimes(1);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);

    releaseFirstProbe(grantedAccess);
    await expect(Promise.all([first, concurrent])).resolves.toEqual([botId, botId]);

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.reconcileChatPrimaryByAccess).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.bindDiscoveredChatBots).not.toHaveBeenCalled();
    expect((service as any).botSelfAccessRecoveryInFlight.size).toBe(0);
  });

  it('does not bind a stale successful probe when bot removal wins during the request', async () => {
    const chatId = '-100-live-probe-removal-race';
    const botId = 'id613002203036_4_bot';
    const probeStartedAt = new Date('2026-07-10T12:00:00.000Z');
    const probeCompletedAt = new Date('2026-07-10T12:00:10.000Z');
    let releaseProbe!: (access: {
      userId: string;
      isAdmin: boolean;
      isOwner: boolean;
      permissions: string[];
    }) => void;
    let reportProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      reportProbeStarted = resolve;
    });
    const probeResult = new Promise<{
      userId: string;
      isAdmin: boolean;
      isOwner: boolean;
      permissions: string[];
    }>((resolve) => {
      releaseProbe = resolve;
    });
    const prisma = {
      webhookEvent: {
        create: jest
          .fn()
          .mockResolvedValueOnce({ id: 'evt-live-probe-race-message' })
          .mockResolvedValueOnce({ id: 'evt-live-probe-race-removal' }),
        updateMany: jest.fn(),
      },
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn(() => {
        reportProbeStarted();
        return probeResult;
      }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce(null);
    maxBotLinkService.markChatBotRemoved.mockResolvedValueOnce(null);
    maxBotLinkService.recordBotAccessProbe.mockResolvedValueOnce(false);

    jest.useFakeTimers();
    try {
      jest.setSystemTime(probeStartedAt);
      const service = new WebhookService(
        prisma as never,
        { get: jest.fn().mockReturnValue(1) } as never,
        maxBotLinkService as never,
        undefined,
        maxClient as never,
      );
      const cacheKey = `${chatId}:${botId}`;
      (service as any).botSelfAccessCache.set(cacheKey, {
        canHandleUserFacing: true,
        checkedAtMs: probeStartedAt.getTime() - 1,
        expiresAtMs: probeCompletedAt.getTime() + 60_000,
      });

      const messageIngest = service.ingest(
        {
          updateId: 'u-live-probe-race-message',
          type: 'message_created',
          botId,
          message: {
            messageId: 'mid-live-probe-race-message',
            chatId,
            chatTitle: 'Lifecycle race',
            entityType: 'chat',
            senderId: 'user-1',
            text: 'hello',
            createdAt: probeStartedAt.toISOString(),
          },
        },
        '127.0.0.1',
      );
      await probeStarted;

      jest.setSystemTime(probeCompletedAt);
      await expect(
        service.ingest(
          {
            updateId: 'u-live-probe-race-removal',
            type: 'bot_removed',
            botId,
            eventTimestampSource: 'payload',
            message: {
              messageId: 'bot_removed:u-live-probe-race-removal',
              chatId,
              chatTitle: 'Lifecycle race',
              entityType: 'chat',
              senderId: 'admin-1',
              text: '',
              createdAt: probeCompletedAt.toISOString(),
            },
          },
          '127.0.0.1',
        ),
      ).resolves.toEqual({ accepted: true, duplicate: false });

      releaseProbe({
        userId: botId,
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      });
      await expect(messageIngest).resolves.toEqual({ accepted: true, duplicate: false });

      expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith({
        chatId,
        botId,
        access: expect.objectContaining({ isAdmin: true }),
        source: 'webhook_owner_failover',
        checkedAt: probeStartedAt,
        allowMembershipRecovery: true,
      });
      expect(maxBotLinkService.markChatBotRemoved.mock.invocationCallOrder[0]).toBeLessThan(
        maxBotLinkService.recordBotAccessProbe.mock.invocationCallOrder[0] ??
          Number.MAX_SAFE_INTEGER,
      );
      expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
      expect((service as any).botSelfAccessCache.has(cacheKey)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not return an old terminal denial when newer accepted evidence supersedes it', async () => {
    const chatId = '-100-live-probe-denial-race';
    const botId = 'id613002203036_4_bot';
    const denialStartedAt = new Date('2026-07-10T13:00:00.000Z');
    const newerEvidenceAt = new Date('2026-07-10T13:00:01.000Z');
    let rejectProbe!: (error: unknown) => void;
    let reportProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      reportProbeStarted = resolve;
    });
    const probeResult = new Promise<never>((_resolve, reject) => {
      rejectProbe = reject;
    });
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn(() => {
        reportProbeStarted();
        return probeResult;
      }),
    };
    maxBotLinkService.recordBotAccessProbe.mockResolvedValueOnce(false);

    jest.useFakeTimers();
    try {
      jest.setSystemTime(denialStartedAt);
      const service = new WebhookService(
        { webhookEvent: {} } as never,
        { get: jest.fn() } as never,
        maxBotLinkService as never,
        undefined,
        maxClient as never,
      );
      const cacheKey = `${chatId}:${botId}`;
      const refresh = (service as any).getBotSelfModerationAccessState(chatId, botId, {
        bypassCache: true,
      });
      await probeStarted;

      jest.setSystemTime(newerEvidenceAt);
      (service as any).cacheBotSelfAccessState(cacheKey, true, newerEvidenceAt.getTime());
      rejectProbe({
        response: { status: 403, data: { code: 'chat.denied' } },
        message: 'chat denied',
      });

      await expect(refresh).resolves.toBeNull();
      expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith({
        chatId,
        botId,
        access: null,
        source: 'webhook_owner_failover',
        checkedAt: denialStartedAt,
        allowMembershipRecovery: false,
      });
      expect((service as any).readCachedBotSelfAccess(cacheKey)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not cache or return live access when fenced persistence fails', async () => {
    const chatId = '-100-live-probe-persist-error';
    const botId = 'id613002203036_4_bot';
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: botId,
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      }),
    };
    maxBotLinkService.recordBotAccessProbe.mockRejectedValueOnce(new Error('database unavailable'));
    const service = new WebhookService(
      { webhookEvent: {} } as never,
      { get: jest.fn() } as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    const cacheKey = `${chatId}:${botId}`;
    (service as any).botSelfAccessCache.set(cacheKey, {
      canHandleUserFacing: true,
      checkedAtMs: Date.now() - 1,
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      (service as any).getBotSelfModerationAccessState(chatId, botId, { bypassCache: true }),
    ).resolves.toBeNull();
    expect((service as any).botSelfAccessCache.has(cacheKey)).toBe(false);
  });

  it.each(['current', 'incoming'])(
    'retains required owner recovery when the %s live probe is unavailable',
    async (failedProbe) => {
      const update: MaxUpdate = {
        updateId: 'owner-retry',
        botId: 'incoming',
        type: 'message_created',
        message: {
          chatId: '-owner-retry',
          senderId: 'actor',
          text: 'ordinary',
          messageId: 'owner-retry',
          createdAt: new Date().toISOString(),
        },
      };
      const receipt = {
        ...persistedReceipt('owner-retry', update),
        legacyDispositionId: null,
        legacyDispositionReceiptId: null,
        sourceDispositionId: null,
        sourceDispositionReceiptId: null,
      } satisfies Pick<
        WebhookEvent,
        | 'status'
        | 'errorMessage'
        | 'legacyDispositionId'
        | 'legacyDispositionReceiptId'
        | 'sourceDispositionId'
        | 'sourceDispositionReceiptId'
      >;
      const store = mockedReceiptStore([receipt]);
      const prisma = {
        webhookEvent: {
          findUnique: store.findUnique,
          updateMany: store.updateMany,
        },
        chatBotMembership: {
          findUnique: jest.fn().mockResolvedValue({
            permissionsSnapshot: {
              checkedAt: new Date().toISOString(),
              isAdmin: false,
              isOwner: false,
              permissions: [],
            },
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const probe = jest.fn();
      if (failedProbe === 'incoming')
        probe.mockResolvedValueOnce({ isAdmin: false, isOwner: false, permissions: [] });
      probe.mockRejectedValueOnce(new Error('MAX unavailable'));
      maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValue('owner');
      const service = new WebhookService(
        prisma as never,
        { get: jest.fn().mockReturnValue(1) } as never,
        maxBotLinkService as never,
        undefined,
        { getCurrentChatMemberAccess: probe } as never,
      );
      await expect(
        service.preparePersistedWebhookEvent('owner-retry', update),
      ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
      expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
      expect(
        prisma.webhookEvent.updateMany.mock.calls.every(([args]) =>
          Object.keys(args.data).every((key) => key === 'executionDeadlineAt'),
        ),
      ).toBe(true);
      expect((service as any).executionOwnerRecheckBackoffUntilMs.size).toBe(0);
    },
  );

  it('completes ordinary message owner failover through a persisted-event live recheck when only the current owner snapshot is stale', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-5a' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['delete_messages'],
        }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');
    maxBotLinkService.bindChatToBot.mockResolvedValueOnce('id613002203036_4_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    (service as any).botSelfAccessCache.set('-100123:id613002203036_bot', {
      canHandleUserFacing: false,
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      service.ingest(
        {
          updateId: 'u-failover-async-1',
          type: 'message_created',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-1a',
            chatId: '-100123',
            chatTitle: 'Тестовый чат',
            senderId: 'user-1',
            text: 'https://spam.example',
            createdAt: new Date('2026-03-31T20:00:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_4_bot',
          }),
        }),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      2,
      '-100123',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxBotLinkService.bindChatToBot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chatId: '-100123',
        botId: 'id613002203036_4_bot',
        allowReassign: true,
      }),
    );
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(2);
  });

  it('completes execution owner live refresh for group admin moderation commands until after persist', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-command-failover' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_4_bot');
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-command-failover-1',
          type: 'message_created',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-command-ban-1',
            chatId: '-73729721862151',
            chatTitle: 'Пантера',
            senderId: '98315271',
            text: 'Бан',
            createdAt: new Date('2026-05-10T03:00:26.996Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(prisma.webhookEvent.create.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.getCurrentChatMemberAccess.mock.invocationCallOrder[0]!,
    );
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_4_bot',
          }),
        }),
      }),
    );
    const persistOrder = prisma.webhookEvent.create.mock.invocationCallOrder[0];

    await flushDeferredWebhookWork();

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(persistOrder).toBeLessThan(
      maxClient.getCurrentChatMemberAccess.mock.invocationCallOrder[0],
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      1,
      '-73729721862151',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      2,
      '-73729721862151',
      expect.objectContaining({
        botId: 'id613002203036_bot',
        bypassCache: true,
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
        botId: 'id613002203036_bot',
        allowReassign: true,
      }),
    );
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(2);
  });

  it('completes execution owner live refresh for custom linked admin commands', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-custom-command-failover' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_4_bot');
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-custom-command-failover-1',
          type: 'message_created',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-custom-command-ban-1',
            chatId: '-73729721862151',
            chatTitle: 'Пантера',
            senderId: '98315271',
            text: 'заблокировать',
            createdAt: new Date('2026-05-10T03:00:26.996Z').toISOString(),
          },
          raw: {
            timestamp: Date.parse('2026-05-10T03:00:26.996Z'),
            message: {
              link: {
                type: 'reply',
                sender: {
                  user_id: 'user-2',
                },
              },
            },
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(prisma.webhookEvent.create.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.getCurrentChatMemberAccess.mock.invocationCallOrder[0]!,
    );
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_4_bot',
          }),
        }),
      }),
    );

    await flushDeferredWebhookWork();

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
        botId: 'id613002203036_bot',
        allowReassign: true,
      }),
    );
  });

  it('completes execution owner live refresh for developer super ban commands', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-super-ban-failover' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_4_bot');
    maxBotLinkService.bindChatToBot.mockResolvedValueOnce('id613002203036_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-super-ban-failover-1',
          type: 'message_created',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-command-super-ban-1',
            chatId: '-73729721862151',
            chatTitle: 'Пантера',
            senderId: '98315271',
            text: 'Супер бан',
            createdAt: new Date('2026-05-10T03:00:26.996Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(prisma.webhookEvent.create.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.getCurrentChatMemberAccess.mock.invocationCallOrder[0]!,
    );

    await flushDeferredWebhookWork();

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
        botId: 'id613002203036_bot',
        allowReassign: true,
      }),
    );
  });

  it('bypasses stale cached bot access states in durable group admin command rechecks', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-command-cache-bypass' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');
    maxBotLinkService.bindChatToBot.mockResolvedValueOnce('id613002203036_4_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    (service as any).botSelfAccessCache.set('-73729721862151:id613002203036_bot', {
      canHandleUserFacing: true,
      expiresAtMs: Date.now() + 60_000,
    });
    (service as any).botSelfAccessCache.set('-73729721862151:id613002203036_4_bot', {
      canHandleUserFacing: false,
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      service.ingest(
        {
          updateId: 'u-command-cache-bypass-1',
          type: 'message_created',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-command-ban-2',
            chatId: '-73729721862151',
            chatTitle: 'Пантера',
            senderId: '98315271',
            text: 'Бан',
            createdAt: new Date('2026-05-10T03:11:32.471Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(prisma.webhookEvent.create.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.getCurrentChatMemberAccess.mock.invocationCallOrder[0]!,
    );
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_4_bot',
          }),
        }),
      }),
    );

    await flushDeferredWebhookWork();

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      1,
      '-73729721862151',
      expect.objectContaining({
        botId: 'id613002203036_bot',
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      2,
      '-73729721862151',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        bypassCache: true,
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
        botId: 'id613002203036_4_bot',
        allowReassign: true,
      }),
    );
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(2);
  });

  it('completes membership churn owner live refresh after receipt persistence', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-membership-failover' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'id613002203036_bot',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'id613002203036_4_bot',
          isAdmin: true,
          isOwner: false,
          permissions: ['delete_messages'],
        }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');
    maxBotLinkService.bindChatToBot.mockResolvedValueOnce('id613002203036_4_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );
    (service as any).botSelfAccessCache.set('-73729721862151:id613002203036_bot', {
      canHandleUserFacing: true,
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      service.ingest(
        {
          updateId: 'u-membership-failover-1',
          type: 'user_added',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'user_added:u-membership-failover-1',
            chatId: '-73729721862151',
            chatTitle: 'Пантера',
            entityType: 'chat',
            senderId: '98315271',
            senderName: 'Новый админ',
            text: '',
            createdAt: new Date('2026-05-10T03:21:00.000Z').toISOString(),
          },
          membership: {
            action: 'added',
            memberUserIds: ['98315271'],
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(prisma.webhookEvent.create.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.getCurrentChatMemberAccess.mock.invocationCallOrder[0]!,
    );
    expect(maxBotLinkService.observeStoredChatBotWebhook).toHaveBeenCalledWith({
      chatId: '-73729721862151',
      primaryBotId: 'id613002203036_bot',
      botId: 'id613002203036_4_bot',
    });
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_4_bot',
          }),
        }),
      }),
    );

    await flushDeferredWebhookWork();

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      1,
      '-73729721862151',
      expect.objectContaining({
        botId: 'id613002203036_bot',
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenNthCalledWith(
      2,
      '-73729721862151',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        trafficClass: 'interactive',
        timeoutMs: 900,
      }),
    );
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-73729721862151',
        botId: 'id613002203036_4_bot',
        allowReassign: true,
      }),
    );
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(2);
  });

  it('keeps the current owner on ordinary message updates without running a live failover check', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-6' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'id613002203036_bot',
        isAdmin: true,
        isOwner: false,
        permissions: ['delete_messages'],
      }),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-owner-ok-1',
          type: 'message_created',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-2',
            chatId: '-100124',
            chatTitle: 'Shared chat',
            senderId: 'user-2',
            text: 'hello',
            createdAt: new Date('2026-03-31T20:00:01.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_bot',
          }),
        }),
      }),
    );
  });

  it('reuses the stored chat binding for ordinary mirrored updates without rewriting chat ownership rows', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-6a' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-owner-stored-1',
          type: 'message_created',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-2a',
            chatId: '-100124',
            chatTitle: 'Shared chat',
            senderId: 'user-2',
            text: 'hello',
            createdAt: new Date('2026-03-31T20:00:01.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.getStoredChatPrimaryBotId).toHaveBeenCalledWith('-100124', {
      bypassCache: true,
    });
    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
    expect(maxBotLinkService.observeStoredChatBotWebhook).toHaveBeenCalledWith({
      chatId: '-100124',
      primaryBotId: 'id613002203036_bot',
      botId: 'id613002203036_4_bot',
    });
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_bot',
          }),
        }),
      }),
    );
  });

  it('does not promote a stored standby from cached snapshots alone', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-6aa' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('id613002203036_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    (service as any).botSelfAccessCache.set('-100124:id613002203036_bot', {
      canHandleUserFacing: false,
      expiresAtMs: Date.now() + 60_000,
    });
    (service as any).botSelfAccessCache.set('-100124:id613002203036_4_bot', {
      canHandleUserFacing: true,
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      service.ingest(
        {
          updateId: 'u-owner-stored-2',
          type: 'message_created',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-2b',
            chatId: '-100124',
            chatTitle: 'Shared chat',
            senderId: 'user-2',
            text: 'hello',
            createdAt: new Date('2026-03-31T20:00:02.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
    expect(maxBotLinkService.observeStoredChatBotWebhook).toHaveBeenCalledWith({
      chatId: '-100124',
      primaryBotId: 'id613002203036_bot',
      botId: 'id613002203036_4_bot',
    });
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_bot',
          }),
        }),
      }),
    );
  });

  it('does not fail over a stale stored primary from persisted snapshots alone', async () => {
    const checkedAt = new Date().toISOString();
    const membershipSnapshots = new Map([
      [
        'bot-1',
        {
          permissionsSnapshot: {
            checkedAt,
            isAdmin: false,
            isOwner: false,
            permissions: [],
          },
        },
      ],
      [
        'bot-5',
        {
          permissionsSnapshot: {
            checkedAt,
            isAdmin: true,
            isOwner: false,
            permissions: ['delete_messages'],
          },
        },
      ],
    ]);
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-6ab' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        findUnique: jest.fn(
          async (args: { where: { chatId_botId: { chatId: string; botId: string } } }) =>
            membershipSnapshots.get(args.where.chatId_botId.botId) ?? null,
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    maxBotLinkService.getStoredChatPrimaryBotId.mockResolvedValueOnce('bot-1');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-owner-stored-bot-5',
          type: 'message_created',
          botId: 'bot-5',
          message: {
            messageId: 'mid-owner-stored-bot-5',
            chatId: '-100125',
            chatTitle: 'Shared five-bot chat',
            senderId: 'user-5',
            text: 'hello',
            createdAt: new Date('2026-03-31T20:00:05.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.getStoredChatPrimaryBotId).toHaveBeenCalledWith('-100125', {
      bypassCache: true,
    });
    expect(
      prisma.chatBotMembership.findUnique.mock.calls.map(([args]) => args.where.chatId_botId),
    ).toEqual([{ chatId: '-100125', botId: 'bot-1' }]);
    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
    expect(maxBotLinkService.observeStoredChatBotWebhook).toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            botId: 'bot-5',
            executionOwnerBotId: 'bot-1',
          }),
        }),
      }),
    );
  });

  it('prepares bot_added binding without probing or promoting a moderation executor', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-6b' }),
        updateMany: jest.fn(),
      },
      chatBotMembership: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockRejectedValue(new Error('bot_added cannot probe moderation rights')),
    };
    maxBotLinkService.bindChatToBot.mockResolvedValueOnce('id613002203036_bot');

    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      maxClient as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-added-failover-1',
          type: 'bot_added',
          botId: 'id613002203036_4_bot',
          message: {
            messageId: 'mid-bot-added-1',
            chatId: '-100140',
            chatTitle: 'Shared chat',
            entityType: 'channel',
            senderId: 'id613002203036_4_bot',
            text: '',
            createdAt: new Date('2026-04-06T00:10:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(prisma.webhookEvent.create.mock.invocationCallOrder[0]).toBeLessThan(
      maxBotLinkService.bindChatToBot.mock.invocationCallOrder[0]!,
    );
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledTimes(1);
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedPayload: expect.objectContaining({
            executionOwnerBotId: 'id613002203036_bot',
          }),
        }),
      }),
    );

    await flushDeferredWebhookWork();

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxBotLinkService.bindChatToBot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chatId: '-100140',
        botId: 'id613002203036_4_bot',
        lifecycleEventType: 'bot_added',
      }),
    );
    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalledWith(
      expect.objectContaining({ allowReassign: true }),
    );
  });

  it('propagates webhook entity type into chat binding updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-7' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-entity-type-1',
          type: 'bot_added',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'mid-entity-type-1',
            chatId: '-100125',
            chatTitle: 'Новости района',
            entityType: 'channel',
            senderId: 'user-3',
            text: 'hello',
            createdAt: new Date('2026-03-31T20:00:02.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100125',
        title: 'Новости района',
        entityType: 'CHANNEL',
        botId: 'id613002203036_bot',
        lifecycleEventType: 'bot_added',
        lifecycleSource: 'webhook',
      }),
    );
  });

  it('persists a bot_added receipt immediately and holds preparation until bootstrap settles', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-7-cache' }),
        updateMany: jest.fn(),
      },
    };
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cache = { upsertManagedEntitiesRecentBootstrap: jest.fn().mockReturnValue(pending) };
    const service = new WebhookService(
      prisma as never,
      { get: jest.fn().mockReturnValue(1) } as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      cache as never,
    );
    const update = {
      updateId: 'u-bot-added-cache-1',
      type: 'bot_added',
      botId: 'id613002203036_bot',
      message: {
        messageId: 'bot_added:u-bot-added-cache-1',
        chatId: '-100128',
        chatTitle: 'Кэшируемый чат',
        entityType: 'channel' as const,
        senderId: 'user-77',
        text: '',
        createdAt: '2026-04-03T12:02:00.000Z',
      },
    };
    await expect(service.storeReceipt(update, '127.0.0.1')).resolves.toMatchObject({
      webhookEventId: 'evt-7-cache',
      duplicate: false,
    });
    expect(cache.upsertManagedEntitiesRecentBootstrap).not.toHaveBeenCalled();
    let settled = false;
    const preparing = service.preparePersistedWebhookEvent('evt-7-cache', update).then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cache.upsertManagedEntitiesRecentBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ id: '-100128', entityType: 'channel' }),
      15 * 60,
      'user-77',
    );
    expect(settled).toBe(false);
    expect(prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
    release();
    await preparing;
    expect(settled).toBe(true);
  });

  it.each(['chat', 'channel'])(
    'handles official and repeated %s bot additions without sending onboarding messages',
    async (entityType) => {
      const prisma = {
        webhookEvent: {
          create: jest.fn(async ({ data }: { data: FixtureRow }) => ({ id: data.id })),
          updateMany: jest.fn(),
        },
      };
      const maxClient = {
        sendMessageImmediateWithId: jest.fn(),
      };
      const service = new WebhookService(
        prisma as never,
        { get: jest.fn().mockReturnValue(1) } as never,
        maxBotLinkService as never,
        undefined,
        maxClient as never,
        maxChatAdminRosterSyncService as never,
      );
      for (const [index, botId] of ['id613002203036_bot', 'id613002203036_4_bot'].entries()) {
        const update = new WebhookParser().parse(
          {
            update_id: `u-silent-added-${index}`,
            update_type: 'bot_added',
            chat_id: -100129,
            chat: { chat_id: -100129, chat_type: entityType, title: 'Тест подключения' },
            user: { user_id: 900002, first_name: 'Анна', last_name: 'Администратор' },
            timestamp: '2026-04-03T12:03:00.000Z',
          },
          { botId },
        );
        expect(update.message?.senderId).toBe('900002');
        expect(update.membership).toEqual({ action: 'added', memberUserIds: [botId] });
        await expect(service.ingest(update, '127.0.0.1')).resolves.toEqual({
          accepted: true,
          duplicate: false,
        });
        await flushDeferredWebhookWork();
        expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalledWith(
          expect.objectContaining({
            chatId: '-100129',
            botIds: [botId],
            entityType,
            source: 'webhook_bot_added',
          }),
        );
        expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
      }
    },
  );

  it('enqueues chat admin roster sync for bot membership churn updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-7' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );

    const beforeIngestMs = Date.now();

    await expect(
      service.ingest(
        {
          updateId: 'u-bot-added-1',
          type: 'bot_added',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'bot_added:u-bot-added-1',
            chatId: '-100126',
            chatTitle: 'Новый чат',
            entityType: 'channel',
            senderId: 'id613002203036_bot',
            text: '',
            createdAt: new Date('2026-04-03T12:00:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
      chatId: '-100126',
      botIds: ['id613002203036_bot'],
      title: 'Новый чат',
      entityType: 'channel',
      source: 'webhook_bot_added',
      retryUntilMs: expect.any(Number),
    });
    const scheduledJob =
      maxChatAdminRosterSyncService.scheduleChatAdminRosterSync.mock.calls[0]?.[0];
    expect(scheduledJob.retryUntilMs).toBeGreaterThanOrEqual(beforeIngestMs + 120_000);
    expect(scheduledJob.retryUntilMs).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it('enqueues chat admin roster sync for chat_title_changed updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-title-changed' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-title-changed-1',
          type: 'chat_title_changed',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'chat_title_changed:u-title-changed-1',
            chatId: '-100129',
            chatTitle: 'Новое название',
            entityType: 'chat',
            senderId: 'user-title-1',
            text: '',
            createdAt: new Date('2026-07-06T09:00:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
      chatId: '-100129',
      botIds: ['id613002203036_bot'],
      title: 'Новое название',
      entityType: 'chat',
      source: 'webhook_chat_title_changed',
      retryUntilMs: null,
    });
  });

  it('prewarms admin roster snapshots for webhook membership churn updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-7a' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-user-added-1',
          type: 'user_added',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'user_added:u-user-added-1',
            chatId: '-100127',
            chatTitle: 'Новый участник',
            entityType: 'chat',
            senderId: 'user-10',
            text: '',
            createdAt: new Date('2026-04-03T12:05:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
      chatId: '-100127',
      botIds: ['id613002203036_bot'],
      title: 'Новый участник',
      entityType: 'chat',
      source: 'webhook_membership_churn',
      retryUntilMs: null,
    });
  });

  it('does not enqueue admin roster sync for private direct membership updates', async () => {
    const prisma = {
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-private-1' }),
        updateMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn().mockReturnValue(1),
    };
    const service = new WebhookService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );

    await expect(
      service.ingest(
        {
          updateId: 'u-private-bot-started-1',
          type: 'bot_started',
          botId: 'id613002203036_bot',
          message: {
            messageId: 'bot_started:u-private-bot-started-1',
            chatId: '214007512',
            senderId: '214007512',
            text: '',
            createdAt: new Date('2026-04-03T12:07:00.000Z').toISOString(),
          },
        },
        '127.0.0.1',
      ),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).not.toHaveBeenCalled();
  });
});
