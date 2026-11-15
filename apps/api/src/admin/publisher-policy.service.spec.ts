import { PUBLISHER_EXPLICIT_ACTIVATION_PENDING_SOURCE } from '../publisher/publisher-entity-connection.util';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChannelPostSignaturePresentation,
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
} from '../prisma/prisma-client';
import { PublisherPolicyService } from './publisher-policy.service';

function createReadiness(readyEntityIds: readonly string[] = []) {
  const readyIds = new Set(readyEntityIds);
  return {
    isRuntimeAvailable: jest.fn().mockResolvedValue(true),
    resolvePolicy: jest.fn(
      (
        row: {
          publikEnabled: boolean;
          revision: number;
          updatedAt: Date;
        } | null,
      ) => ({
        publikEnabled: row?.publikEnabled ?? true,
        revision: row?.revision ?? 0,
        updatedAt: row?.updatedAt.toISOString() ?? null,
      }),
    ),
    resolveReadiness: jest.fn(
      (
        source: { id: string; entityType: ChatEntityType },
        _snapshot?: { now: Date; runtimeAvailable: boolean },
      ) => {
        const ready = readyIds.has(source.id);
        return {
          state: ready ? 'ready' : 'setup_required',
          canPublish: ready,
          canUseChatComments: ready && source.entityType === ChatEntityType.CHAT,
          canUseChannelComments: ready && source.entityType === ChatEntityType.CHANNEL,
          canPublishSuggestions: false,
          blockerCode: ready ? null : 'bot_not_connected',
          checkedAt: null as string | null,
          retryAt: null,
        };
      },
    ),
  };
}

function createBotRegistry() {
  return {
    getPublisherBotDescriptor: () => ({ id: 'publik-bot' }),
    getActionableBots: () => [{ id: 'main-bot' }, { id: 'inactive-main-bot' }],
  };
}

function createBindingRefreshQueue() {
  return {
    enqueue: jest.fn().mockResolvedValue(undefined),
  };
}

const user = {
  userId: 'user-1',
  username: null,
  displayName: null,
};

function createConnectedPublisherBinding(
  overrides: Partial<{
    publisherBotId: string;
    status: ChatBotMembershipStatus;
    botAccessState: ChatBotAccessState;
    botAccessSource: string | null;
    permissionsSnapshot: unknown;
    lastWebhookAt: Date | null;
  }> = {},
) {
  return {
    publisherBotId: 'publik-bot',
    status: ChatBotMembershipStatus.ACTIVE,
    botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
    lastWebhookAt: null,
    botAccessSource: null,
    permissionsSnapshot: null as unknown,
    ...overrides,
  };
}

function createListEntity(
  id: string,
  title: string,
  entityType: ChatEntityType,
  publisherBinding: ReturnType<
    typeof createConnectedPublisherBinding
  > | null = createConnectedPublisherBinding(),
): {
  id: string;
  title: string;
  entityType: ChatEntityType;
  publisherSettings: {
    revision: number;
    chatCommentsEnabled: boolean;
    chatCommentsAdminsEnabled: boolean;
    chatCommentsPostsEnabled: boolean;
    channelCommentsEnabled: boolean;
    channelSuggestionsEnabled: boolean;
    autoRepliesEnabled: boolean;
  } | null;
  publicationPolicy: {
    publikEnabled: boolean;
    revision: number;
    updatedAt: Date;
  } | null;
  publisherBinding: ReturnType<typeof createConnectedPublisherBinding> | null;
  botMemberships: Array<{ botId: string }>;
} {
  return {
    id,
    title,
    entityType,
    publisherSettings: null,
    publicationPolicy: null,
    publisherBinding,
    botMemberships: [{ botId: 'main-bot' }],
  };
}

function createListFixture(
  entities: ReturnType<typeof createListEntity>[],
  readyEntityIds: readonly string[] = [],
) {
  const findMany = jest
    .fn()
    .mockImplementation(
      (request?: {
        where?: { chatId?: string | { in?: string[] }; botId?: string | { not?: string } };
      }) => {
        const requestedChatId = request?.where?.chatId;
        const requestedIds =
          typeof requestedChatId === 'string' ? [requestedChatId] : requestedChatId?.in;
        const edgeBotId = request?.where?.botId === 'publik-bot' ? 'publik-bot' : 'main-bot';
        return Promise.resolve(
          entities
            .filter((chat) => !requestedIds || requestedIds.includes(chat.id))
            .map((chat) => ({
              chatId: chat.id,
              botId: edgeBotId,
              entityType: chat.entityType,
              chat,
            })),
        );
      },
    );
  const catalogFindMany = jest.fn().mockImplementation(
    (request?: {
      where?: {
        OR?: Array<{ botId: string; chatId: string; entityType: ChatEntityType }>;
        chatId?: { in?: string[] };
      };
      select?: { entityType?: boolean; title?: boolean };
    }) => {
      const requestedIds = request?.where?.chatId?.in;
      const targets =
        request?.where?.OR ??
        entities
          .filter((entity) => !requestedIds || requestedIds.includes(entity.id))
          .map((entity) => ({
            botId: 'publik-bot',
            chatId: entity.id,
            entityType: entity.entityType,
          }));
      return Promise.resolve(
        targets.flatMap((target) => {
          const entity = entities.find(
            (candidate) =>
              candidate.id === target.chatId && candidate.entityType === target.entityType,
          );
          return entity
            ? [
                {
                  botId: target.botId,
                  chatId: target.chatId,
                  entityType: target.entityType,
                  title: entity.title,
                  link: null,
                  avatarUrl: null,
                },
              ]
            : [];
        }),
      );
    },
  );
  const catalogFindFirst = jest
    .fn()
    .mockImplementation(
      (request?: { where?: { chatId?: string; entityType?: ChatEntityType } }) => {
        const entity = entities.find(
          (candidate) =>
            candidate.id === request?.where?.chatId &&
            candidate.entityType === request?.where?.entityType,
        );
        return Promise.resolve(
          entity
            ? {
                entityType: entity.entityType,
                title: entity.title,
                link: null,
                avatarUrl: null,
              }
            : null,
        );
      },
    );
  const readiness = createReadiness(readyEntityIds);
  const service = new PublisherPolicyService(
    {
      managedEntityAccessEdge: { findMany },
      managedBotChatCatalog: { findMany: catalogFindMany, findFirst: catalogFindFirst },
    } as never,
    createBotRegistry() as never,
    readiness as never,
    {} as never,
    createBindingRefreshQueue() as never,
  );
  return {
    catalogFindFirst,
    catalogFindMany,
    findMany,
    readiness,
    service,
  };
}

