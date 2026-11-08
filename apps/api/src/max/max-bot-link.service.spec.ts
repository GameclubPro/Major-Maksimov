import {
  ChatBotAccessState,
  ChatCatalogKind,
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  ChatEntityType,
  ChatRoutingState,
  Prisma,
} from '../prisma/prisma-client';
import { MaxBotLinkService } from './max-bot-link.service';
import { ModerationDeleteIntentAccessWakeService } from './moderation-delete-intent-access-wake.service';
import { MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE } from './max-send-route-health';
import {
  MAJOR_EXPLICIT_ACTIVATION_PENDING_SOURCE,
  type ManagedEntityExplicitActivation,
} from './managed-entity-activation.util';

type MutableChat = {
  id: string;
  title: string;
  botId: string | null;
  primaryBotId: string | null;
  fixedModeratorBotId?: string | null;
  entityType?: ChatEntityType;
  catalogKind?: ChatCatalogKind;
  routingState?: ChatRoutingState;
  routingVersion?: number;
};

type MutableChatUpdate = Omit<Partial<MutableChat>, 'routingVersion'> & {
  routingVersion?: number | { increment: number };
};

type MutableMembership = {
  chatId: string;
  botId: string;
  role: ChatBotMembershipRole;
  status: ChatBotMembershipStatus;
  capabilities?: unknown;
  permissionsSnapshot?: unknown;
  botAccessState?: string;
  botAccessCheckedAt?: Date | null;
  botAccessExpiresAt?: Date | null;
  botAccessSource?: string | null;
  botAccessLastErrorCode?: string | null;
  permissionsHash?: string | null;
  sendRouteFailureCount?: number;
  sendRouteQuarantinedUntil?: Date | null;
  sendRouteLastFailureAt?: Date | null;
  sendRouteLastFailureCode?: string | null;
  lifecycleEventAt?: Date | null;
  lifecycleEventType?: string | null;
  lifecycleSource?: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date | null;
  lastWebhookAt: Date | null;
};

const ROUTE_MATRIX_BOT_IDS = [
  'id613002203036_bot',
  'id613002203036_4_bot',
  'id613002203036_5_bot',
  'id613070470872_5_bot',
  'id613070470872_6_bot',
  'id613070470872_9_bot',
] as const;

function createActiveMembership(
  chatId: string,
  botId: string,
  index: number,
  overrides: Partial<MutableMembership> = {},
): MutableMembership {
  const timestamp = new Date(Date.UTC(2026, 2, 31, 0, 0, index));
  return {
    chatId,
    botId,
    role: index === 0 ? ChatBotMembershipRole.PRIMARY : ChatBotMembershipRole.STANDBY,
    status: ChatBotMembershipStatus.ACTIVE,
    botAccessState: 'UNKNOWN',
    botAccessCheckedAt: null,
    permissionsSnapshot: {
      checkedAt: timestamp.toISOString(),
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'write', 'delete_messages', 'add_remove_members'],
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
    lastWebhookAt: timestamp,
    ...overrides,
  };
}

function freshMemberCapability(
  permissions: string[],
  permissionsKnown = true,
): Partial<MutableMembership> {
  return {
    botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
    botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
    botAccessExpiresAt: new Date('2026-05-09T10:19:00.000Z'),
    permissionsSnapshot: {
      checkedAt: '2026-05-09T10:04:00.000Z',
      isAdmin: true,
      isOwner: false,
      permissions,
      permissionsKnown,
    },
  };
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }

  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((tail) => [
      item,
      ...tail,
    ]),
  );
}

function createServiceFixture() {
  const chats = new Map<string, MutableChat>();
  const memberships: MutableMembership[] = [];
  const activationReceipts = new Map<
    string,
    {
      botId: string;
      createdAt: Date;
      normalizedPayload: Record<string, unknown>;
    }
  >();
  const now = () => new Date();

  const matchesScalarCondition = (value: unknown, condition: unknown): boolean => {
    if (condition instanceof Date) {
      return value instanceof Date && value.getTime() === condition.getTime();
    }
    if (condition === null) {
      return value == null;
    }
    if (typeof condition !== 'object' || Array.isArray(condition)) {
      return value === condition;
    }

    const filter = condition as Record<string, unknown>;
    if ('not' in filter && matchesScalarCondition(value, filter.not)) {
      return false;
    }
    if (Array.isArray(filter.in) && !filter.in.includes(value)) {
      return false;
    }
    if (Array.isArray(filter.notIn) && filter.notIn.includes(value)) {
      return false;
    }
    const valueMs = value instanceof Date ? value.getTime() : value;
    for (const [operator, expected] of Object.entries(filter)) {
      const expectedValue = expected instanceof Date ? expected.getTime() : expected;
      if (operator === 'lt' && !(valueMs != null && valueMs < expectedValue!)) {
        return false;
      }
      if (operator === 'lte' && !(valueMs != null && valueMs <= expectedValue!)) {
        return false;
      }
      if (operator === 'gt' && !(valueMs != null && valueMs > expectedValue!)) {
        return false;
      }
      if (operator === 'gte' && !(valueMs != null && valueMs >= expectedValue!)) {
        return false;
      }
    }
    return true;
  };

  const matchesMembershipWhere = (
    membership: MutableMembership,
    where: Record<string, unknown>,
  ): boolean => {
    const or = Array.isArray(where.OR) ? (where.OR as Array<Record<string, unknown>>) : null;
    if (or && !or.some((condition) => matchesMembershipWhere(membership, condition))) {
      return false;
    }
    const and = Array.isArray(where.AND) ? (where.AND as Array<Record<string, unknown>>) : null;
    if (and && !and.every((condition) => matchesMembershipWhere(membership, condition))) {
      return false;
    }

    const scalarFields: Array<keyof MutableMembership> = [
      'chatId',
      'botId',
      'role',
      'status',
      'updatedAt',
      'botAccessState',
      'botAccessCheckedAt',
      'botAccessExpiresAt',
      'sendRouteFailureCount',
      'sendRouteQuarantinedUntil',
      'sendRouteLastFailureAt',
      'sendRouteLastFailureCode',
      'lifecycleEventAt',
      'lifecycleEventType',
      'lifecycleSource',
    ];
    for (const field of scalarFields) {
      if (field in where && !matchesScalarCondition(membership[field], where[field])) {
        return false;
      }
    }

    const chatRelation = where.chat as
      | { is?: { primaryBotId?: unknown; routingVersion?: unknown } }
      | undefined;
    if (chatRelation?.is) {
      const chat = chats.get(membership.chatId);
      if (!chat) {
        return false;
      }
      if (
        'primaryBotId' in chatRelation.is &&
        !matchesScalarCondition(chat.primaryBotId, chatRelation.is.primaryBotId)
      ) {
        return false;
      }
      if (
        'routingVersion' in chatRelation.is &&
        !matchesScalarCondition(chat.routingVersion ?? 0, chatRelation.is.routingVersion)
      ) {
        return false;
      }
    }
    return true;
  };

  const matchesMembershipRelation = (
    chatId: string,
    relation: Record<string, unknown>,
  ): boolean => {
    const rows = memberships.filter((membership) => membership.chatId === chatId);
    const some = relation.some as Record<string, unknown> | undefined;
    const every = relation.every as Record<string, unknown> | undefined;
    const none = relation.none as Record<string, unknown> | undefined;
    return (
      (!some || rows.some((membership) => matchesMembershipWhere(membership, some))) &&
      (!every || rows.every((membership) => matchesMembershipWhere(membership, every))) &&
      (!none || !rows.some((membership) => matchesMembershipWhere(membership, none)))
    );
  };

  const matchesChatWhere = (chat: MutableChat, where: Record<string, unknown>): boolean => {
    const and = Array.isArray(where.AND) ? (where.AND as Array<Record<string, unknown>>) : null;
    if (and && !and.every((condition) => matchesChatWhere(chat, condition))) {
      return false;
    }
    const or = Array.isArray(where.OR) ? (where.OR as Array<Record<string, unknown>>) : null;
    if (or && !or.some((condition) => matchesChatWhere(chat, condition))) {
      return false;
    }
    if ('id' in where && !matchesScalarCondition(chat.id, where.id)) {
      return false;
    }
    if (
      'routingState' in where &&
      !matchesScalarCondition(chat.routingState ?? ChatRoutingState.READY, where.routingState)
    ) {
      return false;
    }
    if (
      'routingVersion' in where &&
      !matchesScalarCondition(chat.routingVersion ?? 0, where.routingVersion)
    ) {
      return false;
    }
    if ('primaryBotId' in where && !matchesScalarCondition(chat.primaryBotId, where.primaryBotId)) {
      return false;
    }
    if ('catalogKind' in where && !matchesScalarCondition(chat.catalogKind, where.catalogKind)) {
      return false;
    }
    const relation = where.botMemberships as Record<string, unknown> | undefined;
    return !relation || matchesMembershipRelation(chat.id, relation);
  };

  let transactionTail = Promise.resolve();
  const prisma = {
    chatRules: {
      findUnique: jest.fn<
        Promise<{ publishedMessageId: string; publishedBotId: string } | null>,
        [unknown]
      >(async () => null),
    },
    managedGiveaway: { findFirst: jest.fn(async () => null) },
    channelSettings: { findUnique: jest.fn(async () => null) },
    chatReportCase: { findFirst: jest.fn(async () => null) },
    channelAutoPostAttachMarker: { findUnique: jest.fn(async () => null) },
    chatAutoCommentAttachMarker: { findUnique: jest.fn(async () => null) },
    moderationDeleteIntent: { findUnique: jest.fn(async () => null) },
    chatMembershipActivityEvent: {
      findFirst: jest.fn(async (): Promise<{ id: string } | null> => null),
    },
    managedEntityAccessEdge: {
      findFirst: jest.fn(async (): Promise<{ checkedAt: Date } | null> => null),
    },
    webhookEvent: {
      findUnique: jest.fn(
        async ({ where }: { where: { dedupKey: string } }) =>
          activationReceipts.get(where.dedupKey) ?? null,
      ),
    },
    chat: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const chat = chats.get(where.id) ?? null;
        if (!chat) {
          return null;
        }
        return {
          title: chat.title,
          entityType: chat.entityType ?? ChatEntityType.CHAT,
          catalogKind: chat.catalogKind ?? null,
          routingState: chat.routingState ?? ChatRoutingState.READY,
          routingVersion: chat.routingVersion ?? 0,
          primaryBotId: chat.primaryBotId,
          fixedModeratorBotId: chat.fixedModeratorBotId,
          botId: chat.botId,
          botMemberships: memberships
            .filter((membership) => membership.chatId === where.id)
            .map((membership) => ({
              botId: membership.botId,
              updatedAt: membership.updatedAt,
              role: membership.role,
              status: membership.status,
              botAccessState: membership.botAccessState ?? 'UNKNOWN',
              botAccessCheckedAt: membership.botAccessCheckedAt ?? null,
              botAccessExpiresAt: membership.botAccessExpiresAt ?? null,
              botAccessSource: membership.botAccessSource ?? null,
              lifecycleEventAt: membership.lifecycleEventAt ?? null,
              lifecycleEventType: membership.lifecycleEventType ?? null,
              lifecycleSource: membership.lifecycleSource ?? null,
              capabilities: membership.capabilities ?? [],
              permissionsSnapshot:
                membership.permissionsSnapshot === Prisma.JsonNull
                  ? null
                  : (membership.permissionsSnapshot ?? null),
              sendRouteFailureCount: membership.sendRouteFailureCount ?? 0,
              sendRouteQuarantinedUntil: membership.sendRouteQuarantinedUntil ?? null,
              sendRouteLastFailureAt: membership.sendRouteLastFailureAt ?? null,
              sendRouteLastFailureCode: membership.sendRouteLastFailureCode ?? null,
            })),
        };
      }),
      create: jest.fn(async ({ data }: { data: MutableChat }) => {
        if (chats.has(data.id)) {
          const error = new Error('Unique constraint failed');
          (error as Error & { code?: string }).code = 'P2002';
          throw error;
        }
        chats.set(data.id, {
          id: data.id,
          title: data.title,
          botId: data.botId ?? null,
          primaryBotId: data.primaryBotId ?? null,
          entityType: data.entityType,
          catalogKind: data.catalogKind,
          routingState: data.routingState ?? ChatRoutingState.READY,
          routingVersion: data.routingVersion ?? 0,
        });
        return chats.get(data.id);
      }),
      createMany: jest.fn(
        async ({
          data,
          skipDuplicates,
        }: {
          data: MutableChat | MutableChat[];
          skipDuplicates?: boolean;
        }) => {
          const rows = Array.isArray(data) ? data : [data];
          let count = 0;
          for (const row of rows) {
            if (chats.has(row.id)) {
              if (skipDuplicates) {
                continue;
              }
              const error = new Error('Unique constraint failed');
              (error as Error & { code?: string }).code = 'P2002';
              throw error;
            }
            chats.set(row.id, {
              id: row.id,
              title: row.title,
              botId: row.botId ?? null,
              primaryBotId: row.primaryBotId ?? null,
              entityType: row.entityType,
              catalogKind: row.catalogKind,
              routingState: row.routingState ?? ChatRoutingState.READY,
              routingVersion: row.routingVersion ?? 0,
            });
            count += 1;
          }
          return { count };
        },
      ),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: MutableChatUpdate }) => {
          const existing = chats.get(where.id);
          if (!existing) {
            throw new Error(`Chat ${where.id} not found`);
          }
          const { routingVersion, ...nextData } = data;
          Object.assign(existing, nextData);
          if (typeof routingVersion === 'number') {
            existing.routingVersion = routingVersion;
          } else if (routingVersion) {
            existing.routingVersion =
              (existing.routingVersion ?? 0) + Number(routingVersion.increment ?? 0);
          }
          return existing;
        },
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown> & { id: string };
          data: MutableChatUpdate;
        }) => {
          const existing = chats.get(where.id);
          if (!existing || !matchesChatWhere(existing, where)) {
            return { count: 0 };
          }
          const { routingVersion, ...nextData } = data;
          Object.assign(existing, nextData);
          if (typeof routingVersion === 'number') {
            existing.routingVersion = routingVersion;
          } else if (routingVersion) {
            existing.routingVersion =
              (existing.routingVersion ?? 0) + Number(routingVersion.increment ?? 0);
          }
          return { count: 1 };
        },
      ),
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { id: string };
          create: MutableChat;
          update: MutableChatUpdate;
        }) => {
          const existing = chats.get(where.id);
          if (existing) {
            const { routingVersion, ...nextData } = update;
            Object.assign(existing, nextData);
            if (typeof routingVersion === 'number') {
              existing.routingVersion = routingVersion;
            } else if (routingVersion) {
              existing.routingVersion =
                (existing.routingVersion ?? 0) + Number(routingVersion.increment ?? 0);
            }
            return existing;
          }
          const created = {
            id: create.id,
            title: create.title,
            botId: create.botId ?? null,
            primaryBotId: create.primaryBotId ?? null,
            entityType: create.entityType,
            catalogKind: create.catalogKind,
            routingState: create.routingState ?? ChatRoutingState.READY,
            routingVersion: create.routingVersion ?? 0,
          };
          chats.set(create.id, created);
          return created;
        },
      ),
    },
    chatBotMembership: {
      createMany: jest.fn(
        async ({
          data,
          skipDuplicates,
        }: {
          data:
            | Omit<MutableMembership, 'createdAt' | 'updatedAt'>
            | Array<Omit<MutableMembership, 'createdAt' | 'updatedAt'>>;
          skipDuplicates?: boolean;
        }) => {
          const rows = Array.isArray(data) ? data : [data];
          let count = 0;
          for (const row of rows) {
            const existing = memberships.some(
              (membership) => membership.chatId === row.chatId && membership.botId === row.botId,
            );
            if (existing) {
              if (skipDuplicates) {
                continue;
              }
              const error = new Error('Unique constraint failed');
              (error as Error & { code?: string }).code = 'P2002';
              throw error;
            }
            memberships.push({
              ...row,
              capabilities: row.capabilities ?? [],
              permissionsSnapshot: row.permissionsSnapshot ?? null,
              createdAt: now(),
              updatedAt: now(),
              lastSeenAt: row.lastSeenAt ?? null,
              lastWebhookAt: row.lastWebhookAt ?? null,
            });
            count += 1;
          }
          return { count };
        },
      ),
      findUnique: jest.fn(
        async ({ where }: { where: { chatId_botId: { chatId: string; botId: string } } }) => {
          const membership = memberships.find(
            (membership) =>
              membership.chatId === where.chatId_botId.chatId &&
              membership.botId === where.chatId_botId.botId,
          );
          return membership ? structuredClone(membership) : null;
        },
      ),
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { chatId_botId: { chatId: string; botId: string } };
          create: Omit<MutableMembership, 'createdAt' | 'updatedAt'>;
          update: Partial<MutableMembership>;
        }) => {
          const existing = memberships.find(
            (membership) =>
              membership.chatId === where.chatId_botId.chatId &&
              membership.botId === where.chatId_botId.botId,
          );
          if (existing) {
            Object.assign(existing, update, { updatedAt: now() });
            return existing;
          }
          const created: MutableMembership = {
            ...create,
            chatId: create.chatId,
            botId: create.botId,
            role: create.role,
            status: create.status,
            capabilities: (create as MutableMembership).capabilities ?? [],
            permissionsSnapshot: (create as MutableMembership).permissionsSnapshot ?? null,
            createdAt: now(),
            updatedAt: now(),
            lastSeenAt: create.lastSeenAt ?? null,
            lastWebhookAt: create.lastWebhookAt ?? null,
          };
          memberships.push(created);
          return created;
        },
      ),
      findMany: jest.fn(async ({ where }: { where: { chatId: string } }) =>
        memberships
          .filter((membership) => membership.chatId === where.chatId)
          .slice()
          .sort((left, right) => {
            const updatedDiff = right.updatedAt.getTime() - left.updatedAt.getTime();
            if (updatedDiff !== 0) {
              return updatedDiff;
            }
            return left.createdAt.getTime() - right.createdAt.getTime();
          })
          .map((membership) => ({
            botId: membership.botId,
            updatedAt: membership.updatedAt,
            role: membership.role,
            status: membership.status,
            botAccessState: membership.botAccessState ?? ChatBotAccessState.UNKNOWN,
            botAccessCheckedAt: membership.botAccessCheckedAt ?? null,
            permissionsSnapshot:
              membership.permissionsSnapshot === Prisma.JsonNull
                ? null
                : (membership.permissionsSnapshot ?? null),
          })),
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown> & { chatId: string };
          data: Partial<MutableMembership>;
        }) => {
          let count = 0;
          for (const membership of memberships) {
            if (!matchesMembershipWhere(membership, where)) {
              continue;
            }
            Object.assign(membership, data, { updatedAt: now() });
            count += 1;
          }
          return { count };
        },
      ),
    },
    $executeRaw: jest.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
        if (!strings.join('').includes('UPDATE chat_bot_memberships'))
          throw new Error('Unexpected fixture SQL mutation');
        const [lastSeenAt, lastWebhookAt, , chatId, botId] = values as [
          Date,
          Date,
          Date,
          string,
          string,
        ];
        // Reuse the fixture's mutation/failure model; native races exercise the real SQL.
        const result = await prisma.chatBotMembership.updateMany({
          where: { chatId, botId, status: ChatBotMembershipStatus.ACTIVE },
          data: { lastSeenAt, lastWebhookAt },
        });
        return result.count;
      },
    ),
    $queryRaw: jest.fn(async (query: unknown) => {
      const sql = query as {
        strings?: readonly string[];
        sql?: string;
        values?: readonly unknown[];
      };
      const text = sql.strings?.join('') ?? sql.sql ?? '';
      const chatId = typeof sql.values?.[0] === 'string' ? sql.values[0] : null;
      // Membership fixtures model rows behind a real FK, so their parent chat is lockable even
      // when a test does not need to populate the rest of the chat projection.
      const parentChatExists =
        chatId !== null &&
        (chats.has(chatId) || memberships.some((membership) => membership.chatId === chatId));
      if (text.includes('FROM "chats"') && chatId && parentChatExists) {
        return [
          {
            id: chatId,
            entityType: chats.get(chatId)?.entityType ?? ChatEntityType.CHAT,
          },
        ];
      }
      return [];
    }),
    $transaction: jest.fn(async <T>(callback: (transaction: unknown) => Promise<T>): Promise<T> => {
      const predecessor = transactionTail;
      let releaseTransaction!: () => void;
      transactionTail = new Promise<void>((resolve) => {
        releaseTransaction = resolve;
      });
      await predecessor;
      const chatSnapshot = structuredClone([...chats.entries()]);
      const membershipSnapshot = structuredClone(memberships);
      try {
        return await callback(prisma);
      } catch (error: unknown) {
        chats.clear();
        for (const [chatId, chat] of chatSnapshot) {
          chats.set(chatId, chat);
        }
        memberships.splice(0, memberships.length, ...membershipSnapshot);
        throw error;
      } finally {
        releaseTransaction();
      }
    }),
  };

  const bots = ROUTE_MATRIX_BOT_IDS.map((id, index) => ({
    id,
    token: `token-${index + 1}`,
    state: 'active',
  }));
  const botRegistry = {
    getBotById: jest.fn((botId?: string | null) => bots.find((bot) => bot.id === botId) ?? null),
    getDefaultBot: jest.fn(() => bots[0]),
    getEntryBot: jest.fn(() => bots[0]),
  };
  const botContext = {
    getActiveBotId: jest.fn((): string | null => null),
  };
  const moderationDeleteIntentAccessWake = {
    wakeAfterCommittedProbe: jest.fn().mockResolvedValue(0),
  };
  const nightModeTransitionScheduler = {
    reconcileChat: jest.fn().mockResolvedValue({
      queueAvailable: true,
      scheduleEnabled: true,
      passes: 1,
    }),
  };

  return {
    service: new MaxBotLinkService(
      prisma as never,
      botRegistry as never,
      botContext as never,
      moderationDeleteIntentAccessWake as never,
      nightModeTransitionScheduler as never,
    ),
    prisma,
    botContext,
    moderationDeleteIntentAccessWake,
    nightModeTransitionScheduler,
    bots,
    chats,
    memberships,
    activationReceipts,
  };
}

function explicitActivationProbe(
  fixture: ReturnType<typeof createServiceFixture>,
  chatId: string,
  botId: string,
  sourceAt = new Date(Date.now() - 1_000),
) {
  const explicitActivation: ManagedEntityExplicitActivation = {
    kind: 'start_in_chat',
    chatId,
    botId,
    sourceAt,
    actorUserId: 'activation-admin',
    updateId: `start-${chatId}`,
  };
  fixture.activationReceipts.set(`${botId}:${explicitActivation.updateId}`, {
    botId,
    createdAt: new Date(),
    normalizedPayload: {
      updateId: explicitActivation.updateId,
      botId,
      type: 'message_created',
      message: {
        chatId,
        senderId: explicitActivation.actorUserId,
        text: 'Старт',
        createdAt: sourceAt.toISOString(),
      },
    },
  });
  return {
    explicitActivation,
    access: {
      isAdmin: true,
      isOwner: false,
      explicitPrivilegeEvidence: true,
      permissionsKnown: true,
      permissions: ['read_all_messages', 'write'],
    },
    activationActorAccess: {
      userId: explicitActivation.actorUserId,
      isAdmin: true,
      isOwner: false,
      explicitPrivilegeEvidence: true,
      isBot: false,
      permissions: [],
    },
  };
}

