import {
  ChatEntityType,
  ManagedEntityAccessState,
  ManagedEntityHandshakeOutcomeStatus,
} from '../prisma/prisma-client';
import { ManagedEntityAccessWriter } from './managed-entity-access-writer.service';
import {
  ManagedEntityHandshakeService,
  MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD,
} from './managed-entity-handshake.service';
import type { MaxChatMemberAccess, MaxClientService } from './max-client.service';
import {
  MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE,
  markMaxPreDispatchGuardRejected,
} from './max-action-pre-dispatch-guard';
import { WebhookParser } from '../webhook/webhook.parser';
import { createGroupCommandAuthorityMock } from '../common/group-command-authority.spec-support';
import { buildGroupCommandKey } from '../common/group-command-authority.service';
import { ManagedEntityActivationRequiredError } from './managed-entity-activation.util';

function createUpdate(overrides: Record<string, unknown> = {}) {
  const messageOverrides =
    typeof overrides.message === 'object' && overrides.message !== null
      ? (overrides.message as Record<string, unknown>)
      : {};
  return {
    updateId: 'u-start-1',
    botId: 'bot-1',
    type: 'message_created',
    message: {
      messageId: 'm-start-1',
      chatId: '-100',
      chatTitle: 'Команда MAX',
      entityType: 'chat',
      senderId: 'admin-1',
      text: 'Старт',
      createdAt: new Date().toISOString(),
      ...messageOverrides,
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'message')),
  } as never;
}

const FORWARDED_PRIVATE_CHAT_ID = '152517912';
const FORWARDED_USER_ID = '195714583';
const FORWARDED_SOURCE_CHAT_ID = '-70000000000001';
const FORWARDED_SOURCE_LINK = 'https://max.ru/channel/news-max';
const FORWARDED_SOURCE_AVATAR_URL = 'https://example.test/news-max.jpg';
const FORWARDED_ACTOR_BURST_LIMIT_MS = 5_000;

type ForwardedUpdateOptions = {
  updateId?: string;
  incomingMessageId?: string;
  privateChatId?: string;
  normalizedChatId?: string;
  forwarderUserId?: string;
  normalizedSenderId?: string;
  sourceChatId?: string;
  sourceMessageId?: string | null;
  recipientChatType?: string;
  rawRecipientChatId?: string | number;
  rawBody?: Record<string, unknown> | null;
  rawLink?: Record<string, unknown> | null;
};

function createForwardedUpdate(options: ForwardedUpdateOptions = {}) {
  const incomingMessageId = options.incomingMessageId ?? 'm-forward-1';
  const privateChatId = options.privateChatId ?? FORWARDED_PRIVATE_CHAT_ID;
  const forwarderUserId = options.forwarderUserId ?? FORWARDED_USER_ID;
  const sourceChatId = options.sourceChatId ?? FORWARDED_SOURCE_CHAT_ID;
  const sourceMessageId =
    options.sourceMessageId === undefined ? 'mid-source-1' : options.sourceMessageId;
  const linkedMessage = {
    ...(sourceMessageId ? { mid: sourceMessageId } : {}),
    text: 'Исходная публикация',
  };
  const link =
    options.rawLink === undefined
      ? {
          type: 'forward',
          chat_id: Number(sourceChatId),
          message: linkedMessage,
        }
      : options.rawLink;

  return {
    updateId: options.updateId ?? 'u-forward-1',
    botId: 'bot-1',
    type: 'message_created',
    message: {
      messageId: incomingMessageId,
      chatId: options.normalizedChatId ?? privateChatId,
      senderId: options.normalizedSenderId ?? forwarderUserId,
      text: 'Пересланная публикация',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        id: incomingMessageId,
        sender: {
          user_id: Number(forwarderUserId),
        },
        recipient: {
          chat_id: options.rawRecipientChatId ?? Number(privateChatId),
          chat_type: options.recipientChatType ?? 'dialog',
        },
        body: options.rawBody ?? null,
        link,
      },
    },
  } as never;
}

function createFixture() {
  const transaction = jest.fn();
  const prisma = {
    chatBotMembership: {
      upsert: jest.fn((args) => ({ operation: 'membership.upsert', args })),
    },
    chatAdminAllowlist: {
      upsert: jest.fn((args) => ({ operation: 'allowlist.upsert', args })),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    managedEntityAdminMember: {
      upsert: jest.fn((args) => ({ operation: 'adminMember.upsert', args })),
      findFirst: jest.fn().mockResolvedValue(null),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    managedBotChatCatalog: {
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    managedEntityAccessEdge: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn((args) => ({ operation: 'edge.upsert', args })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    managedEntityLocalActivity: {
      upsert: jest.fn((args) => ({ operation: 'activity.upsert', args })),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'membership-1' }]),
    $transaction: transaction,
  };
  transaction.mockImplementation(async (callback: (client: typeof prisma) => Promise<unknown>) =>
    callback(prisma),
  );
  const maxClient = {
    getChatSnapshot: jest.fn().mockImplementation(async (chatId = FORWARDED_SOURCE_CHAT_ID) => ({
      chatId,
      title: 'Новости MAX',
      participantsCount: 10,
      status: 'active',
      isPublic: false,
      link: FORWARDED_SOURCE_LINK,
      lastEventAt: null,
      entityType: 'channel',
      avatarUrl: FORWARDED_SOURCE_AVATAR_URL,
    })),
    getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
      userId: 'bot-1',
      isAdmin: true,
      isOwner: false,
      explicitPrivilegeEvidence: true,
      permissionsKnown: true,
      permissions: ['read_all_messages', 'write', 'delete'],
    }),
    getChatMembersAccess: jest.fn().mockResolvedValue(
      new Map([
        [
          'admin-1',
          {
            userId: 'admin-1',
            isBot: false,
            isAdmin: true,
            isOwner: false,
            explicitPrivilegeEvidence: true,
            permissionsKnown: true,
            permissions: ['change_chat_info'],
          },
        ],
        [
          FORWARDED_USER_ID,
          {
            userId: FORWARDED_USER_ID,
            isBot: false,
            isAdmin: true,
            isOwner: false,
            explicitPrivilegeEvidence: true,
            permissionsKnown: true,
            permissions: ['change_chat_info'],
          },
        ],
      ]),
    ),
    sendMessageImmediateWithId: jest.fn().mockResolvedValue({
      messageId: 'reply-1',
      url: null,
    }),
    sendMessage: jest
      .fn<
        ReturnType<MaxClientService['sendMessage']>,
        Parameters<MaxClientService['sendMessage']>
      >()
      .mockResolvedValue({ messageId: 'start-reply-1', url: null }),
    deleteMessage: jest.fn().mockResolvedValue(undefined),
  };
  const maxBotLinkService = {
    getChatExecutionBinding: jest
      .fn()
      .mockResolvedValue({ primaryBotId: null, assignedBotIds: [] }),
    bindDiscoveredChatBots: jest.fn().mockResolvedValue('bot-1'),
    recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    reconcileChatPrimaryByAccess: jest.fn().mockResolvedValue('bot-1'),
    buildEntryMiniappStartUrlSync: jest.fn().mockReturnValue('https://max.ru/entry?startapp=mr-x'),
    buildMiniappStartUrlSync: jest.fn().mockReturnValue('https://max.ru/bot-1?startapp=mr-x'),
  };
  const maxBotRegistry = {
    getAllBots: jest.fn(() => [{ id: 'bot-1', label: 'Бот', state: 'active' as const }]),
    getBotById: jest.fn((botId?: string | null) =>
      botId === 'bot-1' ? { id: 'bot-1', label: 'Бот', state: 'active' as const } : null,
    ),
    isKnownBotUserId: jest.fn((userId?: string | null) => userId === 'bot-1'),
  };
  const chatContextCache = {
    upsertManagedEntitiesRecentBootstrap: jest.fn().mockResolvedValue(undefined),
    getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue(null),
    upsertManagedEntityPublishedSnapshot: jest.fn().mockResolvedValue(undefined),
    setManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue(undefined),
    setAdminAccess: jest.fn().mockResolvedValue(undefined),
    clearAdminAccess: jest.fn().mockResolvedValue(undefined),
    rememberChatAdminUser: jest.fn().mockResolvedValue(undefined),
    rememberChatAdminUserFenced: jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn().mockResolvedValue(undefined),
    invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
    clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
    clearManagedEntitiesPublishedSnapshotsForUsers: jest.fn().mockResolvedValue(undefined),
    applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
  };
  const rosterSync = {
    processJob: jest.fn().mockResolvedValue(true),
    scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
  };
  const handshakeOutcomes = {
    recordOutcome: jest.fn().mockResolvedValue(undefined),
  };
  const accessWriter = new ManagedEntityAccessWriter(
    prisma as never,
    maxBotLinkService as never,
    chatContextCache as never,
  );
  const groupCommandAuthority = createGroupCommandAuthorityMock();
  const service = new ManagedEntityHandshakeService(
    accessWriter as never,
    maxClient as never,
    maxBotLinkService as never,
    maxBotRegistry as never,
    rosterSync as never,
    handshakeOutcomes as never,
    groupCommandAuthority as never,
  );

  return {
    service,
    prisma,
    maxClient,
    maxBotLinkService,
    maxBotRegistry,
    chatContextCache,
    rosterSync,
    handshakeOutcomes,
    groupCommandAuthority,
  };
}

