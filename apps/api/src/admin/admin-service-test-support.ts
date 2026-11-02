import {
  type ChatSummary,
  type ChannelDialogType,
  type ManagedEntityHeader,
} from '@maxim/contracts';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { createChannelSettingsPrismaMock } from './admin-channel-settings-test-support';
import { AdminService } from './admin.service';

export type ManagedEntityType = 'chat' | 'channel';

export type AdminServicePrivateAccess = {
  resolveBroadcastButtons: (
    chatId: string,
    entityType: ManagedEntityType,
    options: Record<string, unknown>,
    botId?: string,
  ) => Promise<Array<Array<{ text: string; type: string; url: string }>>>;
  buildEntityDialogToken: (
    entityType: ManagedEntityType,
    chatId: string,
    type: ChannelDialogType,
    threadId?: string | null,
  ) => string;
  resolveChatDialogThreadId: (
    chatId: string,
    type: ChannelDialogType,
    token: string | null | undefined,
  ) => string | null;
  buildCommentDialogNotificationText: (params: {
    kind: 'reply' | 'all';
    entityType: ManagedEntityType;
    entityTitle: string;
    entityLink: string | null;
    authorUserId: string;
    authorDisplayName: string | null;
    preview: string;
    postPreview: string | null;
    dialogUrl: string;
    postUrl: string | null;
  }) => string;
};

export function createChatSummaryFixture(
  overrides: Partial<ChatSummary> & Pick<ChatSummary, 'id' | 'title' | 'createdAt' | 'entityType'>,
): ChatSummary {
  return {
    id: overrides.id,
    title: overrides.title,
    createdAt: overrides.createdAt,
    entityType: overrides.entityType,
    link: overrides.link ?? null,
    ...(overrides.avatarUrl ? { avatarUrl: overrides.avatarUrl } : {}),
    channelOverview: overrides.channelOverview ?? null,
    primaryBotId: overrides.primaryBotId ?? null,
    assignedBots: overrides.assignedBots ?? [],
    sharedMode: overrides.sharedMode ?? 'owned',
  };
}

export function createAssignedBotFixture(
  overrides: Partial<ChatSummary['assignedBots'][number]> &
    Pick<ChatSummary['assignedBots'][number], 'botId'>,
): ChatSummary['assignedBots'][number] {
  return {
    botId: overrides.botId,
    label: overrides.label ?? overrides.botId,
    role: overrides.role ?? 'standby',
    membershipStatus: overrides.membershipStatus ?? 'active',
    lifecycleState: overrides.lifecycleState ?? 'active',
    speechPersona: overrides.speechPersona ?? 'male',
    characterName: overrides.characterName ?? null,
    avatarUrl: overrides.avatarUrl ?? null,
    capabilities: overrides.capabilities ?? [],
    permissionsSummary: overrides.permissionsSummary ?? null,
  };
}

export function createManagedEntityHeaderFixture(
  overrides: Partial<ManagedEntityHeader> &
    Pick<ManagedEntityHeader, 'id' | 'title' | 'entityType'>,
): ManagedEntityHeader {
  return {
    id: overrides.id,
    title: overrides.title,
    entityType: overrides.entityType,
    link: overrides.link ?? null,
    participantsCount: overrides.participantsCount ?? null,
    ...(overrides.avatarUrl ? { avatarUrl: overrides.avatarUrl } : {}),
    primaryBotId: overrides.primaryBotId ?? null,
    assignedBots: overrides.assignedBots ?? [],
    sharedMode: overrides.sharedMode ?? 'owned',
    accessDiagnostics: overrides.accessDiagnostics ?? {
      state: 'ok',
      lastDetectedAt: null,
      lastCheckedAt: null,
      freshUntil: null,
      source: 'unknown',
      activeBotCount: overrides.assignedBots?.length ?? 0,
      lostBots: [],
    },
    viewerAccess: overrides.viewerAccess ?? {
      state: 'checking',
      reason: null,
      checkedAt: null,
      canEdit: false,
    },
  };
}

export function createBareAdminServiceForCatalogTests() {
  const service = Object.create(AdminService.prototype) as any;
  service.maxBotRegistry = {
    getBotById: jest.fn().mockReturnValue(null),
  };
  service.managedEntitiesRuntimeBotIds = new Set(['bot-1']);
  service.logger = {
    warn: jest.fn(),
  };
  return service;
}

export function expectChatRulesReadOptions(overrides: Record<string, unknown> = {}) {
  return expect.objectContaining({
    trafficClass: 'interactive',
    actionHealthLane: 'background',
    sourceTag: MAX_API_SOURCE_TAGS.CHAT_RULES,
    timeoutMs: 2500,
    ...overrides,
  });
}

export function expectChatRulesSendOptions(overrides: Record<string, unknown> = {}) {
  return expect.objectContaining({
    trafficClass: 'interactive',
    actionHealthLane: 'interactive',
    sourceTag: MAX_API_SOURCE_TAGS.CHAT_RULES,
    timeoutMs: 12000,
    ...overrides,
  });
}

export function expectChatRulesDeleteOptions(overrides: Record<string, unknown> = {}) {
  return expect.objectContaining({
    immediate: true,
    trafficClass: 'interactive',
    actionHealthLane: 'interactive',
    sourceTag: MAX_API_SOURCE_TAGS.CHAT_RULES,
    timeoutMs: 12000,
    ...overrides,
  });
}

export function createAdminMaxBotLinkMock(overrides: Record<string, unknown> = {}) {
  return {
    getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
    getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
    resolveBotId: jest.fn().mockResolvedValue('777000_bot'),
    resolveBotIdForRead: jest.fn().mockResolvedValue('777000_bot'),
    resolveBotIdForSend: jest.fn().mockResolvedValue('777000_bot'),
    resolveBotRoute: jest.fn(),
    resolveContactIdSync: jest.fn().mockReturnValue(null),
    buildEntryMiniappStartUrlSync: jest.fn(
      (startParam: string) => `https://max.ru/entry-bot?startapp=${encodeURIComponent(startParam)}`,
    ),
    buildMiniappStartUrlSync: jest.fn(
      (startParam: string, botId?: string | null) =>
        `https://max.ru/${encodeURIComponent(botId?.trim() || '777000_bot')}?startapp=${encodeURIComponent(startParam)}`,
    ),
    buildBotStartUrlSync: jest.fn(
      (startPayload: string, botId?: string | null) =>
        `https://max.ru/${encodeURIComponent(botId?.trim() || '777000_bot')}?start=${encodeURIComponent(startPayload)}`,
    ),
    ...overrides,
  };
}