function readBotLinkCacheState(service: MaxBotLinkService) {
  return service as unknown as {
    chatBotBindingCache: Map<string, { botId: string; expiresAtMs: number }>;
    observedWebhookTouchCache: Map<string, number>;
    observedWebhookTouchesInFlight: Map<string, Promise<void>>;
    chatBotBindingSweepIterator: IterableIterator<unknown> | null;
    chatBotBindingSweepRemaining: number;
    observedWebhookTouchSweepIterator: IterableIterator<unknown> | null;
    localCacheSweepTimer: NodeJS.Timeout | null;
  };
}

describe('MaxBotLinkService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-09T10:05:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reclaims idle bindings and heartbeat cooldowns in bounded callbacks without evicting fresh routes', async () => {
    const fixture = createServiceFixture();
    const state = readBotLinkCacheState(fixture.service);
    const botId = fixture.bots[1]!.id;
    for (let index = 0; index < 12000; index++) {
      fixture.service.rememberChatBotBinding(`idle-${index}`, botId);
    }
    fixture.prisma.chatBotMembership.updateMany.mockResolvedValue({ count: 1 });
    await Promise.all(
      Array.from({ length: 512 }, (_, index) =>
        fixture.service.observeStoredChatBotWebhook({ chatId: `idle-${index}`, botId }),
      ),
    );
    expect(fixture.service.resolveBotIdSync(null, 'idle-0')).toBe(botId);
    expect(state.chatBotBindingCache.size).toBe(12000);
    expect(state.localCacheSweepTimer?.hasRef()).toBe(false);
    jest.setSystemTime(Date.now() + 600001);
    await jest.advanceTimersToNextTimerAsync();
    expect(state.chatBotBindingCache.size).toBe(12000 - 256);
    expect(state.observedWebhookTouchCache.size).toBe(512 - 256);
    await jest.advanceTimersByTimeAsync(100);
    expect(state.chatBotBindingCache.size).toBe(0);
    expect(state.observedWebhookTouchCache.size).toBe(0);
    expect(state.localCacheSweepTimer).toBeNull();
    expect(fixture.prisma.chatBotMembership.updateMany).toHaveBeenCalledTimes(512);
    fixture.service.onModuleDestroy();
  });

  it('preserves a refreshed exact-bot binding while earlier unused routes expire', async () => {
    const fixture = createServiceFixture();
    const botId = fixture.bots[1]!.id;
    fixture.service.rememberChatBotBinding('old-route', botId);
    fixture.service.rememberChatBotBinding('refreshed-route', botId);
    jest.setSystemTime(Date.now() + 599000);
    fixture.service.rememberChatBotBinding('refreshed-route', botId);
    await jest.advanceTimersByTimeAsync(5000);
    const state = readBotLinkCacheState(fixture.service);
    expect(state.chatBotBindingCache.has('old-route')).toBe(false);
    expect(fixture.service.resolveBotIdSync(null, 'refreshed-route')).toBe(botId);
    expect(state.chatBotBindingCache.size).toBe(1);
    fixture.service.onModuleDestroy();
  });

  it('forgets every local route after a missed invalidation without retaining an active sweep', async () => {
    const fixture = createServiceFixture();
    const state = readBotLinkCacheState(fixture.service);
    const botId = fixture.bots[1]!.id;
    for (let index = 0; index < 512; index++) {
      fixture.service.rememberChatBotBinding(`gap-${index}`, botId);
    }
    await jest.advanceTimersByTimeAsync(5000);
    expect(state.chatBotBindingSweepRemaining).toBe(256);
    fixture.service.forgetAllChatBotBindings();
    expect(state.chatBotBindingCache.size).toBe(0);
    expect(state.chatBotBindingSweepIterator).toBeNull();
    expect(state.chatBotBindingSweepRemaining).toBe(0);
    fixture.service.rememberChatBotBinding('fresh-route', botId);
    await jest.advanceTimersByTimeAsync(1);
    expect(fixture.service.resolveBotIdSync(null, 'fresh-route')).toBe(botId);
    fixture.service.onModuleDestroy();
  });

  it('ends a bounded binding pass while new routes are appended and cancels it on shutdown', async () => {
    const fixture = createServiceFixture();
    const state = readBotLinkCacheState(fixture.service);
    const botId = fixture.bots[1]!.id;
    for (let index = 0; index < 512; index++) {
      fixture.service.rememberChatBotBinding(`initial-${index}`, botId);
    }
    await jest.advanceTimersByTimeAsync(5000);
    expect(state.chatBotBindingSweepRemaining).toBe(256);
    for (let index = 0; index < 512; index++) {
      fixture.service.rememberChatBotBinding(`added-${index}`, botId);
    }
    await jest.advanceTimersByTimeAsync(1);
    expect(state.chatBotBindingSweepIterator).toBeNull();
    expect(state.chatBotBindingSweepRemaining).toBe(0);

    let release!: (value: { count: number }) => void;
    fixture.prisma.chatBotMembership.updateMany.mockImplementationOnce(
      () =>
        new Promise<{ count: number }>((resolve) => {
          release = resolve;
        }),
    );
    const pending = fixture.service.observeStoredChatBotWebhook({ chatId: 'late-touch', botId });
    expect(state.observedWebhookTouchesInFlight.size).toBe(1);
    fixture.service.onModuleDestroy();
    expect(state.observedWebhookTouchesInFlight.size).toBe(1);
    release({ count: 1 });
    await pending;
    expect(state.observedWebhookTouchesInFlight.size).toBe(0);
    fixture.service.rememberChatBotBinding('late-binding', botId);
    expect(state.chatBotBindingCache.size).toBe(0);
    expect(state.observedWebhookTouchCache.size).toBe(0);
    expect(state.chatBotBindingSweepIterator).toBeNull();
    expect(state.observedWebhookTouchSweepIterator).toBeNull();
    expect(state.localCacheSweepTimer).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retries a transient PostgreSQL membership deadlock without replaying business work', async () => {
    jest.useRealTimers();
    const fixture = createServiceFixture();
    const deadlock = Object.assign(new Error('deadlock detected'), { code: 'P2034' });
    let attempts = 0;
    const operation = jest.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw deadlock;
      }
      return 'committed';
    });

    await expect(
      (fixture.service as any).runChatMembershipWriteWithDeadlockRetry(
        operation,
        'test.membershipWrite',
      ),
    ).resolves.toBe('committed');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('keeps routed send access after the former age boundary', async () => {
    const fixture = createServiceFixture();
    fixture.memberships.push(
      createActiveMembership('chat-access-age', fixture.bots[0]!.id, 0, {
        botAccessCheckedAt: new Date('2026-05-09T09:35:00.000Z'),
      }),
    );

    await expect(
      fixture.service.isBotAccessSnapshotStale({
        chatId: 'chat-access-age',
        botId: fixture.bots[0]!.id,
        maxAgeMs: 30 * 60_000,
      }),
    ).resolves.toBe(false);
    await expect(
      fixture.service.isBotAccessSnapshotStale({
        chatId: 'chat-access-age',
        botId: fixture.bots[0]!.id,
        maxAgeMs: 31 * 60_000,
      }),
    ).resolves.toBe(false);
  });

  it('keeps confirmed routed access after the former expiry', async () => {
    const fixture = createServiceFixture();
    const membership = createActiveMembership('chat-access-expiry', fixture.bots[0]!.id, 0, {
      botAccessCheckedAt: new Date('2026-05-09T09:49:00.000Z'),
      botAccessExpiresAt: new Date('2026-05-09T10:05:00.000Z'),
    });
    fixture.memberships.push(membership);

    await expect(
      fixture.service.isBotAccessSnapshotStale({
        chatId: 'chat-access-expiry',
        botId: fixture.bots[0]!.id,
        maxAgeMs: 30 * 60_000,
      }),
    ).resolves.toBe(false);

    membership.botAccessExpiresAt = new Date('2026-05-09T10:05:00.001Z');
    await expect(
      fixture.service.isBotAccessSnapshotStale({
        chatId: 'chat-access-expiry',
        botId: fixture.bots[0]!.id,
        maxAgeMs: 30 * 60_000,
      }),
    ).resolves.toBe(false);
  });

  it('ensures a probe parent without assigning bot ownership or membership', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-access-probe-parent';

    await expect(
      fixture.service.ensureChatForAccessProbe({
        chatId,
        title: 'Probe-only chat',
        entityType: ChatEntityType.CHAT,
      }),
    ).resolves.toBe(true);

    expect(fixture.prisma.chat.createMany).toHaveBeenCalledWith({
      data: {
        id: chatId,
        title: 'Probe-only chat',
        botId: null,
        primaryBotId: null,
        routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
        entityType: ChatEntityType.CHAT,
        catalogKind: ChatCatalogKind.CONTEXT_ONLY,
      },
      skipDuplicates: true,
    });
    expect(fixture.chats.get(chatId)).toEqual({
      id: chatId,
      title: 'Probe-only chat',
      botId: null,
      primaryBotId: null,
      entityType: ChatEntityType.CHAT,
      catalogKind: ChatCatalogKind.CONTEXT_ONLY,
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
      routingVersion: 0,
    });
    expect(fixture.memberships).toEqual([]);
    expect(fixture.prisma.chat.upsert).not.toHaveBeenCalled();
    expect(fixture.prisma.chat.update).not.toHaveBeenCalled();
    expect(fixture.prisma.chat.updateMany).not.toHaveBeenCalled();
    expect(fixture.prisma.chatBotMembership.createMany).not.toHaveBeenCalled();
    expect(fixture.prisma.chatBotMembership.upsert).not.toHaveBeenCalled();
    expect(fixture.prisma.chatBotMembership.updateMany).not.toHaveBeenCalled();
  });

  it('keeps an existing closed route and denied membership unchanged across repeated probe ensures', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-access-probe-existing-denied';
    const botId = fixture.bots[0]!.id;
    const deniedAt = new Date('2026-05-09T10:04:30.000Z');
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Persisted denied chat',
      botId: null,
      primaryBotId: null,
      entityType: ChatEntityType.CHAT,
      catalogKind: ChatCatalogKind.MANAGED,
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
      routingVersion: 11,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, botId, 0, {
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.REMOVED,
        botAccessState: ChatBotAccessState.DENIED,
        botAccessCheckedAt: deniedAt,
        lifecycleEventAt: deniedAt,
        lifecycleEventType: 'bot_removed',
        lifecycleSource: 'webhook',
      }),
    );
    const originalChat = structuredClone(fixture.chats.get(chatId));
    const originalMemberships = structuredClone(fixture.memberships);

    await expect(
      fixture.service.ensureChatForAccessProbe({
        chatId,
        title: 'Incoming webhook title',
        entityType: ChatEntityType.CHANNEL,
      }),
    ).resolves.toBe(true);
    await expect(
      fixture.service.ensureChatForAccessProbe({
        chatId,
        title: 'Another incoming title',
        entityType: ChatEntityType.CHANNEL,
      }),
    ).resolves.toBe(true);

    expect(fixture.chats.get(chatId)).toEqual(originalChat);
    expect(fixture.memberships).toEqual(originalMemberships);
    expect(fixture.prisma.chat.createMany).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.chat.upsert).not.toHaveBeenCalled();
    expect(fixture.prisma.chat.update).not.toHaveBeenCalled();
    expect(fixture.prisma.chat.updateMany).not.toHaveBeenCalled();
    expect(fixture.prisma.chatBotMembership.createMany).not.toHaveBeenCalled();
    expect(fixture.prisma.chatBotMembership.upsert).not.toHaveBeenCalled();
    expect(fixture.prisma.chatBotMembership.updateMany).not.toHaveBeenCalled();
  });

  it('persists a live routed access probe only onto an ACTIVE membership', async () => {
    const fixture = createServiceFixture();
    const membership = createActiveMembership('chat-access-probe', fixture.bots[0]!.id, 0);
    fixture.memberships.push(membership);

    await expect(
      fixture.service.recordBotAccessProbe({
        chatId: 'chat-access-probe',
        botId: fixture.bots[0]!.id,
        access: {
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
          permissionsKnown: true,
        },
        source: 'routed_action_preflight',
        checkedAt: new Date('2026-05-09T10:05:00.000Z'),
      }),
    ).resolves.toBe(true);

    expect(membership).toEqual(
      expect.objectContaining({
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessSource: 'routed_action_preflight',
        botAccessCheckedAt: new Date('2026-05-09T10:05:00.000Z'),
        permissionsSnapshot: expect.objectContaining({
          isAdmin: true,
          permissions: ['write'],
          permissionsKnown: true,
        }),
      }),
    );
    expect(fixture.moderationDeleteIntentAccessWake.wakeAfterCommittedProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-access-probe',
        botId: fixture.bots[0]!.id,
        entityType: ChatEntityType.CHAT,
        source: 'routed_action_preflight',
        previousAccess: expect.objectContaining({
          botAccessState: ChatBotAccessState.UNKNOWN,
        }),
      }),
    );
    expect(fixture.nightModeTransitionScheduler.reconcileChat).not.toHaveBeenCalled();
  });

  it('does not wake deletion solely because an identical proof passed its old TTL', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-expired-identical-delete-proof';
    const botId = fixture.bots[0]!.id;
    const checkedAt = new Date('2026-05-09T10:05:00.000Z');
    const membership = createActiveMembership(chatId, botId, 0, {
      botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
      botAccessCheckedAt: new Date('2026-05-09T09:40:00.000Z'),
      botAccessExpiresAt: new Date('2026-05-09T10:00:00.000Z'),
      permissionsSnapshot: {
        checkedAt: '2026-05-09T09:40:00.000Z',
        isAdmin: true,
        isOwner: false,
        permissions: ['read_all_messages', 'write'],
        permissionsKnown: true,
      },
    });
    fixture.memberships.push(membership);
    const executeRaw = jest.fn(async () => {
      expect(membership.botAccessCheckedAt).toEqual(checkedAt);
      return 1;
    });
    const wake = new ModerationDeleteIntentAccessWakeService({ $executeRaw: executeRaw } as never);
    fixture.moderationDeleteIntentAccessWake.wakeAfterCommittedProbe.mockImplementation((params) =>
      wake.wakeAfterCommittedProbe(params),
    );
    const probe = {
      chatId,
      botId,
      access: {
        isAdmin: true,
        isOwner: false,
        permissions: ['read_all_messages', 'write'],
        permissionsKnown: true,
      },
      source: 'moderation_executor_readiness',
      checkedAt,
    };
    await expect(fixture.service.recordBotAccessProbe(probe)).resolves.toBe(true);
    expect(executeRaw).not.toHaveBeenCalled();
    jest.setSystemTime(new Date('2026-05-09T10:05:01.000Z'));
    await expect(
      fixture.service.recordBotAccessProbe({
        ...probe,
        checkedAt: new Date('2026-05-09T10:05:01.000Z'),
      }),
    ).resolves.toBe(true);
    expect(fixture.moderationDeleteIntentAccessWake.wakeAfterCommittedProbe).toHaveBeenCalledTimes(
      2,
    );
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('reconciles night mode only after a fresh actionable access transition commits', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-night-mode-post-commit';
    fixture.memberships.push(
      createActiveMembership(chatId, fixture.bots[0]!.id, 0, {
        botAccessState: ChatBotAccessState.DENIED,
        botAccessExpiresAt: null,
        permissionsSnapshot: {
          checkedAt: new Date('2026-05-08T09:00:00.000Z').toISOString(),
          isAdmin: false,
          isOwner: false,
        },
      }),
    );
    let transactionCommitted = false;
    const runTransaction = fixture.prisma.$transaction.getMockImplementation()!;
    fixture.prisma.$transaction.mockImplementation(async (callback) => {
      const result = await runTransaction(callback);
      transactionCommitted = true;
      return result;
    });
    fixture.nightModeTransitionScheduler.reconcileChat.mockImplementation(async () => {
      expect(transactionCommitted).toBe(true);
      return {
        queueAvailable: true,
        scheduleEnabled: true,
        passes: 1,
      };
    });

    await expect(
      fixture.service.recordBotAccessProbe({
        chatId,
        botId: fixture.bots[0]!.id,
        ...explicitActivationProbe(fixture, chatId, fixture.bots[0]!.id),
        source: 'late_recovery_probe',
        checkedAt: new Date('2026-05-09T10:05:00.000Z'),
        allowMembershipRecovery: true,
      }),
    ).resolves.toBe(true);

    expect(fixture.nightModeTransitionScheduler.reconcileChat).toHaveBeenCalledWith(chatId);
  });

  it('does not reconcile night mode for an ordinary refresh of already-fresh access', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-night-mode-fresh-refresh';
    fixture.memberships.push(
      createActiveMembership(chatId, fixture.bots[0]!.id, 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
        permissionsSnapshot: {
          checkedAt: new Date('2026-05-09T10:04:00.000Z').toISOString(),
          isAdmin: true,
          isOwner: false,
        },
      }),
    );

    await expect(
      fixture.service.recordBotAccessProbe({
        chatId,
        botId: fixture.bots[0]!.id,
        access: { isAdmin: true, isOwner: false, permissions: ['write'] },
        source: 'routine_refresh',
        checkedAt: new Date('2026-05-09T10:05:00.000Z'),
        allowMembershipRecovery: true,
      }),
    ).resolves.toBe(true);

    expect(fixture.nightModeTransitionScheduler.reconcileChat).not.toHaveBeenCalled();
  });

  it('does not let an older denied probe overwrite a newer confirmed snapshot', async () => {
    const fixture = createServiceFixture();
    const membership = createActiveMembership('chat-access-probe-order', fixture.bots[0]!.id, 0);
    fixture.memberships.push(membership);
    const newerCheckedAt = new Date('2026-05-09T10:04:30.000Z');

    await expect(
      fixture.service.recordBotAccessProbe({
        chatId: 'chat-access-probe-order',
        botId: fixture.bots[0]!.id,
        access: { isAdmin: true, isOwner: false, permissions: ['write'] },
        source: 'newer_probe',
        checkedAt: newerCheckedAt,
      }),
    ).resolves.toBe(true);
    await expect(
      fixture.service.recordBotAccessProbe({
        chatId: 'chat-access-probe-order',
        botId: fixture.bots[0]!.id,
        access: null,
        source: 'older_probe',
        checkedAt: new Date('2026-05-09T10:04:00.000Z'),
      }),
    ).resolves.toBe(false);

    expect(membership).toEqual(
      expect.objectContaining({
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: newerCheckedAt,
        botAccessSource: 'newer_probe',
      }),
    );
  });

  it('does not run recovery when an older successful probe trails a newer denial', async () => {
    const fixture = createServiceFixture();
    const membership = createActiveMembership(
      'chat-access-probe-recovery-order',
      fixture.bots[0]!.id,
      0,
    );
    fixture.memberships.push(membership);
    const newerCheckedAt = new Date('2026-05-09T10:04:30.000Z');

    await expect(
      fixture.service.recordBotAccessProbe({
        chatId: 'chat-access-probe-recovery-order',
        botId: fixture.bots[0]!.id,
        access: null,
        source: 'newer_denial',
        checkedAt: newerCheckedAt,
        lastErrorCode: 'chat.denied',
      }),
    ).resolves.toBe(true);
    await expect(
      fixture.service.recordBotAccessProbe({
        chatId: 'chat-access-probe-recovery-order',
        botId: fixture.bots[0]!.id,
        access: { isAdmin: true, isOwner: false, permissions: ['write'] },
        source: 'older_success',
        checkedAt: new Date('2026-05-09T10:04:00.000Z'),
        allowMembershipRecovery: true,
      }),
    ).resolves.toBe(false);

    expect(membership).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.DENIED,
        botAccessCheckedAt: newerCheckedAt,
        botAccessSource: 'newer_denial',
        botAccessLastErrorCode: 'chat.denied',
      }),
    );
  });

  it('keeps an equal-time member downgrade ahead of a stronger access result', async () => {
    const fixture = createServiceFixture();
    const checkedAt = new Date('2026-05-09T10:04:30.000Z');
    const membership = createActiveMembership(
      'chat-access-probe-equal-downgrade',
      fixture.bots[0]!.id,
      0,
      {
        botAccessState: ChatBotAccessState.CONFIRMED_MEMBER,
        botAccessCheckedAt: checkedAt,
        permissionsSnapshot: {
          checkedAt: checkedAt.toISOString(),
          isAdmin: false,
          isOwner: false,
          permissions: [],
        },
      },
    );
    fixture.memberships.push(membership);

    await expect(
      fixture.service.recordBotAccessProbe({
        chatId: membership.chatId,
        botId: membership.botId,
        access: { isAdmin: true, isOwner: false, permissions: ['write'] },
        source: 'equal_time_stronger_probe',
        checkedAt,
      }),
    ).resolves.toBe(false);

    expect(membership).toEqual(
      expect.objectContaining({
        botAccessState: ChatBotAccessState.CONFIRMED_MEMBER,
        botAccessCheckedAt: checkedAt,
        permissionsSnapshot: expect.objectContaining({ isAdmin: false }),
      }),
    );
  });

  it('preserves removal metadata when a newer denied probe records ordering evidence', async () => {
    const fixture = createServiceFixture();
    const removedAt = new Date('2026-05-09T10:04:00.000Z');
    const accessLossSnapshot = {
      accessLostAt: removedAt.toISOString(),
      accessLostReason: 'bot_removed',
      accessLostSource: 'webhook',
    };
    const membership = createActiveMembership(
      'chat-removed-access-evidence',
      fixture.bots[0]!.id,
      0,
      {
        status: ChatBotMembershipStatus.REMOVED,
        role: ChatBotMembershipRole.STANDBY,
        permissionsSnapshot: accessLossSnapshot,
        permissionsHash: 'preserved-removal-hash',
        lifecycleEventAt: removedAt,
        lifecycleEventType: 'bot_removed',
        lifecycleSource: 'webhook',
      },
    );
    fixture.memberships.push(membership);
    const checkedAt = new Date('2026-05-09T10:04:30.000Z');

    await expect(
      fixture.service.recordBotAccessProbe({
        chatId: membership.chatId,
        botId: membership.botId,
        access: null,
        source: 'post_removal_denial',
        checkedAt,
      }),
    ).resolves.toBe(false);

    expect(membership).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.REMOVED,
        permissionsSnapshot: accessLossSnapshot,
        permissionsHash: 'preserved-removal-hash',
        botAccessState: ChatBotAccessState.DENIED,
        botAccessCheckedAt: checkedAt,
        lifecycleEventAt: removedAt,
      }),
    );
  });

  it('does not synthesize a removal tombstone from a positive non-recovery probe', async () => {
    const fixture = createServiceFixture();

    await expect(
      fixture.service.recordBotAccessProbe({
        chatId: 'chat-positive-probe-without-membership',
        botId: fixture.bots[0]!.id,
        access: { isAdmin: true, isOwner: false, permissions: ['write'] },
        source: 'non_recovery_probe',
        checkedAt: new Date('2026-05-09T10:04:30.000Z'),
      }),
    ).resolves.toBe(false);

    expect(fixture.memberships).toHaveLength(0);
    expect(fixture.prisma.chatBotMembership.createMany).not.toHaveBeenCalled();
    expect(fixture.moderationDeleteIntentAccessWake.wakeAfterCommittedProbe).not.toHaveBeenCalled();
  });

  it('does not let a probe from an older lifecycle epoch overwrite a re-added membership', async () => {
    const fixture = createServiceFixture();
    const readdedAt = new Date('2026-05-09T10:04:30.000Z');
    const membership = createActiveMembership(
      'chat-access-probe-lifecycle-order',
      fixture.bots[0]!.id,
      0,
      {
        botAccessState: ChatBotAccessState.UNKNOWN,
        botAccessCheckedAt: null,
        lifecycleEventAt: readdedAt,
        lifecycleEventType: 'bot_added',
        lifecycleSource: 'webhook',
      },
    );
    fixture.memberships.push(membership);

    await expect(
      fixture.service.recordBotAccessProbe({
        chatId: 'chat-access-probe-lifecycle-order',
        botId: fixture.bots[0]!.id,
        access: null,
        source: 'older_probe',
        checkedAt: new Date('2026-05-09T10:04:00.000Z'),
      }),
    ).resolves.toBe(false);

    expect(membership).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.UNKNOWN,
        botAccessCheckedAt: null,
        lifecycleEventAt: readdedAt,
        lifecycleEventType: 'bot_added',
        lifecycleSource: 'webhook',
      }),
    );
  });

  it('reactivates a removed origin membership only for an explicitly authorized live probe', async () => {
    const fixture = createServiceFixture();
    const membership = createActiveMembership('chat-access-recovery', fixture.bots[0]!.id, 0, {
      status: ChatBotMembershipStatus.REMOVED,
      role: ChatBotMembershipRole.STANDBY,
      lifecycleEventAt: new Date('2026-05-09T09:55:00.000Z'),
      lifecycleEventType: 'bot_removed',
      lifecycleSource: 'webhook',
    });
    fixture.memberships.push(membership);

    await expect(
      fixture.service.recordBotAccessProbe({
        chatId: 'chat-access-recovery',
        botId: fixture.bots[0]!.id,
        ...explicitActivationProbe(fixture, 'chat-access-recovery', fixture.bots[0]!.id),
        source: 'moderation_delete_intent_probe',
        checkedAt: new Date('2026-05-09T10:05:00.000Z'),
        allowMembershipRecovery: true,
      }),
    ).resolves.toBe(true);

    expect(membership).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.ACTIVE,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessSource: 'moderation_delete_intent_probe',
      }),
    );
    expect(fixture.nightModeTransitionScheduler.reconcileChat).toHaveBeenCalledWith(
      'chat-access-recovery',
    );
  });

  it.each([
    'passive',
    'old_source',
    'equal_source',
    'expired_source',
    'future_probe',
    'missing_receipt',
    'future_receipt_source',
    'wrong_receipt_actor',
    'wrong_live_actor',
    'actor_is_bot',
    'actor_type_unknown',
    'actor_lifecycle_changed',
    'actor_access_superseded',
    'bot_privilege_unknown',
    'actor_privilege_unknown',
    'permissions_unknown',
    'read_missing',
    'delete_missing',
  ] as const)('keeps confirmed loss dormant when activation has %s', async (invalid) => {
    const fixture = createServiceFixture();
    const chatId = `-activation-denied-${invalid}`;
    const botId = fixture.bots[0]!.id;
    const lostAt = new Date(Date.now() - 10_000);
    const membership = createActiveMembership(chatId, botId, 0, {
      status: ChatBotMembershipStatus.REMOVED,
      botAccessState: ChatBotAccessState.DENIED,
      botAccessCheckedAt: lostAt,
      lifecycleEventAt: lostAt,
      lifecycleEventType: 'bot_removed',
    });
    fixture.memberships.push(membership);
    const proofAt =
      invalid === 'old_source'
        ? new Date(lostAt.getTime() - 1)
        : invalid === 'equal_source'
          ? lostAt
          : invalid === 'expired_source'
            ? new Date(Date.now() - 300_001)
            : new Date(Date.now() - 1_000);
    const evidence = explicitActivationProbe(fixture, chatId, botId, proofAt);
    const probe: Parameters<MaxBotLinkService['recordBotAccessProbe']>[0] = {
      chatId,
      botId,
      ...evidence,
      source: 'handshake_start',
      checkedAt: new Date(),
      allowMembershipRecovery: true,
    };
    if (invalid === 'passive') delete probe.explicitActivation;
    if (invalid === 'future_probe') probe.checkedAt = new Date(Date.now() + 1_000);
    if (invalid === 'missing_receipt') fixture.activationReceipts.clear();
    const receipt = fixture.activationReceipts.get(
      `${botId}:${evidence.explicitActivation.updateId}`,
    );
    if (invalid === 'future_receipt_source') receipt!.createdAt = new Date(proofAt.getTime() - 1);
    if (invalid === 'wrong_receipt_actor')
      (receipt!.normalizedPayload.message as { senderId: string }).senderId = 'different-admin';
    if (invalid === 'wrong_live_actor') evidence.activationActorAccess.userId = 'different-admin';
    if (invalid === 'actor_is_bot') evidence.activationActorAccess.isBot = true;
    if (invalid === 'actor_type_unknown')
      probe.activationActorAccess = { ...evidence.activationActorAccess, isBot: undefined };
    if (invalid === 'actor_lifecycle_changed')
      fixture.prisma.chatMembershipActivityEvent.findFirst.mockResolvedValue({
        id: 'actor-left-after-probe',
      });
    if (invalid === 'actor_access_superseded')
      fixture.prisma.managedEntityAccessEdge.findFirst.mockResolvedValue({
        checkedAt: new Date(Date.now() + 1),
      });
    if (invalid === 'actor_privilege_unknown')
      evidence.activationActorAccess.explicitPrivilegeEvidence = false;
    if (invalid === 'bot_privilege_unknown') evidence.access.explicitPrivilegeEvidence = false;
    if (invalid === 'permissions_unknown') evidence.access.permissionsKnown = false;
    if (invalid === 'read_missing') evidence.access.permissions = ['write'];
    if (invalid === 'delete_missing') evidence.access.permissions = ['read_all_messages'];
    const before = structuredClone(membership);
    await expect(fixture.service.recordBotAccessProbe(probe)).resolves.toBe(false);
    expect(membership).toEqual(before);
    expect(fixture.moderationDeleteIntentAccessWake.wakeAfterCommittedProbe).not.toHaveBeenCalled();
    expect(fixture.nightModeTransitionScheduler.reconcileChat).not.toHaveBeenCalled();
  });

  it('creates a missing membership and restores night mode scheduling after explicit activation', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-missing-access-recovery';
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Late recovery',
      botId: null,
      primaryBotId: null,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
      routingVersion: 0,
    });

    await expect(
      fixture.service.recordBotAccessProbe({
        chatId,
        botId: fixture.bots[0]!.id,
        ...explicitActivationProbe(fixture, chatId, fixture.bots[0]!.id),
        source: 'late_final_verify_recovery',
        checkedAt: new Date('2026-05-09T10:05:00.000Z'),
        allowMembershipRecovery: true,
      }),
    ).resolves.toBe(true);

    expect(fixture.memberships).toEqual([
      expect.objectContaining({
        chatId,
        botId: fixture.bots[0]!.id,
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
      }),
    ]);
    expect(fixture.nightModeTransitionScheduler.reconcileChat).toHaveBeenCalledWith(chatId);
  });

  it.each([false, true])(
    'permits a passive positive refresh only for existing legacy UNKNOWN membership: existing=%s',
    async (existing) => {
      const fixture = createServiceFixture();
      const chatId = `initial-passive-${existing}`;
      const botId = fixture.bots[0]!.id;
      fixture.chats.set(chatId, {
        id: chatId,
        title: chatId,
        botId: null,
        primaryBotId: null,
        entityType: ChatEntityType.CHAT,
      });
      if (existing) fixture.memberships.push(createActiveMembership(chatId, botId, 0));
      await expect(
        fixture.service.recordBotAccessProbe({
          chatId,
          botId,
          source: 'passive_refresh',
          checkedAt: new Date(),
          allowMembershipRecovery: true,
          access: {
            isAdmin: true,
            isOwner: false,
            permissionsKnown: true,
            permissions: ['read_all_messages', 'write'],
          },
        }),
      ).resolves.toBe(existing);
      if (existing)
        expect(fixture.memberships[0]?.botAccessState).toBe(ChatBotAccessState.CONFIRMED_ADMIN);
      else {
        expect(fixture.memberships).toEqual([]);
        expect(fixture.nightModeTransitionScheduler.reconcileChat).not.toHaveBeenCalled();
        expect(
          fixture.moderationDeleteIntentAccessWake.wakeAfterCommittedProbe,
        ).not.toHaveBeenCalled();
      }
    },
  );

  it('retries a failed post-commit night mode reconciliation without another probe', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-night-mode-reconcile-retry';
    const warnSpy = jest
      .spyOn((fixture.service as any).logger, 'warn')
      .mockImplementation(() => undefined);
    fixture.memberships.push(
      createActiveMembership(chatId, fixture.bots[0]!.id, 0, {
        botAccessState: ChatBotAccessState.DENIED,
        botAccessExpiresAt: null,
        permissionsSnapshot: null,
      }),
    );
    const redisError = new Error('night queue unavailable');
    fixture.nightModeTransitionScheduler.reconcileChat
      .mockRejectedValueOnce(redisError)
      .mockResolvedValueOnce({
        queueAvailable: true,
        scheduleEnabled: true,
        passes: 1,
      });
    const probe = {
      chatId,
      botId: fixture.bots[0]!.id,
      ...explicitActivationProbe(fixture, chatId, fixture.bots[0]!.id),
      source: 'retryable_late_recovery',
      checkedAt: new Date('2026-05-09T10:05:00.000Z'),
      allowMembershipRecovery: true,
    } as const;

    await expect(fixture.service.recordBotAccessProbe(probe)).resolves.toBe(true);
    expect(fixture.nightModeTransitionScheduler.reconcileChat).toHaveBeenCalledTimes(1);
    await jest.runOnlyPendingTimersAsync();

    expect(fixture.nightModeTransitionScheduler.reconcileChat).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      { chatId, err: redisError.message },
      'Failed to reconcile night mode transitions after access recovery; retry remains pending',
    );
  });

  it('unrefs and clears the pending night mode reconciliation retry on shutdown', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-night-mode-reconcile-shutdown';
    fixture.memberships.push(
      createActiveMembership(chatId, fixture.bots[0]!.id, 0, {
        botAccessState: ChatBotAccessState.DENIED,
        botAccessExpiresAt: null,
        permissionsSnapshot: null,
      }),
    );
    fixture.nightModeTransitionScheduler.reconcileChat.mockRejectedValue(
      new Error('night queue unavailable'),
    );

    await expect(
      fixture.service.recordBotAccessProbe({
        chatId,
        botId: fixture.bots[0]!.id,
        ...explicitActivationProbe(fixture, chatId, fixture.bots[0]!.id),
        source: 'publication_preflight',
        checkedAt: new Date('2026-05-09T10:05:00.000Z'),
        allowMembershipRecovery: true,
      }),
    ).resolves.toBe(true);

    const retryTimer = (fixture.service as any).nightModeReconciliationRetryTimer as NodeJS.Timeout;
    expect(retryTimer.hasRef()).toBe(false);
    expect(jest.getTimerCount()).toBe(1);

    fixture.service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fixture.nightModeTransitionScheduler.reconcileChat).toHaveBeenCalledTimes(1);
  });

  it('bounds each autonomous night mode reconciliation retry batch', async () => {
    const fixture = createServiceFixture();
    const pending = (
      fixture.service as unknown as {
        pendingNightModeReconciliations: Set<string>;
      }
    ).pendingNightModeReconciliations;
    const retry = (
      fixture.service as unknown as {
        retryPendingNightModeReconciliations(): Promise<void>;
      }
    ).retryPendingNightModeReconciliations.bind(fixture.service);
    for (let index = 0; index < 51; index += 1) {
      pending.add(`chat-night-mode-retry-batch-${index}`);
    }

    await retry();

    expect(fixture.nightModeTransitionScheduler.reconcileChat).toHaveBeenCalledTimes(50);
    expect(pending).toEqual(new Set(['chat-night-mode-retry-batch-50']));
    expect(jest.getTimerCount()).toBe(1);
    fixture.service.onModuleDestroy();
  });

  it('keeps a removal that is newer than the live probe observation boundary', async () => {
    const fixture = createServiceFixture();
    const membership = createActiveMembership(
      'chat-stale-access-recovery',
      fixture.bots[0]!.id,
      0,
      {
        status: ChatBotMembershipStatus.REMOVED,
        role: ChatBotMembershipRole.STANDBY,
        lifecycleEventAt: new Date('2026-05-09T10:04:30.000Z'),
        lifecycleEventType: 'bot_removed',
        lifecycleSource: 'webhook',
      },
    );
    fixture.memberships.push(membership);

    await expect(
      fixture.service.recordBotAccessProbe({
        chatId: 'chat-stale-access-recovery',
        botId: fixture.bots[0]!.id,
        access: {
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        },
        source: 'admin_roster_sync',
        checkedAt: new Date('2026-05-09T10:04:00.000Z'),
        allowMembershipRecovery: true,
      }),
    ).resolves.toBe(false);

    expect(membership).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.REMOVED,
        lifecycleEventAt: new Date('2026-05-09T10:04:30.000Z'),
        lifecycleEventType: 'bot_removed',
        lifecycleSource: 'webhook',
        botAccessState: ChatBotAccessState.UNKNOWN,
      }),
    );
  });

  it('discovers a new chat with a duplicate-safe insert and awaits explicit activation', async () => {
    const fixture = createServiceFixture();

    await expect(
      fixture.service.bindChatToBot({
        chatId: 'chat-bind-1',
        title: 'Bound chat',
        entityType: ChatEntityType.CHAT,
        botId: 'id613002203036_4_bot',
      }),
    ).resolves.toBeNull();

    expect(fixture.prisma.chat.create).not.toHaveBeenCalled();
    expect(fixture.prisma.chat.createMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 'chat-bind-1',
        title: 'Bound chat',
        botId: 'id613002203036_4_bot',
        primaryBotId: 'id613002203036_4_bot',
        entityType: ChatEntityType.CHAT,
        catalogKind: ChatCatalogKind.MANAGED,
      }),
      skipDuplicates: true,
    });
    expect(fixture.chats.get('chat-bind-1')).toEqual(
      expect.objectContaining({
        botId: null,
        primaryBotId: null,
        routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
      }),
    );
    expect(fixture.memberships).toContainEqual(
      expect.objectContaining({
        chatId: 'chat-bind-1',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessSource: MAJOR_EXPLICIT_ACTIVATION_PENDING_SOURCE,
        lastWebhookAt: expect.any(Date),
      }),
    );
  });

  it('keeps the stored primary bot when a duplicate-safe bind observes another bot', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-bind-2', {
      id: 'chat-bind-2',
      title: 'Stored chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: ChatEntityType.CHAT,
      catalogKind: ChatCatalogKind.MANAGED,
    });
    fixture.memberships.push(createActiveMembership('chat-bind-2', 'id613002203036_bot', 0));

    await expect(
      fixture.service.bindChatToBot({
        chatId: 'chat-bind-2',
        title: 'Updated stored chat',
        entityType: ChatEntityType.CHAT,
        botId: 'id613002203036_4_bot',
      }),
    ).resolves.toBe('id613002203036_bot');

    expect(fixture.prisma.chat.create).not.toHaveBeenCalled();
    expect(fixture.prisma.chat.update).toHaveBeenCalledWith({
      where: { id: 'chat-bind-2' },
      data: expect.objectContaining({
        title: 'Updated stored chat',
        botId: 'id613002203036_bot',
        primaryBotId: 'id613002203036_bot',
        entityType: ChatEntityType.CHAT,
        catalogKind: ChatCatalogKind.MANAGED,
      }),
    });
    expect(fixture.memberships).toContainEqual(
      expect.objectContaining({
        chatId: 'chat-bind-2',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
      }),
    );
    expect(fixture.memberships).toContainEqual(
      expect.objectContaining({
        chatId: 'chat-bind-2',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
      }),
    );
  });

  it.each([1, 2, 3, 6])(
    'keeps deterministic send and moderation routes when %i bot(s) are active in one chat',
    async (botCount) => {
      const fixture = createServiceFixture();
      const chatId = `chat-route-matrix-${botCount}`;
      const botIds = ROUTE_MATRIX_BOT_IDS.slice(0, botCount);
      const primaryBotId = botIds[0];
      if (!primaryBotId) {
        throw new Error('Route matrix needs at least one bot');
      }
      fixture.chats.set(chatId, {
        id: chatId,
        title: `Matrix chat ${botCount}`,
        botId: primaryBotId,
        primaryBotId,
        entityType: ChatEntityType.CHAT,
      });
      fixture.memberships.push(
        ...botIds.map((botId, index) => createActiveMembership(chatId, botId, index)),
      );

      const sendRoute = await fixture.service.resolveBotRoute({
        purpose: 'send_message',
        chatId,
      });
      const moderationRoute = await fixture.service.resolveBotRoute({
        purpose: 'moderation_action',
        chatId,
        action: 'delete_message',
      });

      expect(sendRoute.botId).toBe(primaryBotId);
      expect(sendRoute.primaryBotId).toBe(primaryBotId);
      expect(sendRoute.candidateBotIds).toEqual(botIds);
      expect(moderationRoute.botId).toBe(primaryBotId);
      expect(moderationRoute.primaryBotId).toBe(primaryBotId);
      expect(moderationRoute.candidateBotIds).toEqual(botIds);
    },
  );

  it('excludes quarantined routes only for sends while the quarantine is active', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const fixture = createServiceFixture();
      const chatId = 'chat-send-route-quarantine';
      const primaryBotId = ROUTE_MATRIX_BOT_IDS[0];
      const alternateBotId = ROUTE_MATRIX_BOT_IDS[1];
      fixture.chats.set(chatId, {
        id: chatId,
        title: 'Send route quarantine',
        botId: primaryBotId,
        primaryBotId,
        entityType: ChatEntityType.CHAT,
      });
      fixture.memberships.push(
        createActiveMembership(chatId, primaryBotId, 0, {
          sendRouteFailureCount: 1,
          sendRouteQuarantinedUntil: new Date('2026-07-27T18:00:00.000Z'),
          sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
        }),
        createActiveMembership(chatId, alternateBotId, 1),
      );

      await expect(
        fixture.service.resolveBotRoute({ purpose: 'send_message', chatId }),
      ).resolves.toEqual(
        expect.objectContaining({
          botId: alternateBotId,
          candidateBotIds: [alternateBotId],
          quarantinedCandidateBotIds: [primaryBotId],
        }),
      );
      await expect(
        fixture.service.resolveBotRoute({
          purpose: 'moderation_action',
          chatId,
          action: 'delete_message',
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          botId: primaryBotId,
          candidateBotIds: [primaryBotId, alternateBotId],
        }),
      );

      jest.setSystemTime(new Date('2026-07-27T18:00:01.000Z'));
      await expect(
        fixture.service.resolveBotRoute({ purpose: 'send_message', chatId }),
      ).resolves.toEqual(
        expect.objectContaining({
          botId: alternateBotId,
          candidateBotIds: [alternateBotId],
          quarantinedCandidateBotIds: [primaryBotId],
          halfOpenCandidateBotIds: [],
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('exposes and atomically claims one half-open route after its first quarantine', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T18:00:01.000Z'));
    try {
      const fixture = createServiceFixture();
      const chatId = 'chat-half-open-send-route';
      const primaryBotId = ROUTE_MATRIX_BOT_IDS[0];
      fixture.chats.set(chatId, {
        id: chatId,
        title: 'Half-open send route',
        botId: primaryBotId,
        primaryBotId,
        entityType: ChatEntityType.CHAT,
      });
      fixture.memberships.push(
        createActiveMembership(chatId, primaryBotId, 0, {
          sendRouteFailureCount: 1,
          sendRouteQuarantinedUntil: new Date('2026-07-27T18:00:00.000Z'),
          sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
        }),
      );

      await expect(
        fixture.service.resolveBotRoute({ purpose: 'send_message', chatId }),
      ).resolves.toEqual(
        expect.objectContaining({
          botId: null,
          candidateBotIds: [],
          quarantinedCandidateBotIds: [primaryBotId],
          halfOpenCandidateBotIds: [],
          retryAt: new Date('2026-07-27T18:15:01.000Z'),
        }),
      );
      await expect(
        fixture.service.resolveBotRoute({
          purpose: 'send_message',
          chatId,
          allowHalfOpenProbe: true,
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          botId: primaryBotId,
          candidateBotIds: [primaryBotId],
          quarantinedCandidateBotIds: [],
          halfOpenCandidateBotIds: [primaryBotId],
        }),
      );
      await expect(
        fixture.service.claimSendRouteHalfOpen({ chatId, botId: primaryBotId }),
      ).resolves.toEqual(new Date('2026-07-28T00:00:01.000Z'));
      expect(fixture.prisma.chatBotMembership.updateMany).toHaveBeenLastCalledWith({
        where: {
          chatId,
          botId: primaryBotId,
          status: ChatBotMembershipStatus.ACTIVE,
          sendRouteFailureCount: 1,
          sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
          OR: [
            { sendRouteQuarantinedUntil: null },
            {
              sendRouteQuarantinedUntil: {
                lte: new Date('2026-07-27T18:00:01.000Z'),
              },
            },
          ],
        },
        data: {
          sendRouteQuarantinedUntil: new Date('2026-07-28T00:00:01.000Z'),
        },
      });

      await expect(
        fixture.service.releaseSendRouteHalfOpen({
          chatId,
          botId: primaryBotId,
          claimedUntil: new Date('2026-07-28T00:00:01.000Z'),
        }),
      ).resolves.toBe(true);

      const concurrentClaims = await Promise.all([
        fixture.service.claimSendRouteHalfOpen({ chatId, botId: primaryBotId }),
        fixture.service.claimSendRouteHalfOpen({ chatId, botId: primaryBotId }),
      ]);
      expect(concurrentClaims.filter(Boolean)).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns no send candidate when the only route is quarantined', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const fixture = createServiceFixture();
      const chatId = 'chat-only-send-route-quarantined';
      const primaryBotId = ROUTE_MATRIX_BOT_IDS[0];
      fixture.chats.set(chatId, {
        id: chatId,
        title: 'Only quarantined send route',
        botId: primaryBotId,
        primaryBotId,
        entityType: ChatEntityType.CHAT,
      });
      fixture.memberships.push(
        createActiveMembership(chatId, primaryBotId, 0, {
          sendRouteFailureCount: 2,
          sendRouteQuarantinedUntil: new Date('2026-07-27T18:00:00.000Z'),
          sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
        }),
      );

      await expect(
        fixture.service.resolveBotRoute({ purpose: 'send_message', chatId }),
      ).resolves.toEqual(
        expect.objectContaining({
          botId: null,
          candidateBotIds: [],
          quarantinedCandidateBotIds: [primaryBotId],
          retryAt: new Date('2026-07-27T18:00:00.000Z'),
        }),
      );

      jest.setSystemTime(new Date('2026-07-27T18:00:01.000Z'));
      await expect(
        fixture.service.resolveBotRoute({ purpose: 'send_message', chatId }),
      ).resolves.toEqual(
        expect.objectContaining({
          botId: null,
          candidateBotIds: [],
          quarantinedCandidateBotIds: [primaryBotId],
          retryAt: new Date('2026-07-28T00:00:01.000Z'),
        }),
      );

      const primaryMembership = fixture.memberships.find(
        (membership) => membership.chatId === chatId && membership.botId === primaryBotId,
      );
      primaryMembership!.sendRouteQuarantinedUntil = null;
      primaryMembership!.sendRouteLastFailureCode = null;
      await expect(
        fixture.service.resolveBotRoute({ purpose: 'send_message', chatId }),
      ).resolves.toEqual(
        expect.objectContaining({
          botId: primaryBotId,
          candidateBotIds: [primaryBotId],
          quarantinedCandidateBotIds: [],
        }),
      );
      await expect(
        fixture.service.resolveBotRoute({
          purpose: 'moderation_action',
          chatId,
          action: 'delete_message',
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          botId: primaryBotId,
          candidateBotIds: [primaryBotId],
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('allows one expired sticky route claim only for a newer future night boundary', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-28T00:00:01.000Z'));
    try {
      const fixture = createServiceFixture();
      const chatId = 'chat-future-night-sticky-probe';
      const primaryBotId = ROUTE_MATRIX_BOT_IDS[0];
      const failureBefore = '2026-07-28T00:00:00.000Z';
      fixture.chats.set(chatId, {
        id: chatId,
        title: 'Future night sticky probe',
        botId: primaryBotId,
        primaryBotId,
        entityType: ChatEntityType.CHAT,
      });
      fixture.memberships.push(
        createActiveMembership(chatId, primaryBotId, 0, {
          sendRouteFailureCount: 3,
          sendRouteQuarantinedUntil: new Date('2026-07-27T23:59:59.000Z'),
          sendRouteLastFailureAt: new Date('2026-07-27T00:00:00.000Z'),
          sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
        }),
      );

      await expect(
        fixture.service.resolveBotRoute({
          purpose: 'send_message',
          chatId,
          allowHalfOpenProbe: true,
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          candidateBotIds: [],
          halfOpenCandidateBotIds: [],
        }),
      );
      await expect(
        fixture.service.resolveBotRoute({
          purpose: 'send_message',
          chatId,
          allowHalfOpenProbe: true,
          stickyHalfOpenProbeFailureBefore: failureBefore,
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          botId: primaryBotId,
          candidateBotIds: [primaryBotId],
          halfOpenCandidateBotIds: [primaryBotId],
        }),
      );

      const claimedUntil = new Date('2026-07-28T06:00:01.000Z');
      await expect(
        fixture.service.claimSendRouteHalfOpen({
          chatId,
          botId: primaryBotId,
          stickyProbeFailureBefore: failureBefore,
        }),
      ).resolves.toEqual(claimedUntil);
      expect(fixture.memberships[0]).toEqual(
        expect.objectContaining({
          sendRouteFailureCount: 3,
          sendRouteQuarantinedUntil: claimedUntil,
        }),
      );
      await expect(
        fixture.service.claimSendRouteHalfOpen({
          chatId,
          botId: primaryBotId,
          stickyProbeFailureBefore: failureBefore,
        }),
      ).resolves.toBeNull();
      await expect(
        fixture.service.releaseSendRouteHalfOpen({
          chatId,
          botId: primaryBotId,
          claimedUntil,
          stickyProbeFailureBefore: failureBefore,
        }),
      ).resolves.toBe(true);

      fixture.memberships[0]!.sendRouteLastFailureAt = new Date(failureBefore);
      await expect(
        fixture.service.resolveBotRoute({
          purpose: 'send_message',
          chatId,
          allowHalfOpenProbe: true,
          stickyHalfOpenProbeFailureBefore: failureBefore,
        }),
      ).resolves.toEqual(
        expect.objectContaining({ candidateBotIds: [], halfOpenCandidateBotIds: [] }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails closed for every routed purpose when the chat is NO_ELIGIBLE_BOT', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-no-eligible';
    const botId = fixture.bots[0]!.id;
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Closed route',
      botId,
      primaryBotId: botId,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
      routingVersion: 7,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, botId, 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
      }),
    );

    const routes = await Promise.all([
      fixture.service.resolveBotRoute({ purpose: 'default', chatId }),
      fixture.service.resolveBotRoute({ purpose: 'read', chatId }),
      fixture.service.resolveBotRoute({ purpose: 'send_message', chatId }),
      fixture.service.resolveBotRouteForChannelPoll({ chatId }),
      fixture.service.resolveBotRoute({
        purpose: 'moderation_action',
        chatId,
        action: 'delete_message',
      }),
      fixture.service.resolveBotRoute({
        purpose: 'capability',
        chatId,
        capability: 'background_scans',
      }),
    ]);

    for (const route of routes) {
      expect(route).toEqual(
        expect.objectContaining({
          botId: null,
          candidateBotIds: [],
          routingVersion: 7,
        }),
      );
    }
    await expect(fixture.service.getStoredChatPrimaryBotId(chatId)).resolves.toBeNull();
    await expect(
      fixture.service.getChatExecutionBinding({ chatId, activeBotId: botId }),
    ).resolves.toEqual(expect.objectContaining({ shouldHandleGroupUpdate: false }));
  });

  it('does not let a stale local binding override the primary stored by another process', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-cross-process-primary';
    const oldBotId = fixture.bots[0]!.id;
    const newBotId = fixture.bots[1]!.id;
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Cross-process route',
      botId: newBotId,
      primaryBotId: newBotId,
      routingState: ChatRoutingState.READY,
      routingVersion: 9,
    });
    fixture.service.rememberChatBotBinding(chatId, oldBotId);

    await expect(fixture.service.getStoredChatPrimaryBotId(chatId)).resolves.toBe(newBotId);
    expect(fixture.service.resolveBotIdSync(null, chatId)).toBe(newBotId);
  });

  it.each([undefined, 'Chat chat-kept-title', 'Channel chat-kept-title'])(
    'preserves stored title on discovery and routing refresh with %s',
    async (title) => {
      const fixture = createServiceFixture();
      const chatId = 'chat-kept-title';
      const botId = fixture.bots[0]!.id;
      fixture.chats.set(chatId, {
        id: chatId,
        title: 'Сохранённое имя',
        botId,
        primaryBotId: botId,
      });
      await fixture.service.bindDiscoveredChatBots({ chatId, botIds: [botId], title });
      expect(fixture.chats.get(chatId)?.title).toBe('Сохранённое имя');
      await fixture.service.reconcileChatPrimaryByAccess({ chatId, title });
      expect(fixture.chats.get(chatId)?.title).toBe('Сохранённое имя');
      await fixture.service.bindDiscoveredChatBots({ chatId, botIds: [botId], title: 'Новое имя' });
      expect(fixture.chats.get(chatId)?.title).toBe('Новое имя');
    },
  );

  it('keeps a newly discovered chat closed until an administrator explicitly activates it', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-discovery-needs-access';
    const botId = fixture.bots[0]!.id;

    await expect(
      fixture.service.bindDiscoveredChatBots({
        chatId,
        primaryBotId: botId,
        botIds: [botId],
        title: 'Discovered chat',
        entityType: ChatEntityType.CHAT,
      }),
    ).resolves.toBeNull();
    expect(fixture.chats.get(chatId)).toEqual(
      expect.objectContaining({
        routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
      }),
    );
    await expect(fixture.service.getStoredChatPrimaryBotId(chatId)).resolves.toBeNull();

    await expect(
      fixture.service.recordBotAccessProbe({
        chatId,
        botId,
        checkedAt: new Date(),
        source: 'passive_discovery',
        access: {
          isAdmin: true,
          isOwner: false,
          permissionsKnown: true,
          permissions: ['read_all_messages', 'write'],
        },
      }),
    ).resolves.toBe(false);
    await expect(fixture.service.reconcileChatPrimaryByAccess({ chatId })).resolves.toBeNull();
    expect(fixture.memberships[0]?.botAccessSource).toBe(MAJOR_EXPLICIT_ACTIVATION_PENDING_SOURCE);

    jest.setSystemTime(Date.now() + 2_000);
    await expect(
      fixture.service.recordBotAccessProbe({
        chatId,
        botId,
        checkedAt: new Date(),
        source: 'handshake_start',
        ...explicitActivationProbe(fixture, chatId, botId),
      }),
    ).resolves.toBe(true);

    await expect(fixture.service.reconcileChatPrimaryByAccess({ chatId })).resolves.toBe(botId);
    expect(fixture.chats.get(chatId)).toEqual(
      expect.objectContaining({
        routingState: ChatRoutingState.READY,
      }),
    );
  });

  it('does not reactivate a confirmed removal from discovery metadata alone', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-discovery-after-removal';
    const botId = fixture.bots[0]!.id;
    const removedAt = new Date('2026-05-09T09:00:00.456Z');
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Removed discovery chat',
      botId: null,
      primaryBotId: null,
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
      catalogKind: ChatCatalogKind.MANAGED,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, botId, 0, {
        status: ChatBotMembershipStatus.REMOVED,
        role: ChatBotMembershipRole.STANDBY,
        botAccessState: ChatBotAccessState.LOST,
        lifecycleEventAt: removedAt,
        lifecycleEventType: 'bot_removed',
        lifecycleSource: 'webhook',
        lastSeenAt: removedAt,
        lastWebhookAt: removedAt,
      }),
    );

    await expect(
      fixture.service.bindDiscoveredChatBots({
        chatId,
        primaryBotId: botId,
        botIds: [botId],
        title: 'Removed discovery chat',
        entityType: ChatEntityType.CHAT,
      }),
    ).resolves.toBeNull();

    expect(fixture.memberships[0]).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.REMOVED,
        botAccessState: ChatBotAccessState.LOST,
        lifecycleEventAt: removedAt,
        lifecycleEventType: 'bot_removed',
        lifecycleSource: 'webhook',
      }),
    );
    expect(fixture.chats.get(chatId)).toEqual(
      expect.objectContaining({
        botId: null,
        primaryBotId: null,
        routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
        catalogKind: ChatCatalogKind.MANAGED,
      }),
    );
  });

  it('clears a stale primary when no runtime-actionable membership survives', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-zero-actionable';
    const botId = fixture.bots[0]!.id;
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'No actionable bot',
      botId,
      primaryBotId: botId,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
      routingVersion: 3,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, botId, 0, {
        botAccessState: ChatBotAccessState.DENIED,
      }),
    );

    await expect(fixture.service.reconcileChatPrimaryByAccess({ chatId })).resolves.toBeNull();
    expect(fixture.chats.get(chatId)).toEqual(
      expect.objectContaining({
        botId: null,
        primaryBotId: null,
        routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
        routingVersion: 4,
      }),
    );
  });

  it('reopens a persisted route only after runtime eligibility is confirmed', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-route-recovered';
    const botId = fixture.bots[0]!.id;
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Recovered route',
      botId,
      primaryBotId: botId,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
      routingVersion: 5,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, botId, 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
      }),
    );

    await expect(fixture.service.reconcileChatPrimaryByAccess({ chatId })).resolves.toBe(botId);
    expect(fixture.chats.get(chatId)).toEqual(
      expect.objectContaining({
        routingState: ChatRoutingState.READY,
      }),
    );
    await expect(
      fixture.service.resolveBotRoute({ purpose: 'send_message', chatId }),
    ).resolves.toEqual(expect.objectContaining({ botId, candidateBotIds: [botId] }));
  });

  it('keeps an already consistent route idempotent without rewriting roles or version', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-route-idempotent';
    const botId = fixture.bots[1]!.id;
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Stable route',
      botId,
      primaryBotId: botId,
      routingState: ChatRoutingState.READY,
      routingVersion: 3,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, botId, 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
      }),
    );

    await expect(fixture.service.reconcileChatPrimaryByAccess({ chatId })).resolves.toBe(botId);

    expect(fixture.chats.get(chatId)).toEqual(
      expect.objectContaining({
        botId,
        primaryBotId: botId,
        routingState: ChatRoutingState.READY,
        routingVersion: 3,
      }),
    );
    expect(fixture.prisma.chat.update).not.toHaveBeenCalled();
    expect(fixture.prisma.chatBotMembership.updateMany).not.toHaveBeenCalled();
  });

  it('selects an explicit primary only under the expected routing and access epochs', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-explicit-primary';
    const currentBotId = fixture.bots[0]!.id;
    const nextBotId = fixture.bots[1]!.id;
    const checkedAt = new Date('2026-05-09T10:04:30.000Z');
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Explicit primary',
      botId: currentBotId,
      primaryBotId: currentBotId,
      routingState: ChatRoutingState.READY,
      routingVersion: 4,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, currentBotId, 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: checkedAt,
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
        botAccessSource: 'existing_primary',
        permissionsSnapshot: {
          checkedAt: checkedAt.toISOString(),
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        },
      }),
      createActiveMembership(chatId, nextBotId, 1, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: checkedAt,
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
        botAccessSource: 'execution_planner_primary',
        permissionsSnapshot: {
          checkedAt: checkedAt.toISOString(),
          isAdmin: true,
          isOwner: false,
          permissions: ['write', 'delete_messages'],
        },
      }),
    );

    await expect(
      fixture.service.selectChatPrimaryBot({
        chatId,
        botId: nextBotId,
        expectedRoutingVersion: 4,
        expectedAccessEpoch: {
          checkedAt,
          source: 'execution_planner_primary',
        },
      }),
    ).resolves.toBe(true);

    expect(fixture.chats.get(chatId)).toEqual(
      expect.objectContaining({
        botId: nextBotId,
        primaryBotId: nextBotId,
        routingState: ChatRoutingState.READY,
        routingVersion: 5,
      }),
    );
    expect(fixture.memberships.find((row) => row.botId === currentBotId)?.role).toBe(
      ChatBotMembershipRole.STANDBY,
    );
    expect(fixture.memberships.find((row) => row.botId === nextBotId)?.role).toBe(
      ChatBotMembershipRole.PRIMARY,
    );
  });

  it('rejects explicit primary selection when a lifecycle event supersedes its access epoch', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-explicit-primary-stale-access';
    const currentBotId = fixture.bots[0]!.id;
    const nextBotId = fixture.bots[1]!.id;
    const checkedAt = new Date('2026-05-09T10:04:30.000Z');
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Stale explicit primary',
      botId: currentBotId,
      primaryBotId: currentBotId,
      routingState: ChatRoutingState.READY,
      routingVersion: 7,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, currentBotId, 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
      }),
      createActiveMembership(chatId, nextBotId, 1, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: checkedAt,
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
        botAccessSource: 'execution_planner_primary',
        permissionsSnapshot: {
          checkedAt: checkedAt.toISOString(),
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        },
        lifecycleEventAt: checkedAt,
        lifecycleEventType: 'bot_removed',
        lifecycleSource: 'webhook',
      }),
    );

    await expect(
      fixture.service.selectChatPrimaryBot({
        chatId,
        botId: nextBotId,
        expectedRoutingVersion: 7,
        expectedAccessEpoch: {
          checkedAt,
          source: 'execution_planner_primary',
        },
      }),
    ).resolves.toBe(false);

    expect(fixture.chats.get(chatId)).toEqual(
      expect.objectContaining({
        botId: currentBotId,
        primaryBotId: currentBotId,
        routingVersion: 7,
      }),
    );
    expect(fixture.memberships.find((row) => row.botId === currentBotId)?.role).toBe(
      ChatBotMembershipRole.PRIMARY,
    );
    expect(fixture.memberships.find((row) => row.botId === nextBotId)?.role).toBe(
      ChatBotMembershipRole.STANDBY,
    );
  });

  it('repairs divergent primary roles during durable routing reconciliation', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-route-role-repair';
    const primaryBotId = fixture.bots[0]!.id;
    const stalePrimaryBotId = fixture.bots[1]!.id;
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Divergent roles',
      botId: primaryBotId,
      primaryBotId,
      routingState: ChatRoutingState.READY,
      routingVersion: 8,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, primaryBotId, 0, {
        role: ChatBotMembershipRole.STANDBY,
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
      }),
      createActiveMembership(chatId, stalePrimaryBotId, 1, {
        role: ChatBotMembershipRole.PRIMARY,
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
      }),
    );

    await expect(fixture.service.reconcileChatRoutingState({ chatId })).resolves.toEqual({
      routingState: ChatRoutingState.READY,
      changed: true,
    });

    expect(fixture.chats.get(chatId)?.routingVersion).toBe(9);
    expect(fixture.memberships.find((row) => row.botId === primaryBotId)?.role).toBe(
      ChatBotMembershipRole.PRIMARY,
    );
    expect(fixture.memberships.find((row) => row.botId === stalePrimaryBotId)?.role).toBe(
      ChatBotMembershipRole.STANDBY,
    );
  });

  it('locks the chat before memberships during route reconciliation', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-route-lock-order';
    const botId = fixture.bots[0]!.id;
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Lock order',
      botId,
      primaryBotId: botId,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
      routingVersion: 2,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, botId, 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
      }),
    );

    await fixture.service.reconcileChatRoutingState({ chatId });

    const lockSql = fixture.prisma.$queryRaw.mock.calls.map(([query]) => {
      const statement = query as { strings?: readonly string[]; sql?: string };
      return statement.strings?.join('') ?? statement.sql ?? '';
    });
    expect(lockSql).toHaveLength(2);
    expect(lockSql[0]).toContain('FROM "chats"');
    expect(lockSql[1]).toContain('FROM "chat_bot_memberships"');
  });

  it('force-bumps routingVersion for a dirty epoch even when the effective state stays READY', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-routing-dirty-epoch';
    const botId = fixture.bots[0]!.id;
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Dirty route',
      botId,
      primaryBotId: botId,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
      routingVersion: 7,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, botId, 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
      }),
    );

    await expect(
      fixture.service.reconcileChatRoutingState({ chatId, forceVersionBump: true }),
    ).resolves.toEqual({
      routingState: ChatRoutingState.READY,
      changed: true,
    });
    expect(fixture.chats.get(chatId)?.routingVersion).toBe(8);
  });

  it('rolls back the chat and role writes when primary promotion fails', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-route-promotion-rollback';
    const removedBotId = fixture.bots[0]!.id;
    const nextBotId = fixture.bots[1]!.id;
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Promotion rollback',
      botId: removedBotId,
      primaryBotId: removedBotId,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
      routingVersion: 11,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, removedBotId, 0, {
        status: ChatBotMembershipStatus.REMOVED,
        role: ChatBotMembershipRole.PRIMARY,
        botAccessState: ChatBotAccessState.LOST,
      }),
      createActiveMembership(chatId, nextBotId, 1, {
        role: ChatBotMembershipRole.STANDBY,
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
      }),
    );
    const updateMemberships = fixture.prisma.chatBotMembership.updateMany.getMockImplementation();
    if (!updateMemberships) {
      throw new Error('membership updateMany fixture implementation missing');
    }
    fixture.prisma.chatBotMembership.updateMany.mockImplementation(async (args) => {
      if ((args.data as { role?: ChatBotMembershipRole }).role === ChatBotMembershipRole.PRIMARY) {
        throw new Error('simulated primary promotion failure');
      }
      return updateMemberships(args);
    });

    await expect(fixture.service.reconcileChatPrimaryByAccess({ chatId })).rejects.toThrow(
      'simulated primary promotion failure',
    );
    expect(fixture.chats.get(chatId)).toEqual(
      expect.objectContaining({
        botId: removedBotId,
        primaryBotId: removedBotId,
        routingState: ChatRoutingState.READY,
        routingVersion: 11,
      }),
    );
    expect(fixture.memberships.find((row) => row.botId === removedBotId)?.role).toBe(
      ChatBotMembershipRole.PRIMARY,
    );
    expect(fixture.memberships.find((row) => row.botId === nextBotId)?.role).toBe(
      ChatBotMembershipRole.STANDBY,
    );
  });

  it('promotes an active standby bot to primary when the current primary bot is removed', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-1', {
      id: 'chat-1',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-1',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-03-30T10:00:00.000Z'),
        updatedAt: new Date('2026-03-30T10:00:00.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:00.000Z'),
      },
      {
        chatId: 'chat-1',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-03-30T10:00:01.000Z'),
        updatedAt: new Date('2026-03-30T10:00:01.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:01.000Z'),
      },
    );

    await fixture.service.markChatBotRemoved({
      chatId: 'chat-1',
      botId: 'id613002203036_bot',
      title: 'Shared chat',
    });

    expect(fixture.chats.get('chat-1')).toEqual(
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        primaryBotId: 'id613002203036_4_bot',
      }),
    );
    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_bot'),
    ).toEqual(
      expect.objectContaining({
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.REMOVED,
      }),
    );
    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_4_bot'),
    ).toEqual(
      expect.objectContaining({
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
      }),
    );
  });

  it('promotes the stronger confirmed standby regardless of old TTL', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-3bot-lost-primary', {
      id: 'chat-3bot-lost-primary',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-3bot-lost-primary',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-05-09T10:00:00.000Z'),
        updatedAt: new Date('2026-05-09T10:00:00.000Z'),
        lastSeenAt: new Date('2026-05-09T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-05-09T10:00:00.000Z'),
      },
      {
        chatId: 'chat-3bot-lost-primary',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-07T10:00:00.000Z',
          isAdmin: true,
          isOwner: true,
          permissions: ['delete_messages', 'add_remove_members'],
        },
        createdAt: new Date('2026-05-09T10:00:01.000Z'),
        updatedAt: new Date('2026-05-09T10:00:01.000Z'),
        lastSeenAt: new Date('2026-05-09T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-05-09T10:00:01.000Z'),
      },
      {
        chatId: 'chat-3bot-lost-primary',
        botId: 'id613002203036_5_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:30.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-05-09T10:00:02.000Z'),
        updatedAt: new Date('2026-05-09T10:00:02.000Z'),
        lastSeenAt: new Date('2026-05-09T10:00:02.000Z'),
        lastWebhookAt: new Date('2026-05-09T10:00:02.000Z'),
      },
    );

    await expect(
      fixture.service.markChatBotRemoved({
        chatId: 'chat-3bot-lost-primary',
        botId: 'id613002203036_bot',
        title: 'Shared chat',
      }),
    ).resolves.toBe('id613002203036_4_bot');

    expect(fixture.chats.get('chat-3bot-lost-primary')).toEqual(
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        primaryBotId: 'id613002203036_4_bot',
      }),
    );
    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_4_bot'),
    ).toEqual(
      expect.objectContaining({
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
      }),
    );
    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_5_bot'),
    ).toEqual(
      expect.objectContaining({
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
      }),
    );
  });

  it('does not promote a standby with fresh explicit denied access when primary is removed', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-3bot-denied-standby', {
      id: 'chat-3bot-denied-standby',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      createActiveMembership('chat-3bot-denied-standby', 'id613002203036_bot', 0),
      createActiveMembership('chat-3bot-denied-standby', 'id613002203036_4_bot', 1, {
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:30.000Z',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        },
      }),
      createActiveMembership('chat-3bot-denied-standby', 'id613002203036_5_bot', 2, {
        permissionsSnapshot: {
          checkedAt: '2026-05-07T10:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
      }),
    );

    await expect(
      fixture.service.markChatBotRemoved({
        chatId: 'chat-3bot-denied-standby',
        botId: 'id613002203036_bot',
        title: 'Shared chat',
      }),
    ).resolves.toBe('id613002203036_5_bot');

    expect(fixture.chats.get('chat-3bot-denied-standby')).toEqual(
      expect.objectContaining({
        botId: 'id613002203036_5_bot',
        primaryBotId: 'id613002203036_5_bot',
      }),
    );
    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_4_bot'),
    ).toEqual(
      expect.objectContaining({
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
      }),
    );
  });

  it('resolves an assist-capable standby bot for shared background lanes', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-2', {
      id: 'chat-2',
      title: 'Assist chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-2',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-03-31T00:00:00.000Z'),
        updatedAt: new Date('2026-03-31T00:00:00.000Z'),
        lastSeenAt: new Date('2026-03-31T00:00:00.000Z'),
        lastWebhookAt: new Date('2026-03-31T00:00:00.000Z'),
      },
      {
        chatId: 'chat-2',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-03-31T00:00:01.000Z'),
        updatedAt: new Date('2026-03-31T00:00:01.000Z'),
        lastSeenAt: new Date('2026-03-31T00:00:01.000Z'),
        lastWebhookAt: new Date('2026-03-31T00:00:01.000Z'),
        capabilities: ['suggestion_delivery', 'channel_stats'],
      },
    );

    const resolved = await fixture.service.resolveBotIdForCapability({
      chatId: 'chat-2',
      capability: 'suggestion_delivery',
    });

    expect(resolved).toBe('id613002203036_4_bot');
  });

  it('returns every assist-capable standby before the primary capability fallback', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-2-multi-assist', {
      id: 'chat-2-multi-assist',
      title: 'Assist chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-2-multi-assist',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-03-31T00:00:00.000Z'),
        updatedAt: new Date('2026-03-31T00:00:00.000Z'),
        lastSeenAt: new Date('2026-03-31T00:00:00.000Z'),
        lastWebhookAt: new Date('2026-03-31T00:00:00.000Z'),
      },
      {
        chatId: 'chat-2-multi-assist',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        capabilities: ['suggestion_delivery', 'channel_stats'],
        createdAt: new Date('2026-03-31T00:00:01.000Z'),
        updatedAt: new Date('2026-03-31T00:00:01.000Z'),
        lastSeenAt: new Date('2026-03-31T00:00:01.000Z'),
        lastWebhookAt: new Date('2026-03-31T00:00:01.000Z'),
      },
      {
        chatId: 'chat-2-multi-assist',
        botId: 'id613002203036_5_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        capabilities: ['suggestion_delivery'],
        createdAt: new Date('2026-03-31T00:00:02.000Z'),
        updatedAt: new Date('2026-03-31T00:00:02.000Z'),
        lastSeenAt: new Date('2026-03-31T00:00:02.000Z'),
        lastWebhookAt: new Date('2026-03-31T00:00:02.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdsForCapability({
        chatId: 'chat-2-multi-assist',
        capability: 'suggestion_delivery',
      }),
    ).resolves.toEqual(['id613002203036_4_bot', 'id613002203036_5_bot', 'id613002203036_bot']);

    const route = await fixture.service.resolveBotRoute({
      purpose: 'capability',
      chatId: 'chat-2-multi-assist',
      capability: 'suggestion_delivery',
    });
    expect(route.botId).toBe('id613002203036_4_bot');
    expect(route.candidateBotIds).toEqual([
      'id613002203036_4_bot',
      'id613002203036_5_bot',
      'id613002203036_bot',
    ]);
  });

  it('does not route assist capabilities to a bot with explicit denied access', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-denied-capability', {
      id: 'chat-denied-capability',
      title: 'Denied assist chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      createActiveMembership('chat-denied-capability', 'id613002203036_bot', 0),
      createActiveMembership('chat-denied-capability', 'id613002203036_4_bot', 1, {
        capabilities: ['suggestion_delivery'],
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:30.000Z',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        },
      }),
    );

    await expect(
      fixture.service.resolveBotIdsForCapability({
        chatId: 'chat-denied-capability',
        capability: 'suggestion_delivery',
        fallbackToPrimary: false,
      }),
    ).resolves.toEqual([]);

    await expect(
      fixture.service.resolveBotIdsForCapability({
        chatId: 'chat-denied-capability',
        capability: 'suggestion_delivery',
      }),
    ).resolves.toEqual(['id613002203036_bot']);
  });

  it('stores access-loss diagnostics on removed bot memberships', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-access-lost', {
      id: 'chat-access-lost',
      title: 'Lost chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });

    await fixture.service.markChatBotRemoved({
      chatId: 'chat-access-lost',
      botId: 'id613002203036_bot',
      title: 'Lost chat',
      accessLostReason: 'bot_denied',
      accessLostSource: 'night_mode_transition:close',
      lastMaxErrorCode: 'chat.denied',
      lastMaxErrorMessage: 'Forbidden',
      lastMaxStatusCode: 403,
    });

    expect(
      fixture.memberships.find((membership) => membership.chatId === 'chat-access-lost'),
    ).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.REMOVED,
        permissionsSnapshot: expect.objectContaining({
          accessLostReason: 'bot_denied',
          accessLostSource: 'night_mode_transition:close',
          lastMaxErrorCode: 'chat.denied',
          lastMaxErrorMessage: 'Forbidden',
          lastMaxStatusCode: 403,
          accessLostAt: expect.any(String),
        }),
      }),
    );
  });

  it('does not downgrade a managed group chat to context-only when marking a bot removed', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('managed-chat', {
      id: 'managed-chat',
      title: 'Managed group',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: ChatEntityType.CHAT,
      catalogKind: ChatCatalogKind.MANAGED,
    });
    fixture.memberships.push({
      chatId: 'managed-chat',
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.PRIMARY,
      status: ChatBotMembershipStatus.ACTIVE,
      createdAt: new Date('2026-05-09T10:00:00.000Z'),
      updatedAt: new Date('2026-05-09T10:00:00.000Z'),
      lastSeenAt: new Date('2026-05-09T10:00:00.000Z'),
      lastWebhookAt: new Date('2026-05-09T10:00:00.000Z'),
    });

    await expect(
      fixture.service.markChatBotRemoved({
        chatId: 'managed-chat',
        botId: 'id613002203036_bot',
        title: 'Managed group',
        entityType: ChatEntityType.CHAT,
      }),
    ).resolves.toBeNull();

    expect(fixture.chats.get('managed-chat')).toEqual(
      expect.objectContaining({
        catalogKind: ChatCatalogKind.MANAGED,
        botId: null,
        primaryBotId: null,
      }),
    );
  });

  it('reports non-primary shared chat bindings as non-executable for group updates', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-1', {
      id: 'chat-1',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-1',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-03-30T10:00:00.000Z'),
        updatedAt: new Date('2026-03-30T10:00:00.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:00.000Z'),
      },
      {
        chatId: 'chat-1',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-03-30T10:00:01.000Z'),
        updatedAt: new Date('2026-03-30T10:00:01.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:01.000Z'),
      },
    );

    const binding = await fixture.service.getChatExecutionBinding({
      chatId: 'chat-1',
      activeBotId: 'id613002203036_4_bot',
    });

    expect(binding).toEqual(
      expect.objectContaining({
        activeBotId: 'id613002203036_4_bot',
        primaryBotId: 'id613002203036_bot',
        activeMembershipStatus: ChatBotMembershipStatus.ACTIVE,
        shouldHandleGroupUpdate: false,
      }),
    );
  });

  it('uses an active executable standby instead of a draining stored primary for execution binding', async () => {
    const fixture = createServiceFixture();
    const drainingPrimaryBot = fixture.bots.find((bot) => bot.id === 'id613002203036_bot');
    if (!drainingPrimaryBot) {
      throw new Error('primary bot fixture missing');
    }
    drainingPrimaryBot.state = 'draining';
    fixture.chats.set('chat-draining-execution-owner', {
      id: 'chat-draining-execution-owner',
      title: 'Shared chat with draining owner',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      createActiveMembership('chat-draining-execution-owner', 'id613002203036_bot', 0, {
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write', 'delete_messages', 'add_remove_members'],
        },
      }),
      createActiveMembership('chat-draining-execution-owner', 'id613002203036_4_bot', 1, {
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write', 'delete_messages', 'add_remove_members'],
        },
      }),
    );

    const standbyBinding = await fixture.service.getChatExecutionBinding({
      chatId: 'chat-draining-execution-owner',
      activeBotId: 'id613002203036_4_bot',
    });
    const drainingBinding = await fixture.service.getChatExecutionBinding({
      chatId: 'chat-draining-execution-owner',
      activeBotId: 'id613002203036_bot',
    });

    expect(standbyBinding).toEqual(
      expect.objectContaining({
        activeBotId: 'id613002203036_4_bot',
        primaryBotId: 'id613002203036_4_bot',
        activeMembershipStatus: ChatBotMembershipStatus.ACTIVE,
        assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
        shouldHandleGroupUpdate: true,
      }),
    );
    expect(drainingBinding).toEqual(
      expect.objectContaining({
        activeBotId: 'id613002203036_bot',
        primaryBotId: 'id613002203036_4_bot',
        activeMembershipStatus: ChatBotMembershipStatus.ACTIVE,
        assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
        shouldHandleGroupUpdate: false,
      }),
    );
  });

  it('keeps the operational fallback for execution binding when no executable candidate exists', async () => {
    const fixture = createServiceFixture();
    const drainingPrimaryBot = fixture.bots.find((bot) => bot.id === 'id613002203036_bot');
    if (!drainingPrimaryBot) {
      throw new Error('primary bot fixture missing');
    }
    drainingPrimaryBot.state = 'draining';
    fixture.chats.set('chat-draining-execution-fallback', {
      id: 'chat-draining-execution-fallback',
      title: 'Shared chat with no executable owner',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      createActiveMembership('chat-draining-execution-fallback', 'id613002203036_bot', 0, {
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
      }),
    );

    await expect(
      fixture.service.getChatExecutionBinding({
        chatId: 'chat-draining-execution-fallback',
        activeBotId: 'id613002203036_bot',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        activeBotId: 'id613002203036_bot',
        primaryBotId: 'id613002203036_bot',
        activeMembershipStatus: ChatBotMembershipStatus.ACTIVE,
        assignedBotIds: ['id613002203036_bot'],
        shouldHandleGroupUpdate: true,
      }),
    );
  });

  it('derives a deterministic owner from active memberships when chat primary is missing', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-2', {
      id: 'chat-2',
      title: 'Shared chat without primary',
      botId: null,
      primaryBotId: null,
    });
    fixture.memberships.push(
      {
        chatId: 'chat-2',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-03-30T11:00:00.000Z'),
        updatedAt: new Date('2026-03-30T11:00:00.000Z'),
        lastSeenAt: new Date('2026-03-30T11:00:00.000Z'),
        lastWebhookAt: new Date('2026-03-30T11:00:00.000Z'),
      },
      {
        chatId: 'chat-2',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-03-30T11:00:01.000Z'),
        updatedAt: new Date('2026-03-30T11:00:01.000Z'),
        lastSeenAt: new Date('2026-03-30T11:00:01.000Z'),
        lastWebhookAt: new Date('2026-03-30T11:00:01.000Z'),
      },
    );

    const ownerBinding = await fixture.service.getChatExecutionBinding({
      chatId: 'chat-2',
      activeBotId: 'id613002203036_bot',
    });
    const standbyBinding = await fixture.service.getChatExecutionBinding({
      chatId: 'chat-2',
      activeBotId: 'id613002203036_4_bot',
    });

    expect(ownerBinding).toEqual(
      expect.objectContaining({
        primaryBotId: 'id613002203036_bot',
        assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
        shouldHandleGroupUpdate: true,
      }),
    );
    expect(standbyBinding).toEqual(
      expect.objectContaining({
        primaryBotId: 'id613002203036_bot',
        assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
        shouldHandleGroupUpdate: false,
      }),
    );
  });

  it('keeps the healthy shared owner despite a stronger receiving bot', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-rights', {
      id: 'chat-rights',
      title: 'Shared rights chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-rights',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
          permissionsKnown: true,
        },
        createdAt: new Date('2026-05-09T10:00:00.000Z'),
        updatedAt: new Date('2026-05-09T10:00:00.000Z'),
        lastSeenAt: new Date('2026-05-09T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-05-09T10:00:00.000Z'),
      },
      {
        chatId: 'chat-rights',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write', 'delete_messages', 'add_remove_members'],
          permissionsKnown: true,
        },
        createdAt: new Date('2026-05-09T10:00:01.000Z'),
        updatedAt: new Date('2026-05-09T10:00:01.000Z'),
        lastSeenAt: new Date('2026-05-09T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-05-09T10:00:01.000Z'),
      },
    );

    const strongerBinding = await fixture.service.getChatExecutionBinding({
      chatId: 'chat-rights',
      activeBotId: 'id613002203036_4_bot',
    });
    const weakerBinding = await fixture.service.getChatExecutionBinding({
      chatId: 'chat-rights',
      activeBotId: 'id613002203036_bot',
    });

    expect(strongerBinding).toEqual(
      expect.objectContaining({
        primaryBotId: 'id613002203036_bot',
        shouldHandleGroupUpdate: false,
      }),
    );
    expect(weakerBinding).toEqual(
      expect.objectContaining({
        primaryBotId: 'id613002203036_bot',
        shouldHandleGroupUpdate: true,
      }),
    );
  });

  it('does not use a stale stronger standby as the shared chat execution owner', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-stale-execution-owner', {
      id: 'chat-stale-execution-owner',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-stale-execution-owner',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-05-09T10:00:00.000Z'),
        updatedAt: new Date('2026-05-09T10:00:00.000Z'),
        lastSeenAt: new Date('2026-05-09T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-05-09T10:00:00.000Z'),
      },
      {
        chatId: 'chat-stale-execution-owner',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-07T10:00:00.000Z',
          isAdmin: true,
          isOwner: true,
          permissions: ['delete_messages', 'add_remove_members'],
        },
        createdAt: new Date('2026-05-09T10:00:01.000Z'),
        updatedAt: new Date('2026-05-09T10:00:01.000Z'),
        lastSeenAt: new Date('2026-05-09T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-05-09T10:00:01.000Z'),
      },
    );

    const ownerBinding = await fixture.service.getChatExecutionBinding({
      chatId: 'chat-stale-execution-owner',
      activeBotId: 'id613002203036_bot',
    });
    const staleStandbyBinding = await fixture.service.getChatExecutionBinding({
      chatId: 'chat-stale-execution-owner',
      activeBotId: 'id613002203036_4_bot',
    });

    expect(ownerBinding).toEqual(
      expect.objectContaining({
        primaryBotId: 'id613002203036_bot',
        shouldHandleGroupUpdate: true,
      }),
    );
    expect(staleStandbyBinding).toEqual(
      expect.objectContaining({
        primaryBotId: 'id613002203036_bot',
        shouldHandleGroupUpdate: false,
      }),
    );
  });

  it('preserves a healthy primary when reconciliation sees a stronger standby', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-reconcile-rights', {
      id: 'chat-reconcile-rights',
      title: 'Shared rights chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-reconcile-rights',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
          permissionsKnown: true,
        },
        createdAt: new Date('2026-05-09T10:00:00.000Z'),
        updatedAt: new Date('2026-05-09T10:00:00.000Z'),
        lastSeenAt: new Date('2026-05-09T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-05-09T10:00:00.000Z'),
      },
      {
        chatId: 'chat-reconcile-rights',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write', 'delete_messages', 'add_remove_members'],
          permissionsKnown: true,
        },
        createdAt: new Date('2026-05-09T10:00:01.000Z'),
        updatedAt: new Date('2026-05-09T10:00:01.000Z'),
        lastSeenAt: new Date('2026-05-09T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-05-09T10:00:01.000Z'),
      },
    );

    await expect(
      fixture.service.reconcileChatPrimaryByAccess({ chatId: 'chat-reconcile-rights' }),
    ).resolves.toBe('id613002203036_bot');

    expect(fixture.chats.get('chat-reconcile-rights')).toEqual(
      expect.objectContaining({
        botId: 'id613002203036_bot',
        primaryBotId: 'id613002203036_bot',
      }),
    );
    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_4_bot'),
    ).toEqual(
      expect.objectContaining({
        role: ChatBotMembershipRole.STANDBY,
      }),
    );
    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_bot'),
    ).toEqual(
      expect.objectContaining({
        role: ChatBotMembershipRole.PRIMARY,
      }),
    );
  });

  it('repairs an ineligible stored primary by falling back to an executable legacy bot', async () => {
    const fixture = createServiceFixture();
    const dormantPrimaryBot = fixture.bots.find((bot) => bot.id === 'id613002203036_4_bot');
    if (!dormantPrimaryBot) {
      throw new Error('standby bot fixture missing');
    }
    dormantPrimaryBot.state = 'dormant';
    fixture.chats.set('chat-ineligible-primary', {
      id: 'chat-ineligible-primary',
      title: 'Shared transition chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_4_bot',
    });
    fixture.memberships.push({
      chatId: 'chat-ineligible-primary',
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.STANDBY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: {
        checkedAt: '2026-05-09T10:00:00.000Z',
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      },
      createdAt: new Date('2026-05-09T10:00:00.000Z'),
      updatedAt: new Date('2026-05-09T10:00:00.000Z'),
      lastSeenAt: new Date('2026-05-09T10:00:00.000Z'),
      lastWebhookAt: new Date('2026-05-09T10:00:00.000Z'),
    });

    await expect(
      fixture.service.reconcileChatPrimaryByAccess({ chatId: 'chat-ineligible-primary' }),
    ).resolves.toBe('id613002203036_bot');

    expect(fixture.chats.get('chat-ineligible-primary')).toEqual(
      expect.objectContaining({
        botId: 'id613002203036_bot',
        primaryBotId: 'id613002203036_bot',
      }),
    );
  });

  it('prefers a standby bot with confirmed admin access for member-access lookups', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-1', {
      id: 'channel-1',
      title: 'Shared channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'channel-1',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-03-30T10:00:00.000Z',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        },
        createdAt: new Date('2026-03-30T10:00:00.000Z'),
        updatedAt: new Date('2026-03-30T10:00:00.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:00.000Z'),
      },
      {
        chatId: 'channel-1',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-03-30T10:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-03-30T10:00:01.000Z'),
        updatedAt: new Date('2026-03-30T10:00:01.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdForMemberAccess({ chatId: 'channel-1' }),
    ).resolves.toBe('id613002203036_4_bot');
  });

  it('uses an operational draining bot for member-access reads instead of a dormant primary', async () => {
    const fixture = createServiceFixture();
    const primaryBot = fixture.bots.find((bot) => bot.id === 'id613002203036_bot');
    const standbyBot = fixture.bots.find((bot) => bot.id === 'id613002203036_4_bot');
    if (!primaryBot || !standbyBot) {
      throw new Error('bot fixture missing');
    }
    primaryBot.state = 'dormant';
    standbyBot.state = 'draining';
    fixture.chats.set('channel-operational-read', {
      id: 'channel-operational-read',
      title: 'Shared channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'channel-operational-read',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-26T08:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-05-26T08:00:00.000Z'),
        updatedAt: new Date('2026-05-26T08:00:00.000Z'),
        lastSeenAt: new Date('2026-05-26T08:00:00.000Z'),
        lastWebhookAt: new Date('2026-05-26T08:00:00.000Z'),
      },
      {
        chatId: 'channel-operational-read',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-26T08:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-05-26T08:00:01.000Z'),
        updatedAt: new Date('2026-05-26T08:00:01.000Z'),
        lastSeenAt: new Date('2026-05-26T08:00:01.000Z'),
        lastWebhookAt: new Date('2026-05-26T08:00:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdForMemberAccess({ chatId: 'channel-operational-read' }),
    ).resolves.toBe('id613002203036_4_bot');
  });

  it('reuses the member-access route for generic chat reads when the primary bot lost access', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-read-1', {
      id: 'channel-read-1',
      title: 'Readable channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'channel-read-1',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-03-30T10:00:00.000Z',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        },
        createdAt: new Date('2026-03-30T10:00:00.000Z'),
        updatedAt: new Date('2026-03-30T10:00:00.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:00.000Z'),
      },
      {
        chatId: 'channel-read-1',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-03-30T10:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-03-30T10:00:01.000Z'),
        updatedAt: new Date('2026-03-30T10:00:01.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:01.000Z'),
      },
    );

    await expect(fixture.service.resolveBotIdForRead({ chatId: 'channel-read-1' })).resolves.toBe(
      'id613002203036_4_bot',
    );
  });

  it('returns a structured read route with provenance for generic chat reads', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-read-route-1', {
      id: 'channel-read-route-1',
      title: 'Readable channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'channel-read-route-1',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-03-30T10:00:00.000Z',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        },
        createdAt: new Date('2026-03-30T10:00:00.000Z'),
        updatedAt: new Date('2026-03-30T10:00:00.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:00.000Z'),
      },
      {
        chatId: 'channel-read-route-1',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-03-30T10:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-03-30T10:00:01.000Z'),
        updatedAt: new Date('2026-03-30T10:00:01.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotRoute({
        purpose: 'read',
        chatId: 'channel-read-route-1',
      }),
    ).resolves.toMatchObject({
      purpose: 'read',
      chatId: 'channel-read-route-1',
      primaryBotId: 'id613002203036_4_bot',
      botId: 'id613002203036_4_bot',
      candidateBotIds: ['id613002203036_4_bot'],
      reason: 'primary_confirmed',
    });
  });

  it('uses the send-message route for write delivery instead of generic read fallback', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-send-route-1', {
      id: 'channel-send-route-1',
      title: 'Writable channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'channel-send-route-1',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-03-30T10:00:00.000Z',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        },
        createdAt: new Date('2026-03-30T10:00:00.000Z'),
        updatedAt: new Date('2026-03-30T10:00:00.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:00.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:00.000Z'),
      },
      {
        chatId: 'channel-send-route-1',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-03-30T10:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        },
        createdAt: new Date('2026-03-30T10:00:01.000Z'),
        updatedAt: new Date('2026-03-30T10:00:01.000Z'),
        lastSeenAt: new Date('2026-03-30T10:00:01.000Z'),
        lastWebhookAt: new Date('2026-03-30T10:00:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotRoute({
        purpose: 'send_message',
        chatId: 'channel-send-route-1',
      }),
    ).resolves.toMatchObject({
      purpose: 'send_message',
      chatId: 'channel-send-route-1',
      primaryBotId: 'id613002203036_4_bot',
      botId: 'id613002203036_4_bot',
      candidateBotIds: ['id613002203036_4_bot'],
      reason: 'primary_confirmed',
    });
  });

  it('does not treat channel admin status without write permission as send access', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-send-no-write', {
      id: 'channel-send-no-write',
      title: 'Read-only channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: 'CHANNEL',
    });
    fixture.memberships.push({
      chatId: 'channel-send-no-write',
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.PRIMARY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: {
        checkedAt: '2026-03-30T10:00:00.000Z',
        isAdmin: true,
        isOwner: false,
        permissions: ['edit'],
      },
      createdAt: new Date('2026-03-30T10:00:00.000Z'),
      updatedAt: new Date('2026-03-30T10:00:00.000Z'),
      lastSeenAt: new Date('2026-03-30T10:00:00.000Z'),
      lastWebhookAt: new Date('2026-03-30T10:00:00.000Z'),
    });

    await expect(
      fixture.service.resolveBotRoute({
        purpose: 'send_message',
        chatId: 'channel-send-no-write',
        fallbackToPrimary: false,
      }),
    ).resolves.toMatchObject({ botId: null, candidateBotIds: [] });
  });

  it('excludes known empty channel admin and owner rights while preserving unknown legacy routes', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-send-known-empty', {
      id: 'channel-send-known-empty',
      title: 'Known read-only channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: ChatEntityType.CHANNEL,
    });
    fixture.chats.set('channel-send-legacy-empty', {
      id: 'channel-send-legacy-empty',
      title: 'Legacy permission snapshot',
      botId: 'id613002203036_4_bot',
      primaryBotId: 'id613002203036_4_bot',
      entityType: ChatEntityType.CHANNEL,
    });
    fixture.chats.set('channel-send-owner-empty', {
      id: 'channel-send-owner-empty',
      title: 'Owner channel',
      botId: 'id613002203036_5_bot',
      primaryBotId: 'id613002203036_5_bot',
      entityType: ChatEntityType.CHANNEL,
    });
    fixture.memberships.push(
      createActiveMembership('channel-send-known-empty', 'id613002203036_bot', 0, {
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: [],
          permissionsKnown: true,
        },
      }),
      createActiveMembership('channel-send-legacy-empty', 'id613002203036_4_bot', 0, {
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: [],
        },
      }),
      createActiveMembership('channel-send-owner-empty', 'id613002203036_5_bot', 0, {
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: true,
          permissions: [],
          permissionsKnown: true,
        },
      }),
    );

    await expect(
      fixture.service.resolveBotRoute({
        purpose: 'send_message',
        chatId: 'channel-send-known-empty',
      }),
    ).resolves.toMatchObject({ botId: null, candidateBotIds: [] });
    await expect(
      fixture.service.resolveBotRoute({
        purpose: 'send_message',
        chatId: 'channel-send-legacy-empty',
      }),
    ).resolves.toMatchObject({
      botId: 'id613002203036_4_bot',
      candidateBotIds: ['id613002203036_4_bot'],
      reason: 'primary_soft',
    });
    await expect(
      fixture.service.resolveBotRoute({
        purpose: 'send_message',
        chatId: 'channel-send-owner-empty',
      }),
    ).resolves.toMatchObject({ botId: null, candidateBotIds: [] });
  });

  it('selects a channel poll bot only with confirmed read-all, write, and edit permissions', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-poll-route', {
      id: 'channel-poll-route',
      title: 'Poll channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: 'CHANNEL',
    });
    fixture.memberships.push(
      createActiveMembership('channel-poll-route', 'id613002203036_bot', 0, {
        role: ChatBotMembershipRole.PRIMARY,
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['write', 'edit'],
        },
      }),
      createActiveMembership('channel-poll-route', 'id613002203036_4_bot', 1, {
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write', 'edit'],
        },
      }),
      createActiveMembership('channel-poll-route', 'id613002203036_5_bot', 2, {
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:00:02.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'post_edit_delete_message', 'edit_message'],
        },
      }),
    );

    await expect(
      fixture.service.resolveBotIdForChannelPoll({ chatId: 'channel-poll-route' }),
    ).resolves.toBe('id613002203036_4_bot');
    await expect(
      fixture.service.resolveBotRouteForChannelPoll({ chatId: 'channel-poll-route' }),
    ).resolves.toMatchObject({
      botId: 'id613002203036_4_bot',
      candidateBotIds: ['id613002203036_4_bot', 'id613002203036_5_bot'],
    });
  });

  it('keeps a channel owner eligible for poll routing without read-all permission', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-poll-owner', {
      id: 'channel-poll-owner',
      title: 'Owner poll channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: 'CHANNEL',
    });
    fixture.memberships.push(
      createActiveMembership('channel-poll-owner', 'id613002203036_bot', 0, {
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:00:00.000Z',
          isAdmin: false,
          isOwner: true,
          permissions: ['edit'],
        },
      }),
    );

    await expect(
      fixture.service.resolveBotRouteForChannelPoll({ chatId: 'channel-poll-owner' }),
    ).resolves.toMatchObject({
      botId: 'id613002203036_bot',
      candidateBotIds: ['id613002203036_bot'],
    });
  });

  it('selects a chat poll bot only with confirmed admin, read-all, and write access', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-poll-route', {
      id: 'chat-poll-route',
      title: 'Poll chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: 'CHAT',
    });
    fixture.memberships.push(
      createActiveMembership('chat-poll-route', 'id613002203036_bot', 0, {
        role: ChatBotMembershipRole.PRIMARY,
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:00:00.000Z',
          isAdmin: false,
          isOwner: false,
          permissions: ['write'],
        },
      }),
      createActiveMembership('chat-poll-route', 'id613002203036_4_bot', 1, {
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        },
      }),
      createActiveMembership('chat-poll-route', 'id613002203036_5_bot', 2, {
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:00:02.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['can_read_all_messages', 'can_write'],
        },
      }),
    );

    await expect(
      fixture.service.resolveBotIdForManagedPoll({ chatId: 'chat-poll-route' }),
    ).resolves.toBe('id613002203036_5_bot');
    await expect(
      fixture.service.resolveBotRouteForManagedPoll({ chatId: 'chat-poll-route' }),
    ).resolves.toMatchObject({
      botId: 'id613002203036_5_bot',
      candidateBotIds: ['id613002203036_5_bot'],
    });
  });

  it('keeps a chat owner eligible for poll routing without explicit permissions', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-poll-owner', {
      id: 'chat-poll-owner',
      title: 'Owner poll chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: 'CHAT',
    });
    fixture.memberships.push(
      createActiveMembership('chat-poll-owner', 'id613002203036_bot', 0, {
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:00:00.000Z',
          isAdmin: false,
          isOwner: true,
          permissions: [],
        },
      }),
    );

    await expect(
      fixture.service.resolveBotRouteForManagedPoll({ chatId: 'chat-poll-owner' }),
    ).resolves.toMatchObject({
      botId: 'id613002203036_bot',
      candidateBotIds: ['id613002203036_bot'],
    });
  });

  it('rejects split or unknown channel poll permissions', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-poll-split', {
      id: 'channel-poll-split',
      title: 'Split poll channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: 'CHANNEL',
    });
    fixture.memberships.push(
      createActiveMembership('channel-poll-split', 'id613002203036_bot', 0, {
        role: ChatBotMembershipRole.PRIMARY,
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        },
      }),
      createActiveMembership('channel-poll-split', 'id613002203036_4_bot', 1, {
        botAccessExpiresAt: new Date('2026-05-09T10:20:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['edit'],
        },
      }),
    );

    await expect(
      fixture.service.resolveBotIdForChannelPoll({ chatId: 'channel-poll-split' }),
    ).resolves.toBeNull();
  });

  it('keeps confirmed poll routes regardless of legacy expiry', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-poll-expired', {
      id: 'chat-poll-expired',
      title: 'Poll expiry',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: 'CHAT',
    });
    fixture.memberships.push(
      createActiveMembership('chat-poll-expired', 'id613002203036_bot', 0, {
        role: ChatBotMembershipRole.PRIMARY,
        botAccessExpiresAt: new Date('2026-05-09T10:04:59.999Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
      }),
      createActiveMembership('chat-poll-expired', 'id613002203036_4_bot', 1, {
        botAccessExpiresAt: null,
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
      }),
    );

    await expect(
      fixture.service.resolveBotRouteForManagedPoll({ chatId: 'chat-poll-expired' }),
    ).resolves.toMatchObject({
      botId: 'id613002203036_bot',
      candidateBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
    });
  });

  it('keeps an explicit denied stored primary out of route fallbacks', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-denied-primary-fallbacks', {
      id: 'chat-denied-primary-fallbacks',
      title: 'Denied primary fallbacks',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      createActiveMembership('chat-denied-primary-fallbacks', 'id613002203036_bot', 0, {
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:30.000Z',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        },
      }),
      createActiveMembership('chat-denied-primary-fallbacks', 'id613002203036_4_bot', 1, {
        capabilities: ['suggestion_delivery'],
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:31.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['write', 'read_all_messages'],
        },
      }),
    );

    await expect(
      fixture.service.resolveBotRoute({
        purpose: 'send_message',
        chatId: 'chat-denied-primary-fallbacks',
      }),
    ).resolves.toMatchObject({
      primaryBotId: 'id613002203036_4_bot',
      botId: 'id613002203036_4_bot',
      candidateBotIds: ['id613002203036_4_bot'],
    });
    await expect(
      fixture.service.resolveBotIdsForCapability({
        chatId: 'chat-denied-primary-fallbacks',
        capability: 'suggestion_delivery',
      }),
    ).resolves.toEqual(['id613002203036_4_bot']);
  });

  it('does not fall back to a draining primary bot for send-message routes', async () => {
    const fixture = createServiceFixture();
    const primaryBot = fixture.bots.find((bot) => bot.id === 'id613002203036_bot');
    if (!primaryBot) {
      throw new Error('primary bot fixture missing');
    }
    primaryBot.state = 'draining';
    fixture.chats.set('channel-draining-send-route', {
      id: 'channel-draining-send-route',
      title: 'Writable channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push({
      chatId: 'channel-draining-send-route',
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.PRIMARY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: {
        checkedAt: '2026-05-26T10:00:00.000Z',
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      },
      createdAt: new Date('2026-05-26T10:00:00.000Z'),
      updatedAt: new Date('2026-05-26T10:00:00.000Z'),
      lastSeenAt: new Date('2026-05-26T10:00:00.000Z'),
      lastWebhookAt: new Date('2026-05-26T10:00:00.000Z'),
    });

    await expect(
      fixture.service.resolveBotRoute({
        purpose: 'send_message',
        chatId: 'channel-draining-send-route',
      }),
    ).resolves.toMatchObject({
      purpose: 'send_message',
      chatId: 'channel-draining-send-route',
      primaryBotId: null,
      botId: null,
      candidateBotIds: [],
      reason: null,
    });
  });

  it('falls back to the active bot context for chat reads when no binding exists yet', async () => {
    const fixture = createServiceFixture();
    fixture.botContext.getActiveBotId.mockReturnValue('id613002203036_4_bot');

    await expect(fixture.service.resolveBotIdForRead({ chatId: 'missing-chat' })).resolves.toBe(
      'id613002203036_4_bot',
    );
  });

  it('prefers a bot with complete chat delete access when the primary snapshot lacks it', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-3', {
      id: 'chat-3',
      title: 'Moderated chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-3',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-06T21:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'change_chat_info'],
        },
        createdAt: new Date('2026-04-06T21:00:00.000Z'),
        updatedAt: new Date('2026-04-06T21:00:00.000Z'),
        lastSeenAt: new Date('2026-04-06T21:00:00.000Z'),
        lastWebhookAt: new Date('2026-04-06T21:00:00.000Z'),
      },
      {
        chatId: 'chat-3',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-06T21:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'post_edit_delete_message'],
        },
        createdAt: new Date('2026-04-06T21:00:01.000Z'),
        updatedAt: new Date('2026-04-06T21:00:01.000Z'),
        lastSeenAt: new Date('2026-04-06T21:00:01.000Z'),
        lastWebhookAt: new Date('2026-04-06T21:00:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdForModerationAction({
        chatId: 'chat-3',
        action: 'delete_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toBe('id613002203036_4_bot');
  });

  it.each([
    {
      label: 'accepts chat admin write access',
      entityType: ChatEntityType.CHAT,
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'write'],
      expected: true,
    },
    {
      label: 'accepts the legacy chat post-edit-delete permission for an owner',
      entityType: ChatEntityType.CHAT,
      isAdmin: false,
      isOwner: true,
      permissions: ['read_all_messages', 'post_edit_delete_message'],
      expected: true,
    },
    {
      label: 'rejects delete-only access in a chat',
      entityType: ChatEntityType.CHAT,
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'delete'],
      expected: false,
    },
    {
      label: 'accepts chat write access without read-all',
      entityType: ChatEntityType.CHAT,
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      expected: true,
    },
    {
      label: 'rejects a non-admin chat member with both action permissions',
      entityType: ChatEntityType.CHAT,
      isAdmin: false,
      isOwner: false,
      permissions: ['read_all_messages', 'write'],
      expected: false,
    },
    {
      label: 'accepts channel admin delete access',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'delete'],
      expected: true,
    },
    {
      label: 'accepts the legacy channel delete-message permission for an owner',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: false,
      isOwner: true,
      permissions: ['read_all_messages', 'delete_message'],
      expected: true,
    },
    {
      label: 'rejects channel write access',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'write'],
      expected: false,
    },
    {
      label: 'rejects the chat legacy permission in a channel',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'post_edit_delete_message'],
      expected: false,
    },
    {
      label: 'accepts channel delete access without read-all',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: true,
      isOwner: false,
      permissions: ['delete'],
      expected: true,
    },
  ])('$label', async ({ entityType, isAdmin, isOwner, permissions, expected }) => {
    const fixture = createServiceFixture();
    const chatId = `delete-matrix-${entityType}-${permissions.join('-')}-${String(isOwner)}`;
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Delete capability matrix',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType,
    });
    fixture.memberships.push({
      chatId,
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.PRIMARY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: {
        checkedAt: '2026-05-09T10:04:00.000Z',
        isAdmin,
        isOwner,
        permissions,
      },
      createdAt: new Date('2026-05-09T10:04:00.000Z'),
      updatedAt: new Date('2026-05-09T10:04:00.000Z'),
      lastSeenAt: new Date('2026-05-09T10:04:00.000Z'),
      lastWebhookAt: new Date('2026-05-09T10:04:00.000Z'),
    });

    await expect(
      fixture.service.resolveBotIdForModerationAction({
        chatId,
        action: 'delete_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toBe(expected ? 'id613002203036_bot' : null);
  });

  it('selects a fresh strict member-capable standby over an incapable primary', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-strict-member-standby';
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Strict member standby',
      botId: fixture.bots[0]!.id,
      primaryBotId: fixture.bots[0]!.id,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
    });
    fixture.memberships.push(
      createActiveMembership(
        chatId,
        fixture.bots[0]!.id,
        0,
        freshMemberCapability(['read_all_messages', 'write']),
      ),
      createActiveMembership(
        chatId,
        fixture.bots[1]!.id,
        1,
        freshMemberCapability(['read_all_messages', 'write', 'add_remove_members']),
      ),
    );

    await expect(
      fixture.service.resolveStrictMemberModerationBotRoute({ chatId }),
    ).resolves.toEqual({
      botId: fixture.bots[1]!.id,
      capabilityState: 'confirmed_capable',
      checkedAt: '2026-05-09T10:04:00.000Z',
    });
  });

  it('reports all fresh known member-permission failures as explicitly incapable', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-strict-member-missing';
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Strict member missing',
      botId: fixture.bots[0]!.id,
      primaryBotId: fixture.bots[0]!.id,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
    });
    fixture.memberships.push(
      createActiveMembership(
        chatId,
        fixture.bots[0]!.id,
        0,
        freshMemberCapability(['read_all_messages', 'write']),
      ),
      createActiveMembership(
        chatId,
        fixture.bots[1]!.id,
        1,
        freshMemberCapability(['read_all_messages', 'write']),
      ),
    );

    await expect(
      fixture.service.resolveStrictMemberModerationBotRoute({ chatId }),
    ).resolves.toMatchObject({ botId: null, capabilityState: 'explicitly_incapable' });
  });

  it('retains an old confirmed member capability alongside a peer missing that capability', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-strict-member-mixed';
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Strict member mixed',
      botId: fixture.bots[0]!.id,
      primaryBotId: fixture.bots[0]!.id,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, fixture.bots[0]!.id, 0, {
        ...freshMemberCapability(['read_all_messages', 'write', 'add_remove_members']),
        botAccessExpiresAt: new Date('2026-05-09T10:03:00.000Z'),
      }),
      createActiveMembership(
        chatId,
        fixture.bots[1]!.id,
        1,
        freshMemberCapability(['read_all_messages', 'write']),
      ),
    );

    await expect(
      fixture.service.resolveStrictMemberModerationBotRoute({ chatId }),
    ).resolves.toMatchObject({ botId: fixture.bots[0]!.id, capabilityState: 'confirmed_capable' });
  });

  it('excludes inactive member-capable memberships from a strict route', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-strict-member-inactive';
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Strict member inactive',
      botId: fixture.bots[0]!.id,
      primaryBotId: fixture.bots[0]!.id,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, fixture.bots[0]!.id, 0, {
        ...freshMemberCapability(['read_all_messages', 'write', 'add_remove_members']),
        status: ChatBotMembershipStatus.REMOVED,
      }),
      createActiveMembership(
        chatId,
        fixture.bots[1]!.id,
        1,
        freshMemberCapability(['read_all_messages', 'write']),
      ),
    );

    await expect(
      fixture.service.resolveStrictMemberModerationBotRoute({ chatId }),
    ).resolves.toMatchObject({ botId: null, capabilityState: 'explicitly_incapable' });
  });

  it('treats permissionsKnown=false as unknown instead of confirmed missing', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-strict-member-unknown-permissions';
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Strict member unknown',
      botId: fixture.bots[0]!.id,
      primaryBotId: fixture.bots[0]!.id,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, fixture.bots[0]!.id, 0, freshMemberCapability([], false)),
    );

    await expect(
      fixture.service.resolveStrictMemberModerationBotRoute({ chatId }),
    ).resolves.toMatchObject({ botId: null, capabilityState: 'stale_or_unknown' });
  });

  it('selects a fresh strict write-capable standby over an incapable primary', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-strict-write-standby';
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Strict write standby',
      botId: fixture.bots[0]!.id,
      primaryBotId: fixture.bots[0]!.id,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, fixture.bots[0]!.id, 0, freshMemberCapability([])),
      createActiveMembership(
        chatId,
        fixture.bots[1]!.id,
        1,
        freshMemberCapability(['read_all_messages', 'write']),
      ),
    );

    await expect(fixture.service.resolveStrictWriteModerationBotRoute({ chatId })).resolves.toEqual(
      {
        botId: fixture.bots[1]!.id,
        capabilityState: 'confirmed_capable',
        checkedAt: '2026-05-09T10:04:00.000Z',
      },
    );
  });

  it('keeps an unknown write-permission payload recheckable', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-strict-write-unknown';
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Strict write unknown',
      botId: fixture.bots[0]!.id,
      primaryBotId: fixture.bots[0]!.id,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, fixture.bots[0]!.id, 0, freshMemberCapability([], false)),
    );

    await expect(
      fixture.service.resolveStrictWriteModerationBotRoute({ chatId }),
    ).resolves.toMatchObject({ botId: null, capabilityState: 'stale_or_unknown' });
  });

  it.each([
    { entityType: ChatEntityType.CHAT, permissions: ['write', 'add_remove_members'] },
    { entityType: ChatEntityType.CHAT, permissions: ['read_all_messages', 'add_remove_members'] },
    { entityType: ChatEntityType.CHANNEL, permissions: ['write', 'edit', 'add_remove_members'] },
  ])(
    'rejects every execution purpose after known baseline loss in $entityType with $permissions',
    async ({ entityType, permissions }) => {
      const fixture = createServiceFixture();
      const chatId = `baseline-loss-${entityType}-${permissions.join('-')}`;
      const botId = fixture.bots[0]!.id;
      fixture.chats.set(chatId, {
        id: chatId,
        title: chatId,
        botId,
        primaryBotId: botId,
        entityType,
      });
      fixture.memberships.push(
        createActiveMembership(chatId, botId, 0, {
          ...freshMemberCapability(permissions),
          botAccessSource: 'known_capability_loss',
        }),
      );

      for (const purpose of [
        'moderation',
        'send_message',
        'delete_message',
        'edit_message',
        'moderate_member',
      ] as const) {
        await expect(
          fixture.service.getFreshChatBotExecutionProof({ chatId, botId, purpose }),
        ).resolves.toBeNull();
        await expect(
          fixture.service.verifyChatExecutionProof({
            chatId,
            botId,
            purpose,
            routingVersion: 0,
            accessEpoch: {
              checkedAt: new Date('2026-05-09T10:04:00.000Z'),
              source: 'known_capability_loss',
            },
          }),
        ).resolves.toBe(false);
      }
    },
  );

  it('promotes a healthy peer when the old owner retains delete permission but lost read-all', async () => {
    const fixture = createServiceFixture();
    const chatId = 'dormant-owner-delete-peer';
    const ownerId = fixture.bots[0]!.id;
    const peerId = fixture.bots[1]!.id;
    const checkedAt = new Date('2026-05-09T10:04:00.000Z');
    fixture.chats.set(chatId, {
      id: chatId,
      title: chatId,
      botId: ownerId,
      primaryBotId: ownerId,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
      routingVersion: 0,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, ownerId, 0, {
        ...freshMemberCapability(['write']),
        botAccessSource: 'confirmed_read_loss',
      }),
      createActiveMembership(chatId, peerId, 1, {
        ...freshMemberCapability(['read_all_messages', 'write']),
        botAccessSource: 'healthy_peer',
      }),
    );
    await expect(
      fixture.service.selectChatPrimaryBot({
        chatId,
        botId: peerId,
        expectedRoutingVersion: 0,
        expectedAccessEpoch: { checkedAt, source: 'healthy_peer' },
        expectedPreviousOwner: {
          botId: ownerId,
          accessEpoch: { checkedAt, source: 'confirmed_read_loss' },
          purpose: 'delete_message',
        },
      }),
    ).resolves.toBe(true);
    expect(fixture.chats.get(chatId)?.primaryBotId).toBe(peerId);
  });

  it.each([
    {
      entityType: ChatEntityType.CHAT,
      action: 'moderate_member' as const,
      initial: ['read_all_messages', 'write', 'add_remove_members'],
      remaining: ['read_all_messages', 'write'],
      regained: ['can_read_all_messages', 'can_write', 'can_remove_members'],
    },
    {
      entityType: ChatEntityType.CHANNEL,
      action: 'edit_message' as const,
      initial: ['write', 'delete', 'edit'],
      remaining: ['write', 'delete'],
      regained: ['can_write', 'delete_messages', 'can_edit_messages'],
    },
  ])(
    'keeps lost $action denied across unknown probes, bot_added and passive owner promotion',
    async ({ entityType, action, initial, remaining, regained }) => {
      const fixture = createServiceFixture();
      const chatId = `ceiling-loss-${entityType}`;
      const botId = fixture.bots[0]!.id;
      fixture.chats.set(chatId, {
        id: chatId,
        title: chatId,
        botId,
        primaryBotId: botId,
        entityType,
      });
      const membership = createActiveMembership(chatId, botId, 0, {
        ...freshMemberCapability(initial),
        botAccessSource: 'initial_complete_access',
      });
      fixture.memberships.push(membership);
      const probe = (permissions: string[], permissionsKnown = true, isOwner = false) =>
        fixture.service.recordBotAccessProbe({
          chatId,
          botId,
          checkedAt: new Date(),
          source: 'passive_capability_refresh',
          access: { isAdmin: true, isOwner, permissions, permissionsKnown },
        });
      await expect(probe(remaining)).resolves.toBe(true);
      expect(membership.permissionsSnapshot).toEqual(
        expect.objectContaining({
          activationCapabilityCeiling: expect.not.arrayContaining([action]),
        }),
      );
      const beforeUnknownProbe = structuredClone(membership);
      jest.setSystemTime(Date.now() + 1_000);
      await expect(probe([], false)).resolves.toBe(false);
      expect(membership).toEqual(beforeUnknownProbe);
      const retainedSnapshot = membership.permissionsSnapshot;
      jest.setSystemTime(Date.now() + 1_000);
      await fixture.service.bindChatToBot({
        chatId,
        botId,
        title: chatId,
        entityType,
        lifecycleEventAt: new Date(),
        lifecycleEventType: 'bot_added',
        lifecycleSource: 'webhook',
      });
      expect(membership.permissionsSnapshot).toEqual(retainedSnapshot);
      jest.setSystemTime(Date.now() + 1_000);
      await expect(probe(regained, true, true)).resolves.toBe(true);
      expect(membership.permissionsSnapshot).toEqual(
        expect.objectContaining({
          activationCapabilityCeiling: expect.not.arrayContaining([action]),
        }),
      );
      await expect(
        fixture.service.getFreshChatBotExecutionProof({ chatId, botId, purpose: action }),
      ).resolves.toBeNull();
      await expect(
        fixture.service.resolveBotIdForModerationAction({
          chatId,
          action,
          fallbackToPrimary: false,
        }),
      ).resolves.toBeNull();
      if (action === 'moderate_member')
        await expect(
          fixture.service.resolveStrictMemberModerationBotRoute({ chatId }),
        ).resolves.toMatchObject({ botId: null });

      jest.setSystemTime(Date.now() + 2_000);
      const activation = explicitActivationProbe(fixture, chatId, botId);
      activation.access.permissions = initial;
      await expect(
        fixture.service.recordBotAccessProbe({
          chatId,
          botId,
          checkedAt: new Date(),
          source: 'handshake_start',
          ...activation,
          channelReadVerified: entityType === ChatEntityType.CHANNEL,
        }),
      ).resolves.toBe(true);
      await expect(
        fixture.service.getFreshChatBotExecutionProof({ chatId, botId, purpose: action }),
      ).resolves.toMatchObject({ botId });
    },
  );

  it('accepts an explicit healthy Start when a benign probe is newer than its source', async () => {
    const fixture = createServiceFixture();
    const chatId = 'healthy-start-after-refresh';
    const botId = fixture.bots[0]!.id;
    const permissions = ['read_all_messages', 'write', 'add_remove_members'];
    fixture.chats.set(chatId, {
      id: chatId,
      title: chatId,
      botId,
      primaryBotId: botId,
      entityType: ChatEntityType.CHAT,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, botId, 0, {
        ...freshMemberCapability(permissions),
        botAccessCheckedAt: new Date(Date.now() - 100),
        botAccessSource: 'benign_refresh_after_start_receipt',
      }),
    );
    const activation = explicitActivationProbe(fixture, chatId, botId);
    activation.access.permissions = permissions;
    await expect(
      fixture.service.recordBotAccessProbe({
        chatId,
        botId,
        checkedAt: new Date(),
        source: 'handshake_start',
        ...activation,
      }),
    ).resolves.toBe(true);
  });

  it('routes through a fresh confirmed capability even while stored routing is not ready', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-fresh-delete-capability';
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Fresh delete capability',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
      routingVersion: 9,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, 'id613002203036_bot', 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:19:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
      }),
    );

    await expect(
      fixture.service.resolveDeleteMessageBotRoute({ chatId, requireFreshSnapshot: true }),
    ).resolves.toMatchObject({
      botId: 'id613002203036_bot',
      candidateBotIds: ['id613002203036_bot'],
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
      routingVersion: 9,
      capabilityState: 'confirmed_capable',
      capabilityReason: 'confirmed',
      checkedAt: '2026-05-09T10:04:00.000Z',
      expiresAt: '2026-05-09T10:19:00.000Z',
      candidateCapabilities: [
        expect.objectContaining({
          botId: 'id613002203036_bot',
          state: 'confirmed_capable',
          reason: 'confirmed',
          routeEligible: true,
        }),
      ],
    });
  });

  it('uses durable confirmed capabilities for strict and soft routes', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-stale-delete-capability';
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Stale delete capability',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, 'id613002203036_bot', 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T09:00:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T09:15:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T09:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
      }),
    );

    const strictRoute = await fixture.service.resolveDeleteMessageBotRoute({
      chatId,
      requireFreshSnapshot: true,
    });
    const softRoute = await fixture.service.resolveDeleteMessageBotRoute({
      chatId,
      requireFreshSnapshot: false,
    });

    expect(strictRoute).toMatchObject({
      botId: 'id613002203036_bot',
      candidateBotIds: ['id613002203036_bot'],
      capabilityState: 'confirmed_capable',
      capabilityReason: 'confirmed',
    });
    expect(softRoute).toMatchObject({
      botId: 'id613002203036_bot',
      candidateBotIds: ['id613002203036_bot'],
      reason: 'primary_confirmed',
      capabilityState: 'confirmed_capable',
      capabilityReason: 'confirmed',
    });
  });

  it('keeps a confirmed primary stable after its former expiry', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-mixed-delete-capabilities';
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Mixed delete capabilities',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, 'id613002203036_bot', 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T09:00:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T09:15:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T09:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
      }),
      createActiveMembership(chatId, 'id613002203036_4_bot', 1, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:19:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
      }),
    );

    await expect(
      fixture.service.resolveDeleteMessageBotRoute({
        chatId,
        requireFreshSnapshot: false,
      }),
    ).resolves.toMatchObject({
      botId: 'id613002203036_bot',
      candidateBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
      reason: 'primary_confirmed',
      capabilityState: 'confirmed_capable',
      capabilityReason: 'confirmed',
    });
  });

  it('keeps a fresh explicit channel permission failure out of strict and soft routes', async () => {
    const fixture = createServiceFixture();
    const chatId = 'channel-explicit-delete-incapable';
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Write-only channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: ChatEntityType.CHANNEL,
      routingState: ChatRoutingState.READY,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, 'id613002203036_bot', 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:19:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
      }),
    );

    await expect(
      fixture.service.resolveDeleteMessageBotRoute({
        chatId,
        requireFreshSnapshot: false,
      }),
    ).resolves.toMatchObject({
      botId: null,
      candidateBotIds: [],
      capabilityState: 'explicitly_incapable',
      capabilityReason: 'missing_channel_delete_permission',
      candidateCapabilities: [
        expect.objectContaining({
          routeEligible: false,
          state: 'explicitly_incapable',
          reason: 'missing_channel_delete_permission',
        }),
      ],
    });
  });

  it('uses the delete intent entity type when persisted chat metadata is stale', async () => {
    const fixture = createServiceFixture();
    const chatId = 'stale-chat-record-for-channel';
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Stale chat record',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, 'id613002203036_bot', 0, {
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-05-09T10:04:00.000Z'),
        botAccessExpiresAt: new Date('2026-05-09T10:19:00.000Z'),
        permissionsSnapshot: {
          checkedAt: '2026-05-09T10:04:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
      }),
    );

    await expect(
      fixture.service.resolveDeleteMessageBotRoute({
        chatId,
        expectedEntityType: ChatEntityType.CHANNEL,
        requireFreshSnapshot: true,
      }),
    ).resolves.toMatchObject({
      entityType: ChatEntityType.CHANNEL,
      botId: null,
      candidateBotIds: [],
      capabilityReason: 'missing_channel_delete_permission',
    });
  });

  it('requires an explicit MAX edit permission for channel post edits', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-edit', {
      id: 'channel-edit',
      title: 'Editable channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: 'CHANNEL',
    });
    fixture.memberships.push({
      chatId: 'channel-edit',
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.PRIMARY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: {
        checkedAt: '2026-04-06T21:00:00.000Z',
        isAdmin: true,
        isOwner: false,
        permissions: ['write', 'edit'],
      },
      createdAt: new Date('2026-04-06T21:00:00.000Z'),
      updatedAt: new Date('2026-04-06T21:00:00.000Z'),
      lastSeenAt: new Date('2026-04-06T21:00:00.000Z'),
      lastWebhookAt: new Date('2026-04-06T21:00:00.000Z'),
    });

    await expect(
      fixture.service.resolveBotIdForModerationAction({
        chatId: 'channel-edit',
        action: 'edit_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toBe('id613002203036_bot');
  });

  it('does not use channel write permission as edit permission', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('channel-no-edit', {
      id: 'channel-no-edit',
      title: 'Write-only channel',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: 'CHANNEL',
    });
    fixture.memberships.push({
      chatId: 'channel-no-edit',
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.PRIMARY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: {
        checkedAt: '2026-04-06T21:00:00.000Z',
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      },
      createdAt: new Date('2026-04-06T21:00:00.000Z'),
      updatedAt: new Date('2026-04-06T21:00:00.000Z'),
      lastSeenAt: new Date('2026-04-06T21:00:00.000Z'),
      lastWebhookAt: new Date('2026-04-06T21:00:00.000Z'),
    });

    await expect(
      fixture.service.resolveBotIdForModerationAction({
        chatId: 'channel-no-edit',
        action: 'edit_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toBeNull();
  });

  it.each([
    {
      label: 'accepts current chat write permission',
      entityType: ChatEntityType.CHAT,
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
      expected: true,
    },
    {
      label: 'accepts legacy chat post-edit-delete permission',
      entityType: ChatEntityType.CHAT,
      isAdmin: false,
      isOwner: true,
      permissions: ['post_edit_delete_message'],
      expected: true,
    },
    {
      label: 'rejects channel edit permission in a chat',
      entityType: ChatEntityType.CHAT,
      isAdmin: true,
      isOwner: false,
      permissions: ['edit_message'],
      expected: false,
    },
    {
      label: 'accepts legacy channel edit-message permission',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: false,
      isOwner: true,
      permissions: ['edit_message'],
      expected: true,
    },
    {
      label: 'rejects chat post-edit-delete permission in a channel',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: true,
      isOwner: false,
      permissions: ['post_edit_delete_message'],
      expected: false,
    },
    {
      label: 'rejects a channel owner without explicit edit permission',
      entityType: ChatEntityType.CHANNEL,
      isAdmin: false,
      isOwner: true,
      permissions: [],
      expected: false,
    },
  ])('$label', async ({ entityType, isAdmin, isOwner, permissions, expected }) => {
    const fixture = createServiceFixture();
    const chatId = `edit-matrix-${entityType}-${permissions.join('-') || 'none'}-${String(isOwner)}`;
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Edit capability matrix',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType,
    });
    fixture.memberships.push({
      chatId,
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.PRIMARY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: {
        checkedAt: '2026-08-15T10:00:00.000Z',
        isAdmin,
        isOwner,
        permissions,
      },
      createdAt: new Date('2026-08-15T10:00:00.000Z'),
      updatedAt: new Date('2026-08-15T10:00:00.000Z'),
      lastSeenAt: new Date('2026-08-15T10:00:00.000Z'),
      lastWebhookAt: new Date('2026-08-15T10:00:00.000Z'),
    });

    await expect(
      fixture.service.resolveBotIdForModerationAction({
        chatId,
        action: 'edit_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toBe(expected ? 'id613002203036_bot' : null);
  });

  it('does not treat non-empty admin permissions as delete-capable without a delete alias', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-4', {
      id: 'chat-4',
      title: 'Restricted chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-4',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-06T21:10:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-04-06T21:10:00.000Z'),
        updatedAt: new Date('2026-04-06T21:10:00.000Z'),
        lastSeenAt: new Date('2026-04-06T21:10:00.000Z'),
        lastWebhookAt: new Date('2026-04-06T21:10:00.000Z'),
      },
      {
        chatId: 'chat-4',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-06T21:10:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['change_chat_info'],
        },
        createdAt: new Date('2026-04-06T21:10:01.000Z'),
        updatedAt: new Date('2026-04-06T21:10:01.000Z'),
        lastSeenAt: new Date('2026-04-06T21:10:01.000Z'),
        lastWebhookAt: new Date('2026-04-06T21:10:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdForModerationAction({
        chatId: 'chat-4',
        action: 'delete_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toBeNull();
  });

  it('does not use fallback candidates whose explicit snapshot lacks delete permission', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-fallback-delete-limited', {
      id: 'chat-fallback-delete-limited',
      title: 'Restricted chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      entityType: 'CHAT',
    });
    fixture.memberships.push({
      chatId: 'chat-fallback-delete-limited',
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.PRIMARY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: {
        checkedAt: '2026-07-06T09:40:01.508Z',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members', 'read_all_messages', 'pin_message', 'can_call'],
        health: 'ok',
      },
      createdAt: new Date('2026-07-06T09:40:01.508Z'),
      updatedAt: new Date('2026-07-06T09:40:01.508Z'),
      lastSeenAt: new Date('2026-07-06T09:40:01.508Z'),
      lastWebhookAt: new Date('2026-07-06T09:40:01.508Z'),
    });

    await expect(
      fixture.service.resolveBotIdsForModerationAction({
        chatId: 'chat-fallback-delete-limited',
        action: 'delete_message',
      }),
    ).resolves.toEqual([]);
  });

  it('does not fall back to a bot whose refreshed snapshot marks delete as action-limited', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-action-limited', {
      id: 'chat-action-limited',
      title: 'Restricted chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push({
      chatId: 'chat-action-limited',
      botId: 'id613002203036_bot',
      role: ChatBotMembershipRole.PRIMARY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: {
        checkedAt: '2026-05-15T00:23:29.333Z',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members', 'read_all_messages'],
        health: 'action_limited',
        missingActions: ['delete_message'],
      },
      createdAt: new Date('2026-05-15T00:23:29.333Z'),
      updatedAt: new Date('2026-05-15T00:23:29.333Z'),
      lastSeenAt: new Date('2026-05-15T00:23:29.333Z'),
      lastWebhookAt: new Date('2026-05-15T00:23:28.984Z'),
    });

    await expect(
      fixture.service.resolveBotIdsForModerationAction({
        chatId: 'chat-action-limited',
        action: 'delete_message',
      }),
    ).resolves.toEqual([]);
  });

  it('returns null for member moderation when every active bot explicitly lacks the permission', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-4', {
      id: 'chat-4',
      title: 'Restricted chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-4',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-06T21:10:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-04-06T21:10:00.000Z'),
        updatedAt: new Date('2026-04-06T21:10:00.000Z'),
        lastSeenAt: new Date('2026-04-06T21:10:00.000Z'),
        lastWebhookAt: new Date('2026-04-06T21:10:00.000Z'),
      },
      {
        chatId: 'chat-4',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-06T21:10:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['change_chat_info'],
        },
        createdAt: new Date('2026-04-06T21:10:01.000Z'),
        updatedAt: new Date('2026-04-06T21:10:01.000Z'),
        lastSeenAt: new Date('2026-04-06T21:10:01.000Z'),
        lastWebhookAt: new Date('2026-04-06T21:10:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdForModerationAction({
        chatId: 'chat-4',
        action: 'moderate_member',
        fallbackToPrimary: false,
      }),
    ).resolves.toBeNull();
  });

  it('falls back to a standby bot with unknown permissions when the active primary is not an admin', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-5', {
      id: 'chat-5',
      title: 'Shared restricted chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-5',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-07T00:20:00.000Z',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        },
        createdAt: new Date('2026-04-07T00:20:00.000Z'),
        updatedAt: new Date('2026-04-07T00:20:00.000Z'),
        lastSeenAt: new Date('2026-04-07T00:20:00.000Z'),
        lastWebhookAt: new Date('2026-04-07T00:20:00.000Z'),
      },
      {
        chatId: 'chat-5',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: null,
        createdAt: new Date('2026-04-07T00:20:01.000Z'),
        updatedAt: new Date('2026-04-07T00:20:01.000Z'),
        lastSeenAt: new Date('2026-04-07T00:20:01.000Z'),
        lastWebhookAt: new Date('2026-04-07T00:20:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdForModerationAction({
        chatId: 'chat-5',
        action: 'delete_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toBe('id613002203036_4_bot');
  });

  it('still falls back to a standby bot with unknown permissions when there is no active primary membership', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-6', {
      id: 'chat-6',
      title: 'Standby-only chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-6',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.REMOVED,
        permissionsSnapshot: {
          checkedAt: '2026-04-07T00:30:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-04-07T00:30:00.000Z'),
        updatedAt: new Date('2026-04-07T00:30:00.000Z'),
        lastSeenAt: new Date('2026-04-07T00:30:00.000Z'),
        lastWebhookAt: new Date('2026-04-07T00:30:00.000Z'),
      },
      {
        chatId: 'chat-6',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: null,
        createdAt: new Date('2026-04-07T00:30:01.000Z'),
        updatedAt: new Date('2026-04-07T00:30:01.000Z'),
        lastSeenAt: new Date('2026-04-07T00:30:01.000Z'),
        lastWebhookAt: new Date('2026-04-07T00:30:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdForModerationAction({
        chatId: 'chat-6',
        action: 'delete_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toBe('id613002203036_4_bot');
  });

  it('excludes primary moderation action candidates that explicitly lack delete permission', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-7', {
      id: 'chat-7',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-7',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-07T00:40:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-04-07T00:40:00.000Z'),
        updatedAt: new Date('2026-04-07T00:40:00.000Z'),
        lastSeenAt: new Date('2026-04-07T00:40:00.000Z'),
        lastWebhookAt: new Date('2026-04-07T00:40:00.000Z'),
      },
      {
        chatId: 'chat-7',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-07T00:40:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
        createdAt: new Date('2026-04-07T00:40:01.000Z'),
        updatedAt: new Date('2026-04-07T00:40:01.000Z'),
        lastSeenAt: new Date('2026-04-07T00:40:01.000Z'),
        lastWebhookAt: new Date('2026-04-07T00:40:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdsForModerationAction({
        chatId: 'chat-7',
        action: 'delete_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toEqual(['id613002203036_4_bot']);
  });

  it('does not route moderation actions to a draining standby bot', async () => {
    const fixture = createServiceFixture();
    const standbyBot = fixture.bots.find((bot) => bot.id === 'id613002203036_4_bot');
    if (!standbyBot) {
      throw new Error('standby bot fixture missing');
    }
    standbyBot.state = 'draining';
    fixture.chats.set('chat-draining-action', {
      id: 'chat-draining-action',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-draining-action',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-26T09:00:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-05-26T09:00:00.000Z'),
        updatedAt: new Date('2026-05-26T09:00:00.000Z'),
        lastSeenAt: new Date('2026-05-26T09:00:00.000Z'),
        lastWebhookAt: new Date('2026-05-26T09:00:00.000Z'),
      },
      {
        chatId: 'chat-draining-action',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-05-26T09:00:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
        createdAt: new Date('2026-05-26T09:00:01.000Z'),
        updatedAt: new Date('2026-05-26T09:00:01.000Z'),
        lastSeenAt: new Date('2026-05-26T09:00:01.000Z'),
        lastWebhookAt: new Date('2026-05-26T09:00:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdsForModerationAction({
        chatId: 'chat-draining-action',
        action: 'delete_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toEqual([]);
  });

  it('does not route assist capabilities to a draining standby bot', async () => {
    const fixture = createServiceFixture();
    const standbyBot = fixture.bots.find((bot) => bot.id === 'id613002203036_4_bot');
    if (!standbyBot) {
      throw new Error('standby bot fixture missing');
    }
    standbyBot.state = 'draining';
    fixture.chats.set('chat-draining-capability', {
      id: 'chat-draining-capability',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-draining-capability',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        createdAt: new Date('2026-05-26T09:10:00.000Z'),
        updatedAt: new Date('2026-05-26T09:10:00.000Z'),
        lastSeenAt: new Date('2026-05-26T09:10:00.000Z'),
        lastWebhookAt: new Date('2026-05-26T09:10:00.000Z'),
      },
      {
        chatId: 'chat-draining-capability',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        capabilities: ['suggestion_delivery'],
        createdAt: new Date('2026-05-26T09:10:01.000Z'),
        updatedAt: new Date('2026-05-26T09:10:01.000Z'),
        lastSeenAt: new Date('2026-05-26T09:10:01.000Z'),
        lastWebhookAt: new Date('2026-05-26T09:10:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotIdForCapability({
        chatId: 'chat-draining-capability',
        capability: 'suggestion_delivery',
        fallbackToPrimary: false,
      }),
    ).resolves.toBeNull();
  });

  it('returns a structured moderation route for the confirmed delete-capable bot', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-route-7', {
      id: 'chat-route-7',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push(
      {
        chatId: 'chat-route-7',
        botId: 'id613002203036_bot',
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-07T00:40:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        },
        createdAt: new Date('2026-04-07T00:40:00.000Z'),
        updatedAt: new Date('2026-04-07T00:40:00.000Z'),
        lastSeenAt: new Date('2026-04-07T00:40:00.000Z'),
        lastWebhookAt: new Date('2026-04-07T00:40:00.000Z'),
      },
      {
        chatId: 'chat-route-7',
        botId: 'id613002203036_4_bot',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        permissionsSnapshot: {
          checkedAt: '2026-04-07T00:40:01.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        },
        createdAt: new Date('2026-04-07T00:40:01.000Z'),
        updatedAt: new Date('2026-04-07T00:40:01.000Z'),
        lastSeenAt: new Date('2026-04-07T00:40:01.000Z'),
        lastWebhookAt: new Date('2026-04-07T00:40:01.000Z'),
      },
    );

    await expect(
      fixture.service.resolveBotRoutes({
        purpose: 'moderation_action',
        chatId: 'chat-route-7',
        action: 'delete_message',
        fallbackToPrimary: false,
      }),
    ).resolves.toMatchObject({
      purpose: 'moderation_action',
      chatId: 'chat-route-7',
      primaryBotId: 'id613002203036_bot',
      botId: 'id613002203036_4_bot',
      candidateBotIds: ['id613002203036_4_bot'],
      reason: 'alternate_confirmed',
      action: 'delete_message',
    });
  });

  it('touches observed shared-bot membership without rewriting the chat row on every webhook', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-8', {
      id: 'chat-8',
      title: 'Shared chat',
      botId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
    });
    fixture.memberships.push({
      chatId: 'chat-8',
      botId: 'id613002203036_4_bot',
      role: ChatBotMembershipRole.STANDBY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: null,
      createdAt: new Date('2026-05-09T09:00:00.000Z'),
      updatedAt: new Date('2026-05-09T09:00:00.000Z'),
      lastSeenAt: null,
      lastWebhookAt: null,
    });

    await fixture.service.observeStoredChatBotWebhook({
      chatId: 'chat-8',
      primaryBotId: 'id613002203036_bot',
      botId: 'id613002203036_4_bot',
    });
    await fixture.service.observeStoredChatBotWebhook({
      chatId: 'chat-8',
      primaryBotId: 'id613002203036_bot',
      botId: 'id613002203036_4_bot',
    });

    expect(fixture.prisma.chat.update).not.toHaveBeenCalled();
    expect(fixture.prisma.chatBotMembership.upsert).not.toHaveBeenCalled();
    expect(fixture.prisma.chatBotMembership.updateMany).toHaveBeenCalledTimes(1);
    expect(
      fixture.memberships.find((membership) => membership.botId === 'id613002203036_4_bot'),
    ).toEqual(
      expect.objectContaining({
        chatId: 'chat-8',
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        lastWebhookAt: expect.any(Date),
      }),
    );
  });

  it('touches an active mirrored membership without promoting it when the chat has no primary', async () => {
    const fixture = createServiceFixture();
    fixture.chats.set('chat-route-gap-touch', {
      id: 'chat-route-gap-touch',
      title: 'Route gap chat',
      botId: null,
      primaryBotId: null,
    });
    fixture.memberships.push({
      chatId: 'chat-route-gap-touch',
      botId: 'id613002203036_4_bot',
      role: ChatBotMembershipRole.STANDBY,
      status: ChatBotMembershipStatus.ACTIVE,
      permissionsSnapshot: null,
      createdAt: new Date('2026-05-09T09:00:00.000Z'),
      updatedAt: new Date('2026-05-09T09:00:00.000Z'),
      lastSeenAt: null,
      lastWebhookAt: null,
    });

    await fixture.service.observeStoredChatBotWebhook({
      chatId: 'chat-route-gap-touch',
      primaryBotId: null,
      botId: 'id613002203036_4_bot',
      observedAt: new Date('2026-05-09T09:05:00.000Z'),
    });

    expect(fixture.memberships[0]).toEqual(
      expect.objectContaining({
        role: ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        lastSeenAt: new Date('2026-05-09T09:05:00.000Z'),
        lastWebhookAt: new Date('2026-05-09T09:05:00.000Z'),
      }),
    );
  });

  it('coalesces 100 concurrent heartbeat observations into one membership write', async () => {
    const fixture = createServiceFixture();
    let release!: (value: { count: number }) => void;
    fixture.prisma.chatBotMembership.updateMany.mockImplementationOnce(
      () =>
        new Promise<{ count: number }>((resolve) => {
          release = resolve;
        }),
    );
    const input = { chatId: 'heartbeat-burst', botId: fixture.bots[0]!.id };
    const pending = Array.from({ length: 100 }, () =>
      fixture.service.observeStoredChatBotWebhook(input),
    );
    expect(fixture.prisma.chatBotMembership.updateMany).toHaveBeenCalledTimes(1);
    release({ count: 1 });
    await Promise.all(pending);
    await fixture.service.observeStoredChatBotWebhook(input);
    expect(fixture.prisma.chatBotMembership.updateMany).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.chat.update).not.toHaveBeenCalled();
  });

  it('shares a failed heartbeat without caching success and retries the next observation', async () => {
    const fixture = createServiceFixture();
    let reject!: (reason: Error) => void;
    fixture.prisma.chatBotMembership.updateMany.mockImplementationOnce(
      () =>
        new Promise<{ count: number }>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const input = { chatId: 'heartbeat-retry', botId: fixture.bots[0]!.id };
    const pending = Array.from({ length: 20 }, () =>
      fixture.service.observeStoredChatBotWebhook(input),
    );
    const settlement = Promise.allSettled(pending);
    const error = new Error('temporary membership storage failure');
    reject(error);
    expect(await settlement).toEqual(
      Array.from({ length: 20 }, () => ({ status: 'rejected', reason: error })),
    );
    fixture.prisma.chatBotMembership.updateMany.mockResolvedValueOnce({ count: 1 });
    await fixture.service.observeStoredChatBotWebhook(input);
    expect(fixture.prisma.chatBotMembership.updateMany).toHaveBeenCalledTimes(2);
  });

  it('does not share heartbeats across chats or bots, or retain a missing membership result', async () => {
    const fixture = createServiceFixture();
    fixture.prisma.chatBotMembership.updateMany.mockResolvedValue({ count: 0 });
    const first = { chatId: 'heartbeat-a', botId: fixture.bots[0]!.id };
    await Promise.all([
      fixture.service.observeStoredChatBotWebhook(first),
      fixture.service.observeStoredChatBotWebhook({ ...first, chatId: 'heartbeat-b' }),
      fixture.service.observeStoredChatBotWebhook({ ...first, botId: fixture.bots[1]!.id }),
    ]);
    fixture.prisma.chatBotMembership.updateMany.mockResolvedValueOnce({ count: 1 });
    await fixture.service.observeStoredChatBotWebhook(first);
    expect(fixture.prisma.chatBotMembership.updateMany).toHaveBeenCalledTimes(4);
    jest.advanceTimersByTime(60_000);
    await fixture.service.observeStoredChatBotWebhook(first);
    expect(fixture.prisma.chatBotMembership.updateMany).toHaveBeenCalledTimes(5);
  });

  it('bounds completed heartbeat cooldowns without turning eviction into an access grant', async () => {
    const fixture = createServiceFixture();
    const cache = (fixture.service as unknown as { observedWebhookTouchCache: Map<string, number> })
      .observedWebhookTouchCache;
    const botId = fixture.bots[0]!.id;
    for (let index = 0; index < 10_000; index++)
      cache.set(`old-${index}:${botId}`, Date.now() + 60_000);
    fixture.prisma.chatBotMembership.updateMany.mockResolvedValue({ count: 1 });
    await fixture.service.observeStoredChatBotWebhook({ chatId: 'new-heartbeat', botId });
    expect(cache.size).toBe(10_000);
    expect(cache.has(`old-0:${botId}`)).toBe(false);
    await fixture.service.observeStoredChatBotWebhook({ chatId: 'old-0', botId });
    expect(fixture.prisma.chatBotMembership.updateMany).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.chatBotMembership.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { chatId: 'old-0', botId, status: ChatBotMembershipStatus.ACTIVE },
        data: { lastSeenAt: expect.any(Date), lastWebhookAt: expect.any(Date) },
      }),
    );
    expect(fixture.prisma.chat.update).not.toHaveBeenCalled();
    expect(fixture.prisma.chatBotMembership.upsert).not.toHaveBeenCalled();
  });

  it('does not reactivate or clear access loss on an ordinary webhook after bot removal', async () => {
    const fixture = createServiceFixture();
    const removedAt = new Date('2026-05-09T09:00:00.123Z');
    const accessLossSnapshot = {
      accessLostAt: removedAt.toISOString(),
      accessLostReason: 'bot_removed',
    };
    fixture.chats.set('chat-lifecycle-observe', {
      id: 'chat-lifecycle-observe',
      title: 'Lifecycle chat',
      botId: null,
      primaryBotId: null,
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
    });
    fixture.memberships.push({
      chatId: 'chat-lifecycle-observe',
      botId: 'id613002203036_4_bot',
      role: ChatBotMembershipRole.STANDBY,
      status: ChatBotMembershipStatus.REMOVED,
      permissionsSnapshot: accessLossSnapshot,
      botAccessState: ChatBotAccessState.DENIED,
      lifecycleEventAt: removedAt,
      lifecycleEventType: 'bot_removed',
      lifecycleSource: 'webhook',
      createdAt: removedAt,
      updatedAt: removedAt,
      lastSeenAt: removedAt,
      lastWebhookAt: removedAt,
    });

    await fixture.service.observeStoredChatBotWebhook({
      chatId: 'chat-lifecycle-observe',
      primaryBotId: null,
      botId: 'id613002203036_4_bot',
      observedAt: new Date('2026-05-09T09:05:00.456Z'),
    });

    expect(fixture.memberships[0]).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.REMOVED,
        permissionsSnapshot: accessLossSnapshot,
        botAccessState: ChatBotAccessState.DENIED,
        lifecycleEventAt: removedAt,
        lifecycleEventType: 'bot_removed',
        lastWebhookAt: removedAt,
      }),
    );
  });

  it('fences an older removal behind a newer positive probe but lets equal-time removal win', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-lifecycle-removal-access-epoch';
    const botId = fixture.bots[0]!.id;
    const checkedAt = new Date('2026-05-09T09:00:00.456Z');
    const olderRemovalAt = new Date(checkedAt.getTime() - 1);
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Lifecycle access epoch',
      botId,
      primaryBotId: botId,
      routingState: ChatRoutingState.READY,
    });
    fixture.memberships.push(createActiveMembership(chatId, botId, 0));

    await expect(
      fixture.service.recordBotAccessProbe({
        chatId,
        botId,
        access: { isAdmin: true, isOwner: false, permissions: ['write'] },
        source: 'newer_positive_probe',
        checkedAt,
      }),
    ).resolves.toBe(true);
    await expect(
      fixture.service.markChatBotRemoved({
        chatId,
        botId,
        lifecycleEventAt: olderRemovalAt,
        lifecycleEventType: 'bot_removed',
        lifecycleSource: 'webhook',
      }),
    ).resolves.toBe(botId);

    expect(fixture.memberships[0]).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: checkedAt,
      }),
    );
    expect(fixture.memberships[0]?.lifecycleEventAt).toBeUndefined();

    await expect(
      fixture.service.markChatBotRemoved({
        chatId,
        botId,
        lifecycleEventAt: checkedAt,
        lifecycleEventType: 'bot_removed',
        lifecycleSource: 'webhook',
      }),
    ).resolves.toBeNull();
    expect(fixture.memberships[0]).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.REMOVED,
        botAccessCheckedAt: checkedAt,
        lifecycleEventAt: checkedAt,
        lifecycleEventType: 'bot_removed',
      }),
    );
  });

  it('preserves confirmed denial across older, equal and newer bot_added observations', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-lifecycle-add-access-epoch';
    const botId = fixture.bots[0]!.id;
    const priorLifecycleAt = new Date('2026-05-09T09:00:00.100Z');
    const deniedAt = new Date('2026-05-09T09:00:00.456Z');
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Lifecycle add access epoch',
      botId,
      primaryBotId: botId,
      routingState: ChatRoutingState.READY,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, botId, 0, {
        lifecycleEventAt: priorLifecycleAt,
        lifecycleEventType: 'bot_added',
        lifecycleSource: 'webhook',
      }),
    );

    await expect(
      fixture.service.recordBotAccessProbe({
        chatId,
        botId,
        access: null,
        source: 'newer_denied_probe',
        checkedAt: deniedAt,
        lastErrorCode: 'chat.denied',
      }),
    ).resolves.toBe(true);

    for (const lifecycleEventAt of [new Date(deniedAt.getTime() - 1), deniedAt]) {
      await expect(
        fixture.service.bindChatToBot({
          chatId,
          title: 'Lifecycle add access epoch',
          entityType: ChatEntityType.CHAT,
          botId,
          lifecycleEventAt,
          lifecycleEventType: 'bot_added',
          lifecycleSource: 'webhook',
        }),
      ).resolves.toBeNull();
      expect(fixture.memberships[0]).toEqual(
        expect.objectContaining({
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.DENIED,
          botAccessCheckedAt: deniedAt,
          botAccessSource: 'newer_denied_probe',
          lifecycleEventAt: priorLifecycleAt,
        }),
      );
      expect(fixture.chats.get(chatId)?.routingState).toBe(ChatRoutingState.NO_ELIGIBLE_BOT);
    }

    const readdedAt = new Date(deniedAt.getTime() + 1);
    await expect(
      fixture.service.bindChatToBot({
        chatId,
        title: 'Lifecycle add access epoch',
        entityType: ChatEntityType.CHAT,
        botId,
        lifecycleEventAt: readdedAt,
        lifecycleEventType: 'bot_added',
        lifecycleSource: 'webhook',
      }),
    ).resolves.toBeNull();
    expect(fixture.memberships[0]).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.DENIED,
        botAccessCheckedAt: deniedAt,
        lifecycleEventAt: priorLifecycleAt,
        lifecycleEventType: 'bot_added',
      }),
    );
    expect(fixture.chats.get(chatId)?.routingState).toBe(ChatRoutingState.NO_ELIGIBLE_BOT);
  });

  it('preserves removal across every bot_added observation without explicit activation', async () => {
    const fixture = createServiceFixture();
    const botId = 'id613002203036_4_bot';
    const removedAt = new Date('2026-05-09T09:00:00.456Z');
    fixture.chats.set('chat-lifecycle-readd', {
      id: 'chat-lifecycle-readd',
      title: 'Lifecycle chat',
      botId: null,
      primaryBotId: null,
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
    });
    fixture.memberships.push({
      chatId: 'chat-lifecycle-readd',
      botId,
      role: ChatBotMembershipRole.STANDBY,
      status: ChatBotMembershipStatus.REMOVED,
      permissionsSnapshot: { accessLostAt: removedAt.toISOString() },
      botAccessState: ChatBotAccessState.LOST,
      lifecycleEventAt: removedAt,
      lifecycleEventType: 'bot_removed',
      lifecycleSource: 'webhook',
      createdAt: removedAt,
      updatedAt: removedAt,
      lastSeenAt: removedAt,
      lastWebhookAt: removedAt,
    });

    for (const lifecycleEventAt of [
      new Date('2026-05-09T08:59:59.999Z'),
      new Date(removedAt),
      new Date(removedAt.getTime() + 1),
    ]) {
      await expect(
        fixture.service.bindChatToBot({
          chatId: 'chat-lifecycle-readd',
          title: 'Lifecycle chat',
          entityType: ChatEntityType.CHAT,
          botId,
          lifecycleEventAt,
          lifecycleEventType: 'bot_added',
          lifecycleSource: 'webhook',
        }),
      ).resolves.toBeNull();
      expect(fixture.memberships[0]).toEqual(
        expect.objectContaining({
          status: ChatBotMembershipStatus.REMOVED,
          lifecycleEventAt: removedAt,
          lifecycleEventType: 'bot_removed',
          botAccessState: ChatBotAccessState.LOST,
        }),
      );
      expect(fixture.chats.get('chat-lifecycle-readd')?.routingState).toBe(
        ChatRoutingState.NO_ELIGIBLE_BOT,
      );
    }
  });

  it('preserves lifecycle fencing across every delivery order of add, message, removal, duplicate, and re-add', async () => {
    const eventKinds = ['add', 'message', 'remove', 'remove-duplicate', 'readd'] as const;
    const addedAt = new Date('2026-05-09T09:00:00.123Z');
    const messageAt = new Date('2026-05-09T09:00:00.234Z');
    const removedAt = new Date('2026-05-09T09:00:00.456Z');
    const readdedAt = new Date('2026-05-09T09:00:00.789Z');

    for (const deliveryOrder of permutations(eventKinds)) {
      const fixture = createServiceFixture();
      const chatId = `chat-lifecycle-permutation-${deliveryOrder.join('-')}`;
      const botId = fixture.bots[0]!.id;

      let confirmedRemoval = false;
      for (const eventKind of deliveryOrder) {
        if (confirmedRemoval)
          expect(fixture.memberships[0]?.status).toBe(ChatBotMembershipStatus.REMOVED);
        if (eventKind === 'message') {
          await fixture.service.observeStoredChatBotWebhook({
            chatId,
            primaryBotId: null,
            botId,
            observedAt: messageAt,
          });
          continue;
        }
        if (eventKind === 'remove' || eventKind === 'remove-duplicate') {
          await fixture.service.markChatBotRemoved({
            chatId,
            botId,
            title: 'Lifecycle permutation',
            entityType: ChatEntityType.CHAT,
            lifecycleEventAt: removedAt,
            lifecycleEventType: 'bot_removed',
            lifecycleSource: 'webhook',
          });
          confirmedRemoval ||= fixture.memberships[0]?.status === ChatBotMembershipStatus.REMOVED;
          continue;
        }

        const lifecycleEventAt = eventKind === 'readd' ? readdedAt : addedAt;
        await fixture.service.bindChatToBot({
          chatId,
          botId,
          title: 'Lifecycle permutation',
          entityType: ChatEntityType.CHAT,
          lifecycleEventAt,
          lifecycleEventType: 'bot_added',
          lifecycleSource: 'webhook',
        });
      }

      const membership = fixture.memberships.find(
        (candidate) => candidate.chatId === chatId && candidate.botId === botId,
      );
      expect(membership).toEqual(
        expect.objectContaining({
          status: confirmedRemoval
            ? ChatBotMembershipStatus.REMOVED
            : ChatBotMembershipStatus.ACTIVE,
          lifecycleEventAt: confirmedRemoval ? removedAt : readdedAt,
          lifecycleEventType: confirmedRemoval ? 'bot_removed' : 'bot_added',
        }),
      );
    }
  });

  it.each([
    {
      label: 'add insert wins before a newer removal',
      firstInsert: 'bot_added' as const,
      addedAt: new Date('2026-05-09T09:00:00.100Z'),
      removedAt: new Date('2026-05-09T09:00:00.200Z'),
      expectedStatus: ChatBotMembershipStatus.REMOVED,
      expectedLifecycleType: 'bot_removed',
      expectedRoutingState: ChatRoutingState.NO_ELIGIBLE_BOT,
    },
    {
      label: 'removal insert wins before a newer add',
      firstInsert: 'bot_removed' as const,
      addedAt: new Date('2026-05-09T09:00:00.200Z'),
      removedAt: new Date('2026-05-09T09:00:00.100Z'),
      expectedStatus: ChatBotMembershipStatus.REMOVED,
      expectedLifecycleType: 'bot_removed',
      expectedRoutingState: ChatRoutingState.NO_ELIGIBLE_BOT,
    },
  ])(
    'resolves concurrent first-membership creation when $label',
    async ({
      firstInsert,
      addedAt,
      removedAt,
      expectedStatus,
      expectedLifecycleType,
      expectedRoutingState,
    }) => {
      const fixture = createServiceFixture();
      const chatId = `chat-first-membership-${firstInsert}`;
      const botId = fixture.bots[0]!.id;
      fixture.chats.set(chatId, {
        id: chatId,
        title: 'First membership race',
        botId: null,
        primaryBotId: null,
        entityType: ChatEntityType.CHAT,
        routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
        routingVersion: 0,
      });

      const createDeferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((settle) => {
          resolve = settle;
        });
        return { promise, resolve };
      };
      const addStarted = createDeferred();
      const removalStarted = createDeferred();
      const addGate = createDeferred();
      const removalGate = createDeferred();
      const addCompleted = createDeferred();
      const removalCompleted = createDeferred();
      const reconciliationsReady = createDeferred();
      let reconciliationCalls = 0;
      const originalTransaction = fixture.prisma.$transaction.getMockImplementation();
      if (!originalTransaction) {
        throw new Error('transaction fixture implementation missing');
      }
      fixture.prisma.$transaction.mockImplementation(async (...args) => {
        reconciliationCalls += 1;
        if (reconciliationCalls === 2) {
          reconciliationsReady.resolve();
        }
        await reconciliationsReady.promise;
        return originalTransaction(...args);
      });
      const originalCreateMany =
        fixture.prisma.chatBotMembership.createMany.getMockImplementation();
      if (!originalCreateMany) {
        throw new Error('membership createMany fixture implementation missing');
      }
      fixture.prisma.chatBotMembership.createMany.mockImplementation(async (args) => {
        const data = args.data as { lifecycleEventType?: string };
        const isAdd = data.lifecycleEventType === 'bot_added';
        (isAdd ? addStarted : removalStarted).resolve();
        await (isAdd ? addGate : removalGate).promise;
        const result = await originalCreateMany(args);
        (isAdd ? addCompleted : removalCompleted).resolve();
        return result;
      });

      const add = fixture.service.bindChatToBot({
        chatId,
        title: 'First membership race',
        entityType: ChatEntityType.CHAT,
        botId,
        lifecycleEventAt: addedAt,
        lifecycleEventType: 'bot_added',
        lifecycleSource: 'webhook',
      });
      const remove = fixture.service.markChatBotRemoved({
        chatId,
        title: 'First membership race',
        entityType: ChatEntityType.CHAT,
        botId,
        lifecycleEventAt: removedAt,
        lifecycleEventType: 'bot_removed',
        lifecycleSource: 'webhook',
      });

      await Promise.all([addStarted.promise, removalStarted.promise]);
      if (firstInsert === 'bot_added') {
        addGate.resolve();
        await addCompleted.promise;
        removalGate.resolve();
      } else {
        removalGate.resolve();
        await removalCompleted.promise;
        addGate.resolve();
      }
      await Promise.all([add, remove]);

      expect(fixture.memberships).toHaveLength(1);
      expect(fixture.memberships[0]).toEqual(
        expect.objectContaining({
          chatId,
          botId,
          status: expectedStatus,
          lifecycleEventType: expectedLifecycleType,
          lifecycleEventAt: expectedLifecycleType === 'bot_added' ? addedAt : removedAt,
        }),
      );
      expect(fixture.chats.get(chatId)).toEqual(
        expect.objectContaining({ routingState: expectedRoutingState }),
      );
    },
  );

  it('does not clear removal from a live_probe label without explicit activation', async () => {
    const fixture = createServiceFixture();
    const chatId = 'chat-live-probe-readd';
    const botId = fixture.bots[0]!.id;
    const probeAt = new Date('2026-05-09T10:04:30.000Z');
    const expiresAt = new Date('2026-05-09T10:20:00.000Z');
    const confirmedSnapshot = {
      checkedAt: probeAt.toISOString(),
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
    };
    fixture.chats.set(chatId, {
      id: chatId,
      title: 'Probe recovery',
      botId: null,
      primaryBotId: null,
      routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
      routingVersion: 2,
    });
    fixture.memberships.push(
      createActiveMembership(chatId, botId, 0, {
        status: ChatBotMembershipStatus.REMOVED,
        role: ChatBotMembershipRole.STANDBY,
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: probeAt,
        botAccessExpiresAt: expiresAt,
        permissionsSnapshot: confirmedSnapshot,
        lifecycleEventAt: new Date('2026-05-09T09:00:00.000Z'),
        lifecycleEventType: 'bot_removed',
      }),
    );

    await expect(
      fixture.service.bindChatToBot({
        chatId,
        title: 'Probe recovery',
        entityType: ChatEntityType.CHAT,
        botId,
        allowReassign: true,
        lifecycleEventAt: probeAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      }),
    ).resolves.toBeNull();

    expect(fixture.memberships[0]).toEqual(
      expect.objectContaining({
        status: ChatBotMembershipStatus.REMOVED,
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessExpiresAt: expiresAt,
        permissionsSnapshot: confirmedSnapshot,
      }),
    );
    expect(fixture.chats.get(chatId)?.routingState).toBe(ChatRoutingState.NO_ELIGIBLE_BOT);
  });

  it('builds entry mini app links through the canonical entry bot', () => {
    const fixture = createServiceFixture();

    const url = fixture.service.buildEntryMiniappStartUrlSync('route_abc');

    expect(url).toBe('https://max.ru/id613002203036_bot?startapp=route_abc');
    expect(fixture.service.buildBotUrlSync()).toBe('https://max.ru/id613002203036_bot');
  });

  it('keeps init data handoff bound to its configured dormant bot', () => {
    const fixture = createServiceFixture();
    const launchBot = fixture.bots[1]!;
    launchBot.state = 'dormant';

    expect(fixture.service.buildInitDataBotUrlSync(launchBot.id)).toBe(
      `https://max.ru/${launchBot.id}`,
    );

    launchBot.state = 'disabled';
    expect(fixture.service.buildInitDataBotUrlSync(launchBot.id)).toBeNull();
    expect(fixture.service.buildInitDataBotUrlSync('unknown-bot')).toBeNull();
  });
  it('keeps an old bot route for its saved rules without allowing new or unrelated effects', async () => {
    const fixture = createServiceFixture();
    const chatId = 'fixed-old-rules';
    const [oldBot, currentBot] = fixture.bots;
    fixture.chats.set(chatId, {
      id: chatId,
      title: chatId,
      entityType: ChatEntityType.CHAT,
      botId: currentBot!.id,
      primaryBotId: currentBot!.id,
      fixedModeratorBotId: currentBot!.id,
      routingState: ChatRoutingState.READY,
      routingVersion: 7,
    });
    for (const [index, bot] of [oldBot!, currentBot!].entries())
      fixture.memberships.push(
        createActiveMembership(chatId, bot.id, index, {
          ...freshMemberCapability(['read_all_messages', 'write', 'add_remove_members']),
          botAccessSource: 'confirmed',
        }),
      );
    fixture.prisma.chatRules.findUnique.mockResolvedValue({
      publishedMessageId: 'rules-message',
      publishedBotId: oldBot!.id,
    });
    await expect(fixture.service.resolveDeleteMessageBotRoute({ chatId })).resolves.toMatchObject({
      candidateBotIds: [currentBot!.id],
    });
    await expect(
      fixture.service.resolveDeleteMessageBotRoute({
        chatId,
        existingMessage: { messageId: 'rules-message', botId: oldBot!.id },
      }),
    ).resolves.toMatchObject({ candidateBotIds: [currentBot!.id, oldBot!.id] });
    const request = { chatId, botId: oldBot!.id, purpose: 'edit_message' as const };
    await expect(fixture.service.getFreshChatBotExecutionProof(request)).resolves.toBeNull();
    await expect(
      fixture.service.getFreshChatBotExecutionProof({
        ...request,
        existingMessage: { messageId: 'rules-message' },
      }),
    ).resolves.toMatchObject({ botId: oldBot!.id, routingVersion: 7 });
    await expect(
      fixture.service.resolveDeleteMessageBotRoute({
        chatId,
        existingMessage: { messageId: 'user-message', botId: oldBot!.id },
      }),
    ).resolves.toMatchObject({ candidateBotIds: [currentBot!.id] });
    fixture.memberships[0]!.botAccessState = ChatBotAccessState.DENIED;
    await expect(
      fixture.service.resolveDeleteMessageBotRoute({
        chatId,
        existingMessage: { messageId: 'rules-message', botId: oldBot!.id },
      }),
    ).resolves.toMatchObject({ candidateBotIds: [currentBot!.id] });
  });
});