describe('ManagedEntityHandshakeService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([1, 4, 9])(
    'publishes one fresh admin-verified Start success across %i observer bots',
    async (botCount) => {
      const authority = createGroupCommandAuthorityMock();
      const fixtures = Array.from({ length: botCount }, () => createFixture());
      const bots = fixtures.map((_, index) => ({
        id: `bot-${index + 1}`,
        label: 'Бот',
        state: 'active' as const,
      }));
      for (const fixture of fixtures) {
        Object.assign(fixture.service, { groupCommandAuthority: authority });
        fixture.maxBotRegistry.getBotById.mockImplementation(
          (id) => bots.find((bot) => bot.id === id) ?? null,
        );
        fixture.maxBotRegistry.getAllBots.mockReturnValue(bots);
      }
      await Promise.all(
        fixtures.map((fixture, index) =>
          fixture.service.handleWebhookUpdate(
            createUpdate({
              botId: bots[index]!.id,
              updateId: `mirrored-start-${index}`,
            }),
          ),
        ),
      );
      expect(
        fixtures.reduce(
          (count, fixture) => count + fixture.maxClient.sendMessage.mock.calls.length,
          0,
        ),
      ).toBe(1);
      expect(
        fixtures.reduce(
          (count, fixture) =>
            count + fixture.prisma.managedEntityAccessEdge.upsert.mock.calls.length,
          0,
        ),
      ).toBe(botCount);
      expect(authority.complete).toHaveBeenCalledTimes(1);
      for (const [index, fixture] of fixtures.entries()) {
        expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
          '-100',
          expect.objectContaining({ botId: bots[index]!.id, bypassCache: true }),
        );
        expect(fixture.maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith(
          expect.objectContaining({
            botId: bots[index]!.id,
            explicitActivation: expect.objectContaining({
              kind: 'start_in_chat',
              botId: bots[index]!.id,
              chatId: '-100',
              actorUserId: 'admin-1',
              updateId: `mirrored-start-${index}`,
            }),
          }),
        );
        expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledWith(
          '-100',
          ['admin-1'],
          expect.objectContaining({ bypassCache: true }),
        );
      }
    },
  );

  it('activates only the receiving bot when another bot owns the pending Start confirmation', async () => {
    const fixture = createFixture();
    const update = createUpdate();
    const other = await fixture.groupCommandAuthority.claim(update, 'bot-2');
    await fixture.groupCommandAuthority.release(other!);
    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('connected');
    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      '-100',
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(fixture.maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
    expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(fixture.groupCommandAuthority.complete).not.toHaveBeenCalled();
  });

  it.each(['bot_role', 'actor_role', 'actor_bot', 'actor_unknown'] as const)(
    'refuses activation when the live proof has %s uncertainty',
    async (uncertainty) => {
      const fixture = createFixture();
      if (uncertainty === 'bot_role') {
        fixture.maxClient.getCurrentChatMemberAccess.mockResolvedValueOnce({
          userId: 'bot-1',
          isAdmin: true,
          isOwner: false,
          explicitPrivilegeEvidence: false,
          permissionsKnown: true,
          permissions: ['read_all_messages', 'write'],
        });
      } else {
        fixture.maxClient.getChatMembersAccess.mockResolvedValueOnce(
          new Map([
            [
              'admin-1',
              {
                userId: 'admin-1',
                isAdmin: true,
                isOwner: false,
                isBot: uncertainty === 'actor_unknown' ? undefined : uncertainty === 'actor_bot',
                explicitPrivilegeEvidence: uncertainty !== 'actor_role',
                permissions: [],
              },
            ],
          ]),
        );
      }
      await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('denied');
      expect(fixture.maxBotLinkService.recordBotAccessProbe).not.toHaveBeenCalled();
      expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
      expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
      expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    },
  );

  it('settles a typed initial activation refusal silently without retrying the legacy callback', async () => {
    const fixture = createFixture();
    fixture.maxClient.getCurrentChatMemberAccess.mockRejectedValueOnce(
      new ManagedEntityActivationRequiredError(),
    );
    const update = createUpdate({
      type: 'message_callback',
      raw: {
        callback: {
          payload: MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD,
          user: { user_id: 'admin-1' },
        },
      },
    });
    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('denied');
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ManagedEntityHandshakeOutcomeStatus.BOT_DENIED,
        reason: 'explicit_activation_required',
      }),
    );
    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('rate_limited');
    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    expect(fixture.maxBotLinkService.recordBotAccessProbe).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('keeps an untyped activation error retryable instead of inferring a safe refusal from its text', async () => {
    const fixture = createFixture();
    fixture.maxClient.getCurrentChatMemberAccess.mockRejectedValueOnce(
      new Error(new ManagedEntityActivationRequiredError().message),
    );
    const update = createUpdate({
      type: 'message_callback',
      raw: {
        callback: {
          payload: MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD,
          user: { user_id: 'admin-1' },
        },
      },
    });
    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('failed');
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
  });

  it('does not treat a later activation error as an initial access refusal', async () => {
    const fixture = createFixture();
    fixture.maxClient.getChatMembersAccess.mockRejectedValueOnce(
      new ManagedEntityActivationRequiredError(),
    );
    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('failed');
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
  });

  it('does not turn a legacy callback into activation of a dormant membership', async () => {
    const fixture = createFixture();
    fixture.maxBotLinkService.recordBotAccessProbe.mockResolvedValueOnce(false);
    const update = createUpdate({
      type: 'message_callback',
      raw: {
        callback: {
          payload: MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD,
          user: { user_id: 'admin-1' },
        },
      },
    });
    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('failed');
    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      '-100',
      expect.objectContaining({ explicitActivation: undefined }),
    );
    expect(fixture.maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({ explicitActivation: undefined }),
    );
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
  });

  it.each(['start', 'forward'] as const)(
    'rejects malformed %s activation before any remote probe or reply',
    async (kind) => {
      for (const defect of [
        'timestamp_missing',
        'timestamp_old',
        'timestamp_future',
        'origin_mismatch',
        'update_missing',
      ]) {
        const fixture = createFixture();
        const update = kind === 'start' ? createUpdate() : createForwardedUpdate();
        const payload = update as unknown as { updateId: string; message: { createdAt?: string } };
        if (defect === 'timestamp_missing') delete payload.message.createdAt;
        if (defect === 'timestamp_old')
          payload.message.createdAt = new Date(Date.now() - 300_001).toISOString();
        if (defect === 'timestamp_future')
          payload.message.createdAt = new Date(Date.now() + 1_000).toISOString();
        if (defect === 'update_missing') payload.updateId = '';
        if (defect === 'origin_mismatch')
          fixture.maxBotRegistry.getBotById.mockReturnValue({
            id: 'bot-2',
            label: 'Бот',
            state: 'active',
          });
        await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('denied');
        expect(fixture.maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
        expect(fixture.maxClient.getChatMembersAccess).not.toHaveBeenCalled();
        expect(fixture.maxClient.getChatSnapshot).not.toHaveBeenCalled();
        expect(fixture.maxBotLinkService.recordBotAccessProbe).not.toHaveBeenCalled();
        expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
        expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
        expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
      }
    },
  );

  it('lets a healthy peer connect after the first observer bot is denied', async () => {
    const authority = createGroupCommandAuthorityMock();
    const weak = createFixture();
    const healthy = createFixture();
    for (const fixture of [weak, healthy]) {
      Object.assign(fixture.service, { groupCommandAuthority: authority });
      fixture.maxBotRegistry.getBotById.mockImplementation((id) =>
        id ? { id, label: 'Бот', state: 'active' } : null,
      );
    }
    weak.maxClient.getCurrentChatMemberAccess.mockResolvedValueOnce({
      userId: 'bot-1',
      isAdmin: false,
      isOwner: false,
      explicitPrivilegeEvidence: true,
      permissionsKnown: true,
      permissions: [],
    });
    expect(await weak.service.handleWebhookUpdate(createUpdate())).toBe('denied');
    expect(
      await healthy.service.handleWebhookUpdate(
        createUpdate({ botId: 'bot-2', updateId: 'healthy-peer' }),
      ),
    ).toBe('connected');
    expect(weak.maxClient.sendMessage).not.toHaveBeenCalled();
    expect(healthy.maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(authority.claim).toHaveBeenCalledTimes(1);
    expect(authority.claim).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-2' }),
      'bot-2',
    );
  });

  it.each(['recovered', 'hold'])(
    'does not publish another Start confirmation for %s historical delivery',
    async (state) => {
      const fixture = createFixture();
      fixture.groupCommandAuthority.inspectLegacyStart.mockResolvedValue(state);
      await fixture.service.handleWebhookUpdate(createUpdate());
      expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
      expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
      expect(fixture.groupCommandAuthority.complete).toHaveBeenCalledTimes(1);
      if (state === 'hold') {
        expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledTimes(1);
        expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
      }
    },
  );

  it('keeps an ambiguous Start confirmation silent on mirrored receipts', async () => {
    const authority = createGroupCommandAuthorityMock();
    const first = createFixture();
    const peer = createFixture();
    for (const fixture of [first, peer])
      Object.assign(fixture.service, { groupCommandAuthority: authority });
    first.maxClient.sendMessage.mockRejectedValueOnce(
      new Error('MAX send timeout: ambiguous outcome'),
    );
    await first.service.handleWebhookUpdate(createUpdate());
    await peer.service.handleWebhookUpdate(createUpdate({ updateId: 'mirrored-after-timeout' }));
    expect(first.maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(peer.maxClient.sendMessage).not.toHaveBeenCalled();
    expect(first.maxClient.sendMessage.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        candidateBotIds: ['bot-1'],
        routing: { purpose: 'send_message', requiredBotId: 'bot-1' },
        beforeImmediateSendMutation: expect.any(Function),
      }),
    );
  });

  it('settles a one-shot Start confirmation refusal while retaining the applied connection', async () => {
    const fixture = createFixture();
    fixture.maxClient.sendMessage.mockRejectedValueOnce(
      markMaxPreDispatchGuardRejected(
        new Error('Start authority expired before transport'),
        MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE,
      ),
    );
    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('connected');
    expect(fixture.maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.sendMessage.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        immediate: true,
        immediateFailurePolicy: 'terminal',
        candidateBotIds: ['bot-1'],
        routing: { purpose: 'send_message', requiredBotId: 'bot-1' },
        beforeImmediateSendMutation: expect.any(Function),
      }),
    );
    expect(fixture.groupCommandAuthority.prepareResult).toHaveBeenCalledWith(expect.anything(), {
      action: 'START',
      noticeText: null,
      applied: true,
    });
    expect(fixture.groupCommandAuthority.complete).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    await fixture.service.handleWebhookUpdate(createUpdate({ updateId: 'refused-start-mirror' }));
    expect(fixture.maxClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not bootstrap a public Start without a proven actor', async () => {
    const fixture = createFixture();
    expect(
      await fixture.service.handleWebhookUpdate(createUpdate({ message: { senderId: null } })),
    ).toBe('denied');
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['chat', 'channel'] as const)(
    'does not rename an existing %s from a Start without metadata',
    async (entityType) => {
      const fixture = createFixture();
      await expect(
        fixture.service.handleWebhookUpdate(
          createUpdate({ message: { chatTitle: undefined, entityType } }),
        ),
      ).resolves.toBe('connected');
      expect(fixture.maxBotLinkService.bindDiscoveredChatBots).toHaveBeenCalledWith(
        expect.objectContaining({ title: null }),
      );
      expect(fixture.maxBotLinkService.reconcileChatPrimaryByAccess).toHaveBeenCalledWith(
        expect.objectContaining({ title: null }),
      );
      const catalog = fixture.prisma.managedBotChatCatalog.upsert.mock.calls[0]?.[0] as {
        update: Record<string, unknown>;
      };
      expect(catalog.update).not.toHaveProperty('title');
      const activity = fixture.prisma.managedEntityLocalActivity.upsert.mock.calls[0]?.[0];
      expect(activity.update).not.toHaveProperty('chatTitle');
    },
  );

  it('connects a chat when Старт is sent by an admin and the bot is admin', async () => {
    const fixture = createFixture();
    fixture.chatContextCache.getManagedEntitiesPublishedSnapshot.mockResolvedValueOnce({
      items: [
        {
          id: '-100',
          title: 'Старое название',
          link: 'https://max.ru/join/existing-chat',
          avatarUrl: 'https://example.test/existing-chat.jpg',
        },
      ],
    } as never);

    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('connected');

    expect(fixture.maxBotLinkService.bindDiscoveredChatBots).toHaveBeenCalledWith({
      chatId: '-100',
      primaryBotId: 'bot-1',
      botIds: ['bot-1'],
      title: 'Команда MAX',
      entityType: ChatEntityType.CHAT,
    });
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_userId_botId: {
            chatId: '-100',
            userId: 'admin-1',
            botId: 'bot-1',
          },
        },
        create: expect.objectContaining({
          state: ManagedEntityAccessState.GRANTED,
          source: 'handshake_start',
        }),
      }),
    );
    expect(fixture.maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100',
        botId: 'bot-1',
        source: 'handshake_start',
        checkedAt: expect.any(Date),
        allowMembershipRecovery: true,
      }),
    );
    expect(fixture.prisma.chatBotMembership.upsert).not.toHaveBeenCalled();
    const lockSql = fixture.prisma.$queryRaw.mock.calls.map(([query]) =>
      Array.isArray(query) ? query.join('') : (query as { sql: string }).sql,
    );
    expect(lockSql).toHaveLength(6);
    expect(lockSql[0]).toContain('FROM "chats"');
    expect(lockSql[1]).toContain('FROM "chat_bot_memberships"');
    expect(lockSql[2]).toContain('FROM chat_admin_roster_states');
    expect(lockSql[3]).toContain('FROM "chats"');
    expect(lockSql[4]).toContain('FROM "chat_bot_memberships"');
    expect(lockSql[5]).toContain('FROM chat_admin_roster_states');
    expect(fixture.chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(1);
    expect(fixture.chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100',
        userId: 'admin-1',
        state: 'granted',
        eventAt: expect.any(Date),
        publishedSummary: expect.objectContaining({
          id: '-100',
          title: 'Команда MAX',
          entityType: 'chat',
        }),
        recentBootstrapSummary: expect.objectContaining({
          id: '-100',
          title: 'Команда MAX',
          entityType: 'chat',
        }),
      }),
      { acceptNewerGrantedEpoch: true },
    );
    expect(fixture.prisma.$queryRaw.mock.invocationCallOrder[5]).toBeLessThan(
      fixture.chatContextCache.applyAdminAccessEpochMutation.mock.invocationCallOrder[0],
    );
    const catalogWrite = fixture.prisma.managedBotChatCatalog.upsert.mock.calls[0]?.[0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(catalogWrite.create).toEqual(
      expect.objectContaining({
        link: null,
        avatarUrl: null,
      }),
    );
    expect(catalogWrite.update).not.toHaveProperty('link');
    expect(catalogWrite.update).not.toHaveProperty('avatarUrl');
    const rosterJob = {
      chatId: '-100',
      botIds: ['bot-1'],
      title: 'Команда MAX',
      entityType: 'chat',
      source: 'handshake_start',
    };
    expect(fixture.rosterSync.processJob).not.toHaveBeenCalled();
    expect(fixture.rosterSync.scheduleChatAdminRosterSync).toHaveBeenCalledWith(rosterJob);
    expect(fixture.maxClient.deleteMessage).toHaveBeenCalledWith(
      '-100',
      'm-start-1',
      expect.objectContaining({
        immediate: true,
        botId: 'bot-1',
        sourceTag: 'managed_handshake',
        ignoreFailureMetricStatuses: [403, 404],
      }),
    );
    expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessage).toHaveBeenCalledWith(
      '-100',
      'Готово, чат подключен.',
      {
        buttons: [
          [{ type: 'link', text: 'Открыть настройки', url: 'https://max.ru/entry?startapp=mr-x' }],
        ],
      },
      expect.objectContaining({
        immediate: true,
        botId: 'bot-1',
        idempotencyKey: `managed-handshake-start:${buildGroupCommandKey('-100', 'm-start-1')}`,
        autoDeleteDelayMs: 180_000,
      }),
    );
    const startParam = fixture.maxBotLinkService.buildEntryMiniappStartUrlSync.mock.calls[0]?.[0];
    expect(JSON.parse(Buffer.from(startParam.slice(3), 'base64url').toString('utf8'))).toEqual({
      v: 1,
      k: 'route',
      r: '/chat/-100/settings',
    });
    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      '-100',
      expect.objectContaining({ sourceTag: 'managed_handshake', bypassCache: true }),
    );
    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      '-100',
      ['admin-1'],
      expect.objectContaining({ sourceTag: 'managed_handshake', bypassCache: true }),
    );
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100',
        userId: 'admin-1',
        botId: 'bot-1',
        entityType: ChatEntityType.CHAT,
        status: ManagedEntityHandshakeOutcomeStatus.CONNECTED,
      }),
    );
  });

  it('compensates its SQL grant when a newer cache epoch rejects publication', async () => {
    const fixture = createFixture();
    fixture.chatContextCache.applyAdminAccessEpochMutation.mockResolvedValueOnce(false);

    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.not.toBe(
      'connected',
    );

    expect(fixture.prisma.managedEntityAccessEdge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: '-100',
          userId: 'admin-1',
          state: ManagedEntityAccessState.GRANTED,
          checkedAt: expect.any(Date),
        }),
      }),
    );
    expect(fixture.prisma.managedEntityAdminMember.deleteMany).toHaveBeenCalled();
    expect(fixture.prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: '-100',
        userId: { in: ['admin-1', 'idadmin-1'] },
      },
    });
  });

  it('anchors every granted access write to the start of live MAX verification', async () => {
    const probeStartedAt = new Date('2026-08-20T10:00:00.000Z');
    jest.useFakeTimers().setSystemTime(probeStartedAt);
    const fixture = createFixture();
    fixture.maxClient.getCurrentChatMemberAccess.mockImplementationOnce(async () => {
      jest.setSystemTime(new Date('2026-08-20T10:00:05.000Z'));
      return {
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        explicitPrivilegeEvidence: true,
        permissionsKnown: true,
        permissions: ['read_all_messages', 'write', 'delete'],
      };
    });

    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('connected');

    const persistedProbe = fixture.maxBotLinkService.recordBotAccessProbe.mock.calls[0]?.[0] as {
      checkedAt: Date;
    };
    expect(persistedProbe.checkedAt).toEqual(probeStartedAt);

    const adminWrite = fixture.prisma.managedEntityAdminMember.upsert.mock.calls[0]?.[0] as {
      create: { checkedAt: Date; expiresAt: Date };
      update: { checkedAt: Date; expiresAt: Date };
    };
    const edgeWrite = fixture.prisma.managedEntityAccessEdge.upsert.mock.calls[0]?.[0] as {
      create: { checkedAt: Date; expiresAt: Date };
      update: { checkedAt: Date; expiresAt: Date };
    };
    const activityWrite = fixture.prisma.managedEntityLocalActivity.upsert.mock.calls[0]?.[0] as {
      create: { lastEventAt: Date };
      update: { lastEventAt: Date };
    };
    const expectedExpiry = new Date(probeStartedAt.getTime() + 3 * 24 * 60 * 60 * 1_000);
    expect(adminWrite.create).toEqual(
      expect.objectContaining({ checkedAt: probeStartedAt, expiresAt: expectedExpiry }),
    );
    expect(adminWrite.update).toEqual(
      expect.objectContaining({ checkedAt: probeStartedAt, expiresAt: expectedExpiry }),
    );
    expect(edgeWrite.create).toEqual(
      expect.objectContaining({ checkedAt: probeStartedAt, expiresAt: expectedExpiry }),
    );
    expect(edgeWrite.update).toEqual(
      expect.objectContaining({ checkedAt: probeStartedAt, expiresAt: expectedExpiry }),
    );
    expect(activityWrite.create.lastEventAt).toEqual(probeStartedAt);
    expect(activityWrite.update.lastEventAt).toEqual(probeStartedAt);
    expect(fixture.prisma.$queryRaw.mock.calls[1]?.slice(1)).toEqual(
      expect.arrayContaining(['-100', 'bot-1', probeStartedAt, 'handshake_start']),
    );
  });

  it.each([ManagedEntityAccessState.USER_DENIED, ManagedEntityAccessState.BOT_DENIED] as const)(
    'does not restore a delayed grant over a newer %s edge stored under an id-prefixed alias',
    async (newerState) => {
      const probeStartedAt = new Date('2026-08-20T10:00:00.000Z');
      const newerCheckedAt = new Date('2026-08-20T10:00:01.000Z');
      jest.useFakeTimers().setSystemTime(probeStartedAt);
      const fixture = createFixture();
      let resolveUserAccess!: (value: Map<string, MaxChatMemberAccess>) => void;
      let notifyUserProbeStarted!: () => void;
      const userProbeStarted = new Promise<void>((resolve) => {
        notifyUserProbeStarted = resolve;
      });
      const delayedUserAccess = new Promise<Map<string, MaxChatMemberAccess>>((resolve) => {
        resolveUserAccess = resolve;
      });
      fixture.maxClient.getChatMembersAccess.mockImplementationOnce(() => {
        notifyUserProbeStarted();
        return delayedUserAccess;
      });

      const pendingHandshake = fixture.service.handleWebhookUpdate(
        createUpdate({ message: { senderId: '123' } }),
      );
      await userProbeStarted;

      jest.setSystemTime(newerCheckedAt);
      fixture.prisma.managedEntityAccessEdge.findFirst.mockResolvedValueOnce({
        userId: 'id123',
        state: newerState,
        checkedAt: newerCheckedAt,
      });
      resolveUserAccess(
        new Map([
          [
            '123',
            {
              userId: '123',
              isBot: false,
              isAdmin: true,
              isOwner: false,
              explicitPrivilegeEvidence: true,
              permissionsKnown: true,
              permissions: ['change_chat_info'],
            },
          ],
        ]),
      );

      await expect(pendingHandshake).resolves.toBe('failed');

      expect(fixture.prisma.managedEntityAccessEdge.findFirst).toHaveBeenCalledWith({
        where: {
          chatId: '-100',
          userId: { in: ['123', 'id123'] },
          checkedAt: { gt: probeStartedAt },
          OR: [
            { botId: 'bot-1' },
            { state: 'USER_DENIED' },
            { userRole: { notIn: ['ADMIN', 'OWNER'] } },
          ],
        },
        select: { checkedAt: true },
      });
      expect(fixture.prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
      expect(fixture.prisma.managedEntityAdminMember.upsert).not.toHaveBeenCalled();
      expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
      expect(fixture.prisma.managedEntityLocalActivity.upsert).not.toHaveBeenCalled();
      expect(fixture.prisma.managedBotChatCatalog.upsert).not.toHaveBeenCalled();
      expect(fixture.chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
      expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ManagedEntityHandshakeOutcomeStatus.FAILED,
          reason: 'bot_access_probe_superseded',
        }),
      );
    },
  );

  it('does not publish grants when a newer membership event supersedes the live probe', async () => {
    const fixture = createFixture();
    fixture.maxBotLinkService.recordBotAccessProbe.mockResolvedValueOnce(false);

    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('failed');

    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
    expect(fixture.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(fixture.prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityAdminMember.upsert).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityLocalActivity.upsert).not.toHaveBeenCalled();
    expect(fixture.prisma.managedBotChatCatalog.upsert).not.toHaveBeenCalled();
    expect(fixture.prisma.chatBotMembership.upsert).not.toHaveBeenCalled();
    expect(fixture.maxBotLinkService.reconcileChatPrimaryByAccess).not.toHaveBeenCalled();
    expect(fixture.chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
    expect(fixture.rosterSync.processJob).not.toHaveBeenCalled();
    expect(fixture.rosterSync.scheduleChatAdminRosterSync).not.toHaveBeenCalled();
    expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ManagedEntityHandshakeOutcomeStatus.FAILED,
        reason: 'bot_access_probe_superseded',
      }),
    );
    const internals = fixture.service as unknown as {
      rateLimitUntilMs: Map<string, number>;
    };
    expect(internals.rateLimitUntilMs.size).toBe(0);
  });

  it('does not publish grants when the accepted membership epoch changes before commit', async () => {
    const fixture = createFixture();
    fixture.prisma.$queryRaw.mockResolvedValueOnce([{ id: 'chat-1' }]).mockResolvedValueOnce([]);

    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('failed');

    expect(fixture.maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityAdminMember.upsert).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityLocalActivity.upsert).not.toHaveBeenCalled();
    expect(fixture.prisma.managedBotChatCatalog.upsert).not.toHaveBeenCalled();
    expect(fixture.chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
    expect(fixture.rosterSync.processJob).not.toHaveBeenCalled();
    expect(fixture.rosterSync.scheduleChatAdminRosterSync).not.toHaveBeenCalled();
    expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ManagedEntityHandshakeOutcomeStatus.FAILED,
        reason: 'bot_access_probe_superseded',
      }),
    );
  });

  it('does not publish caches when removal wins after the database grant commits', async () => {
    const fixture = createFixture();
    fixture.prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'chat-1' }])
      .mockResolvedValueOnce([{ id: 'membership-1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'chat-1' }])
      .mockResolvedValueOnce([]);

    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('failed');

    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.managedEntityAccessEdge.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        chatId: '-100',
        userId: 'admin-1',
        botId: 'bot-1',
        state: ManagedEntityAccessState.GRANTED,
        checkedAt: expect.any(Date),
      }),
      data: expect.objectContaining({
        state: ManagedEntityAccessState.BOT_DENIED,
        expiresAt: null,
        deniedReason: 'bot_access_probe_superseded',
      }),
    });
    expect(fixture.chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
    expect(
      fixture.chatContextCache.clearManagedEntitiesRecentBootstrapForChat,
    ).not.toHaveBeenCalled();
    expect(
      fixture.chatContextCache.clearManagedEntitiesPublishedSnapshotsForUsers,
    ).not.toHaveBeenCalled();
    expect(fixture.chatContextCache.clearAdminAccess).not.toHaveBeenCalled();
    expect(fixture.chatContextCache.invalidate).not.toHaveBeenCalled();
    expect(fixture.rosterSync.processJob).not.toHaveBeenCalled();
    expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ManagedEntityHandshakeOutcomeStatus.FAILED,
        reason: 'bot_access_probe_superseded',
      }),
    );
  });

  it('connects from an official MAX forward after normalizing it through WebhookParser', async () => {
    const fixture = createFixture();
    const update = new WebhookParser().parse(
      {
        update_type: 'message_created',
        timestamp: new Date().toISOString(),
        message: {
          sender: { user_id: Number(FORWARDED_USER_ID), first_name: 'Иван' },
          recipient: {
            chat_id: Number(FORWARDED_PRIVATE_CHAT_ID),
            chat_type: 'dialog',
          },
          body: {
            mid: 'm-forward-parser-1',
            seq: 42,
            text: null,
            attachments: null,
          },
          link: {
            type: 'forward',
            chat_id: Number(FORWARDED_SOURCE_CHAT_ID),
            message: {
              mid: 'mid-source-parser-1',
              seq: 7,
              text: 'Исходная публикация',
              attachments: null,
            },
          },
        },
      },
      { botId: 'bot-1' },
    );

    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('connected');

    expect(update.message).toMatchObject({
      messageId: 'm-forward-parser-1',
      chatId: FORWARDED_PRIVATE_CHAT_ID,
      senderId: FORWARDED_USER_ID,
    });
    expect(fixture.maxClient.getChatSnapshot).toHaveBeenCalledWith(
      FORWARDED_SOURCE_CHAT_ID,
      expect.objectContaining({ bypassCache: true }),
    );
    expect(fixture.chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: FORWARDED_SOURCE_CHAT_ID,
        userId: FORWARDED_USER_ID,
        state: 'granted',
        eventAt: expect.any(Date),
        publishedSummary: expect.objectContaining({
          id: FORWARDED_SOURCE_CHAT_ID,
          entityType: 'channel',
        }),
      }),
      { acceptNewerGrantedEpoch: true },
    );
    expect(fixture.rosterSync.processJob).not.toHaveBeenCalled();
    expect(fixture.rosterSync.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
      chatId: FORWARDED_SOURCE_CHAT_ID,
      botIds: ['bot-1'],
      title: 'Новости MAX',
      entityType: 'channel',
      source: 'handshake_start',
    });
  });

  it('requires the exact Старт message in a managed chat', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({ message: { chatId: '-100', senderId: 'admin-1', text: 'Стартуем' } }),
      ),
    ).resolves.toBe('ignored');
    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({ message: { chatId: '100', senderId: 'admin-1', text: 'Старт' } }),
      ),
    ).resolves.toBe('ignored');
    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          message: {
            chatId: '-100',
            senderId: 'admin-1',
            text: '',
          },
        }),
      ),
    ).resolves.toBe('ignored');

    expect(fixture.maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  it('connects from the bot_added Старт callback with the same admin checks', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          type: 'message_callback',
          message: {
            chatId: '-100',
            senderId: 'admin-1',
            text: '',
          },
          raw: {
            callback: {
              callback_id: 'cb-start-1',
              payload: MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD,
              user: {
                user_id: 'admin-1',
              },
            },
          },
        }),
      ),
    ).resolves.toBe('connected');

    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      '-100',
      expect.objectContaining({ sourceTag: 'managed_handshake' }),
    );
    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      '-100',
      ['admin-1'],
      expect.objectContaining({ sourceTag: 'managed_handshake' }),
    );
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: ManagedEntityAccessState.GRANTED,
          source: 'handshake_start',
        }),
      }),
    );
    expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('uses the callback user when MAX does not expose message senderId', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          type: 'message_callback',
          message: {
            chatId: '-100',
            senderId: '',
            text: '',
          },
          raw: {
            callback: {
              callback_id: 'cb-start-2',
              payload: MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD,
              user: {
                user_id: 'admin-1',
              },
            },
          },
        }),
      ),
    ).resolves.toBe('connected');

    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      '-100',
      ['admin-1'],
      expect.objectContaining({ sourceTag: 'managed_handshake' }),
    );
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_userId_botId: {
            chatId: '-100',
            userId: 'admin-1',
            botId: 'bot-1',
          },
        },
      }),
    );
  });

  it('uses the callback user when the callback message sender is the bot', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          type: 'message_callback',
          message: {
            chatId: '-100',
            senderId: 'bot-1',
            text: '',
          },
          raw: {
            callback: {
              callback_id: 'cb-start-3',
              payload: MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD,
              user: {
                user_id: 'admin-1',
              },
            },
          },
        }),
      ),
    ).resolves.toBe('connected');

    expect(fixture.chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100',
        userId: 'admin-1',
        state: 'granted',
        recentBootstrapSummary: expect.objectContaining({
          id: '-100',
          entityType: 'chat',
        }),
      }),
      { acceptNewerGrantedEpoch: true },
    );
    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      '-100',
      ['admin-1'],
      expect.objectContaining({ sourceTag: 'managed_handshake' }),
    );
  });

  it('ignores unrelated callbacks', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          type: 'message_callback',
          message: {
            chatId: '-100',
            senderId: 'admin-1',
            text: '',
          },
          raw: {
            callback: {
              callback_id: 'cb-other',
              payload: 'action|sample-1|1|0',
            },
          },
        }),
      ),
    ).resolves.toBe('ignored');

    expect(fixture.maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  it('denies the command when the sender is not an admin', async () => {
    const fixture = createFixture();
    fixture.maxClient.getChatMembersAccess.mockResolvedValueOnce(
      new Map([
        [
          'admin-1',
          {
            userId: 'admin-1',
            isBot: false,
            isAdmin: false,
            isOwner: false,
            explicitPrivilegeEvidence: true,
            permissionsKnown: true,
            permissions: [],
          },
        ],
      ]),
    );

    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('denied');
    await expect(
      fixture.service.handleWebhookUpdate(createUpdate({ updateId: 'u-start-1-duplicate' })),
    ).resolves.toBe('rate_limited');

    expect(fixture.maxBotLinkService.bindDiscoveredChatBots).not.toHaveBeenCalled();
    expect(fixture.chatContextCache.upsertManagedEntitiesRecentBootstrap).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ManagedEntityHandshakeOutcomeStatus.USER_DENIED,
        reason: 'user_not_admin',
      }),
    );
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ManagedEntityHandshakeOutcomeStatus.RATE_LIMITED,
        reason: 'duplicate_recently',
      }),
    );
    expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('silently rate limits repeated denied callback clicks to avoid group spam', async () => {
    const fixture = createFixture();
    fixture.maxClient.getChatMembersAccess.mockResolvedValueOnce(
      new Map([
        [
          'admin-1',
          {
            userId: 'admin-1',
            isBot: false,
            isAdmin: false,
            isOwner: false,
            explicitPrivilegeEvidence: true,
            permissionsKnown: true,
            permissions: [],
          },
        ],
      ]),
    );
    const callbackUpdate = createUpdate({
      type: 'message_callback',
      message: {
        chatId: '-100',
        senderId: 'bot-1',
        text: '',
      },
      raw: {
        callback: {
          callback_id: 'cb-denied-1',
          payload: MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD,
          user: {
            user_id: 'admin-1',
          },
        },
      },
    });

    await expect(fixture.service.handleWebhookUpdate(callbackUpdate)).resolves.toBe('denied');
    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          type: 'message_callback',
          updateId: 'u-start-callback-denied-duplicate',
          message: {
            chatId: '-100',
            senderId: 'bot-1',
            text: '',
          },
          raw: {
            callback: {
              callback_id: 'cb-denied-2',
              payload: MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD,
              user: {
                user_id: 'admin-1',
              },
            },
          },
        }),
      ),
    ).resolves.toBe('rate_limited');

    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ManagedEntityHandshakeOutcomeStatus.RATE_LIMITED,
        reason: 'duplicate_recently',
      }),
    );
  });

  it('confirms Start without waiting for a full administrator roster refresh', async () => {
    const fixture = createFixture();
    fixture.rosterSync.processJob.mockImplementation(() => new Promise(() => {}));

    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('connected');

    const rosterJob = {
      chatId: '-100',
      botIds: ['bot-1'],
      title: 'Команда MAX',
      entityType: 'chat',
      source: 'handshake_start',
    };
    expect(fixture.rosterSync.processJob).not.toHaveBeenCalled();
    expect(fixture.rosterSync.scheduleChatAdminRosterSync).toHaveBeenCalledWith(rosterJob);
    expect(fixture.maxClient.deleteMessage).toHaveBeenCalledWith(
      '-100',
      'm-start-1',
      expect.objectContaining({ immediate: true, botId: 'bot-1' }),
    );
  });

  it('retries the same Start after a failed durable roster handoff without confirming early', async () => {
    const fixture = createFixture();
    fixture.rosterSync.scheduleChatAdminRosterSync.mockResolvedValueOnce(false);
    const update = createUpdate();

    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('failed');
    expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
    expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();

    fixture.prisma.managedEntityAccessEdge.findUnique.mockResolvedValueOnce({ state: 'GRANTED' });
    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('already_connected');
    expect(fixture.rosterSync.scheduleChatAdminRosterSync).toHaveBeenCalledTimes(2);
    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(fixture.maxClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('rate limits duplicate bot access denials but allows a new Старт message to retry', async () => {
    const fixture = createFixture();
    fixture.maxClient.getCurrentChatMemberAccess
      .mockResolvedValueOnce({
        userId: 'bot-1',
        isAdmin: false,
        isOwner: false,
        explicitPrivilegeEvidence: true,
        permissionsKnown: true,
        permissions: [],
      })
      .mockResolvedValueOnce({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        explicitPrivilegeEvidence: true,
        permissionsKnown: true,
        permissions: ['read_all_messages', 'write'],
      });

    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('denied');
    await expect(
      fixture.service.handleWebhookUpdate(createUpdate({ updateId: 'u-start-1-duplicate' })),
    ).resolves.toBe('rate_limited');
    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          updateId: 'u-start-2',
          message: {
            messageId: 'm-start-2',
          },
        }),
      ),
    ).resolves.toBe('connected');

    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledTimes(1);
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ManagedEntityHandshakeOutcomeStatus.RATE_LIMITED,
        reason: 'duplicate_recently',
      }),
    );
  });

  it('treats MAX 403 during bot access lookup as a rate-limited bot denial', async () => {
    const fixture = createFixture();
    fixture.maxClient.getCurrentChatMemberAccess.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 403'), {
        response: {
          status: 403,
          data: {
            code: 'chat.denied',
          },
        },
      }),
    );

    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('denied');
    await expect(
      fixture.service.handleWebhookUpdate(createUpdate({ updateId: 'u-start-1-duplicate' })),
    ).resolves.toBe('rate_limited');

    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      '-100',
      expect.objectContaining({
        sourceTag: 'managed_handshake',
        ignoreFailureMetricStatuses: [403, 404],
      }),
    );
    expect(fixture.maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ManagedEntityHandshakeOutcomeStatus.BOT_DENIED,
        reason: 'bot_access_denied',
      }),
    );
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ManagedEntityHandshakeOutcomeStatus.RATE_LIMITED,
        reason: 'duplicate_recently',
      }),
    );
  });

  it('refreshes an existing granted edge when the chat is already connected', async () => {
    const fixture = createFixture();
    fixture.prisma.managedEntityAccessEdge.findUnique.mockResolvedValueOnce({
      state: ManagedEntityAccessState.GRANTED,
    });

    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe(
      'already_connected',
    );

    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          state: ManagedEntityAccessState.GRANTED,
          expiresAt: expect.any(Date),
          source: 'handshake_start',
        }),
      }),
    );
    expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
  });

  it('silently denies public Start when sender is a bot/system identity', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          message: {
            messageId: 'm-channel-1',
            chatId: '-200',
            chatTitle: 'Канал MAX',
            entityType: 'channel',
            senderId: 'bot-1',
            text: 'Старт',
            createdAt: new Date().toISOString(),
          },
        }),
      ),
    ).resolves.toBe('denied');

    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
    expect(fixture.chatContextCache.upsertManagedEntitiesRecentBootstrap).not.toHaveBeenCalled();
    expect(fixture.maxBotLinkService.recordBotAccessProbe).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(fixture.maxClient.getChatMembersAccess).not.toHaveBeenCalled();
  });

  it('ignores bot lifecycle events in the explicit handshake handler without reviving catalog or UI', async () => {
    const fixture = createFixture();
    fixture.maxBotLinkService.recordBotAccessProbe.mockResolvedValueOnce(false);

    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          type: 'bot_added',
          message: {
            messageId: 'm-channel-superseded',
            chatId: '-201',
            chatTitle: 'Удаленный канал',
            entityType: 'channel',
            senderId: 'bot-1',
            text: 'Старт',
            createdAt: new Date().toISOString(),
          },
        }),
      ),
    ).resolves.toBe('ignored');

    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
    expect(fixture.prisma.managedBotChatCatalog.upsert).not.toHaveBeenCalled();
    expect(fixture.chatContextCache.upsertManagedEntitiesRecentBootstrap).not.toHaveBeenCalled();
    expect(fixture.chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
    expect(fixture.handshakeOutcomes.recordOutcome).not.toHaveBeenCalled();
  });

  it.each([
    ['missing read-all', ['write'], true],
    ['missing delete', ['read_all_messages'], true],
    ['unknown permissions', ['read_all_messages', 'write'], false],
    ['owner without permissions', [], true],
  ] as const)(
    'keeps public Start silent and inactive with %s',
    async (reason, permissions, permissionsKnown) => {
      const fixture = createFixture();
      fixture.maxClient.getCurrentChatMemberAccess.mockResolvedValueOnce({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: reason === 'owner without permissions',
        explicitPrivilegeEvidence: true,
        permissionsKnown,
        permissions: [...permissions],
      });
      await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('denied');
      expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
      expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
      expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    },
  );

  it('does not treat channel write as delete capability', async () => {
    const fixture = createFixture();
    fixture.maxClient.getCurrentChatMemberAccess.mockResolvedValueOnce({
      userId: 'bot-1',
      isAdmin: true,
      isOwner: false,
      explicitPrivilegeEvidence: true,
      permissionsKnown: true,
      permissions: ['read_all_messages', 'write'],
    });

    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          message: {
            messageId: 'm-channel-command-1',
            chatId: '-200',
            chatTitle: 'Канал MAX',
            entityType: 'channel',
            senderId: 'admin-1',
            text: 'Старт',
          },
        }),
      ),
    ).resolves.toBe('denied');

    expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('deletes a channel Старт message only with channel delete capability', async () => {
    const fixture = createFixture();
    fixture.maxClient.getCurrentChatMemberAccess.mockResolvedValueOnce({
      userId: 'bot-1',
      isAdmin: true,
      isOwner: false,
      explicitPrivilegeEvidence: true,
      permissionsKnown: true,
      permissions: ['delete'],
    });

    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          message: {
            messageId: 'm-channel-command-2',
            chatId: '-200',
            chatTitle: 'Канал MAX',
            entityType: 'channel',
            senderId: 'admin-1',
            text: 'Старт',
          },
        }),
      ),
    ).resolves.toBe('connected');

    expect(fixture.maxClient.deleteMessage).toHaveBeenCalledWith(
      '-200',
      'm-channel-command-2',
      expect.objectContaining({ botId: 'bot-1' }),
    );
  });

  it('allows a new Старт message to refresh access but rate limits duplicate deliveries', async () => {
    const fixture = createFixture();

    await expect(fixture.service.handleWebhookUpdate(createUpdate())).resolves.toBe('connected');
    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          updateId: 'u-start-1-duplicate',
        }),
      ),
    ).resolves.toBe('rate_limited');
    await expect(
      fixture.service.handleWebhookUpdate(
        createUpdate({
          updateId: 'u-start-2',
          message: {
            messageId: 'm-start-2',
          },
        }),
      ),
    ).resolves.toBe('connected');

    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledTimes(2);
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100',
        userId: 'admin-1',
        botId: 'bot-1',
        status: ManagedEntityHandshakeOutcomeStatus.RATE_LIMITED,
        reason: 'duplicate_recently',
      }),
    );
    expect(fixture.maxClient.deleteMessage).toHaveBeenCalledWith(
      '-100',
      'm-start-2',
      expect.objectContaining({ immediate: true, botId: 'bot-1' }),
    );
  });

  it('connects a forwarded channel after live bot and forwarder access checks', async () => {
    const fixture = createFixture();

    await expect(fixture.service.handleWebhookUpdate(createForwardedUpdate())).resolves.toBe(
      'connected',
    );

    expect(fixture.maxClient.getChatSnapshot).toHaveBeenCalledWith(
      FORWARDED_SOURCE_CHAT_ID,
      expect.objectContaining({
        botId: 'bot-1',
        bypassCache: true,
        sourceTag: 'managed_handshake',
      }),
    );
    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      FORWARDED_SOURCE_CHAT_ID,
      expect.objectContaining({
        botId: 'bot-1',
        bypassCache: true,
        sourceTag: 'managed_handshake',
      }),
    );
    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      FORWARDED_SOURCE_CHAT_ID,
      [FORWARDED_USER_ID],
      expect.objectContaining({
        botId: 'bot-1',
        bypassCache: true,
        sourceTag: 'managed_handshake',
      }),
    );
    expect(fixture.maxBotLinkService.bindDiscoveredChatBots).toHaveBeenCalledWith({
      chatId: FORWARDED_SOURCE_CHAT_ID,
      primaryBotId: 'bot-1',
      botIds: ['bot-1'],
      title: 'Новости MAX',
      entityType: ChatEntityType.CHANNEL,
    });
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_userId_botId: {
            chatId: FORWARDED_SOURCE_CHAT_ID,
            userId: FORWARDED_USER_ID,
            botId: 'bot-1',
          },
        },
        create: expect.objectContaining({
          entityType: ChatEntityType.CHANNEL,
          state: ManagedEntityAccessState.GRANTED,
          source: 'handshake_start',
        }),
      }),
    );
    expect(fixture.prisma.managedBotChatCatalog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          link: FORWARDED_SOURCE_LINK,
          avatarUrl: FORWARDED_SOURCE_AVATAR_URL,
        }),
        update: expect.objectContaining({
          link: FORWARDED_SOURCE_LINK,
          avatarUrl: FORWARDED_SOURCE_AVATAR_URL,
        }),
      }),
    );
    expect(fixture.chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: FORWARDED_SOURCE_CHAT_ID,
        userId: FORWARDED_USER_ID,
        state: 'granted',
        publishedSummary: expect.objectContaining({
          id: FORWARDED_SOURCE_CHAT_ID,
          title: 'Новости MAX',
          entityType: 'channel',
          link: FORWARDED_SOURCE_LINK,
          avatarUrl: FORWARDED_SOURCE_AVATAR_URL,
        }),
      }),
      { acceptNewerGrantedEpoch: true },
    );
    expect(fixture.maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      FORWARDED_PRIVATE_CHAT_ID,
      'Готово, канал подключен.',
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: 'Открыть настройки' })]],
      }),
      expect.objectContaining({ botId: 'bot-1', sourceTag: 'managed_handshake' }),
    );
    expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: FORWARDED_SOURCE_CHAT_ID,
        userId: FORWARDED_USER_ID,
        entityType: ChatEntityType.CHANNEL,
        status: ManagedEntityHandshakeOutcomeStatus.CONNECTED,
      }),
    );
  });

  it.each(['snapshot_denied', 'not_admin', 'member_denied', 'timeout'])(
    'never substitutes another configured bot when the receiving DM bot has %s',
    async (failure) => {
      const fixture = createFixture();
      const denied = { response: { status: 403, data: { code: 'chat.denied' } } };
      fixture.maxBotRegistry.getBotById.mockImplementation((id) =>
        id === 'bot-1' || id === 'bot-2' ? { id, label: 'Бот', state: 'active' as const } : null,
      );
      fixture.maxBotLinkService.getChatExecutionBinding.mockResolvedValue({
        primaryBotId: 'bot-2',
        assignedBotIds: ['bot-1', 'bot-2'],
      });
      if (failure === 'snapshot_denied' || failure === 'timeout') {
        fixture.maxClient.getChatSnapshot.mockRejectedValueOnce(
          failure === 'timeout' ? new Error('timeout') : denied,
        );
      } else if (failure === 'member_denied') {
        fixture.maxClient.getCurrentChatMemberAccess.mockRejectedValueOnce(denied);
      } else {
        fixture.maxClient.getCurrentChatMemberAccess.mockResolvedValueOnce({
          userId: 'bot-1',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        });
      }
      await expect(fixture.service.handleWebhookUpdate(createForwardedUpdate())).resolves.toBe(
        failure === 'timeout' ? 'failed' : 'denied',
      );
      expect(
        fixture.maxClient.getChatSnapshot.mock.calls.map(([, options]) => options.botId),
      ).toEqual(['bot-1']);
      expect(fixture.maxBotLinkService.getChatExecutionBinding).not.toHaveBeenCalled();
      expect(fixture.maxClient.getChatMembersAccess).not.toHaveBeenCalled();
      expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
      expect(fixture.maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
      expect(fixture.maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
        FORWARDED_PRIVATE_CHAT_ID,
        expect.any(String),
        undefined,
        expect.objectContaining({ botId: 'bot-1' }),
      );
      expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
    },
  );

  it('connects a channel administrator with channel permissions and no group read-all flag', async () => {
    const fixture = createFixture();
    fixture.maxClient.getCurrentChatMemberAccess.mockResolvedValueOnce({
      userId: 'bot-1',
      isAdmin: true,
      isOwner: false,
      explicitPrivilegeEvidence: true,
      permissionsKnown: true,
      permissions: ['write', 'edit', 'delete'],
    });
    await expect(fixture.service.handleWebhookUpdate(createForwardedUpdate())).resolves.toBe(
      'connected',
    );
    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(fixture.maxBotLinkService.getChatExecutionBinding).not.toHaveBeenCalled();
  });

  it('checks only the exact receiving bot even when many other bots are assigned', async () => {
    const fixture = createFixture();
    fixture.maxBotLinkService.getChatExecutionBinding.mockResolvedValue({
      primaryBotId: 'bot-2',
      assignedBotIds: ['bot-1', 'bot-2', 'bot-3', 'bot-4', 'bot-5'],
    });
    fixture.maxClient.getChatSnapshot.mockRejectedValue({ response: { status: 403 } });
    await expect(fixture.service.handleWebhookUpdate(createForwardedUpdate())).resolves.toBe(
      'denied',
    );
    expect(
      fixture.maxClient.getChatSnapshot.mock.calls.map(([, options]) => options.botId),
    ).toEqual(['bot-1']);
    expect(fixture.maxBotLinkService.getChatExecutionBinding).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
  });

  it('does not mistake a failed user lookup for missing bot administrator rights', async () => {
    const fixture = createFixture();
    fixture.maxClient.getChatMembersAccess.mockRejectedValueOnce({ response: { status: 403 } });
    await expect(fixture.service.handleWebhookUpdate(createForwardedUpdate())).resolves.toBe(
      'failed',
    );
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      FORWARDED_PRIVATE_CHAT_ID,
      'Не удалось проверить доступ. Попробуйте еще раз.',
      undefined,
      expect.anything(),
    );
  });

  it.each(['chat', 'channel'])(
    'keeps failed and anonymous %s handshakes silent',
    async (entityType) => {
      for (const result of ['superseded', 'anonymous', 'timeout', 'bot_denied', 'user_denied']) {
        const fixture = createFixture();
        if (result === 'superseded')
          fixture.maxBotLinkService.recordBotAccessProbe.mockResolvedValueOnce(false);
        if (result === 'timeout')
          fixture.maxClient.getCurrentChatMemberAccess.mockRejectedValueOnce(new Error('timeout'));
        if (result === 'bot_denied')
          fixture.maxClient.getCurrentChatMemberAccess.mockResolvedValueOnce({
            userId: 'bot-1',
            isAdmin: false,
            isOwner: false,
            explicitPrivilegeEvidence: true,
            permissionsKnown: true,
            permissions: [],
          });
        if (result === 'user_denied')
          fixture.maxClient.getChatMembersAccess.mockResolvedValueOnce(new Map());
        await fixture.service.handleWebhookUpdate(
          createUpdate({
            message: {
              entityType,
              senderId: result === 'anonymous' ? 'bot-1' : 'admin-1',
            },
          }),
        );
        expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
        expect(fixture.maxClient.sendMessage).not.toHaveBeenCalled();
      }
    },
  );

  it('confirms a channel Start once and preserves connection when the send times out', async () => {
    const fixture = createFixture();
    fixture.maxClient.sendMessage.mockRejectedValueOnce(new Error('timeout'));
    const update = createUpdate({ message: { entityType: 'channel' } });
    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('connected');
    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('rate_limited');
    expect(fixture.maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.sendMessage).toHaveBeenCalledWith(
      '-100',
      'Готово, канал подключен.',
      expect.anything(),
      expect.objectContaining({ botId: 'bot-1', immediate: true, autoDeleteDelayMs: 180_000 }),
    );
  });

  it('connects a forwarded group chat using the live source entity type', async () => {
    const fixture = createFixture();
    const sourceChatId = '-70000000000002';
    fixture.maxClient.getChatSnapshot.mockResolvedValueOnce({
      chatId: sourceChatId,
      title: 'Рабочая группа',
      participantsCount: 8,
      status: 'active',
      isPublic: false,
      link: null,
      lastEventAt: null,
      entityType: 'chat',
      avatarUrl: null,
    });

    await expect(
      fixture.service.handleWebhookUpdate(
        createForwardedUpdate({
          updateId: 'u-forward-chat-1',
          incomingMessageId: 'm-forward-chat-1',
          sourceChatId,
          sourceMessageId: 'mid-source-chat-1',
        }),
      ),
    ).resolves.toBe('connected');

    expect(fixture.maxBotLinkService.bindDiscoveredChatBots).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: sourceChatId,
        title: 'Рабочая группа',
        entityType: ChatEntityType.CHAT,
      }),
    );
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          chatId: sourceChatId,
          userId: FORWARDED_USER_ID,
          entityType: ChatEntityType.CHAT,
          state: ManagedEntityAccessState.GRANTED,
        }),
      }),
    );
    expect(fixture.chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: sourceChatId,
        userId: FORWARDED_USER_ID,
        state: 'granted',
        publishedSummary: expect.objectContaining({
          id: sourceChatId,
          title: 'Рабочая группа',
          entityType: 'chat',
        }),
      }),
      { acceptNewerGrantedEpoch: true },
    );
    expect(fixture.maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      FORWARDED_PRIVATE_CHAT_ID,
      'Готово, чат подключен.',
      expect.anything(),
      expect.objectContaining({ botId: 'bot-1', sourceTag: 'managed_handshake' }),
    );
    expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('denies forwarded recovery when the forwarder is not a source channel admin', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-01T10:00:00.000Z'));
    const fixture = createFixture();
    const update = createForwardedUpdate();
    fixture.maxClient.getChatMembersAccess.mockResolvedValueOnce(
      new Map([
        [
          FORWARDED_USER_ID,
          {
            userId: FORWARDED_USER_ID,
            isBot: false,
            isAdmin: false,
            isOwner: false,
            explicitPrivilegeEvidence: true,
            permissionsKnown: true,
            permissions: [],
          },
        ],
      ]),
    );

    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('denied');

    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessageImmediateWithId).toHaveBeenNthCalledWith(
      1,
      FORWARDED_PRIVATE_CHAT_ID,
      'Подключить канал может только владелец или администратор.',
      undefined,
      expect.objectContaining({ botId: 'bot-1', sourceTag: 'managed_handshake' }),
    );
    expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: FORWARDED_SOURCE_CHAT_ID,
        userId: FORWARDED_USER_ID,
        status: ManagedEntityHandshakeOutcomeStatus.USER_DENIED,
        reason: 'user_not_admin',
      }),
    );

    await expect(
      fixture.service.handleWebhookUpdate(
        createForwardedUpdate({
          updateId: 'u-forward-other-source',
          incomingMessageId: 'm-forward-other-source',
          sourceChatId: '-70000000000002',
          sourceMessageId: 'mid-forward-other-source',
        }),
      ),
    ).resolves.toBe('rate_limited');

    jest.advanceTimersByTime(FORWARDED_ACTOR_BURST_LIMIT_MS + 1);
    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('connected');

    expect(fixture.maxClient.getChatSnapshot).toHaveBeenCalledTimes(2);
    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledTimes(1);
  });

  it('denies forwarded recovery when the bot is not a source channel admin', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-01T10:00:00.000Z'));
    const fixture = createFixture();
    const update = createForwardedUpdate();
    fixture.maxClient.getCurrentChatMemberAccess.mockResolvedValueOnce({
      userId: 'bot-1',
      isAdmin: false,
      isOwner: false,
      explicitPrivilegeEvidence: true,
      permissionsKnown: true,
      permissions: [],
    });

    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('denied');

    expect(fixture.maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessageImmediateWithId).toHaveBeenNthCalledWith(
      1,
      FORWARDED_PRIVATE_CHAT_ID,
      'Бот не администратор канала. Назначьте бота администратором и перешлите сообщение еще раз.',
      undefined,
      expect.objectContaining({ botId: 'bot-1', sourceTag: 'managed_handshake' }),
    );
    expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();

    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('rate_limited');

    jest.advanceTimersByTime(FORWARDED_ACTOR_BURST_LIMIT_MS + 1);
    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('connected');

    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledTimes(1);
  });

  it('requires read_all_messages for a forwarded group recovery bot admin', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-01T10:00:00.000Z'));
    const fixture = createFixture();
    const update = createForwardedUpdate();
    fixture.maxClient.getChatSnapshot.mockResolvedValue({
      ...(await fixture.maxClient.getChatSnapshot()),
      entityType: 'chat',
    });
    fixture.maxClient.getCurrentChatMemberAccess.mockResolvedValueOnce({
      userId: 'bot-1',
      isAdmin: true,
      isOwner: false,
      explicitPrivilegeEvidence: true,
      permissionsKnown: true,
      permissions: ['write'],
    });

    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('denied');

    expect(fixture.maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessageImmediateWithId).toHaveBeenNthCalledWith(
      1,
      FORWARDED_PRIVATE_CHAT_ID,
      'У бота нет доступа ко всем сообщениям чата. Включите это право и перешлите сообщение еще раз.',
      undefined,
      expect.objectContaining({ botId: 'bot-1', sourceTag: 'managed_handshake' }),
    );
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ManagedEntityHandshakeOutcomeStatus.BOT_DENIED,
        reason: 'bot_missing_read_all_messages',
      }),
    );

    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('rate_limited');

    jest.advanceTimersByTime(FORWARDED_ACTOR_BURST_LIMIT_MS + 1);
    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('connected');

    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledTimes(1);
  });

  it('does not activate a forwarded recovery owner without confirmed channel delete permission', async () => {
    const fixture = createFixture();
    fixture.maxClient.getCurrentChatMemberAccess.mockResolvedValueOnce({
      userId: 'bot-1',
      isAdmin: false,
      isOwner: true,
      explicitPrivilegeEvidence: true,
      permissionsKnown: true,
      permissions: [],
    });

    await expect(fixture.service.handleWebhookUpdate(createForwardedUpdate())).resolves.toBe(
      'denied',
    );

    expect(fixture.maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
  });

  it('releases forwarding throttle after a terminal source lookup denial', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-01T10:00:00.000Z'));
    const fixture = createFixture();
    const update = createForwardedUpdate();
    fixture.maxClient.getChatSnapshot.mockRejectedValueOnce({
      response: {
        status: 403,
        data: { code: 'chat.denied' },
      },
    });

    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('denied');
    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('rate_limited');

    jest.advanceTimersByTime(FORWARDED_ACTOR_BURST_LIMIT_MS + 1);
    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('connected');

    expect(fixture.maxClient.getChatSnapshot).toHaveBeenCalledTimes(2);
    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.sendMessageImmediateWithId).toHaveBeenNthCalledWith(
      1,
      FORWARDED_PRIVATE_CHAT_ID,
      'Не удалось проверить доступ к источнику пересылки. Перешлите сообщение непосредственно из нужного чата или канала. Если бот уже администратор, повторно добавлять его не нужно.',
      undefined,
      expect.objectContaining({ botId: 'bot-1', sourceTag: 'managed_handshake' }),
    );
  });

  it('releases forwarded recovery deduplication after a transient source lookup failure', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-01T10:00:00.000Z'));
    const fixture = createFixture();
    const update = createForwardedUpdate();
    fixture.maxClient.getChatSnapshot.mockRejectedValueOnce(new Error('temporary timeout'));

    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('failed');
    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('rate_limited');

    jest.advanceTimersByTime(FORWARDED_ACTOR_BURST_LIMIT_MS + 1);
    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('connected');

    expect(fixture.maxClient.getChatSnapshot).toHaveBeenCalledTimes(2);
    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.sendMessageImmediateWithId).toHaveBeenNthCalledWith(
      1,
      FORWARDED_PRIVATE_CHAT_ID,
      'Не удалось проверить доступ. Перешлите сообщение еще раз позже.',
      undefined,
      expect.objectContaining({ botId: 'bot-1', sourceTag: 'managed_handshake' }),
    );
  });

  it('deduplicates repeated delivery of the same forwarded message', async () => {
    const fixture = createFixture();
    const update = createForwardedUpdate();

    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('connected');
    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('rate_limited');
    await expect(
      fixture.service.handleWebhookUpdate(
        createForwardedUpdate({
          updateId: 'u-forward-2',
          incomingMessageId: 'm-forward-2',
          sourceMessageId: 'mid-source-2',
        }),
      ),
    ).resolves.toBe('rate_limited');

    expect(fixture.maxClient.getChatSnapshot).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledTimes(1);
    expect(fixture.chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('keeps a completed forwarded recovery throttled when outcome telemetry fails', async () => {
    const fixture = createFixture();
    const update = createForwardedUpdate();
    fixture.handshakeOutcomes.recordOutcome.mockRejectedValueOnce(
      new Error('outcome storage unavailable'),
    );

    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('connected');
    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('rate_limited');

    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledTimes(1);
    expect(fixture.chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(fixture.handshakeOutcomes.recordOutcome).toHaveBeenCalledTimes(1);
  });

  it('prunes expired handshake throttle keys and caps retained entries', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-01T10:00:00.000Z'));
    const fixture = createFixture();
    const internals = fixture.service as unknown as {
      rateLimitUntilMs: Map<string, number>;
      reserveRateLimitKey: (key: string) => boolean;
    };

    try {
      for (let index = 0; index < 2_050; index += 1) {
        expect(internals.reserveRateLimitKey(`test:${index}`)).toBe(true);
      }
      expect(internals.rateLimitUntilMs.size).toBe(2_048);
      expect(internals.rateLimitUntilMs.has('test:0')).toBe(false);

      jest.advanceTimersByTime(3 * 60 * 1_000 + 1);
      expect(internals.reserveRateLimitKey('test:fresh')).toBe(true);
      expect(internals.rateLimitUntilMs.size).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('connects from the bounded legacy forwarded_message shape', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.handleWebhookUpdate(
        createForwardedUpdate({
          updateId: 'u-forward-legacy-1',
          incomingMessageId: 'm-forward-legacy-1',
          rawBody: {
            forwarded_message: {
              chat_id: Number(FORWARDED_SOURCE_CHAT_ID),
              message_id: 'mid-source-legacy-1',
            },
          },
          rawLink: null,
        }),
      ),
    ).resolves.toBe('connected');

    expect(fixture.maxClient.getChatSnapshot).toHaveBeenCalledWith(
      FORWARDED_SOURCE_CHAT_ID,
      expect.objectContaining({ bypassCache: true }),
    );
    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      FORWARDED_SOURCE_CHAT_ID,
      [FORWARDED_USER_ID],
      expect.objectContaining({ bypassCache: true }),
    );
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledTimes(1);
    expect(fixture.maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      FORWARDED_PRIVATE_CHAT_ID,
      'Готово, канал подключен.',
      expect.anything(),
      expect.objectContaining({ botId: 'bot-1' }),
    );
  });

  it('connects when MAX keeps sender, recipient, and incoming message ids on flat fields', async () => {
    const fixture = createFixture();
    const update = {
      updateId: 'u-forward-flat-1',
      botId: 'bot-1',
      type: 'message_created',
      message: {
        messageId: 'm-forward-flat-1',
        chatId: FORWARDED_PRIVATE_CHAT_ID,
        senderId: FORWARDED_USER_ID,
        text: 'Пересланная публикация',
        createdAt: new Date().toISOString(),
      },
      raw: {
        update_type: 'message_created',
        message: {
          message_id: 'm-forward-flat-1',
          sender_id: Number(FORWARDED_USER_ID),
          chat_id: Number(FORWARDED_PRIVATE_CHAT_ID),
          link: {
            type: 'forward',
            chat_id: Number(FORWARDED_SOURCE_CHAT_ID),
            message: {
              mid: 'mid-source-flat-1',
              text: 'Исходная публикация',
            },
          },
        },
      },
    } as never;

    await expect(fixture.service.handleWebhookUpdate(update)).resolves.toBe('connected');

    expect(fixture.maxClient.getChatSnapshot).toHaveBeenCalledWith(
      FORWARDED_SOURCE_CHAT_ID,
      expect.objectContaining({ bypassCache: true }),
    );
    expect(fixture.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      FORWARDED_SOURCE_CHAT_ID,
      expect.objectContaining({ bypassCache: true }),
    );
    expect(fixture.maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      FORWARDED_SOURCE_CHAT_ID,
      [FORWARDED_USER_ID],
      expect.objectContaining({ bypassCache: true }),
    );
    expect(fixture.prisma.managedEntityAccessEdge.upsert).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'without the linked source message id',
      () => createForwardedUpdate({ sourceMessageId: null }),
    ],
    [
      'when normalized and raw sender ids differ',
      () => createForwardedUpdate({ normalizedSenderId: '195714584' }),
    ],
    ['with direct outer message text', () => createForwardedUpdate({ rawBody: { text: 'Старт' } })],
  ])('ignores a malformed forwarded recovery candidate %s', async (_label, buildUpdate) => {
    const fixture = createFixture();

    await expect(fixture.service.handleWebhookUpdate(buildUpdate())).resolves.toBe('ignored');

    expect(fixture.maxClient.getChatSnapshot).not.toHaveBeenCalled();
    expect(fixture.maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(fixture.maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
  });

  it('ignores a forwarded message whose source is a private dialog', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.handleWebhookUpdate(
        createForwardedUpdate({ sourceChatId: '70000000000001' }),
      ),
    ).resolves.toBe('ignored');

    expect(fixture.maxClient.getChatSnapshot).not.toHaveBeenCalled();
    expect(fixture.maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
  });

  it.each([
    ['a group-chat recipient', 'chat'],
    ['a channel recipient', 'channel'],
  ])('ignores a forwarded message delivered to %s', async (_label, recipientChatType) => {
    const fixture = createFixture();
    const recipientChatId = '-80000000000001';

    await expect(
      fixture.service.handleWebhookUpdate(
        createForwardedUpdate({
          recipientChatType,
          rawRecipientChatId: Number(recipientChatId),
          normalizedChatId: recipientChatId,
        }),
      ),
    ).resolves.toBe('ignored');

    expect(fixture.maxClient.getChatSnapshot).not.toHaveBeenCalled();
    expect(fixture.maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(fixture.prisma.managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    expect(fixture.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
  });
});