export function createPrismaMock() {
  const defaultManagedBroadcast = {
    id: 'broadcast-1',
    sourceChatId: 'chat-1',
    entityType: 'CHAT',
    actorUserId: 'admin-1',
    text: '',
    textFormat: 'plain',
    applyToAllChats: false,
    targetChatIds: ['chat-1'],
    buttons: [],
    buttonEnabled: false,
    buttonUrl: '',
    buttonText: 'Открыть',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    mediaType: null,
    mediaPayload: null,
    mediaMimeType: '',
    mediaFileName: '',
    scheduleMode: 'legacy',
    scheduleTimezone: 'Europe/Moscow',
    nextSendAt: null,
    cycleEnabled: false,
    cycleEveryHours: 1,
    cycleCount: 1,
    sentCount: 0,
    status: 'ACTIVE',
    lastError: null,
    lockedAt: null,
    lockToken: null,
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-01T00:00:00.000Z'),
  };
  let managedBroadcastState: Record<string, unknown> | null = { ...defaultManagedBroadcast };
  const matchesManagedBroadcastWhere = (
    where: Record<string, unknown> | undefined,
    state: Record<string, unknown> | null = managedBroadcastState,
  ): boolean => {
    if (!state || !where) {
      return Boolean(state);
    }

    if (typeof where.id === 'string' && state.id !== where.id) {
      return false;
    }
    if (typeof where.sourceChatId === 'string' && state.sourceChatId !== where.sourceChatId) {
      return false;
    }
    if (typeof where.entityType === 'string' && state.entityType !== where.entityType) {
      return false;
    }
    if (typeof where.status === 'string' && state.status !== where.status) {
      return false;
    }
    if (where.status && typeof where.status === 'object') {
      const statusFilter = where.status as { in?: string[]; not?: string };
      if (Array.isArray(statusFilter.in) && !statusFilter.in.includes(String(state.status))) {
        return false;
      }
      if (typeof statusFilter.not === 'string' && state.status === statusFilter.not) {
        return false;
      }
    }
    if (where.nextSendAt && typeof where.nextSendAt === 'object' && 'lte' in where.nextSendAt) {
      const nextSendAt = state.nextSendAt instanceof Date ? state.nextSendAt : null;
      if (!nextSendAt || nextSendAt > (where.nextSendAt as { lte: Date }).lte) {
        return false;
      }
    }
    if (where.updatedAt && typeof where.updatedAt === 'object' && 'lte' in where.updatedAt) {
      const updatedAt = state.updatedAt instanceof Date ? state.updatedAt : null;
      if (!updatedAt || updatedAt > (where.updatedAt as { lte: Date }).lte) {
        return false;
      }
    }
    if ('lockedAt' in where) {
      const lockedAt = state.lockedAt instanceof Date ? state.lockedAt : null;
      if (where.lockedAt === null && lockedAt !== null) {
        return false;
      }
      if (
        where.lockedAt instanceof Date &&
        (!lockedAt || lockedAt.getTime() !== where.lockedAt.getTime())
      ) {
        return false;
      }
      if (where.lockedAt && typeof where.lockedAt === 'object' && 'lt' in where.lockedAt) {
        if (!lockedAt || lockedAt >= (where.lockedAt as { lt: Date }).lt) {
          return false;
        }
      }
      if (where.lockedAt && typeof where.lockedAt === 'object' && 'gte' in where.lockedAt) {
        if (!lockedAt || lockedAt < (where.lockedAt as { gte: Date }).gte) {
          return false;
        }
      }
      if (where.lockedAt && typeof where.lockedAt === 'object' && 'not' in where.lockedAt) {
        const notValue = (where.lockedAt as { not?: Date | null }).not;
        if (notValue === null && lockedAt === null) {
          return false;
        }
        if (notValue instanceof Date && lockedAt?.getTime() === notValue.getTime()) {
          return false;
        }
      }
    }
    if ('lockToken' in where) {
      const lockToken = typeof state.lockToken === 'string' ? state.lockToken : null;
      if (where.lockToken === null && lockToken !== null) {
        return false;
      }
      if (typeof where.lockToken === 'string' && lockToken !== where.lockToken) {
        return false;
      }
    }
    if (Array.isArray(where.OR) && !where.OR.some((item) => matchesManagedBroadcastWhere(item))) {
      return false;
    }

    return true;
  };
  type ChannelSuggestionAdminDeliveryMockRow = {
    id: string;
    auditLogId: string;
    adminUserId: string;
    botKey: string;
    botId: string | null;
    privateChatId: string | null;
    status: string;
    attemptCount: number;
    remoteMessageId: string | null;
    lastError: string | null;
    lastStatusCode: number | null;
    lastErrorCode: string | null;
    terminal: boolean;
    sentAt: Date | null;
    lockedAt: Date | null;
    lockToken: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  const channelSuggestionAdminDeliveries: ChannelSuggestionAdminDeliveryMockRow[] = [];
  const matchesChannelSuggestionAdminDeliveryWhere = (
    row: ChannelSuggestionAdminDeliveryMockRow,
    where: Record<string, unknown> | undefined,
  ): boolean => {
    if (!where) {
      return true;
    }
    if (typeof where.id === 'string' && row.id !== where.id) {
      return false;
    }
    if (where.id && typeof where.id === 'object') {
      const idFilter = where.id as { in?: string[] };
      if (Array.isArray(idFilter.in) && !idFilter.in.includes(row.id)) {
        return false;
      }
    }
    if (typeof where.auditLogId === 'string' && row.auditLogId !== where.auditLogId) {
      return false;
    }
    if (typeof where.adminUserId === 'string' && row.adminUserId !== where.adminUserId) {
      return false;
    }
    if (typeof where.botKey === 'string' && row.botKey !== where.botKey) {
      return false;
    }
    if (typeof where.status === 'string' && row.status !== where.status) {
      return false;
    }
    if (where.status && typeof where.status === 'object') {
      const statusFilter = where.status as { in?: string[]; not?: string };
      if (Array.isArray(statusFilter.in) && !statusFilter.in.includes(row.status)) {
        return false;
      }
      if (typeof statusFilter.not === 'string' && row.status === statusFilter.not) {
        return false;
      }
    }
    if (typeof where.terminal === 'boolean' && row.terminal !== where.terminal) {
      return false;
    }
    if (typeof where.lastErrorCode === 'string' && row.lastErrorCode !== where.lastErrorCode) {
      return false;
    }
    if ('lockToken' in where) {
      if (where.lockToken === null && row.lockToken !== null) {
        return false;
      }
      if (typeof where.lockToken === 'string' && row.lockToken !== where.lockToken) {
        return false;
      }
    }
    if ('lockedAt' in where && where.lockedAt === null && row.lockedAt !== null) {
      return false;
    }
    if (where.lockedAt && typeof where.lockedAt === 'object') {
      const lockedAtFilter = where.lockedAt as { lt?: Date; gte?: Date };
      if (lockedAtFilter.lt && !(row.lockedAt && row.lockedAt < lockedAtFilter.lt)) {
        return false;
      }
      if (lockedAtFilter.gte && !(row.lockedAt && row.lockedAt >= lockedAtFilter.gte)) {
        return false;
      }
    }
    return true;
  };
  type ManualModerationFanoutLedgerMockRow = {
    id: string;
    operationKey: string;
    jobId: string | null;
    rootIntentKey: string | null;
    sourceKind: string;
    operation: string;
    sourceChatId: string;
    targetChatId: string;
    targetUserId: string;
    actorUserId: string;
    logicalAction: string;
    executionMode: string | null;
    botId: string | null;
    status: string;
    attemptCount: number;
    moderationEventId: string | null;
    auditLogId: string | null;
    remoteMessageId: string | null;
    lastError: string | null;
    lastStatusCode: number | null;
    lastErrorCode: string | null;
    metadata: unknown;
    terminal: boolean;
    lockedAt: Date | null;
    lockToken: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  const manualModerationFanoutLedgerEntries: ManualModerationFanoutLedgerMockRow[] = [];
  const matchesManualModerationFanoutLedgerWhere = (
    row: ManualModerationFanoutLedgerMockRow,
    where: Record<string, unknown> | undefined,
  ): boolean => {
    if (!where) {
      return true;
    }
    for (const key of [
      'id',
      'operationKey',
      'jobId',
      'rootIntentKey',
      'sourceKind',
      'sourceChatId',
      'targetChatId',
      'targetUserId',
      'actorUserId',
      'logicalAction',
      'botId',
      'lockToken',
    ] as const) {
      if (typeof where[key] === 'string' && row[key] !== where[key]) {
        return false;
      }
      if (where[key] === null && row[key] !== null) {
        return false;
      }
    }
    for (const key of ['status', 'operation'] as const) {
      const filter = where[key];
      if (typeof filter === 'string' && row[key] !== filter) return false;
      if (!filter || typeof filter !== 'object') continue;
      const { in: included, not: excluded } = filter as { in?: string[]; not?: string };
      if (Array.isArray(included) && !included.includes(row[key])) return false;
      if (typeof excluded === 'string' && row[key] === excluded) return false;
    }
    if ('lockedAt' in where && where.lockedAt === null && row.lockedAt !== null) {
      return false;
    }
    if (where.lockedAt && typeof where.lockedAt === 'object') {
      const lockedAtFilter = where.lockedAt as { lt?: Date; gte?: Date };
      if (lockedAtFilter.lt && !(row.lockedAt && row.lockedAt < lockedAtFilter.lt)) {
        return false;
      }
      if (lockedAtFilter.gte && !(row.lockedAt && row.lockedAt >= lockedAtFilter.gte)) {
        return false;
      }
    }
    return true;
  };
  const applyManualModerationFanoutLedgerData = (
    row: ManualModerationFanoutLedgerMockRow,
    data: Record<string, unknown>,
  ) => {
    for (const key of [
      'jobId',
      'rootIntentKey',
      'sourceKind',
      'operation',
      'sourceChatId',
      'targetChatId',
      'targetUserId',
      'actorUserId',
      'logicalAction',
      'executionMode',
      'botId',
      'status',
      'moderationEventId',
      'auditLogId',
      'remoteMessageId',
      'lastError',
      'lastStatusCode',
      'lastErrorCode',
      'metadata',
      'lockedAt',
      'lockToken',
    ] as const) {
      if (key in data && data[key] !== undefined) {
        (row as unknown as Record<string, unknown>)[key] = data[key] ?? null;
      }
    }
    if ('terminal' in data && data.terminal !== undefined) {
      row.terminal = data.terminal === true;
    }
    if (
      data.attemptCount &&
      typeof data.attemptCount === 'object' &&
      'increment' in data.attemptCount
    ) {
      row.attemptCount += Number((data.attemptCount as { increment: number }).increment);
    } else if (typeof data.attemptCount === 'number') {
      row.attemptCount = data.attemptCount;
    }
    row.updatedAt = new Date('2026-03-01T00:00:00.000Z');
  };
  const prisma = {
    commentRestriction: { findUnique: jest.fn().mockResolvedValue(null) },
    chat: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Команда MAX',
        entityType: 'CHAT',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
      update: jest.fn().mockResolvedValue(undefined),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Команда MAX',
        entityType: 'CHAT',
      }),
      count: jest.fn().mockResolvedValue(0),
    },
    chatMembershipActivityEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    chatMembershipActivityFeedItem: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    managedBotChatCatalog: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    channelSettings: createChannelSettingsPrismaMock(),
    chatSettings: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ chatId: 'chat-1' }),
      upsert: jest.fn().mockResolvedValue({
        chatId: 'chat-1',
        commentsEnabled: false,
        commentsAdminsEnabled: true,
        commentsAllEnabled: false,
        commentsChatBroadcastsEnabled: false,
      }),
      update: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    chatParticipantModerationImmunity: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({
        id: 'immunity-1',
        chatId: 'chat-1',
        userId: 'user-1',
        expiresAt: new Date('2026-04-17T12:00:00.000Z'),
        dailyViolationLimit: 3,
        dailyViolationUsage: 0,
        usageDateKey: '2026-04-15',
        createdByUserId: 'admin-1',
        updatedByUserId: 'admin-1',
        createdAt: new Date('2026-04-15T12:00:00.000Z'),
        updatedAt: new Date('2026-04-15T12:00:00.000Z'),
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    chatAdminAllowlist: {
      upsert: jest.fn().mockResolvedValue(undefined),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    adminGlobalSpammerExemption: {
      upsert: jest.fn().mockResolvedValue(undefined),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    domainAllowlist: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue(undefined),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    channelSuggestionImageAsset: { findMany: jest.fn().mockResolvedValue([]) },
    dialogNotificationSubscription: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest
        .fn()
        .mockImplementation(async ({ create, update }: { create: any; update: any }) => ({
          ...create,
          ...update,
        })),
    },
    dialogNotificationPreference: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest
        .fn()
        .mockImplementation(async ({ create, update }: { create: any; update: any }) => ({
          ...create,
          ...update,
        })),
    },
    managedBroadcast: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockImplementation(async () => managedBroadcastState),
      findUnique: jest.fn().mockImplementation(async () => managedBroadcastState),
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        managedBroadcastState = {
          ...defaultManagedBroadcast,
          ...data,
        };
        return managedBroadcastState;
      }),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        managedBroadcastState = {
          ...managedBroadcastState,
          ...data,
        };
        return managedBroadcastState;
      }),
      delete: jest.fn().mockImplementation(async () => {
        const deleted = managedBroadcastState;
        managedBroadcastState = null;
        return deleted;
      }),
      updateMany: jest
        .fn()
        .mockImplementation(
          async ({
            where,
            data,
          }: {
            where?: Record<string, unknown>;
            data: Record<string, unknown>;
          }) => {
            if (!matchesManagedBroadcastWhere(where)) {
              return { count: 0 };
            }

            managedBroadcastState = {
              ...managedBroadcastState,
              ...data,
            };
            return { count: 1 };
          },
        ),
    },
    managedBroadcastDelivery: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    channelSuggestionAdminDelivery: {
      createMany: jest
        .fn()
        .mockImplementation(
          async ({
            data,
            skipDuplicates,
          }: {
            data: Array<Record<string, unknown>>;
            skipDuplicates?: boolean;
          }) => {
            let count = 0;
            for (const item of data) {
              const auditLogId = String(item.auditLogId);
              const adminUserId = String(item.adminUserId);
              const botKey = String(item.botKey);
              if (
                skipDuplicates &&
                channelSuggestionAdminDeliveries.some(
                  (row) =>
                    row.auditLogId === auditLogId &&
                    row.adminUserId === adminUserId &&
                    row.botKey === botKey,
                )
              ) {
                continue;
              }
              channelSuggestionAdminDeliveries.push({
                id:
                  typeof item.id === 'string'
                    ? item.id
                    : `suggestion-delivery-${channelSuggestionAdminDeliveries.length + 1}`,
                auditLogId,
                adminUserId,
                botKey,
                botId: typeof item.botId === 'string' ? item.botId : null,
                privateChatId: typeof item.privateChatId === 'string' ? item.privateChatId : null,
                status: typeof item.status === 'string' ? item.status : 'PENDING',
                attemptCount: Number(item.attemptCount ?? 0),
                remoteMessageId:
                  typeof item.remoteMessageId === 'string' ? item.remoteMessageId : null,
                lastError: typeof item.lastError === 'string' ? item.lastError : null,
                lastStatusCode:
                  typeof item.lastStatusCode === 'number' ? item.lastStatusCode : null,
                lastErrorCode: typeof item.lastErrorCode === 'string' ? item.lastErrorCode : null,
                terminal: item.terminal === true,
                sentAt: item.sentAt instanceof Date ? item.sentAt : null,
                lockedAt: item.lockedAt instanceof Date ? item.lockedAt : null,
                lockToken: typeof item.lockToken === 'string' ? item.lockToken : null,
                createdAt:
                  item.createdAt instanceof Date
                    ? item.createdAt
                    : new Date('2026-03-01T00:00:00.000Z'),
                updatedAt:
                  item.updatedAt instanceof Date
                    ? item.updatedAt
                    : new Date('2026-03-01T00:00:00.000Z'),
              });
              count += 1;
            }
            return { count };
          },
        ),
      findMany: jest
        .fn()
        .mockImplementation(async ({ where }: { where?: Record<string, unknown> } = {}) =>
          channelSuggestionAdminDeliveries.filter((row) =>
            matchesChannelSuggestionAdminDeliveryWhere(row, where),
          ),
        ),
      updateMany: jest
        .fn()
        .mockImplementation(
          async ({
            where,
            data,
          }: {
            where?: Record<string, unknown>;
            data: Record<string, unknown>;
          }) => {
            let count = 0;
            for (const row of channelSuggestionAdminDeliveries) {
              if (!matchesChannelSuggestionAdminDeliveryWhere(row, where)) {
                continue;
              }
              count += 1;
              if (typeof data.status === 'string') {
                row.status = data.status;
              }
              if ('botId' in data) {
                row.botId = (data.botId as string | null) ?? null;
              }
              if ('privateChatId' in data) {
                row.privateChatId = (data.privateChatId as string | null) ?? null;
              }
              if ('remoteMessageId' in data) {
                row.remoteMessageId = (data.remoteMessageId as string | null) ?? null;
              }
              if ('lastError' in data) {
                row.lastError = (data.lastError as string | null) ?? null;
              }
              if ('lastStatusCode' in data) {
                row.lastStatusCode = (data.lastStatusCode as number | null) ?? null;
              }
              if ('lastErrorCode' in data) {
                row.lastErrorCode = (data.lastErrorCode as string | null) ?? null;
              }
              if ('terminal' in data) {
                row.terminal = data.terminal === true;
              }
              if ('sentAt' in data) {
                row.sentAt = (data.sentAt as Date | null) ?? null;
              }
              if ('lockedAt' in data) {
                row.lockedAt = (data.lockedAt as Date | null) ?? null;
              }
              if ('lockToken' in data) {
                row.lockToken = (data.lockToken as string | null) ?? null;
              }
              if (
                data.attemptCount &&
                typeof data.attemptCount === 'object' &&
                'increment' in data.attemptCount
              ) {
                row.attemptCount += Number((data.attemptCount as { increment: number }).increment);
              }
              row.updatedAt = new Date('2026-03-01T00:00:00.000Z');
            }
            return { count };
          },
        ),
    },
    manualModerationFanoutLedgerEntry: {
      createMany: jest
        .fn()
        .mockImplementation(
          async ({
            data,
            skipDuplicates,
          }: {
            data: Array<Record<string, unknown>>;
            skipDuplicates?: boolean;
          }) => {
            let count = 0;
            for (const item of data) {
              const operationKey = String(item.operationKey);
              if (
                skipDuplicates &&
                manualModerationFanoutLedgerEntries.some((row) => row.operationKey === operationKey)
              ) {
                continue;
              }
              manualModerationFanoutLedgerEntries.push({
                id:
                  typeof item.id === 'string'
                    ? item.id
                    : `manual-fanout-ledger-${manualModerationFanoutLedgerEntries.length + 1}`,
                operationKey,
                jobId: typeof item.jobId === 'string' ? item.jobId : null,
                rootIntentKey: typeof item.rootIntentKey === 'string' ? item.rootIntentKey : null,
                sourceKind: String(item.sourceKind ?? ''),
                operation: String(item.operation ?? ''),
                sourceChatId: String(item.sourceChatId ?? ''),
                targetChatId: String(item.targetChatId ?? ''),
                targetUserId: String(item.targetUserId ?? ''),
                actorUserId: String(item.actorUserId ?? ''),
                logicalAction: String(item.logicalAction ?? ''),
                executionMode: typeof item.executionMode === 'string' ? item.executionMode : null,
                botId: typeof item.botId === 'string' ? item.botId : null,
                status: typeof item.status === 'string' ? item.status : 'IN_PROGRESS',
                attemptCount: Number(item.attemptCount ?? 0),
                moderationEventId:
                  typeof item.moderationEventId === 'string' ? item.moderationEventId : null,
                auditLogId: typeof item.auditLogId === 'string' ? item.auditLogId : null,
                remoteMessageId:
                  typeof item.remoteMessageId === 'string' ? item.remoteMessageId : null,
                lastError: typeof item.lastError === 'string' ? item.lastError : null,
                lastStatusCode:
                  typeof item.lastStatusCode === 'number' ? item.lastStatusCode : null,
                lastErrorCode: typeof item.lastErrorCode === 'string' ? item.lastErrorCode : null,
                metadata: 'metadata' in item ? item.metadata : null,
                terminal: item.terminal === true,
                lockedAt: item.lockedAt instanceof Date ? item.lockedAt : null,
                lockToken: typeof item.lockToken === 'string' ? item.lockToken : null,
                createdAt:
                  item.createdAt instanceof Date
                    ? item.createdAt
                    : new Date('2026-03-01T00:00:00.000Z'),
                updatedAt:
                  item.updatedAt instanceof Date
                    ? item.updatedAt
                    : new Date('2026-03-01T00:00:00.000Z'),
              });
              count += 1;
            }
            return { count };
          },
        ),
      findMany: jest
        .fn()
        .mockImplementation(async ({ where }: { where?: Record<string, unknown> } = {}) =>
          manualModerationFanoutLedgerEntries.filter((row) =>
            matchesManualModerationFanoutLedgerWhere(row, where),
          ),
        ),
      count: jest
        .fn()
        .mockImplementation(
          async ({ where }: { where?: Record<string, unknown> } = {}) =>
            manualModerationFanoutLedgerEntries.filter((row) =>
              matchesManualModerationFanoutLedgerWhere(row, where),
            ).length,
        ),
      updateMany: jest
        .fn()
        .mockImplementation(
          async ({
            where,
            data,
          }: {
            where?: Record<string, unknown>;
            data: Record<string, unknown>;
          }) => {
            let count = 0;
            for (const row of manualModerationFanoutLedgerEntries) {
              if (!matchesManualModerationFanoutLedgerWhere(row, where)) {
                continue;
              }
              count += 1;
              applyManualModerationFanoutLedgerData(row, data);
            }
            return { count };
          },
        ),
      deleteMany: jest
        .fn()
        .mockImplementation(async ({ where }: { where?: Record<string, unknown> } = {}) => {
          let count = 0;
          for (let index = manualModerationFanoutLedgerEntries.length - 1; index >= 0; index -= 1) {
            if (
              !matchesManualModerationFanoutLedgerWhere(
                manualModerationFanoutLedgerEntries[index],
                where,
              )
            ) {
              continue;
            }
            manualModerationFanoutLedgerEntries.splice(index, 1);
            count += 1;
          }
          return { count };
        }),
    },
    managedBroadcastOccurrence: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    managedBroadcastCalendarReservation: {
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    publicationOccurrence: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    managedBroadcastIdempotencyRecord: {
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'broadcast-idempotency-1',
        ...data,
        broadcastId: null,
        result: null,
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      })),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest
        .fn()
        .mockImplementation(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
            id: where.id,
            ...data,
            updatedAt: new Date('2026-03-01T00:00:00.000Z'),
          }),
        ),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    managedAutopostMaterialization: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    channelAudienceSnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue(undefined),
    },
    channelPost: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'post-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    channelPostViewSnapshot: {
      create: jest.fn().mockResolvedValue(undefined),
      findMany: jest.fn().mockResolvedValue([]),
    },
    chatRules: {
      findUniqueOrThrow: jest.fn(),
      upsert: jest.fn().mockResolvedValue({
        id: 'rules-1',
        chatId: 'chat-1',
        text: '',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        autoTextEnabled: false,
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    channelStatsSyncState: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    managedEntityFavorite: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    moderationEvent: {
      create: jest.fn().mockResolvedValue({ id: 'moderation-event-1' }),
      count: jest.fn(),
      groupBy: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    maxActionLedgerEntry: {
      findUnique: jest.fn().mockResolvedValue(null),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    webhookExecutionClaim: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(),
  };
  prisma.chatRules.findUniqueOrThrow.mockImplementation(async () => prisma.chatRules.upsert());
  const transactionPrisma = new Proxy(prisma, {
    get(target, property, receiver) {
      if (property !== '$queryRaw') return Reflect.get(target, property, receiver);
      return async (...args: unknown[]) => {
        const sql = extractSqlText(args);
        if (/FOR UPDATE OF chat|SELECT id FROM chats WHERE id =/u.test(sql))
          return [{ id: 'chat-1' }];
        if (/clock_timestamp\(\) AT TIME ZONE 'UTC'/u.test(sql)) return [{ at: new Date() }];
        return prisma.$queryRaw(...args);
      };
    },
  });
  prisma.$transaction = jest.fn(
    (input: unknown[] | ((tx: typeof prisma) => Promise<unknown> | unknown)) => {
      if (typeof input === 'function') {
        return Promise.resolve(input(transactionPrisma));
      }
      return Promise.all(input as Promise<unknown>[]);
    },
  );

  return prisma;
}

export type ManagedBroadcastDeliveryRow = {
  id: string;
  broadcastId: string;
  occurrenceIndex: number;
  targetChatId: string;
  botId: string | null;
  status: string;
  attemptCount: number;
  remoteMessageId: string | null;
  legacySentWithoutRemoteId: boolean;
  lastError: string | null;
  sentAt: Date | null;
  lockedAt: Date | null;
  lockToken: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export function wireManagedBroadcastDeliveryStore(prisma: ReturnType<typeof createPrismaMock>) {
  const deliveries: ManagedBroadcastDeliveryRow[] = [];

  function matchesWhere(
    delivery: ManagedBroadcastDeliveryRow,
    where: Record<string, unknown> | undefined,
  ): boolean {
    if (!where) {
      return true;
    }
    if (Array.isArray(where.OR)) {
      const branches = where.OR as Record<string, unknown>[];
      if (!branches.some((branch) => matchesWhere(delivery, branch))) {
        return false;
      }
    }
    if (typeof where.broadcastId === 'string' && delivery.broadcastId !== where.broadcastId) {
      return false;
    }
    if (
      typeof where.occurrenceIndex === 'number' &&
      delivery.occurrenceIndex !== where.occurrenceIndex
    ) {
      return false;
    }
    if (
      where.occurrenceIndex &&
      typeof where.occurrenceIndex === 'object' &&
      'in' in where.occurrenceIndex &&
      Array.isArray((where.occurrenceIndex as { in?: number[] }).in) &&
      !(where.occurrenceIndex as { in: number[] }).in.includes(delivery.occurrenceIndex)
    ) {
      return false;
    }
    if (
      where.occurrenceIndex &&
      typeof where.occurrenceIndex === 'object' &&
      'gte' in where.occurrenceIndex &&
      delivery.occurrenceIndex < Number((where.occurrenceIndex as { gte: number }).gte)
    ) {
      return false;
    }
    if (
      where.occurrenceIndex &&
      typeof where.occurrenceIndex === 'object' &&
      'gt' in where.occurrenceIndex &&
      delivery.occurrenceIndex <= Number((where.occurrenceIndex as { gt: number }).gt)
    ) {
      return false;
    }
    if (
      where.occurrenceIndex &&
      typeof where.occurrenceIndex === 'object' &&
      'lte' in where.occurrenceIndex &&
      delivery.occurrenceIndex > Number((where.occurrenceIndex as { lte: number }).lte)
    ) {
      return false;
    }
    if (typeof where.id === 'string' && delivery.id !== where.id) {
      return false;
    }
    if (typeof where.targetChatId === 'string' && delivery.targetChatId !== where.targetChatId) {
      return false;
    }
    if (where.targetChatId && typeof where.targetChatId === 'object') {
      const targetChatIdFilter = where.targetChatId as { in?: string[] };
      if (
        Array.isArray(targetChatIdFilter.in) &&
        !targetChatIdFilter.in.includes(delivery.targetChatId)
      ) {
        return false;
      }
    }
    if (where.status && typeof where.status === 'string' && delivery.status !== where.status) {
      return false;
    }
    if (where.status && typeof where.status === 'object') {
      const statusFilter = where.status as { in?: string[]; not?: string };
      if (Array.isArray(statusFilter.in) && !statusFilter.in.includes(delivery.status)) {
        return false;
      }
      if (typeof statusFilter.not === 'string' && delivery.status === statusFilter.not) {
        return false;
      }
    }
    if ('lockedAt' in where && where.lockedAt === null && delivery.lockedAt !== null) {
      return false;
    }
    if (
      where.lockedAt instanceof Date &&
      (!delivery.lockedAt || delivery.lockedAt.getTime() !== where.lockedAt.getTime())
    ) {
      return false;
    }
    if (
      where.lockedAt &&
      typeof where.lockedAt === 'object' &&
      'lt' in where.lockedAt &&
      !(delivery.lockedAt && delivery.lockedAt < (where.lockedAt as { lt: Date }).lt)
    ) {
      return false;
    }
    if (where.lockedAt && typeof where.lockedAt === 'object' && 'not' in where.lockedAt) {
      const notValue = (where.lockedAt as { not?: Date | null }).not;
      if (notValue === null && delivery.lockedAt === null) {
        return false;
      }
      if (notValue instanceof Date && delivery.lockedAt?.getTime() === notValue.getTime()) {
        return false;
      }
    }
    if (
      where.lockedAt &&
      typeof where.lockedAt === 'object' &&
      'gte' in where.lockedAt &&
      !(delivery.lockedAt && delivery.lockedAt >= (where.lockedAt as { gte: Date }).gte)
    ) {
      return false;
    }
    if ('lockToken' in where) {
      if (where.lockToken === null && delivery.lockToken !== null) {
        return false;
      }
      if (typeof where.lockToken === 'string' && delivery.lockToken !== where.lockToken) {
        return false;
      }
    }
    if ('remoteMessageId' in where) {
      if (where.remoteMessageId === null && delivery.remoteMessageId !== null) {
        return false;
      }
      if (
        typeof where.remoteMessageId === 'string' &&
        delivery.remoteMessageId !== where.remoteMessageId
      ) {
        return false;
      }
      if (where.remoteMessageId && typeof where.remoteMessageId === 'object') {
        const remoteMessageIdFilter = where.remoteMessageId as { not?: string | null };
        if (
          'not' in remoteMessageIdFilter &&
          delivery.remoteMessageId === remoteMessageIdFilter.not
        ) {
          return false;
        }
      }
    }
    return true;
  }

  prisma.managedBroadcastDelivery.createMany.mockImplementation(
    async ({
      data,
      skipDuplicates,
    }: {
      data: Array<Record<string, unknown>>;
      skipDuplicates?: boolean;
    }) => {
      let count = 0;
      for (const row of data) {
        if (
          skipDuplicates &&
          deliveries.some(
            (delivery) =>
              delivery.broadcastId === String(row.broadcastId) &&
              delivery.occurrenceIndex === Number(row.occurrenceIndex) &&
              delivery.targetChatId === String(row.targetChatId),
          )
        ) {
          continue;
        }

        deliveries.push({
          id: typeof row.id === 'string' ? row.id : `delivery-${deliveries.length + 1}`,
          broadcastId: String(row.broadcastId),
          occurrenceIndex: Number(row.occurrenceIndex),
          targetChatId: String(row.targetChatId),
          botId: typeof row.botId === 'string' ? row.botId : null,
          status: String(row.status ?? 'PENDING'),
          attemptCount: Number(row.attemptCount ?? 0),
          remoteMessageId: typeof row.remoteMessageId === 'string' ? row.remoteMessageId : null,
          legacySentWithoutRemoteId: Boolean(row.legacySentWithoutRemoteId),
          lastError: typeof row.lastError === 'string' ? row.lastError : null,
          sentAt: row.sentAt instanceof Date ? row.sentAt : null,
          lockedAt: row.lockedAt instanceof Date ? row.lockedAt : null,
          lockToken: typeof row.lockToken === 'string' ? row.lockToken : null,
          createdAt:
            row.createdAt instanceof Date ? row.createdAt : new Date('2026-03-01T00:00:00.000Z'),
          updatedAt:
            row.updatedAt instanceof Date ? row.updatedAt : new Date('2026-03-01T00:00:00.000Z'),
        });
        count += 1;
      }
      return { count };
    },
  );
  prisma.managedBroadcastDelivery.findMany.mockImplementation(
    async ({ where }: { where?: Record<string, unknown> }) =>
      deliveries.filter((delivery) => matchesWhere(delivery, where)),
  );
  prisma.managedBroadcastDelivery.count.mockImplementation(
    async ({ where }: { where?: Record<string, unknown> }) =>
      deliveries.filter((delivery) => matchesWhere(delivery, where)).length,
  );
  prisma.managedBroadcastDelivery.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const delivery = deliveries.find((item) => item.id === where.id);
      if (!delivery) {
        return undefined;
      }
      if (typeof data.status === 'string') {
        delivery.status = data.status;
      }
      if ('lockedAt' in data) {
        delivery.lockedAt = (data.lockedAt as Date | null) ?? null;
      }
      if ('lockToken' in data) {
        delivery.lockToken = (data.lockToken as string | null) ?? null;
      }
      if ('lastError' in data) {
        delivery.lastError = (data.lastError as string | null) ?? null;
      }
      if ('remoteMessageId' in data) {
        delivery.remoteMessageId = (data.remoteMessageId as string | null) ?? null;
      }
      if ('botId' in data) {
        delivery.botId = (data.botId as string | null) ?? null;
      }
      if ('legacySentWithoutRemoteId' in data) {
        delivery.legacySentWithoutRemoteId = Boolean(data.legacySentWithoutRemoteId);
      }
      if ('sentAt' in data) {
        delivery.sentAt = (data.sentAt as Date | null) ?? null;
      }
      delivery.updatedAt = new Date('2026-03-01T00:00:00.000Z');
      return delivery;
    },
  );
  prisma.managedBroadcastDelivery.updateMany.mockImplementation(
    async ({ where, data }: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const delivery of deliveries) {
        if (!matchesWhere(delivery, where)) {
          continue;
        }
        count += 1;
        if (typeof data.status === 'string') {
          delivery.status = data.status;
        }
        if ('lockedAt' in data) {
          delivery.lockedAt = (data.lockedAt as Date | null) ?? null;
        }
        if ('lockToken' in data) {
          delivery.lockToken = (data.lockToken as string | null) ?? null;
        }
        if ('lastError' in data) {
          delivery.lastError = (data.lastError as string | null) ?? null;
        }
        if ('remoteMessageId' in data) {
          delivery.remoteMessageId = (data.remoteMessageId as string | null) ?? null;
        }
        if ('botId' in data) {
          delivery.botId = (data.botId as string | null) ?? null;
        }
        if ('legacySentWithoutRemoteId' in data) {
          delivery.legacySentWithoutRemoteId = Boolean(data.legacySentWithoutRemoteId);
        }
        if ('sentAt' in data) {
          delivery.sentAt = (data.sentAt as Date | null) ?? null;
        }
        if (
          data.attemptCount &&
          typeof data.attemptCount === 'object' &&
          'increment' in data.attemptCount
        ) {
          delivery.attemptCount += Number((data.attemptCount as { increment: number }).increment);
        }
        delivery.updatedAt = new Date('2026-03-01T00:00:00.000Z');
      }
      return { count };
    },
  );
  prisma.managedBroadcastDelivery.deleteMany.mockImplementation(
    async ({ where }: { where?: Record<string, unknown> }) => {
      const before = deliveries.length;
      const remaining = deliveries.filter((delivery) => !matchesWhere(delivery, where));
      deliveries.splice(0, deliveries.length, ...remaining);
      return { count: before - deliveries.length };
    },
  );

  return deliveries;
}

export type ManagedBroadcastOccurrenceRow = {
  id: string;
  broadcastId: string;
  sourceChatId: string;
  entityType: 'CHAT' | 'CHANNEL';
  occurrenceIndex: number;
  scheduledAt: Date;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

export function wireManagedBroadcastOccurrenceStore(
  prisma: ReturnType<typeof createPrismaMock>,
  initialRows: ManagedBroadcastOccurrenceRow[] = [],
) {
  const occurrences = [...initialRows];

  function matchesWhere(
    occurrence: ManagedBroadcastOccurrenceRow,
    where: Record<string, unknown> | undefined,
  ): boolean {
    if (!where) {
      return true;
    }

    if (typeof where.sourceChatId === 'string' && occurrence.sourceChatId !== where.sourceChatId) {
      return false;
    }
    if (typeof where.entityType === 'string' && occurrence.entityType !== where.entityType) {
      return false;
    }
    if (typeof where.broadcastId === 'string' && occurrence.broadcastId !== where.broadcastId) {
      return false;
    }
    if (where.broadcastId && typeof where.broadcastId === 'object') {
      const broadcastFilter = where.broadcastId as { in?: string[]; not?: string };
      if (
        Array.isArray(broadcastFilter.in) &&
        !broadcastFilter.in.includes(occurrence.broadcastId)
      ) {
        return false;
      }
      if (
        typeof broadcastFilter.not === 'string' &&
        occurrence.broadcastId === broadcastFilter.not
      ) {
        return false;
      }
    }
    if (
      typeof where.occurrenceIndex === 'number' &&
      occurrence.occurrenceIndex !== where.occurrenceIndex
    ) {
      return false;
    }
    if (
      where.occurrenceIndex &&
      typeof where.occurrenceIndex === 'object' &&
      'in' in where.occurrenceIndex &&
      Array.isArray((where.occurrenceIndex as { in?: number[] }).in) &&
      !(where.occurrenceIndex as { in: number[] }).in.includes(occurrence.occurrenceIndex)
    ) {
      return false;
    }
    if (
      where.occurrenceIndex &&
      typeof where.occurrenceIndex === 'object' &&
      'gte' in where.occurrenceIndex &&
      occurrence.occurrenceIndex < Number((where.occurrenceIndex as { gte: number }).gte)
    ) {
      return false;
    }
    if (typeof where.status === 'string' && occurrence.status !== where.status) {
      return false;
    }
    if (where.status && typeof where.status === 'object') {
      const statusFilter = where.status as { in?: string[]; not?: string };
      if (Array.isArray(statusFilter.in) && !statusFilter.in.includes(occurrence.status)) {
        return false;
      }
      if (typeof statusFilter.not === 'string' && occurrence.status === statusFilter.not) {
        return false;
      }
    }
    if (where.scheduledAt && typeof where.scheduledAt === 'object') {
      const scheduledAtFilter = where.scheduledAt as { in?: Date[] };
      if (
        Array.isArray(scheduledAtFilter.in) &&
        !scheduledAtFilter.in.some((value) => value.getTime() === occurrence.scheduledAt.getTime())
      ) {
        return false;
      }
    }

    return true;
  }

  prisma.managedBroadcastOccurrence.findMany.mockImplementation(
    async ({
      where,
      orderBy,
    }: {
      where?: Record<string, unknown>;
      orderBy?: Array<Record<string, 'asc' | 'desc'>>;
    } = {}) => {
      const filtered = occurrences.filter((occurrence) => matchesWhere(occurrence, where));
      if (!Array.isArray(orderBy) || orderBy.length === 0) {
        return filtered;
      }

      return [...filtered].sort((left, right) => {
        for (const item of orderBy) {
          const [key, direction] = Object.entries(item)[0] ?? [];
          if (!key || !direction) {
            continue;
          }

          const leftValue = left[key as keyof ManagedBroadcastOccurrenceRow];
          const rightValue = right[key as keyof ManagedBroadcastOccurrenceRow];
          const leftComparable = leftValue instanceof Date ? leftValue.getTime() : leftValue;
          const rightComparable = rightValue instanceof Date ? rightValue.getTime() : rightValue;

          if (leftComparable === rightComparable) {
            continue;
          }

          const comparison = leftComparable < rightComparable ? -1 : 1;
          return direction === 'desc' ? comparison * -1 : comparison;
        }

        return 0;
      });
    },
  );
  prisma.managedBroadcastOccurrence.findUnique.mockImplementation(
    async ({
      where,
    }: {
      where: { broadcastId_occurrenceIndex: { broadcastId: string; occurrenceIndex: number } };
    }) =>
      occurrences.find(
        (occurrence) =>
          occurrence.broadcastId === where.broadcastId_occurrenceIndex.broadcastId &&
          occurrence.occurrenceIndex === where.broadcastId_occurrenceIndex.occurrenceIndex,
      ) ?? null,
  );
  prisma.managedBroadcastOccurrence.createMany.mockImplementation(
    async ({ data }: { data: Array<Record<string, unknown>> }) => {
      for (const row of data) {
        occurrences.push({
          id: `occurrence-${occurrences.length + 1}`,
          broadcastId: String(row.broadcastId),
          sourceChatId: String(row.sourceChatId),
          entityType: String(row.entityType) as 'CHAT' | 'CHANNEL',
          occurrenceIndex: Number(row.occurrenceIndex),
          scheduledAt: row.scheduledAt as Date,
          status: String(row.status ?? 'ACTIVE'),
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
          updatedAt: new Date('2026-03-01T00:00:00.000Z'),
        });
      }

      return { count: data.length };
    },
  );
  prisma.managedBroadcastOccurrence.deleteMany.mockImplementation(
    async ({ where }: { where?: Record<string, unknown> }) => {
      const before = occurrences.length;
      const remaining = occurrences.filter((occurrence) => !matchesWhere(occurrence, where));
      occurrences.splice(0, occurrences.length, ...remaining);
      return { count: before - occurrences.length };
    },
  );
  prisma.managedBroadcastOccurrence.updateMany.mockImplementation(
    async ({ where, data }: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const occurrence of occurrences) {
        if (!matchesWhere(occurrence, where)) {
          continue;
        }

        count += 1;
        if (typeof data.status === 'string') {
          occurrence.status = data.status;
        }
        occurrence.updatedAt = new Date('2026-03-01T00:00:00.000Z');
      }

      return { count };
    },
  );

  return occurrences;
}

export function extractSqlText(arg: unknown): string {
  if (Array.isArray(arg)) {
    return arg.map((part) => extractSqlText(part)).join(' ');
  }

  if (arg && typeof arg === 'object' && 'strings' in arg) {
    const sqlArg = arg as { strings?: unknown; values?: unknown };
    const strings = sqlArg.strings;
    const values = sqlArg.values;
    const parts: string[] = [];
    if (Array.isArray(strings)) {
      parts.push(strings.map((part) => String(part)).join(' '));
    }
    if (Array.isArray(values)) {
      parts.push(values.map((part) => extractSqlText(part)).join(' '));
    }
    if (parts.length > 0) {
      return parts.filter(Boolean).join(' ');
    }
  }

  return String(arg);
}

export function createDecimalLike(value: number) {
  return {
    toNumber: () => value,
    toString: () => String(value),
  };
}

export function createConfigMock(
  options: { previousToken?: string; botId?: string | null; token?: string } = {},
) {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'MAX_BOT_TOKEN') {
        return options.token ?? 'test-max-bot-token';
      }
      throw new Error(`Missing key: ${key}`);
    }),
    get: jest.fn((key: string) => {
      if (key === 'APP_BASE_URL') {
        return 'https://major-maksimov.ru';
      }
      if (key === 'MAX_BOT_ID') {
        return options.botId ?? '777000_bot';
      }
      if (key === 'MAX_BOT_CONTACT_ID') {
        return '777000';
      }
      if (key === 'MAX_BOT_TOKEN_PREVIOUS') {
        return options.previousToken ?? null;
      }
      return null;
    }),
  };
}