function createPolicyMutationFixture(
  options: {
    storedEntityType?: ChatEntityType;
    publicationPolicy?: object | null;
    publisherSettings?: object | null;
  } = {},
) {
  const updatedAt = new Date('2026-08-26T10:00:00.000Z');
  const storedPolicy = {
    chatId: 'channel-1',
    publikEnabled: true,
    revision: 1,
    updatedByUserId: user.userId,
    createdAt: updatedAt,
    updatedAt,
  };
  const storedPublisherSettings = {
    chatId: 'channel-1',
    chatCommentsEnabled: true,
    chatCommentsAdminsEnabled: false,
    chatCommentsPostsEnabled: true,
    channelCommentsEnabled: true,
    channelSuggestionsEnabled: true,
    autoRepliesEnabled: false,
    revision: 1,
    updatedByUserId: user.userId,
    createdAt: updatedAt,
    updatedAt,
  };
  const existingPublisherSettings =
    options.publisherSettings === undefined
      ? null
      : { ...storedPublisherSettings, ...options.publisherSettings };
  const updatedPublisherSettings = existingPublisherSettings
    ? { ...existingPublisherSettings, revision: existingPublisherSettings.revision + 1 }
    : storedPublisherSettings;
  const tx = {
    managedEntityPublicationPolicy: {
      create: jest.fn().mockResolvedValue(storedPolicy),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(storedPolicy),
    },
    publisherEntitySettings: {
      create: jest.fn().mockResolvedValue(storedPublisherSettings),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(updatedPublisherSettings),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
  };
  const transaction = jest.fn(async (callback: (transactionClient: typeof tx) => unknown) =>
    callback(tx),
  );
  const prisma = {
    managedEntityAccessEdge: {
      findMany: jest
        .fn()
        .mockImplementation(
          (request: { where: { chatId: string; entityType: ChatEntityType } }) => {
            const entityType = options.storedEntityType ?? ChatEntityType.CHANNEL;
            return Promise.resolve(
              request.where.entityType !== entityType
                ? []
                : [
                    {
                      chatId: request.where.chatId,
                      botId: 'publik-bot',
                      entityType,
                      chat: {
                        id: request.where.chatId,
                        entityType,
                        publicationPolicy:
                          options.publicationPolicy === undefined
                            ? null
                            : { ...storedPolicy, ...options.publicationPolicy },
                        publisherSettings: existingPublisherSettings,
                        publisherBinding: createConnectedPublisherBinding(),
                      },
                    },
                  ],
            );
          },
        ),
    },
    managedBotChatCatalog: {
      findFirst: jest.fn().mockResolvedValue({
        entityType: options.storedEntityType ?? ChatEntityType.CHANNEL,
        title: 'Публик',
        link: null,
        avatarUrl: null,
      }),
    },
    chat: {
      findUnique: jest.fn().mockResolvedValue({
        entityType: options.storedEntityType ?? ChatEntityType.CHANNEL,
        publicationPolicy:
          options.publicationPolicy === undefined
            ? null
            : { ...storedPolicy, ...options.publicationPolicy },
        publisherSettings: existingPublisherSettings,
        publisherBinding: createConnectedPublisherBinding(),
      }),
    },
    $transaction: transaction,
  };
  const readiness = createReadiness(['channel-1', 'chat-1']);
  const managedEntities = {
    assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
  };
  const bindingRefreshQueue = createBindingRefreshQueue();
  const service = new PublisherPolicyService(
    prisma as never,
    createBotRegistry() as never,
    readiness as never,
    managedEntities as never,
    bindingRefreshQueue as never,
  );

  return {
    bindingRefreshQueue,
    managedEntities,
    prisma,
    readiness,
    service,
    storedPolicy,
    storedPublisherSettings,
    transaction,
    tx,
  };
}

describe('PublisherPolicyService', () => {
  it('authorizes a selected refresh with fresh exact-bot actor access even when bot readiness is stale', async () => {
    const entity = createListEntity('chat-1', 'Чат', ChatEntityType.CHAT);
    const { service, findMany, readiness } = createListFixture([entity]);
    readiness.resolveReadiness.mockReturnValue({
      state: 'setup_required',
      canPublish: false,
      canUseChatComments: false,
      canUseChannelComments: false,
      canPublishSuggestions: false,
      blockerCode: 'bot_access_expired',
      checkedAt: null,
      retryAt: null,
    });
    await expect(
      service.resolveDraftTargets(user, [{ chatId: 'chat-1', entityType: 'chat' }]),
    ).resolves.toEqual([{ chatId: 'chat-1', entityType: 'chat' }]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: { in: ['chat-1'] },
          userId: user.userId,
          botId: 'publik-bot',
          state: ManagedEntityAccessState.GRANTED,
          userRole: { in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN] },
        }),
      }),
    );
  });

  it('checks the selected actor before returning persisted settings, without probing on home', async () => {
    const f = createListFixture([createListEntity('chat-1', 'Чат', ChatEntityType.CHAT)]);
    const denied = new Error('Selected actor denied');
    const assertAccess = jest.fn().mockRejectedValue(denied);
    Object.assign(f.service, { selectedAccess: { assertAccess } });
    await f.service.listEntities(user);
    expect(assertAccess).not.toHaveBeenCalled();
    f.findMany.mockClear();
    await expect(f.service.getEntity('chat', 'chat-1', user)).rejects.toBe(denied);
    expect(assertAccess).toHaveBeenCalledWith(user, 'chat-1', 'chat');
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it('rejects selected refresh authorization for a missing actor grant or mismatched entity type', async () => {
    const { service, findMany } = createListFixture([
      createListEntity('chat-1', 'Чат', ChatEntityType.CHAT),
    ]);
    await expect(
      service.resolveDraftTargets(user, [{ chatId: 'chat-1', entityType: 'channel' }]),
    ).rejects.toBeInstanceOf(BadRequestException);
    findMany.mockResolvedValueOnce([]);
    await expect(
      service.resolveDraftTargets(user, [{ chatId: 'chat-1', entityType: 'chat' }]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lists deduplicated entities from exact Publisher user access without Major membership', async () => {
    const chat = {
      id: 'chat-1',
      title: 'Команда',
      entityType: ChatEntityType.CHAT,
      publisherSettings: null,
      publicationPolicy: null,
      publisherBinding: createConnectedPublisherBinding(),
      botMemberships: [],
    };
    const prisma = {
      managedEntityAccessEdge: {
        findMany: jest.fn().mockResolvedValue([
          { chatId: 'chat-1', botId: 'publik-bot', entityType: ChatEntityType.CHAT, chat },
          { chatId: 'chat-1', botId: 'publik-bot', entityType: ChatEntityType.CHAT, chat },
          {
            chatId: 'chat-2',
            botId: 'inactive-main-bot',
            chat: { ...chat, id: 'chat-2', botMemberships: [] },
          },
        ]),
      },
      managedBotChatCatalog: {
        findMany: jest.fn().mockResolvedValue([
          {
            botId: 'publik-bot',
            chatId: chat.id,
            entityType: ChatEntityType.CHAT,
            title: 'Команда Публика',
            link: null,
            avatarUrl: null,
          },
        ]),
      },
    };
    const readiness = createReadiness();
    const service = new PublisherPolicyService(
      prisma as never,
      createBotRegistry() as never,
      readiness as never,
      {} as never,
      createBindingRefreshQueue() as never,
    );

    const response = await service.listEntities({
      userId: 'user-1',
      username: null,
      displayName: null,
    });

    expect(response.items).toHaveLength(1);
    expect(response.items[0]?.id).toBe('chat-1');
    expect(response.items[0]?.title).toBe('Команда Публика');
    expect(response.accessVerificationPending).toBe(false);
    expect(prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          state: ManagedEntityAccessState.GRANTED,
          userRole: { in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN] },
          botId: 'publik-bot',
          chat: {
            publisherBinding: {
              is: {
                publisherBotId: 'publik-bot',
                status: ChatBotMembershipStatus.ACTIVE,
                AND: [
                  {
                    OR: [
                      { botAccessSource: null },
                      { botAccessSource: { not: PUBLISHER_EXPLICIT_ACTIVATION_PENDING_SOURCE } },
                    ],
                  },
                ],
                OR: [
                  {
                    botAccessState: {
                      in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER],
                    },
                  },
                  {
                    botAccessState: ChatBotAccessState.UNKNOWN,
                    lastWebhookAt: { not: null },
                  },
                ],
              },
            },
          },
        }),
      }),
    );
    expect(readiness.resolveReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chat-1' }),
      expect.objectContaining({ now: expect.any(Date), runtimeAvailable: true }),
    );
    expect(readiness.isRuntimeAvailable).toHaveBeenCalledTimes(1);
  });

  it('exposes only entities with independently observed Publik membership', async () => {
    const confirmedAdmin = createListEntity(
      'chat-confirmed-admin',
      'Подтвержденный администратор',
      ChatEntityType.CHAT,
    );
    const confirmedMember = createListEntity(
      'chat-confirmed-member',
      'Подтвержденный участник',
      ChatEntityType.CHAT,
      createConnectedPublisherBinding({ botAccessState: ChatBotAccessState.CONFIRMED_MEMBER }),
    );
    const webhookObserved = createListEntity(
      'chat-webhook-observed',
      'Webhook наблюдение',
      ChatEntityType.CHAT,
      createConnectedPublisherBinding({
        botAccessState: ChatBotAccessState.UNKNOWN,
        lastWebhookAt: new Date('2026-08-26T10:00:00.000Z'),
      }),
    );
    const bootstrapOnly = createListEntity(
      'chat-bootstrap-only',
      'Только bootstrap Майора',
      ChatEntityType.CHAT,
      createConnectedPublisherBinding({ botAccessState: ChatBotAccessState.UNKNOWN }),
    );
    const denied = createListEntity(
      'chat-denied',
      'Нет подключения',
      ChatEntityType.CHAT,
      createConnectedPublisherBinding({ botAccessState: ChatBotAccessState.DENIED }),
    );
    const removed = createListEntity(
      'chat-removed',
      'Удаленный Публик',
      ChatEntityType.CHAT,
      createConnectedPublisherBinding({ status: ChatBotMembershipStatus.REMOVED }),
    );
    const wrongBot = createListEntity(
      'chat-wrong-bot',
      'Чужой binding',
      ChatEntityType.CHAT,
      createConnectedPublisherBinding({ publisherBotId: 'other-bot' }),
    );
    const missingBinding = createListEntity(
      'chat-missing-binding',
      'Только Майор',
      ChatEntityType.CHAT,
      null,
    );
    const disabled = {
      ...createListEntity('chat-disabled', 'Публик выключен', ChatEntityType.CHAT),
      publicationPolicy: {
        publikEnabled: false,
        revision: 1,
        updatedAt: new Date('2026-08-26T11:00:00.000Z'),
      },
    };
    const pending = createListEntity(
      'pending',
      'Pending',
      ChatEntityType.CHAT,
      createConnectedPublisherBinding({
        botAccessState: ChatBotAccessState.UNKNOWN,
        lastWebhookAt: new Date(),
        botAccessSource: PUBLISHER_EXPLICIT_ACTIVATION_PENDING_SOURCE,
      }),
    );
    const writeDenied = createListEntity(
      'write-denied',
      'Write denied',
      ChatEntityType.CHAT,
      createConnectedPublisherBinding({
        permissionsSnapshot: {
          isAdmin: true,
          isOwner: false,
          permissionsKnown: true,
          permissions: ['read_all_messages'],
        },
      }),
    );
    const fixture = createListFixture([
      confirmedAdmin,
      confirmedMember,
      pending,
      writeDenied,
      webhookObserved,
      bootstrapOnly,
      denied,
      removed,
      wrongBot,
      missingBinding,
      disabled,
    ]);

    const listed = await fixture.service.listEntities(user);
    expect(listed.items.map((entity) => entity.id).sort()).toEqual(
      [confirmedAdmin.id, webhookObserved.id, disabled.id].sort(),
    );

    await expect(
      fixture.service.resolveEntities(user, {
        targets: [
          { id: confirmedAdmin.id, entityType: 'chat' },
          { id: bootstrapOnly.id, entityType: 'chat' },
          { id: missingBinding.id, entityType: 'chat' },
          { id: disabled.id, entityType: 'chat' },
        ],
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ id: confirmedAdmin.id })],
    });
    await expect(fixture.service.getEntity('chat', bootstrapOnly.id, user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(fixture.service.getEntity('chat', disabled.id, user)).resolves.toMatchObject({
      id: disabled.id,
      policy: { publikEnabled: false },
    });
  });

  it('selects only bounded user-authorized refresh candidates with Publik evidence', async () => {
    const refreshRow = (
      id: string,
      overrides: Partial<{
        publisherBotId: string;
        status: ChatBotMembershipStatus;
        botAccessState: ChatBotAccessState;
        botAccessSource: string | null;
        permissionsSnapshot: unknown;
        lastSeenAt: Date | null;
        lastWebhookAt: Date | null;
        accessBotId: string;
        accessEntityType: ChatEntityType;
      }> = {},
    ) => ({
      chatId: id,
      publisherBotId: overrides.publisherBotId ?? 'publik-bot',
      status: overrides.status ?? ChatBotMembershipStatus.ACTIVE,
      botAccessState: overrides.botAccessState ?? ChatBotAccessState.CONFIRMED_ADMIN,
      botAccessSource: overrides.botAccessSource ?? null,
      permissionsSnapshot: overrides.permissionsSnapshot ?? null,
      lastSeenAt: overrides.lastSeenAt ?? null,
      lastWebhookAt: overrides.lastWebhookAt ?? null,
      chat: {
        entityType: ChatEntityType.CHAT,
        accessEdges: [
          {
            botId: overrides.accessBotId ?? 'publik-bot',
            entityType: overrides.accessEntityType ?? ChatEntityType.CHAT,
          },
        ],
      },
    });
    const readyIds = Array.from({ length: 50 }, (_, index) => `confirmed-${index}`);
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([
        refreshRow('lost-last-seen-only', {
          botAccessState: ChatBotAccessState.LOST,
          lastSeenAt: new Date('2026-08-26T10:00:00.000Z'),
        }),
        refreshRow('stale-evidenced', {
          botAccessState: ChatBotAccessState.STALE,
          lastWebhookAt: new Date('2026-08-26T10:00:00.000Z'),
        }),
        refreshRow('pending-explicit-activation', {
          botAccessState: ChatBotAccessState.UNKNOWN,
          botAccessSource: PUBLISHER_EXPLICIT_ACTIVATION_PENDING_SOURCE,
          lastWebhookAt: new Date(),
        }),
        refreshRow('known-write-denied', {
          permissionsSnapshot: {
            isAdmin: true,
            isOwner: false,
            permissionsKnown: true,
            permissions: [],
          },
        }),
        refreshRow('unknown-no-evidence', { botAccessState: ChatBotAccessState.UNKNOWN }),
        refreshRow('lost-no-evidence', { botAccessState: ChatBotAccessState.LOST }),
        refreshRow('wrong-publisher', { publisherBotId: 'other-bot' }),
        refreshRow('removed', { status: ChatBotMembershipStatus.REMOVED }),
        refreshRow('wrong-access-bot', { accessBotId: 'main-bot' }),
        refreshRow('edge-type-mismatch', { accessEntityType: ChatEntityType.CHANNEL }),
        refreshRow('missing-catalog'),
        refreshRow('wrong-catalog-type'),
      ])
      .mockResolvedValueOnce(readyIds.map((id) => refreshRow(id)));
    const catalogFindMany = jest
      .fn()
      .mockImplementation(({ where }: { where: { chatId: { in: string[] } } }) =>
        Promise.resolve(
          where.chatId.in.flatMap((chatId) =>
            chatId === 'missing-catalog'
              ? []
              : [
                  {
                    chatId,
                    entityType:
                      chatId === 'wrong-catalog-type'
                        ? ChatEntityType.CHANNEL
                        : ChatEntityType.CHAT,
                  },
                ],
          ),
        ),
      );
    const service = new PublisherPolicyService(
      {
        publisherEntityBinding: { findMany },
        managedBotChatCatalog: { findMany: catalogFindMany },
      } as never,
      createBotRegistry() as never,
      createReadiness() as never,
      {} as never,
      createBindingRefreshQueue() as never,
    );

    await expect(service.listRefreshableEntityIds(user, 500, ['already-queued'])).resolves.toEqual([
      'stale-evidenced',
      ...readyIds.slice(0, 49),
    ]);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(catalogFindMany).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        take: 200,
        orderBy: [
          { botAccessCheckedAt: { sort: 'asc', nulls: 'first' } },
          { updatedAt: 'asc' },
          { chatId: 'asc' },
        ],
        where: expect.objectContaining({
          publisherBotId: 'publik-bot',
          status: ChatBotMembershipStatus.ACTIVE,
          chatId: { notIn: ['already-queued'] },
          OR: expect.arrayContaining([
            {
              botAccessState: {
                in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER],
              },
            },
            { lastWebhookAt: { not: null } },
          ]),
          AND: expect.arrayContaining([
            {
              OR: expect.arrayContaining([
                {
                  botAccessState: {
                    in: ['UNKNOWN', 'CONFIRMED_MEMBER', 'DENIED', 'LOST', 'STALE'],
                  },
                },
                { sendRouteQuarantinedUntil: { gt: expect.any(Date) } },
              ]),
            },
          ]),
          chat: expect.objectContaining({
            AND: expect.arrayContaining([
              {
                accessEdges: {
                  some: expect.objectContaining({
                    userId: user.userId,
                    botId: 'publik-bot',
                    OR: expect.arrayContaining([
                      {
                        state: ManagedEntityAccessState.GRANTED,
                        userRole: {
                          in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN],
                        },
                      },
                      {
                        state: {
                          in: [
                            ManagedEntityAccessState.USER_DENIED,
                            ManagedEntityAccessState.BOT_DENIED,
                          ],
                        },
                        checkedAt: { gt: expect.any(Date) },
                      },
                    ]),
                  }),
                },
              },
            ]),
          }),
        }),
      }),
    );
    expect(findMany.mock.calls[0]?.[0].where.OR).not.toContainEqual({
      lastSeenAt: { not: null },
    });
    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        take: 200,
        where: expect.objectContaining({
          chatId: { notIn: ['already-queued', 'stale-evidenced'] },
          botAccessState: {
            in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER],
          },
        }),
      }),
    );
  });

  it('keeps expired grants and recent terminal denials eligible for manual recovery', async () => {
    const refreshRow = (id: string, entityType: ChatEntityType) => ({
      chatId: id,
      publisherBotId: 'publik-bot',
      status: ChatBotMembershipStatus.ACTIVE,
      botAccessState: ChatBotAccessState.STALE,
      lastSeenAt: null,
      lastWebhookAt: new Date('2026-08-30T10:00:00.000Z'),
      chat: {
        accessEdges: [{ botId: 'publik-bot', entityType }],
      },
    });
    const rows = [
      refreshRow('expired-granted-chat', ChatEntityType.CHAT),
      refreshRow('terminal-user-denied-channel', ChatEntityType.CHANNEL),
      refreshRow('terminal-bot-denied-chat', ChatEntityType.CHAT),
    ];
    const findMany = jest.fn().mockResolvedValueOnce(rows);
    const catalogFindMany = jest.fn().mockResolvedValue(
      rows.map((row) => ({
        chatId: row.chatId,
        entityType: row.chat.accessEdges[0]!.entityType,
      })),
    );
    const service = new PublisherPolicyService(
      {
        publisherEntityBinding: { findMany },
        managedBotChatCatalog: { findMany: catalogFindMany },
      } as never,
      createBotRegistry() as never,
      createReadiness() as never,
      {} as never,
      createBindingRefreshQueue() as never,
    );

    await expect(service.listRefreshableEntityIds(user, 3)).resolves.toEqual(
      rows.map((row) => row.chatId),
    );

    const accessFilter = findMany.mock.calls[0]?.[0].where.chat.AND[0].accessEdges.some;
    expect(JSON.stringify(findMany.mock.calls[0]?.[0].where)).not.toContain('publikEnabled');
    expect(accessFilter).toEqual(
      expect.objectContaining({
        userId: user.userId,
        botId: 'publik-bot',
        OR: [
          {
            state: ManagedEntityAccessState.GRANTED,
            userRole: {
              in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN],
            },
          },
          {
            state: {
              in: [ManagedEntityAccessState.USER_DENIED, ManagedEntityAccessState.BOT_DENIED],
            },
            checkedAt: { gt: expect.any(Date) },
          },
        ],
      }),
    );
    expect(accessFilter).not.toHaveProperty('checkedAt');
    expect(accessFilter.OR[0]).not.toHaveProperty('expiresAt');
    expect(accessFilter.OR[0]).not.toHaveProperty('OR');
  });

  it('keyset-scans beyond 200 invalid catalog rows for valid chats and channels', async () => {
    const refreshRow = (id: string, entityType: ChatEntityType) => ({
      chatId: id,
      publisherBotId: 'publik-bot',
      status: ChatBotMembershipStatus.ACTIVE,
      botAccessState: ChatBotAccessState.STALE,
      lastSeenAt: null,
      lastWebhookAt: new Date('2026-08-30T10:00:00.000Z'),
      chat: {
        accessEdges: [{ botId: 'publik-bot', entityType }],
      },
    });
    const firstPage = [
      ...Array.from({ length: 100 }, (_, index) =>
        refreshRow(`missing-${String(index).padStart(3, '0')}`, ChatEntityType.CHAT),
      ),
      ...Array.from({ length: 100 }, (_, index) =>
        refreshRow(`mismatch-${String(index).padStart(3, '0')}`, ChatEntityType.CHAT),
      ),
    ];
    const secondPage = [
      refreshRow('mismatch-200', ChatEntityType.CHAT),
      refreshRow('valid-chat', ChatEntityType.CHAT),
      refreshRow('valid-channel', ChatEntityType.CHANNEL),
    ];
    const findMany = jest.fn().mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);
    const catalogFindMany = jest.fn(({ where }: { where: { chatId: { in: string[] } } }) =>
      Promise.resolve(
        where.chatId.in.flatMap((chatId) => {
          if (chatId.startsWith('missing-')) {
            return [];
          }
          if (chatId.startsWith('mismatch-')) {
            return [{ chatId, entityType: ChatEntityType.CHANNEL }];
          }
          return [
            {
              chatId,
              entityType: chatId === 'valid-channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT,
            },
          ];
        }),
      ),
    );
    const service = new PublisherPolicyService(
      {
        publisherEntityBinding: { findMany },
        managedBotChatCatalog: { findMany: catalogFindMany },
      } as never,
      createBotRegistry() as never,
      createReadiness() as never,
      {} as never,
      createBindingRefreshQueue() as never,
    );

    await expect(service.listRefreshableEntityIds(user, 2)).resolves.toEqual([
      'valid-chat',
      'valid-channel',
    ]);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cursor: { chatId: firstPage.at(-1)?.chatId },
        skip: 1,
        take: 200,
      }),
    );
    expect(catalogFindMany).toHaveBeenCalledTimes(2);
  });

  it('uses only exact scoped catalog rows and builds settings handoffs through the entry bot', async () => {
    const safeEntityId = 'chat/id ?';
    const mainOnlyEntityId = 'main-only';
    const invalidLinkCases = [
      ['credentials', 'https://user:secret@max.ru/team'],
      ['foreign-host', 'https://example.com/team'],
      ['http', 'http://max.ru/team'],
      ['port', 'https://max.ru:8443/team'],
      ['hash', 'https://max.ru/team#members'],
      ['root', 'https://max.ru/'],
    ] as const;
    const entities = [
      createListEntity(safeEntityId, 'Безопасный чат', ChatEntityType.CHAT),
      createListEntity(mainOnlyEntityId, 'Без metadata Публика', ChatEntityType.CHAT),
      ...invalidLinkCases.map(([id]) => createListEntity(id, id, ChatEntityType.CHAT)),
    ];
    const findMany = jest.fn().mockResolvedValue(
      entities.map((chat) => ({
        chatId: chat.id,
        botId: 'publik-bot',
        entityType: chat.entityType,
        chat,
      })),
    );
    const catalogFindMany = jest.fn().mockResolvedValue([
      {
        botId: 'publik-bot',
        chatId: safeEntityId,
        entityType: ChatEntityType.CHAT,
        title: 'Каталог Публика',
        link: 'https://www.max.ru/team?from=catalog',
        avatarUrl: 'https://cdn.example.com/avatar.png?size=small',
      },
      ...invalidLinkCases.map(([chatId, link]) => ({
        botId: 'publik-bot',
        chatId,
        entityType: ChatEntityType.CHAT,
        title: `Публик ${chatId}`,
        link,
        avatarUrl:
          chatId === 'credentials' ? 'https://user:secret@cdn.example.com/avatar.png' : null,
      })),
      {
        botId: 'main-bot',
        chatId: mainOnlyEntityId,
        entityType: ChatEntityType.CHAT,
        title: 'Только Майор',
        link: 'https://max.ru/unrelated-route',
        avatarUrl: 'https://cdn.example.com/unrelated.png',
      },
    ]);
    const service = new PublisherPolicyService(
      {
        managedEntityAccessEdge: { findMany },
        managedBotChatCatalog: { findMany: catalogFindMany },
      } as never,
      createBotRegistry() as never,
      createReadiness() as never,
      {} as never,
      createBindingRefreshQueue() as never,
    );

    const response = await service.listEntities(user);
    const entitiesById = new Map(response.items.map((entity) => [entity.id, entity]));
    const safeEntity = entitiesById.get(safeEntityId);

    expect(safeEntity).toMatchObject({
      title: 'Каталог Публика',
      avatarUrl: 'https://cdn.example.com/avatar.png?size=small',
      entityUrl: 'https://max.ru/team?from=catalog',
    });
    expect(safeEntity).not.toHaveProperty('settingsHandoffUrl');
    expect(safeEntity).not.toHaveProperty('channelOverview');
    for (const [id] of invalidLinkCases) {
      expect(entitiesById.get(id)?.entityUrl).toBeNull();
    }
    expect(entitiesById.has(mainOnlyEntityId)).toBe(false);
    expect(entitiesById.get('credentials')?.avatarUrl).toBeNull();
    expect(catalogFindMany).toHaveBeenCalledWith({
      where: {
        status: 'ACTIVE',
        OR: entities.map((entity) => ({
          botId: 'publik-bot',
          chatId: entity.id,
          entityType: ChatEntityType.CHAT,
        })),
      },
      select: {
        botId: true,
        chatId: true,
        entityType: true,
        title: true,
        link: true,
        avatarUrl: true,
      },
    });
  });

  it('loads catalog presentation in bounded batches without per-entity queries', async () => {
    const entities = Array.from({ length: 201 }, (_, index) =>
      createListEntity(`chat-${index}`, `Чат ${index}`, ChatEntityType.CHAT),
    );
    const fixture = createListFixture(entities);

    await expect(fixture.service.listEntities(user)).resolves.toMatchObject({
      items: expect.any(Array),
    });

    expect(fixture.catalogFindMany).toHaveBeenCalledTimes(2);
    expect(fixture.catalogFindMany.mock.calls.map(([request]) => request.where.OR.length)).toEqual([
      200, 1,
    ]);
  });

  it('uses the entity id instead of the Major title when the Publisher catalog title is empty', async () => {
    const entity = createListEntity('publisher-chat-id', 'Название из Майора', ChatEntityType.CHAT);
    const fixture = createListFixture([entity]);
    fixture.catalogFindMany.mockResolvedValueOnce([
      {
        botId: 'publik-bot',
        chatId: entity.id,
        entityType: ChatEntityType.CHAT,
        title: '   ',
        link: null,
        avatarUrl: null,
      },
    ]);

    await expect(fixture.service.listEntities(user)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: entity.id, title: entity.id })],
    });
  });

  it('exposes Publik chat modules without importing Major channel overview data', async () => {
    const channel = {
      id: 'channel-1',
      title: 'Канал',
      entityType: ChatEntityType.CHANNEL,
      publisherSettings: null,
      channelSettings: {
        postSignatureEnabled: true,
        postSignaturePresentation: ChannelPostSignaturePresentation.BUTTON,
        postSignatureText: '📞 Заказать рекламу',
        postSignatureUrl: 'https://example.test/ads',
      },
      publicationPolicy: null,
      publisherBinding: createConnectedPublisherBinding(),
      botMemberships: [{ botId: 'main-bot' }],
    };
    const chat = {
      id: 'chat-1',
      title: 'Чат',
      entityType: ChatEntityType.CHAT,
      publisherSettings: {
        revision: 3,
        chatCommentsEnabled: true,
        chatCommentsAdminsEnabled: false,
        chatCommentsPostsEnabled: true,
        channelSuggestionsEnabled: false,
        autoRepliesEnabled: true,
      },
      publicationPolicy: null,
      publisherBinding: createConnectedPublisherBinding(),
      botMemberships: [{ botId: 'main-bot' }],
    };
    const prisma = {
      managedEntityAccessEdge: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: channel.id,
            botId: 'publik-bot',
            entityType: ChatEntityType.CHANNEL,
            chat: channel,
          },
          { chatId: chat.id, botId: 'publik-bot', entityType: ChatEntityType.CHAT, chat },
        ]),
      },
      managedBotChatCatalog: {
        findMany: jest.fn().mockResolvedValue([
          {
            botId: 'publik-bot',
            chatId: channel.id,
            entityType: ChatEntityType.CHANNEL,
            title: channel.title,
            link: null,
            avatarUrl: null,
          },
          {
            botId: 'publik-bot',
            chatId: chat.id,
            entityType: ChatEntityType.CHAT,
            title: chat.title,
            link: null,
            avatarUrl: null,
          },
        ]),
      },
    };
    const service = new PublisherPolicyService(
      prisma as never,
      createBotRegistry() as never,
      createReadiness() as never,
      {} as never,
      createBindingRefreshQueue() as never,
    );

    const response = await service.listEntities(user);

    expect(response.items).toHaveLength(2);
    expect(response.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: chat.id,
          entityType: 'chat',
          moduleSettings: {
            revision: 3,
            chatComments: {
              commentsEnabled: true,
              commentsAdminsEnabled: false,
              commentsChatBroadcastsEnabled: true,
              commentsReplaceOriginalEnabled: false,
            },
            autoRepliesEnabled: true,
            channelCommentsEnabled: null,
            channelSuggestionsEnabled: null,
            channelSuggestionsRequireSubscription: null,
            channelSuggestionsDeleteOnUnsubscribe: null,
          },
        }),
        expect.objectContaining({
          id: channel.id,
          entityType: 'channel',
          channelPostSignature: {
            enabled: true,
            customButtonsEnabled: false,
            customButtons: [],
            presentation: 'button',
            text: '📞 Заказать рекламу',
            url: 'https://example.test/ads',
          },
          moduleSettings: {
            revision: 0,
            chatComments: null,
            autoRepliesEnabled: null,
            channelCommentsEnabled: false,
            channelSuggestionsEnabled: false,
            channelSuggestionsRequireSubscription: false,
            channelSuggestionsDeleteOnUnsubscribe: false,
          },
        }),
      ]),
    );
  });

  it('hydrates only SQL page ids and preserves keyset order after current access filtering', async () => {
    const fixture = createListFixture([
      createListEntity('chat-1', 'Первый', ChatEntityType.CHAT),
      createListEntity('chat-2', 'Второй', ChatEntityType.CHAT),
      createListEntity('chat-3', 'Третий', ChatEntityType.CHAT),
    ]);
    const page = jest.fn().mockResolvedValue({
      ids: ['chat-3', 'revoked', 'chat-1'],
      nextCursor: null,
      filteredTotal: 3,
      summary: { total: 3, chat: 3, channel: 0, ready: 0, attention: 3 },
    });
    Object.assign(fixture.service, { catalogQuery: { page } });
    const response = await fixture.service.listEntities(user, { pagination: 'cursor', limit: 3 });
    expect(response.items.map((entity) => entity.id)).toEqual(['chat-3', 'chat-1']);
    expect(fixture.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ chatId: { in: ['chat-3', 'revoked', 'chat-1'] } }),
      }),
    );
  });

  it('hydrates only requested user-scoped entities in request order', async () => {
    const fixture = createListFixture([
      createListEntity('chat-1', 'Чат', ChatEntityType.CHAT),
      createListEntity('channel-1', 'Канал', ChatEntityType.CHANNEL),
    ]);

    await expect(
      fixture.service.resolveEntities(user, {
        targets: [
          { id: 'channel-1', entityType: 'channel' },
          { id: 'chat-1', entityType: 'chat' },
          { id: 'chat-1', entityType: 'channel' },
        ],
      }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({ id: 'channel-1', entityType: 'channel' }),
        expect.objectContaining({ id: 'chat-1', entityType: 'chat' }),
      ],
    });
    expect(fixture.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ chatId: { in: ['channel-1', 'chat-1'] } }),
      }),
    );
  });

  it('resolves publication targets only from the exact Publisher-owned user scope', async () => {
    const fixture = createListFixture([
      createListEntity('chat-1', 'Чат', ChatEntityType.CHAT),
      createListEntity('channel-1', 'Канал', ChatEntityType.CHANNEL),
    ]);

    await expect(
      fixture.service.resolvePublicationTargets(user, [
        { chatId: 'channel-1', entityType: 'channel' },
        { chatId: 'chat-1', entityType: 'chat' },
      ]),
    ).resolves.toEqual([
      {
        chatId: 'channel-1',
        entityType: 'channel',
        title: 'Канал',
        avatarUrl: null,
        link: null,
      },
      {
        chatId: 'chat-1',
        entityType: 'chat',
        title: 'Чат',
        avatarUrl: null,
        link: null,
      },
    ]);
    expect(fixture.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: { in: ['channel-1', 'chat-1'] },
          userId: user.userId,
          botId: 'publik-bot',
        }),
      }),
    );
  });

  it('fails publication target resolution when any selected entity is outside Publisher scope', async () => {
    const fixture = createListFixture([createListEntity('chat-1', 'Чат', ChatEntityType.CHAT)]);

    await expect(
      fixture.service.resolvePublicationTargets(user, [
        { chatId: 'chat-1', entityType: 'chat' },
        { chatId: 'channel-foreign', entityType: 'channel' },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not hydrate a batch target outside the requesting user scope', async () => {
    const foreignChat = createListEntity('chat-foreign', 'Чужой чат', ChatEntityType.CHAT);
    const findMany = jest
      .fn()
      .mockImplementation(({ where }: { where: { userId: string; chatId?: { in?: string[] } } }) =>
        Promise.resolve(
          where.userId === 'user-2' && where.chatId?.in?.includes(foreignChat.id)
            ? [
                {
                  chatId: foreignChat.id,
                  botId: 'publik-bot',
                  entityType: foreignChat.entityType,
                  chat: foreignChat,
                },
              ]
            : [],
        ),
      );
    const service = new PublisherPolicyService(
      {
        managedEntityAccessEdge: { findMany },
        managedBotChatCatalog: {
          findMany: jest.fn().mockResolvedValue([
            {
              botId: 'publik-bot',
              chatId: foreignChat.id,
              entityType: ChatEntityType.CHAT,
              title: 'Publisher-scoped chat',
              link: null,
              avatarUrl: null,
            },
          ]),
        },
      } as never,
      createBotRegistry() as never,
      createReadiness() as never,
      {} as never,
      createBindingRefreshQueue() as never,
    );
    const body = { targets: [{ id: foreignChat.id, entityType: 'chat' }] };

    await expect(service.resolveEntities(user, body)).resolves.toEqual({ items: [] });
    await expect(
      service.resolveEntities({ ...user, userId: 'user-2' }, body),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ id: foreignChat.id, entityType: 'chat' })],
    });
    expect(findMany.mock.calls.map(([request]) => request.where.userId)).toEqual([
      user.userId,
      'user-2',
    ]);
  });

  it('rejects invalid entity hydration before loading access edges', async () => {
    const fixture = createListFixture([]);

    await expect(fixture.service.resolveEntities(user, { targets: [] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fixture.findMany).not.toHaveBeenCalled();
  });

  it('validates explicit cursor mode but ignores pagination fields for legacy callers', async () => {
    const fixture = createListFixture([
      createListEntity('chat-1', 'Один', ChatEntityType.CHAT),
      createListEntity('chat-2', 'Два', ChatEntityType.CHAT),
    ]);

    await expect(
      fixture.service.listEntities(user, { limit: 1, query: 'нет совпадений' }),
    ).resolves.toMatchObject({
      items: expect.arrayContaining([expect.any(Object), expect.any(Object)]),
    });
    fixture.findMany.mockClear();
    fixture.readiness.isRuntimeAvailable.mockClear();

    await expect(
      fixture.service.listEntities(user, { pagination: 'cursor', limit: 101 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      fixture.service.listEntities(user, { pagination: 'offset' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      fixture.service.listEntities(user, {
        pagination: 'cursor',
        query: 'x'.repeat(121),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(fixture.findMany).not.toHaveBeenCalled();
    expect(fixture.readiness.isRuntimeAvailable).not.toHaveBeenCalled();
  });

  it('does not return an entity from another user-scoped access list', async () => {
    const foreignChat = {
      id: 'chat-foreign',
      title: 'Чужой чат',
      entityType: ChatEntityType.CHAT,
      publisherSettings: null,
      publicationPolicy: null,
      publisherBinding: createConnectedPublisherBinding(),
      botMemberships: [{ botId: 'main-bot' }],
    };
    const findMany = jest.fn().mockImplementation(({ where }: { where: { userId: string } }) =>
      Promise.resolve(
        where.userId === 'user-2'
          ? [
              {
                chatId: foreignChat.id,
                botId: 'publik-bot',
                entityType: ChatEntityType.CHAT,
                chat: foreignChat,
              },
            ]
          : [],
      ),
    );
    const catalogFindFirst = jest.fn().mockResolvedValue({
      entityType: ChatEntityType.CHAT,
      title: 'Чат Публика',
      link: 'https://max.ru/scoped-chat',
      avatarUrl: null,
    });
    const service = new PublisherPolicyService(
      {
        managedEntityAccessEdge: { findMany },
        managedBotChatCatalog: { findFirst: catalogFindFirst },
      } as never,
      createBotRegistry() as never,
      createReadiness() as never,
      {} as never,
      createBindingRefreshQueue() as never,
    );

    await expect(
      service.getEntity('chat', foreignChat.id, {
        userId: 'user-1',
        username: null,
        displayName: null,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.getEntity('chat', foreignChat.id, {
        userId: 'user-2',
        username: null,
        displayName: null,
      }),
    ).resolves.toMatchObject({
      id: foreignChat.id,
      title: 'Чат Публика',
      entityUrl: 'https://max.ru/scoped-chat',
    });
    await expect(
      service.getEntity('channel', foreignChat.id, {
        userId: 'user-2',
        username: null,
        displayName: null,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findMany.mock.calls.map(([request]) => request.where.userId)).toEqual([
      'user-1',
      'user-2',
      'user-2',
    ]);
    expect(findMany.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: foreignChat.id,
          entityType: ChatEntityType.CHAT,
        }),
      }),
    );
    expect(catalogFindFirst).toHaveBeenCalledTimes(1);
    expect(catalogFindFirst).toHaveBeenCalledWith({
      where: {
        botId: 'publik-bot',
        chatId: foreignChat.id,
        entityType: ChatEntityType.CHAT,
        status: 'ACTIVE',
      },
      select: {
        entityType: true,
        title: true,
        link: true,
        avatarUrl: true,
      },
    });
  });

  it('rejects a Publisher entity without its exact active catalog row', async () => {
    const entity = createListEntity('publisher-chat', 'Название из Майора', ChatEntityType.CHAT);
    const fixture = createListFixture([entity]);
    fixture.catalogFindFirst.mockResolvedValueOnce(null);

    await expect(fixture.service.getEntity('chat', entity.id, user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fixture.readiness.isRuntimeAvailable).not.toHaveBeenCalled();
    expect(fixture.catalogFindFirst).toHaveBeenCalledWith({
      where: {
        botId: 'publik-bot',
        chatId: entity.id,
        entityType: ChatEntityType.CHAT,
        status: 'ACTIVE',
      },
      select: {
        entityType: true,
        title: true,
        link: true,
        avatarUrl: true,
      },
    });
  });

  it('rejects a policy mutation without exact Publisher access even if Major access exists', async () => {
    const assertManagedEntityAdminAccess = jest.fn().mockResolvedValue(undefined);
    const findMany = jest.fn().mockResolvedValue([]);
    const findUnique = jest.fn();
    const transaction = jest.fn();
    const service = new PublisherPolicyService(
      {
        chat: { findUnique },
        managedEntityAccessEdge: { findMany },
        $transaction: transaction,
      } as never,
      createBotRegistry() as never,
      createReadiness() as never,
      { assertManagedEntityAdminAccess } as never,
      createBindingRefreshQueue() as never,
    );
    await expect(
      service.updatePolicy('chat', 'chat-foreign', user, {
        expectedRevision: 0,
        publikEnabled: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(assertManagedEntityAdminAccess).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-foreign',
          botId: 'publik-bot',
          userId: user.userId,
        }),
      }),
    );
    expect(findUnique).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('lets Publisher-owned admins change channel secondary modules without Major access', async () => {
    const fixture = createPolicyMutationFixture();
    const getEntity = jest
      .spyOn(fixture.service, 'getEntity')
      .mockResolvedValue({ id: 'channel-1' } as never);

    await expect(
      fixture.service.updateModuleSettings('channel', 'channel-1', user, {
        expectedRevision: 0,
        channelCommentsEnabled: true,
        channelSuggestionsEnabled: true,
      }),
    ).resolves.toEqual({
      revision: 1,
      chatComments: null,
      autoRepliesEnabled: null,
      channelCommentsEnabled: true,
      channelSuggestionsEnabled: true,
      channelSuggestionsRequireSubscription: false,
      channelSuggestionsDeleteOnUnsubscribe: false,
    });

    expect(getEntity).toHaveBeenCalledWith('channel', 'channel-1', user);
    expect(fixture.managedEntities.assertManagedEntityAdminAccess).not.toHaveBeenCalled();
    expect(fixture.tx.managedEntityPublicationPolicy.create).not.toHaveBeenCalled();
    expect(fixture.tx.publisherEntitySettings.create).toHaveBeenCalledWith({
      data: {
        chatId: 'channel-1',
        channelCommentsEnabled: true,
        channelSuggestionsEnabled: true,
        updatedByUserId: user.userId,
      },
    });
    expect(fixture.tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        chatId: 'channel-1',
        actorUserId: user.userId,
        action: 'UPDATE_PUBLISHER_MODULE_SETTINGS',
        payload: {
          changed: { channelCommentsEnabled: true, channelSuggestionsEnabled: true },
          revision: 1,
        },
      },
    });
    expect(fixture.readiness.resolvePolicy).not.toHaveBeenCalled();
  });

  it('updates all Publik-owned chat comment settings in their own transaction', async () => {
    const fixture = createPolicyMutationFixture({
      storedEntityType: ChatEntityType.CHAT,
      publisherSettings: { revision: 4 },
    });
    const getEntity = jest
      .spyOn(fixture.service, 'getEntity')
      .mockResolvedValue({ id: 'chat-1' } as never);
    const chatComments = {
      commentsEnabled: true,
      commentsAdminsEnabled: false,
      commentsChatBroadcastsEnabled: true,
    };

    await expect(
      fixture.service.updateModuleSettings('chat', 'chat-1', user, {
        expectedRevision: 4,
        chatComments,
      }),
    ).resolves.toEqual({
      revision: 5,
      chatComments: { ...chatComments, commentsReplaceOriginalEnabled: false },
      autoRepliesEnabled: false,
      channelCommentsEnabled: null,
      channelSuggestionsEnabled: null,
      channelSuggestionsRequireSubscription: null,
      channelSuggestionsDeleteOnUnsubscribe: null,
    });

    expect(getEntity).toHaveBeenCalledWith('chat', 'chat-1', user);
    expect(fixture.managedEntities.assertManagedEntityAdminAccess).not.toHaveBeenCalled();
    expect(fixture.tx.managedEntityPublicationPolicy.updateMany).not.toHaveBeenCalled();
    expect(fixture.tx.publisherEntitySettings.updateMany).toHaveBeenCalledWith({
      where: { chatId: 'chat-1', revision: 4 },
      data: {
        chatCommentsEnabled: true,
        chatCommentsAdminsEnabled: false,
        chatCommentsPostsEnabled: true,
        revision: { increment: 1 },
        updatedByUserId: user.userId,
      },
    });
    expect(fixture.tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        chatId: 'chat-1',
        actorUserId: user.userId,
        action: 'UPDATE_PUBLISHER_MODULE_SETTINGS',
        payload: {
          changed: { chatComments },
          revision: 5,
        },
      },
    });
  });

  it('updates the chat auto-reply module switch with the same optimistic revision', async () => {
    const fixture = createPolicyMutationFixture({
      storedEntityType: ChatEntityType.CHAT,
      publisherSettings: { revision: 2, autoRepliesEnabled: false },
    });
    fixture.tx.publisherEntitySettings.findUniqueOrThrow.mockResolvedValue({
      revision: 3,
      chatCommentsEnabled: true,
      chatCommentsAdminsEnabled: false,
      chatCommentsPostsEnabled: true,
      channelCommentsEnabled: false,
      channelSuggestionsEnabled: true,
      autoRepliesEnabled: true,
    });
    jest.spyOn(fixture.service, 'getEntity').mockResolvedValue({ id: 'chat-1' } as never);

    await expect(
      fixture.service.updateModuleSettings('chat', 'chat-1', user, {
        expectedRevision: 2,
        autoRepliesEnabled: true,
      }),
    ).resolves.toEqual({
      revision: 3,
      chatComments: {
        commentsEnabled: true,
        commentsAdminsEnabled: false,
        commentsChatBroadcastsEnabled: true,
        commentsReplaceOriginalEnabled: false,
      },
      autoRepliesEnabled: true,
      channelCommentsEnabled: null,
      channelSuggestionsEnabled: null,
      channelSuggestionsRequireSubscription: null,
      channelSuggestionsDeleteOnUnsubscribe: null,
    });

    expect(fixture.tx.publisherEntitySettings.updateMany).toHaveBeenCalledWith({
      where: { chatId: 'chat-1', revision: 2 },
      data: {
        autoRepliesEnabled: true,
        revision: { increment: 1 },
        updatedByUserId: user.userId,
      },
    });
    expect(fixture.tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        chatId: 'chat-1',
        actorUserId: user.userId,
        action: 'UPDATE_PUBLISHER_MODULE_SETTINGS',
        payload: { changed: { autoRepliesEnabled: true }, revision: 3 },
      },
    });
  });

  it('persists the explicit replacement mode and preserves it for older clients', async () => {
    const fixture = createPolicyMutationFixture({
      storedEntityType: ChatEntityType.CHAT,
      publisherSettings: { revision: 4, chatCommentsReplaceOriginalEnabled: true },
    });
    jest.spyOn(fixture.service, 'getEntity').mockResolvedValue({ id: 'chat-1' } as never);
    const chatComments = {
      commentsEnabled: true,
      commentsAdminsEnabled: false,
      commentsChatBroadcastsEnabled: true,
      commentsReplaceOriginalEnabled: true,
    };
    const saved = await fixture.service.updateModuleSettings('chat', 'chat-1', user, {
      expectedRevision: 4,
      chatComments,
    });
    expect(saved.chatComments?.commentsReplaceOriginalEnabled).toBe(true);
    expect(fixture.tx.publisherEntitySettings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ chatCommentsReplaceOriginalEnabled: true }),
      }),
    );
    const legacy = {
      commentsEnabled: true,
      commentsAdminsEnabled: false,
      commentsChatBroadcastsEnabled: true,
    };
    await fixture.service.updateModuleSettings('chat', 'chat-1', user, {
      expectedRevision: 4,
      chatComments: legacy,
    });
    expect(fixture.tx.publisherEntitySettings.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ chatCommentsReplaceOriginalEnabled: undefined }),
      }),
    );
  });

  it('keeps the Major toggle and Publisher secondary-module writes disjoint', async () => {
    const fixture = createPolicyMutationFixture();
    const getEntity = jest.spyOn(fixture.service, 'getEntity');

    await expect(
      fixture.service.updatePolicy('channel', 'channel-1', user, {
        expectedRevision: 0,
        publikEnabled: true,
        channelSuggestionsEnabled: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      fixture.service.updatePolicy('chat', 'chat-1', user, {
        expectedRevision: 0,
        publikEnabled: true,
        chatComments: {
          commentsEnabled: true,
          commentsAdminsEnabled: true,
          commentsChatBroadcastsEnabled: true,
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      fixture.service.updateModuleSettings('channel', 'channel-1', user, {
        expectedRevision: 0,
        publikEnabled: false,
        channelSuggestionsEnabled: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(fixture.managedEntities.assertManagedEntityAdminAccess).not.toHaveBeenCalled();
    expect(getEntity).not.toHaveBeenCalled();
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it('rejects chat comment module writes for channels before access checks', async () => {
    const fixture = createPolicyMutationFixture();

    await expect(
      fixture.service.updateModuleSettings('channel', 'channel-1', user, {
        expectedRevision: 0,
        chatComments: {
          commentsEnabled: true,
          commentsAdminsEnabled: false,
          commentsChatBroadcastsEnabled: false,
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(fixture.prisma.chat.findUnique).not.toHaveBeenCalled();
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it('rejects auto-reply module writes for channels before access checks', async () => {
    const fixture = createPolicyMutationFixture();

    await expect(
      fixture.service.updateModuleSettings('channel', 'channel-1', user, {
        expectedRevision: 0,
        autoRepliesEnabled: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(fixture.prisma.chat.findUnique).not.toHaveBeenCalled();
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it('uses exact Publisher access for the Publik toggle without Major ownership', async () => {
    const fixture = createPolicyMutationFixture({ publicationPolicy: { revision: 1 } });

    await fixture.service.updatePolicy('channel', 'channel-1', user, {
      expectedRevision: 1,
      publikEnabled: false,
    });

    expect(fixture.managedEntities.assertManagedEntityAdminAccess).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: user.userId,
          botId: 'publik-bot',
          state: ManagedEntityAccessState.GRANTED,
        }),
      }),
    );
  });

  it('rejects a disabled-to-enabled Publik policy transition when write is missing', async () => {
    const fixture = createPolicyMutationFixture({
      publicationPolicy: { revision: 2, publikEnabled: false },
    });
    fixture.readiness.resolveReadiness.mockReturnValue({
      state: 'setup_required',
      canPublish: false,
      canUseChatComments: false,
      canUseChannelComments: false,
      canPublishSuggestions: false,
      blockerCode: 'write_permission_missing',
      checkedAt: '2026-08-30T10:00:00.000Z',
      retryAt: null,
    });

    const error = (await fixture.service
      .updatePolicy('channel', 'channel-1', user, {
        expectedRevision: 2,
        publikEnabled: true,
      })
      .catch((caught: unknown) => caught)) as { getResponse(): unknown };

    expect(error.getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'Боту не хватает прав для включения выбранной функции.',
      code: 'BOT_CAPABILITY_REQUIRED',
      missingPermissions: ['write'],
      featureKeys: ['publikEnabled'],
      checkedAt: '2026-08-30T10:00:00.000Z',
      blockerCode: 'write_permission_missing',
      stale: false,
      canRecheck: true,
    });
    expect(fixture.readiness.resolveReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'channel-1' }),
      { runtimeAvailable: true, assumePolicyEnabled: true },
    );
    expect(fixture.bindingRefreshQueue.enqueue).toHaveBeenCalledWith({
      chatId: 'channel-1',
      publisherBotId: 'publik-bot',
      reason: 'policy_enablement_recheck',
    });
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it('reports stale Publisher access without claiming that write is missing', async () => {
    const fixture = createPolicyMutationFixture({
      publicationPolicy: { revision: 2, publikEnabled: false },
    });
    fixture.readiness.resolveReadiness.mockReturnValue({
      state: 'setup_required',
      canPublish: false,
      canUseChatComments: false,
      canUseChannelComments: false,
      canPublishSuggestions: false,
      blockerCode: 'bot_access_expired',
      checkedAt: '2026-08-29T10:00:00.000Z',
      retryAt: null,
    });

    const error = (await fixture.service
      .updatePolicy('channel', 'channel-1', user, {
        expectedRevision: 2,
        publikEnabled: true,
      })
      .catch((caught: unknown) => caught)) as { getResponse(): Record<string, unknown> };

    expect(error.getResponse()).toMatchObject({
      code: 'BOT_CAPABILITY_REQUIRED',
      missingPermissions: [],
      blockerCode: 'bot_access_expired',
      stale: true,
      canRecheck: true,
    });
    expect(fixture.bindingRefreshQueue.enqueue).toHaveBeenCalledWith({
      chatId: 'channel-1',
      publisherBotId: 'publik-bot',
      reason: 'policy_enablement_recheck',
    });
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it('refreshes an unconfirmed disabled binding before enabling it on retry', async () => {
    const fixture = createPolicyMutationFixture({
      publicationPolicy: { revision: 2, publikEnabled: false },
    });
    fixture.readiness.resolveReadiness.mockReturnValueOnce({
      state: 'setup_required',
      canPublish: false,
      canUseChatComments: false,
      canUseChannelComments: false,
      canPublishSuggestions: false,
      blockerCode: 'bot_access_unconfirmed',
      checkedAt: null,
      retryAt: null,
    });

    const firstAttempt = fixture.service.updatePolicy('channel', 'channel-1', user, {
      expectedRevision: 2,
      publikEnabled: true,
    });

    await expect(firstAttempt).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'BOT_CAPABILITY_REQUIRED',
        blockerCode: 'bot_access_unconfirmed',
        stale: true,
        canRecheck: true,
      }),
    });
    expect(fixture.bindingRefreshQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(fixture.transaction).not.toHaveBeenCalled();

    fixture.readiness.resolveReadiness.mockReturnValue({
      state: 'ready',
      canPublish: true,
      canUseChatComments: false,
      canUseChannelComments: false,
      canPublishSuggestions: false,
      blockerCode: null,
      checkedAt: '2026-08-30T10:00:01.000Z',
      retryAt: null,
    });

    await expect(
      fixture.service.updatePolicy('channel', 'channel-1', user, {
        expectedRevision: 2,
        publikEnabled: true,
      }),
    ).resolves.toMatchObject({ publikEnabled: true });
    expect(fixture.bindingRefreshQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(fixture.transaction).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the disabled-policy recheck cannot be queued', async () => {
    const fixture = createPolicyMutationFixture({
      publicationPolicy: { revision: 2, publikEnabled: false },
    });
    fixture.readiness.resolveReadiness.mockReturnValue({
      state: 'setup_required',
      canPublish: false,
      canUseChatComments: false,
      canUseChannelComments: false,
      canPublishSuggestions: false,
      blockerCode: 'bot_access_unconfirmed',
      checkedAt: null,
      retryAt: null,
    });
    fixture.bindingRefreshQueue.enqueue.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(
      fixture.service.updatePolicy('channel', 'channel-1', user, {
        expectedRevision: 2,
        publikEnabled: true,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'BOT_CAPABILITY_CHECK_UNAVAILABLE',
        blockerCode: 'publisher_recheck_unavailable',
        canRecheck: false,
      }),
    });
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it('checks only Publisher module switches that transition from false to true', async () => {
    const fixture = createPolicyMutationFixture({
      storedEntityType: ChatEntityType.CHAT,
      publisherSettings: {
        revision: 4,
        chatCommentsEnabled: false,
        chatCommentsAdminsEnabled: false,
        chatCommentsPostsEnabled: true,
        autoRepliesEnabled: false,
      },
    });
    jest.spyOn(fixture.service, 'getEntity').mockResolvedValue({ id: 'chat-1' } as never);
    fixture.readiness.resolveReadiness.mockReturnValue({
      state: 'setup_required',
      canPublish: false,
      canUseChatComments: false,
      canUseChannelComments: false,
      canPublishSuggestions: false,
      blockerCode: 'bot_not_admin',
      checkedAt: '2026-08-30T10:00:00.000Z',
      retryAt: null,
    });

    const error = (await fixture.service
      .updateModuleSettings('chat', 'chat-1', user, {
        expectedRevision: 4,
        chatComments: {
          commentsEnabled: true,
          commentsAdminsEnabled: true,
          commentsChatBroadcastsEnabled: true,
        },
        autoRepliesEnabled: true,
      })
      .catch((caught: unknown) => caught)) as { getResponse(): Record<string, unknown> };

    expect(error.getResponse()).toMatchObject({
      code: 'BOT_CAPABILITY_REQUIRED',
      missingPermissions: ['administrator'],
      featureKeys: [
        'chatComments.commentsEnabled',
        'chatComments.commentsAdminsEnabled',
        'autoRepliesEnabled',
      ],
      blockerCode: 'bot_not_admin',
      stale: false,
    });
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it('allows staging nested chat comment settings while comments remain disabled', async () => {
    const fixture = createPolicyMutationFixture({
      storedEntityType: ChatEntityType.CHAT,
      publisherSettings: {
        revision: 4,
        chatCommentsEnabled: false,
        chatCommentsAdminsEnabled: false,
        chatCommentsPostsEnabled: false,
      },
    });
    jest.spyOn(fixture.service, 'getEntity').mockResolvedValue({ id: 'chat-1' } as never);

    await expect(
      fixture.service.updateModuleSettings('chat', 'chat-1', user, {
        expectedRevision: 4,
        chatComments: {
          commentsEnabled: false,
          commentsAdminsEnabled: true,
          commentsChatBroadcastsEnabled: true,
        },
      }),
    ).resolves.toBeDefined();

    expect(fixture.readiness.isRuntimeAvailable).not.toHaveBeenCalled();
    expect(fixture.readiness.resolveReadiness).not.toHaveBeenCalled();
    expect(fixture.tx.publisherEntitySettings.updateMany).toHaveBeenCalledTimes(1);
  });

  it('maps Publisher heartbeat read failures to the structured capability 503', async () => {
    const fixture = createPolicyMutationFixture({
      publicationPolicy: { revision: 2, publikEnabled: false },
    });
    fixture.readiness.isRuntimeAvailable.mockRejectedValueOnce(new Error('redis unavailable'));

    const error = (await fixture.service
      .updatePolicy('channel', 'channel-1', user, {
        expectedRevision: 2,
        publikEnabled: true,
      })
      .catch((caught: unknown) => caught)) as {
      getStatus(): number;
      getResponse(): Record<string, unknown>;
    };

    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({
      code: 'BOT_CAPABILITY_CHECK_UNAVAILABLE',
      featureKeys: ['publikEnabled'],
      blockerCode: 'publisher_runtime_unavailable',
      stale: true,
      canRecheck: false,
    });
    expect(fixture.readiness.resolveReadiness).not.toHaveBeenCalled();
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it('returns 503 and leaves policy unchanged while Publisher runtime readiness is transient', async () => {
    const fixture = createPolicyMutationFixture({
      publicationPolicy: { revision: 2, publikEnabled: false },
    });
    fixture.readiness.resolveReadiness.mockReturnValue({
      state: 'temporarily_unavailable',
      canPublish: false,
      canUseChatComments: false,
      canUseChannelComments: false,
      canPublishSuggestions: false,
      blockerCode: 'publisher_runtime_unavailable',
      checkedAt: null,
      retryAt: null,
    });

    const error = (await fixture.service
      .updatePolicy('channel', 'channel-1', user, {
        expectedRevision: 2,
        publikEnabled: true,
      })
      .catch((caught: unknown) => caught)) as {
      getStatus(): number;
      getResponse(): Record<string, unknown>;
    };

    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({
      code: 'BOT_CAPABILITY_CHECK_UNAVAILABLE',
      featureKeys: ['publikEnabled'],
      blockerCode: 'publisher_runtime_unavailable',
      stale: true,
      canRecheck: false,
    });
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it('reads the Publik toggle through its exact catalog and access edge without probing readiness', async () => {
    const fixture = createPolicyMutationFixture({
      publicationPolicy: { revision: 1 },
    });

    await expect(
      fixture.service.getPolicyForPublisher('channel', 'channel-1', user),
    ).resolves.toEqual({
      publikEnabled: true,
      revision: 1,
      updatedAt: '2026-08-26T10:00:00.000Z',
    });

    expect(fixture.managedEntities.assertManagedEntityAdminAccess).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: user.userId,
          botId: 'publik-bot',
          state: ManagedEntityAccessState.GRANTED,
        }),
      }),
    );
    expect(fixture.prisma.chat.findUnique).not.toHaveBeenCalled();
    expect(fixture.readiness.isRuntimeAvailable).not.toHaveBeenCalled();
    expect(fixture.readiness.resolveReadiness).not.toHaveBeenCalled();
  });

  it('rejects enabling suggestions for a chat before access checks or database reads', async () => {
    const fixture = createPolicyMutationFixture({ storedEntityType: ChatEntityType.CHAT });

    await expect(
      fixture.service.updateModuleSettings('chat', 'chat-1', user, {
        expectedRevision: 0,
        channelSuggestionsEnabled: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(fixture.managedEntities.assertManagedEntityAdminAccess).not.toHaveBeenCalled();
    expect(fixture.prisma.chat.findUnique).not.toHaveBeenCalled();
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it('rejects a route entity type that does not match the stored entity', async () => {
    const fixture = createPolicyMutationFixture({ storedEntityType: ChatEntityType.CHANNEL });

    await expect(
      fixture.service.updatePolicy('chat', 'channel-1', user, {
        expectedRevision: 0,
        publikEnabled: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(fixture.managedEntities.assertManagedEntityAdminAccess).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: user.userId,
          botId: 'publik-bot',
          state: ManagedEntityAccessState.GRANTED,
        }),
      }),
    );
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it('returns a revision conflict without writing an audit row', async () => {
    const fixture = createPolicyMutationFixture({ publicationPolicy: { revision: 3 } });
    fixture.tx.managedEntityPublicationPolicy.updateMany.mockResolvedValue({ count: 0 });

    const operation = fixture.service.updatePolicy('channel', 'channel-1', user, {
      expectedRevision: 2,
      publikEnabled: false,
    });

    await expect(operation).rejects.toBeInstanceOf(ConflictException);
    await expect(operation).rejects.toMatchObject({
      response: {
        code: 'PUBLISHER_POLICY_REVISION_CONFLICT',
      },
    });
    expect(fixture.tx.managedEntityPublicationPolicy.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(fixture.tx.auditLog.create).not.toHaveBeenCalled();
    expect(fixture.readiness.resolvePolicy).not.toHaveBeenCalled();
  });

  it('keeps the audit append in the policy transaction and does not report an unaudited update', async () => {
    const fixture = createPolicyMutationFixture({ publicationPolicy: { revision: 1 } });
    const auditFailure = new Error('audit insert failed');
    fixture.tx.auditLog.create.mockRejectedValue(auditFailure);

    await expect(
      fixture.service.updatePolicy('channel', 'channel-1', user, {
        expectedRevision: 1,
        publikEnabled: false,
      }),
    ).rejects.toBe(auditFailure);

    expect(fixture.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.tx.managedEntityPublicationPolicy.updateMany).toHaveBeenCalledWith({
      where: { chatId: 'channel-1', revision: 1 },
      data: {
        publikEnabled: false,
        revision: { increment: 1 },
        updatedByUserId: user.userId,
      },
    });
    expect(fixture.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(fixture.readiness.resolvePolicy).not.toHaveBeenCalled();
  });
});