export function createChatContextCacheMock(overrides: Record<string, unknown> = {}) {
  const refreshCursorByScope = new Map<string, number | null>();
  const discoverySnapshotByScope = new Map<string, unknown[] | null>();
  const lastSyncedAtByScope = new Map<string, string | null>();
  const publishedSnapshotByScope = new Map<string, unknown | null>();
  const publishedDiffByScope = new Map<string, unknown | null>();
  const recentBootstrapByEntityType = new Map<string, unknown[] | null>();
  const buildScopeKey = (userId: string, entityType: string) => `${userId}:${entityType}`;
  const buildDiffScopeKey = (userId: string, entityType: string, baseVersion: string) =>
    `${userId}:${entityType}:${baseVersion}`;

  return {
    invalidate: jest.fn().mockResolvedValue(undefined),
    getAdminAccess: jest.fn().mockResolvedValue(null),
    setAdminAccess: jest.fn().mockResolvedValue(undefined),
    applyAdminAccessEpochMutation: jest
      .fn()
      .mockImplementation(
        async (params: {
          chatId: string;
          userId: string;
          state: string;
          publishedSummary?: ChatSummary;
        }) => {
          for (const entityType of ['chat', 'channel']) {
            const key = buildScopeKey(params.userId, entityType);
            const current = publishedSnapshotByScope.get(key) as
              | ({ items: ChatSummary[]; itemCount: number } & Record<string, unknown>)
              | null
              | undefined;
            if (!current || !Array.isArray(current.items)) {
              continue;
            }
            const remaining = current.items.filter((item) => item.id !== params.chatId);
            const items =
              params.state === 'granted' && params.publishedSummary?.entityType === entityType
                ? [params.publishedSummary, ...remaining]
                : remaining;
            publishedSnapshotByScope.set(key, {
              ...current,
              itemCount: items.length,
              items,
            });
          }
          return true;
        },
      ),
    rememberChatAdminUser: jest.fn().mockResolvedValue(undefined),
    getManagedEntityHeader: jest.fn().mockResolvedValue(null),
    setManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
    invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
    getManagedEntityBotProfile: jest.fn().mockResolvedValue(null),
    setManagedEntityBotProfile: jest.fn().mockResolvedValue(undefined),
    isManagedEntitiesRefreshCooldownActive: jest.fn().mockResolvedValue(false),
    activateManagedEntitiesRefreshCooldown: jest.fn().mockResolvedValue(undefined),
    isManagedEntitiesRefreshBackoffActive: jest.fn().mockResolvedValue(false),
    getManagedEntitiesRefreshBackoffRemainingMs: jest.fn().mockResolvedValue(0),
    activateManagedEntitiesRefreshBackoff: jest.fn().mockResolvedValue(undefined),
    isManagedRefreshSourceBackoffActive: jest.fn().mockResolvedValue(false),
    getManagedRefreshSourceBackoffRemainingMs: jest.fn().mockResolvedValue(0),
    activateManagedRefreshSourceBackoff: jest.fn().mockResolvedValue(undefined),
    getManagedEntitiesRefreshCursor: jest
      .fn()
      .mockImplementation(
        async (userId: string, entityType: string) =>
          refreshCursorByScope.get(buildScopeKey(userId, entityType)) ?? null,
      ),
    setManagedEntitiesRefreshCursor: jest
      .fn()
      .mockImplementation(async (userId: string, entityType: string, cursor: number) => {
        refreshCursorByScope.set(buildScopeKey(userId, entityType), cursor);
      }),
    clearManagedEntitiesRefreshCursor: jest
      .fn()
      .mockImplementation(async (userId: string, entityType: string) => {
        refreshCursorByScope.delete(buildScopeKey(userId, entityType));
      }),
    getManagedEntitiesDiscoverySnapshot: jest
      .fn()
      .mockImplementation(
        async (userId: string, entityType: string) =>
          discoverySnapshotByScope.get(buildScopeKey(userId, entityType)) ?? null,
      ),
    setManagedEntitiesDiscoverySnapshot: jest
      .fn()
      .mockImplementation(async (userId: string, entityType: string, snapshot: unknown[]) => {
        discoverySnapshotByScope.set(buildScopeKey(userId, entityType), snapshot);
      }),
    clearManagedEntitiesDiscoverySnapshot: jest
      .fn()
      .mockImplementation(async (userId: string, entityType: string) => {
        discoverySnapshotByScope.delete(buildScopeKey(userId, entityType));
      }),
    getManagedEntitiesLastSyncedAt: jest
      .fn()
      .mockImplementation(
        async (userId: string, entityType: string) =>
          lastSyncedAtByScope.get(buildScopeKey(userId, entityType)) ?? null,
      ),
    setManagedEntitiesLastSyncedAt: jest
      .fn()
      .mockImplementation(async (userId: string, entityType: string, isoValue: string) => {
        lastSyncedAtByScope.set(buildScopeKey(userId, entityType), isoValue);
      }),
    getManagedEntitiesPublishedSnapshot: jest
      .fn()
      .mockImplementation(
        async (userId: string, entityType: string) =>
          publishedSnapshotByScope.get(buildScopeKey(userId, entityType)) ?? null,
      ),
    setManagedEntitiesPublishedSnapshot: jest
      .fn()
      .mockImplementation(async (userId: string, entityType: string, snapshot: unknown) => {
        publishedSnapshotByScope.set(buildScopeKey(userId, entityType), snapshot);
        return true;
      }),
    clearManagedEntitiesPublishedSnapshot: jest
      .fn()
      .mockImplementation(async (userId: string, entityType: string) => {
        publishedSnapshotByScope.delete(buildScopeKey(userId, entityType));
      }),
    getManagedEntitiesPublishedDiff: jest
      .fn()
      .mockImplementation(async (userId: string, entityType: string, baseVersion: string) => {
        return publishedDiffByScope.get(buildDiffScopeKey(userId, entityType, baseVersion)) ?? null;
      }),
    setManagedEntitiesPublishedDiff: jest
      .fn()
      .mockImplementation(
        async (userId: string, entityType: string, baseVersion: string, diff: unknown) => {
          publishedDiffByScope.set(buildDiffScopeKey(userId, entityType, baseVersion), diff);
        },
      ),
    upsertManagedEntityPublishedSnapshot: jest
      .fn()
      .mockImplementation(async (userId: string, summary: ChatSummary) => {
        const currentKey = buildScopeKey(userId, summary.entityType);
        const oppositeType = summary.entityType === 'chat' ? 'channel' : 'chat';
        const oppositeKey = buildScopeKey(userId, oppositeType);
        const current = publishedSnapshotByScope.get(currentKey) as
          | ({ items: ChatSummary[]; itemCount: number } & Record<string, unknown>)
          | null
          | undefined;
        const opposite = publishedSnapshotByScope.get(oppositeKey) as
          | ({ items: ChatSummary[]; itemCount: number } & Record<string, unknown>)
          | null
          | undefined;
        const previous = [...(current?.items ?? []), ...(opposite?.items ?? [])].find(
          (item) => item.id === summary.id,
        );
        const nextSummary: ChatSummary = {
          ...summary,
          link: summary.link === undefined ? (previous?.link ?? null) : summary.link,
        };
        if (summary.avatarUrl === undefined && previous?.avatarUrl !== undefined) {
          nextSummary.avatarUrl = previous.avatarUrl;
        }
        const items = [
          nextSummary,
          ...(current?.items ?? []).filter((item) => item.id !== summary.id),
        ];
        publishedSnapshotByScope.set(currentKey, {
          ...(current ?? {}),
          version: `test-upsert:${summary.id}`,
          builtAt: new Date().toISOString(),
          lastSyncedAt: (current?.lastSyncedAt as string | null | undefined) ?? null,
          itemCount: items.length,
          itemsHash: `test-upsert:${summary.id}:${items.length}`,
          items,
        });

        if (opposite?.items.some((item) => item.id === summary.id)) {
          const oppositeItems = opposite.items.filter((item) => item.id !== summary.id);
          if (oppositeItems.length === 0) {
            publishedSnapshotByScope.delete(oppositeKey);
          } else {
            publishedSnapshotByScope.set(oppositeKey, {
              ...opposite,
              itemCount: oppositeItems.length,
              items: oppositeItems,
            });
          }
        }
      }),
    getManagedEntitiesRecentBootstrap: jest
      .fn()
      .mockImplementation(async (entityType: string, userId?: string | null) =>
        (
          (recentBootstrapByEntityType.get(entityType) ?? []) as Array<
            ChatSummary & { bootstrapUserIds?: string[] }
          >
        ).map((entry) => {
          const normalizedUserId =
            typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : null;
          if (
            normalizedUserId &&
            Array.isArray(entry.bootstrapUserIds) &&
            entry.bootstrapUserIds.includes(normalizedUserId)
          ) {
            return {
              ...entry,
              bootstrapUserIds: Array.from(
                new Set([normalizedUserId, ...(entry.bootstrapUserIds ?? [])]),
              ),
            };
          }
          return entry;
        }),
      ),
    upsertManagedEntitiesRecentBootstrap: jest
      .fn()
      .mockImplementation(async (item: ChatSummary, _ttlSec: number, userId?: string | null) => {
        const entityType = item.entityType;
        const normalizedUserId =
          typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : null;
        const nextItem = normalizedUserId
          ? {
              ...item,
              bootstrapUserIds: Array.from(
                new Set([
                  normalizedUserId,
                  ...((item as { bootstrapUserIds?: string[] }).bootstrapUserIds ?? []),
                ]),
              ),
            }
          : item;
        const current = (recentBootstrapByEntityType.get(entityType) ?? []) as ChatSummary[];
        recentBootstrapByEntityType.set(
          entityType,
          [nextItem, ...current.filter((entry) => entry.id !== item.id)].slice(0, 500),
        );
      }),
    clearManagedEntitiesRecentBootstrapForChat: jest
      .fn()
      .mockImplementation(async (chatId: string, entityType: string | null) => {
        const entityTypes = entityType ? [entityType] : ['chat', 'channel'];
        for (const currentEntityType of entityTypes) {
          const current = (recentBootstrapByEntityType.get(currentEntityType) ??
            []) as ChatSummary[];
          recentBootstrapByEntityType.set(
            currentEntityType,
            current.filter((entry) => entry.id !== chatId),
          );
        }
      }),
    ...overrides,
  };
}

export {
  createDeferred,
  createLocalManagedEntityRow,
  decodeBase64UrlJson,
  flushAsyncTasks,
  publishCommentsDialogToken,
  publishSuggestDialogToken,
  readButtonUrl,
  readDialogButtonToken,
} from './admin-service-focused-test-support';
