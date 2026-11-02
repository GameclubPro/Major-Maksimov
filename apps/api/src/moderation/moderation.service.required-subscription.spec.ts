import { ChannelPostDemandRuntime } from './channel-post-demand-runtime';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import type { MaxClientService } from '../max/max-client.service';
import type { ManagedEntityAccessLossService } from '../max/managed-entity-access-loss.service';
import {
  REQUIRED_SUBSCRIPTION_MAX_CHANNELS,
  ChatEntityType,
  SanctionAction,
  ModerationService,
  withAutomaticMutePersistenceFixture,
  MODERATION_ACTION_ACCESS_LOSS_HOT_PATH_TIMEOUT_MS,
  MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
  REQUIRED_SUBSCRIPTION_MEMBERSHIP_HOT_PATH_TIMEOUT_MS,
  extractSqlText,
  userMention,
  expectImmediateDeleteMessage,
  expectImmediateKickMember,
  expectImmediateBanMember,
  createMaxApiError,
  createDeferred,
  createSettings,
  createUpdate,
  createRequiredSubscriptionRedisCounter,
  createModerationServiceWithSanctionStateLock,
  type MaxUpdate,
} from './moderation.service.spec-support';
import {
  RequiredSubscriptionExecutionRejectedError,
  RequiredSubscriptionInitialSourceUnavailableError,
  RequiredSubscriptionMembershipUnavailableError,
  RequiredSubscriptionDeleteSourceUnavailableError,
} from './required-subscription-execution-guard.service';

// FLAG: This suite verifies orchestration with an explicit successful deletion boundary.
// Real current-policy, lease, receipt and selected-token guards run in the native fullpath suite.
function installRequiredSubscriptionFixtureGuards(service: ModerationService): ModerationService {
  const boundary = service as unknown as {
    moderationDeleteIntentService?: unknown;
    executeModerationDelete(
      input: { chatId: string; messageId: string },
      options?: unknown,
    ): Promise<unknown>;
    deleteMessageImmediatelyLegacy(
      chatId: string,
      messageId: string,
      options?: unknown,
    ): Promise<{ ok: boolean; botId: string | null }>;
  };
  const original = boundary.executeModerationDelete.bind(service);
  Object.assign(service, {
    requiredSubscriptionExecutionGuard: {
      assertNoticeAllowed: jest.fn().mockResolvedValue(undefined),
      authorize: jest
        .fn()
        .mockResolvedValue({ reasonKeys: ['REQUIRED_SUBSCRIPTION:message-delete'] }),
    },
    executeModerationDelete: jest.fn(
      async (input: { chatId: string; messageId: string }, options?: unknown) => {
        if (boundary.moderationDeleteIntentService) return original(input, options);
        const result = await boundary.deleteMessageImmediatelyLegacy(
          input.chatId,
          input.messageId,
          options,
        );
        return {
          accepted: result.ok,
          gone: result.ok,
          deleted: result.ok,
          eventPersistedByIntent: false,
          botId: result.botId,
        };
      },
    ),
  });
  return service;
}

function createRequiredSubscriptionService(
  ...args: ConstructorParameters<typeof ModerationService>
): ModerationService {
  return installRequiredSubscriptionFixtureGuards(new ModerationService(...args));
}

describe('ModerationService', () => {
  beforeEach(() =>
    jest.spyOn(ChannelPostDemandRuntime.prototype, 'selectChannels').mockResolvedValue([]),
  );
  afterEach(() => jest.restoreAllMocks());
  describe('required subscription', () => {
    function createPrismaForRequiredSubscription(
      settingsOverrides: Record<string, unknown> = {},
      adminUserIds: string[] = [],
    ) {
      const persistedModerationEvents = new Map<string, { metadata: unknown }>();
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings(settingsOverrides),
            domains: [],
            admins: adminUserIds.map((userId) => ({ userId })),
            rules: {
              publishedUrl: null,
              publishedMessageId: 'mid-rules-1',
            },
          }),
          findMany: jest.fn().mockResolvedValue([]),
        },
        violation: {
          create: jest.fn(),
          count: jest.fn().mockResolvedValue(1),
        },
        moderationEvent: {
          findUnique: jest.fn(async (args: { where: { id: string } }) => {
            return persistedModerationEvents.get(args.where.id) ?? null;
          }),
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
          upsert: jest.fn(
            async (args: {
              where: { id: string };
              create: { metadata?: unknown; ruleCode?: unknown };
            }) => {
              const existing = persistedModerationEvents.get(args.where.id);
              if (existing) {
                return existing;
              }
              const created = { metadata: args.create.metadata ?? null };
              persistedModerationEvents.set(args.where.id, created);
              return created;
            },
          ),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
        globalSpammer: {
          upsert: jest.fn(),
        },
        chatRules: {
          update: jest.fn(),
        },
      };
      return withAutomaticMutePersistenceFixture(prisma);
    }

    function createRequiredSubscriptionMediaUpdate(params: {
      messageId: string;
      createdAt: string;
      mediaGroupId?: string;
      chatId?: string;
      userId?: string;
    }): MaxUpdate {
      const update = createUpdate();
      update.updateId = `update-${params.messageId}`;
      if (!update.message) return update;
      update.message.messageId = params.messageId;
      update.message.createdAt = params.createdAt;
      update.message.chatId = params.chatId ?? 'chat-1';
      update.message.senderId = params.userId ?? 'user-1';
      update.message.text = '';
      update.raw = {
        message: {
          body: {
            ...(params.mediaGroupId ? { media_group_id: params.mediaGroupId } : {}),
            attachments: [
              {
                type: 'image',
                payload: { url: `https://cdn.example/${params.messageId}.jpg` },
              },
            ],
          },
        },
      };
      return update;
    }

    function createRequiredSubscriptionMaxClient(
      sendMessage: jest.Mock = jest.fn().mockResolvedValue(undefined),
    ) {
      return {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage,
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
    }

    describe('moderation action fallback', () => {
      it('accepts unified moderation routes when the link service exposes them', async () => {
        const operation = jest.fn().mockResolvedValue(undefined);
        const maxBotLinkService = {
          resolveBotRoutes: jest.fn().mockResolvedValue({
            purpose: 'moderation_action',
            chatId: 'chat-route-1',
            primaryBotId: 'id613002203036_bot',
            botId: 'id613002203036_4_bot',
            candidateBotIds: ['id613002203036_4_bot'],
            reason: 'alternate_confirmed',
            action: 'delete_message',
          }),
        };
        const service = createRequiredSubscriptionService(
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          maxBotLinkService as never,
        );

        await expect(
          (service as any).executeModerationActionWithFallback({
            chatId: 'chat-route-1',
            action: 'delete_message',
            messageId: 'message-1',
            operation,
          }),
        ).resolves.toBe(true);

        expect(maxBotLinkService.resolveBotRoutes).toHaveBeenCalledWith({
          purpose: 'moderation_action',
          chatId: 'chat-route-1',
          action: 'delete_message',
          fallbackToPrimary: true,
        });
        expect(operation).toHaveBeenCalledWith('id613002203036_4_bot');
      });

      it('refreshes bot access snapshots when stale member-moderation snapshots leave no candidates', async () => {
        const prisma = {
          chat: {
            findUnique: jest.fn().mockResolvedValue({
              botMemberships: [{ botId: 'id613002203036_4_bot', status: 'ACTIVE' }],
            }),
          },
          chatBotMembership: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        };
        const maxClient = {
          getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
            userId: '613002203036_4',
            isAdmin: true,
            isOwner: false,
            permissions: ['add_remove_members'],
          }),
        };
        const maxBotLinkService = {
          resolveBotIdsForModerationAction: jest
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce(['id613002203036_4_bot']),
          recordBotAccessProbe: jest.fn().mockResolvedValue(true),
          getResolvedBotSync: jest.fn((botId?: string | null) => ({
            id: botId ?? 'id613002203036_bot',
          })),
        };
        const operation = jest.fn().mockResolvedValue(undefined);
        const service = createRequiredSubscriptionService(
          prisma as never,
          {} as never,
          {} as never,
          maxClient as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          maxBotLinkService as never,
        );

        await expect(
          (service as any).executeModerationActionWithFallback({
            chatId: 'chat-1',
            action: 'moderate_member',
            userId: 'user-1',
            operation,
          }),
        ).resolves.toBe(true);

        expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith('chat-1', {
          botId: 'id613002203036_4_bot',
          bypassCache: true,
          trafficClass: 'background',
          actionHealthLane: 'background',
          timeoutMs: 1_500,
        });
        expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith(
          expect.objectContaining({
            chatId: 'chat-1',
            botId: 'id613002203036_4_bot',
            access: expect.objectContaining({
              isAdmin: true,
              isOwner: false,
              permissions: ['add_remove_members'],
            }),
            source: 'moderation_action_moderate_member',
            checkedAt: expect.any(Date),
            allowMembershipRecovery: false,
          }),
        );
        expect(prisma.chatBotMembership.updateMany).not.toHaveBeenCalled();
        expect(operation).toHaveBeenCalledWith('id613002203036_4_bot');
      });

      it.each<{ status: number; code?: string; denied: boolean }>([
        { status: 401, denied: false },
        { status: 403, denied: false },
        { status: 404, denied: false },
        { status: 401, code: 'access.denied', denied: false },
        { status: 404, code: 'message.not.found', denied: false },
        { status: 404, code: 'user.not.found', denied: false },
        { status: 404, code: 'member.not.found', denied: false },
        { status: 403, code: 'access.denied', denied: true },
        { status: 403, code: 'chat.denied', denied: true },
        { status: 404, code: 'chat.not.found', denied: true },
      ])(
        'requires explicit own-member denial for HTTP $status / $code',
        async ({ status, code, denied }) => {
          const prisma = {
            chat: {
              findUnique: jest.fn().mockResolvedValue({
                entityType: ChatEntityType.CHAT,
                botMemberships: [{ botId: 'id613002203036_4_bot', status: 'ACTIVE' }],
              }),
            },
          };
          const getCurrentChatMemberAccess: jest.MockedFunction<
            MaxClientService['getCurrentChatMemberAccess']
          > = jest
            .fn()
            .mockRejectedValue(
              createMaxApiError(status, 'chat denied; bot is not a chat member', code),
            );
          const recordBotAccessProbe: jest.MockedFunction<
            MaxBotLinkService['recordBotAccessProbe']
          > = jest.fn().mockResolvedValue(true);
          const maxBotLinkService = {
            resolveBotIdsForModerationAction: jest.fn().mockResolvedValue([]),
            recordBotAccessProbe,
            getResolvedBotSync: jest.fn((botId?: string | null) => ({
              id: botId ?? 'id613002203036_bot',
            })),
          };
          const operation = jest.fn().mockResolvedValue(undefined);
          const service = createRequiredSubscriptionService(
            prisma as never,
            {} as never,
            {} as never,
            { getCurrentChatMemberAccess } as never,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            maxBotLinkService as never,
          );

          await expect(
            (service as any).executeModerationActionWithFallback({
              chatId: 'chat-1',
              action: 'moderate_member',
              userId: 'user-1',
              operation,
            }),
          ).resolves.toBe(false);

          expect(getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
          expect(operation).not.toHaveBeenCalled();
          if (denied) {
            expect(recordBotAccessProbe).toHaveBeenCalledTimes(1);
            expect(recordBotAccessProbe).toHaveBeenCalledWith(
              expect.objectContaining({
                chatId: 'chat-1',
                botId: 'id613002203036_4_bot',
                access: null,
                source: 'moderation_action_moderate_member',
                allowMembershipRecovery: false,
              }),
            );
          } else {
            expect(recordBotAccessProbe).not.toHaveBeenCalled();
          }
        },
      );

      it.each<{ status: number; code?: string; denied: boolean }>([
        { status: 403, denied: false },
        { status: 403, code: 'user.not.found', denied: false },
        { status: 404, code: 'user.not.found', denied: false },
        { status: 403, code: 'member.not.found', denied: false },
        { status: 404, code: 'member.not.found', denied: false },
        { status: 404, code: 'message.not.found', denied: false },
        { status: 403, code: 'access.denied', denied: false },
        { status: 403, code: 'chat.denied', denied: true },
        { status: 404, code: 'chat.not.found', denied: true },
      ])(
        'preserves baseline membership after target mutation HTTP $status / $code unless chat denial is explicit',
        async ({ status, code, denied }) => {
          const originalAccess = {
            isAdmin: true,
            isOwner: false,
            permissions: ['read_all_messages', 'write', 'add_remove_members'],
          };
          let storedAccess: Parameters<MaxBotLinkService['recordBotAccessProbe']>[0]['access'] =
            originalAccess;
          const recordBotAccessProbe: jest.MockedFunction<
            MaxBotLinkService['recordBotAccessProbe']
          > = jest.fn(
            async ({ access }: Parameters<MaxBotLinkService['recordBotAccessProbe']>[0]) => {
              storedAccess = access;
              return true;
            },
          );
          const recordIfManagedEntityAccessLost: jest.MockedFunction<
            ManagedEntityAccessLossService['recordIfManagedEntityAccessLost']
          > = jest.fn().mockResolvedValue(null);
          const maxBotLinkService = {
            resolveBotIdsForModerationAction: jest
              .fn()
              .mockResolvedValue(['id613002203036_bot', 'id613002203036_4_bot']),
            recordBotAccessProbe,
            getResolvedBotSync: jest.fn((botId?: string | null) => ({
              id: botId ?? 'id613002203036_bot',
            })),
          };
          const mutationError = createMaxApiError(
            status,
            'chat denied; bot is not a chat member',
            code,
          );
          const operation = jest
            .fn()
            .mockRejectedValueOnce(mutationError)
            .mockResolvedValueOnce(undefined);
          const service = createRequiredSubscriptionService(
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            maxBotLinkService as never,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            { recordIfManagedEntityAccessLost } as never,
          );

          await expect(
            (service as any).executeModerationActionWithFallback({
              chatId: 'chat-1',
              action: 'moderate_member',
              userId: 'user-1',
              operation,
            }),
          ).resolves.toBe(true);

          expect(operation.mock.calls).toEqual([['id613002203036_bot'], ['id613002203036_4_bot']]);
          await expect(
            (service as any).isModerationActionBotBackoffActive(
              'chat-1',
              'moderate_member',
              'id613002203036_bot',
            ),
          ).resolves.toBe(true);
          await expect(
            (service as any).isModerationActionBotBackoffActive(
              'chat-1',
              'moderate_member',
              'id613002203036_4_bot',
            ),
          ).resolves.toBe(false);
          if (denied) {
            expect(recordIfManagedEntityAccessLost).toHaveBeenCalledTimes(1);
            expect(recordBotAccessProbe).toHaveBeenCalledTimes(1);
            expect(storedAccess).toBeNull();
          } else {
            expect(recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
            expect(recordBotAccessProbe).not.toHaveBeenCalled();
            expect(storedAccess).toBe(originalAccess);
          }
        },
      );

      it('requires read-all plus MAX write permission for refreshed chat delete access', async () => {
        const prisma = {
          chat: {
            findUnique: jest.fn().mockResolvedValue({
              entityType: ChatEntityType.CHAT,
              botMemberships: [{ botId: 'id613002203036_4_bot', status: 'ACTIVE' }],
            }),
          },
          chatBotMembership: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        };
        const maxClient = {
          getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
            userId: '613002203036_4',
            isAdmin: true,
            isOwner: false,
            permissions: ['read_all_messages', 'write'],
          }),
        };
        const maxBotLinkService = {
          resolveBotIdsForModerationAction: jest
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce(['id613002203036_4_bot']),
          recordBotAccessProbe: jest.fn().mockResolvedValue(true),
          getResolvedBotSync: jest.fn((botId?: string | null) => ({
            id: botId ?? 'id613002203036_bot',
          })),
        };
        const operation = jest.fn().mockResolvedValue(undefined);
        const service = createRequiredSubscriptionService(
          prisma as never,
          {} as never,
          {} as never,
          maxClient as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          maxBotLinkService as never,
        );

        await expect(
          (service as any).executeModerationActionWithFallback({
            chatId: 'chat-1',
            action: 'delete_message',
            messageId: 'message-1',
            operation,
          }),
        ).resolves.toBe(true);

        expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith(
          expect.objectContaining({
            chatId: 'chat-1',
            botId: 'id613002203036_4_bot',
            access: expect.objectContaining({
              isAdmin: true,
              isOwner: false,
              permissions: ['read_all_messages', 'write'],
            }),
            source: 'moderation_action_delete_message',
            checkedAt: expect.any(Date),
            allowMembershipRecovery: false,
          }),
        );
        expect(prisma.chatBotMembership.updateMany).not.toHaveBeenCalled();
        expect(operation).toHaveBeenCalledWith('id613002203036_4_bot');
      });

      it('does not retry a moderation action when the live probe loses its lifecycle CAS', async () => {
        const prisma = {
          chat: {
            findUnique: jest.fn().mockResolvedValue({
              entityType: ChatEntityType.CHAT,
              botMemberships: [{ botId: 'id613002203036_4_bot', status: 'ACTIVE' }],
            }),
          },
        };
        const maxClient = {
          getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
            userId: '613002203036_4',
            isAdmin: true,
            isOwner: false,
            permissions: ['read_all_messages', 'write'],
          }),
        };
        const maxBotLinkService = {
          resolveBotIdsForModerationAction: jest
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce(['id613002203036_4_bot']),
          recordBotAccessProbe: jest.fn().mockResolvedValue(false),
          getResolvedBotSync: jest.fn((botId?: string | null) => ({
            id: botId ?? 'id613002203036_bot',
          })),
        };
        const operation = jest.fn().mockResolvedValue(undefined);
        const service = createRequiredSubscriptionService(
          prisma as never,
          {} as never,
          {} as never,
          maxClient as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          maxBotLinkService as never,
        );

        await expect(
          (service as any).executeModerationActionWithFallback({
            chatId: 'chat-1',
            action: 'delete_message',
            messageId: 'message-1',
            operation,
          }),
        ).resolves.toBe(false);

        expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(1);
        expect(operation).not.toHaveBeenCalled();
      });

      it('keeps stale moderation action backoff out of the hot path and schedules a recheck', async () => {
        const prisma = {
          chat: {
            findUnique: jest.fn().mockResolvedValue({
              botMemberships: [{ botId: 'id613002203036_4_bot', status: 'ACTIVE' }],
            }),
          },
          chatBotMembership: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        };
        const maxClient = {
          getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
            userId: '613002203036_4',
            isAdmin: true,
            isOwner: false,
            permissions: ['delete_messages'],
          }),
        };
        const maxBotLinkService = {
          resolveBotIdsForModerationAction: jest.fn().mockResolvedValue(['id613002203036_4_bot']),
          getResolvedBotSync: jest.fn((botId?: string | null) => ({
            id: botId ?? 'id613002203036_bot',
          })),
        };
        const maxChatAdminRosterSyncService = {
          scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
        };
        const runtimeDiagnosticsService = {
          recordProblemChat: jest.fn().mockResolvedValue(undefined),
        };
        const operation = jest.fn().mockResolvedValue(undefined);
        const service = createRequiredSubscriptionService(
          prisma as never,
          {} as never,
          {} as never,
          maxClient as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          maxBotLinkService as never,
          undefined,
          undefined,
          undefined,
          runtimeDiagnosticsService as never,
          maxChatAdminRosterSyncService as never,
        );

        await (service as any).rememberModerationActionBotBackoff(
          'chat-1',
          'delete_message',
          'id613002203036_4_bot',
        );

        await expect(
          (service as any).executeModerationActionWithFallback({
            chatId: 'chat-1',
            action: 'delete_message',
            messageId: 'msg-1',
            operation,
          }),
        ).resolves.toBe(false);

        expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
        expect(operation).not.toHaveBeenCalled();
        expect(runtimeDiagnosticsService.recordProblemChat).toHaveBeenCalledWith({
          chatId: 'chat-1',
          botId: null,
          category: 'moderation_action_no_candidate',
          severity: 'warning',
          action: 'delete_message',
          statusCode: null,
          reason: 'all candidate bots are temporarily backed off after permission failures',
        });
        expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
          chatId: 'chat-1',
          botIds: [],
          title: null,
          entityType: null,
          source: 'moderation_destructive_path',
          retryUntilMs: null,
        });
        await expect(
          (service as any).isModerationActionBotBackoffActive(
            'chat-1',
            'delete_message',
            'id613002203036_4_bot',
          ),
        ).resolves.toBe(true);
      });

      it('continues to a survivor bot when access-loss persistence exceeds its budget', async () => {
        jest.useFakeTimers();
        const accessLoss = createDeferred<void>();
        const runtimeDiagnosticsService = {
          recordHotPathStageOutcome: jest.fn(),
          recordProblemChat: jest.fn(),
        };
        const maxBotLinkService = {
          resolveBotIdsForModerationAction: jest
            .fn()
            .mockResolvedValue(['id613002203036_bot', 'id613002203036_4_bot']),
          getResolvedBotSync: jest.fn((botId?: string | null) => ({
            id: botId ?? 'id613002203036_bot',
          })),
          recordBotAccessProbe: jest.fn(
            () =>
              new Promise<boolean>(() => {
                // Models a snapshot waiting on the same parent Chat lock.
              }),
          ),
        };
        const managedEntityAccessLossService = {
          recordIfManagedEntityAccessLost: jest.fn().mockReturnValue(accessLoss.promise),
        };
        const terminalError = createMaxApiError(
          403,
          'Request failed with status code 403',
          'chat.denied',
        );
        const operation = jest
          .fn()
          .mockRejectedValueOnce(terminalError)
          .mockResolvedValueOnce(undefined);
        const service = createRequiredSubscriptionService(
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          maxBotLinkService as never,
          undefined,
          undefined,
          undefined,
          runtimeDiagnosticsService as never,
          undefined,
          undefined,
          managedEntityAccessLossService as never,
        );
        const debugSpy = jest
          .spyOn((service as any).logger, 'debug')
          .mockImplementation(() => undefined);

        try {
          const resultPromise = (service as any).executeModerationActionWithFallback({
            chatId: 'chat-1',
            action: 'delete_message',
            messageId: 'message-1',
            operation,
          });

          await Promise.resolve();
          await Promise.resolve();
          await jest.advanceTimersByTimeAsync(MODERATION_ACTION_ACCESS_LOSS_HOT_PATH_TIMEOUT_MS);
          expect(
            managedEntityAccessLossService.recordIfManagedEntityAccessLost,
          ).toHaveBeenCalledWith({
            chatId: 'chat-1',
            botId: 'id613002203036_bot',
            entityType: null,
            source: 'moderation_action:delete_message',
            operation: 'delete',
            error: terminalError,
            lifecycleEventAt: expect.any(Date),
            lifecycleEventType: 'live_probe',
            lifecycleSource: 'live_probe',
          });

          await expect(resultPromise).resolves.toBe(true);
          expect(operation).toHaveBeenNthCalledWith(1, 'id613002203036_bot');
          expect(operation).toHaveBeenNthCalledWith(2, 'id613002203036_4_bot');
          expect(maxBotLinkService.recordBotAccessProbe).not.toHaveBeenCalled();
          expect(runtimeDiagnosticsService.recordHotPathStageOutcome).toHaveBeenCalledWith({
            stage: 'moderation-action-access-loss.deferred',
            outcome: 'skip',
            failOpen: true,
          });
          expect(debugSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              chatId: 'chat-1',
              botId: 'id613002203036_bot',
              action: 'delete_message',
              timeoutMs: MODERATION_ACTION_ACCESS_LOSS_HOT_PATH_TIMEOUT_MS,
            }),
            'Moderation action access-loss recording exceeded hot-path budget; continuing detached',
          );

          accessLoss.resolve();
          await Promise.resolve();
          await Promise.resolve();
          expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith({
            chatId: 'chat-1',
            botId: 'id613002203036_bot',
            access: null,
            source: 'moderation_action_delete_message',
            checkedAt: expect.any(Date),
            allowMembershipRecovery: false,
          });
        } finally {
          debugSpy.mockRestore();
          jest.useRealTimers();
        }
      });

      it('refreshes candidates and retries another bot after a terminal moderation access error', async () => {
        const prisma = {
          chat: {
            findUnique: jest.fn().mockResolvedValue({
              entityType: ChatEntityType.CHAT,
              botMemberships: [
                { botId: 'id613002203036_bot', status: 'ACTIVE' },
                { botId: 'id613002203036_4_bot', status: 'ACTIVE' },
              ],
            }),
          },
          chatBotMembership: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        };
        const maxClient = {
          getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
            userId: '613002203036',
            isAdmin: true,
            isOwner: false,
            permissions: ['add_remove_members'],
          }),
        };
        const maxBotLinkService = {
          resolveBotIdsForModerationAction: jest
            .fn()
            .mockResolvedValueOnce(['id613002203036_bot'])
            .mockResolvedValueOnce(['id613002203036_bot', 'id613002203036_4_bot']),
          recordBotAccessProbe: jest.fn().mockResolvedValue(true),
          getResolvedBotSync: jest.fn((botId?: string | null) => ({
            id: botId ?? 'id613002203036_bot',
          })),
        };
        const maxChatAdminRosterSyncService = {
          scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
        };
        const managedEntityAccessLossService = {
          recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
            classification: {
              kind: 'managed_entity_access_lost',
              reason: 'bot_denied',
              statusCode: 403,
              code: 'chat.denied',
              message: 'request failed with status code 403',
            },
            reason: 'bot_denied',
            recorded: {
              chatId: 'chat-1',
            },
          }),
        };
        const terminalError = createMaxApiError(
          403,
          'Request failed with status code 403',
          'chat.denied',
        );
        const operation = jest.fn().mockImplementation(async (botId?: string) => {
          if (botId === 'id613002203036_bot') {
            throw terminalError;
          }
        });
        const service = createRequiredSubscriptionService(
          prisma as never,
          {} as never,
          {} as never,
          maxClient as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          maxBotLinkService as never,
          undefined,
          undefined,
          undefined,
          undefined,
          maxChatAdminRosterSyncService as never,
          undefined,
          managedEntityAccessLossService as never,
        );

        await expect(
          (service as any).executeModerationActionWithFallback({
            chatId: 'chat-1',
            action: 'moderate_member',
            userId: 'user-1',
            operation,
          }),
        ).resolves.toBe(true);

        expect(operation.mock.calls).toEqual([['id613002203036_bot'], ['id613002203036_4_bot']]);
        expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith('chat-1', {
          botId: 'id613002203036_bot',
          bypassCache: true,
          trafficClass: 'background',
          actionHealthLane: 'background',
          timeoutMs: 1_500,
        });
        expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith('chat-1', {
          botId: 'id613002203036_4_bot',
          bypassCache: true,
          trafficClass: 'background',
          actionHealthLane: 'background',
          timeoutMs: 1_500,
        });
        expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith(
          {
            chatId: 'chat-1',
            botId: 'id613002203036_bot',
            entityType: null,
            source: 'moderation_action:moderate_member',
            operation: 'member_moderation',
            error: terminalError,
            lifecycleEventAt: expect.any(Date),
            lifecycleEventType: 'live_probe',
            lifecycleSource: 'live_probe',
          },
        );
        expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).not.toHaveBeenCalled();
      });

      it('sends ban notice with the bot that won moderation fallback', async () => {
        const prisma = {
          chat: {
            findUnique: jest.fn().mockResolvedValue({
              entityType: ChatEntityType.CHAT,
              primaryBotId: 'id613002203036_bot',
              botId: 'id613002203036_bot',
              botMemberships: [
                { botId: 'id613002203036_bot', status: 'ACTIVE' },
                { botId: 'id613002203036_4_bot', status: 'ACTIVE' },
              ],
            }),
          },
          chatBotMembership: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          moderationEvent: {
            findFirst: jest.fn().mockResolvedValue(null),
          },
        };
        const terminalError = createMaxApiError(
          403,
          'Request failed with status code 403',
          'chat.denied',
        );
        const maxClient = {
          banMember: jest
            .fn()
            .mockImplementation(
              async (_chatId: string, _userId: string, options?: { botId?: string }) => {
                if (options?.botId === 'id613002203036_bot') {
                  throw terminalError;
                }
              },
            ),
          sendMessage: jest.fn().mockResolvedValue({ messageId: 'notice-1' }),
          getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
            userId: '613002203036_4',
            isAdmin: true,
            isOwner: false,
            permissions: ['add_remove_members', 'write'],
          }),
        };
        const maxBotLinkService = {
          resolveBotIdsForModerationAction: jest
            .fn()
            .mockResolvedValueOnce(['id613002203036_bot'])
            .mockResolvedValueOnce(['id613002203036_bot', 'id613002203036_4_bot']),
          recordBotAccessProbe: jest.fn().mockResolvedValue(true),
          getResolvedBotSync: jest.fn((botId?: string | null) => ({
            id: botId ?? 'id613002203036_bot',
          })),
        };
        const managedEntityAccessLossService = {
          recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
            classification: {
              kind: 'managed_entity_access_lost',
              reason: 'bot_denied',
              statusCode: 403,
              code: 'chat.denied',
              message: 'request failed with status code 403',
            },
            reason: 'bot_denied',
            recorded: {
              chatId: 'chat-1',
            },
          }),
        };
        const service = createRequiredSubscriptionService(
          prisma as never,
          {} as never,
          {} as never,
          maxClient as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          maxBotLinkService as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          managedEntityAccessLossService as never,
        );

        await (service as any).applySanctionAction({
          chatId: 'chat-1',
          userId: 'user-1',
          action: SanctionAction.BAN,
          userLabel: userMention('Нарушитель'),
          messageId: 'message-1',
          muteDurationHours: 1,
          deleteBotMessagesEnabled: true,
          deleteBotMessagesDelayMinutes: 3,
          botSpeechStyle: null,
          trackAsGlobalSpammer: false,
          persistModerationEvent: jest.fn().mockResolvedValue({ id: 'sanction-event-fallback' }),
        });

        expect(maxClient.banMember).toHaveBeenCalledWith(
          'chat-1',
          'user-1',
          expect.objectContaining({ botId: 'id613002203036_bot' }),
        );
        expect(maxClient.banMember).toHaveBeenCalledWith(
          'chat-1',
          'user-1',
          expect.objectContaining({ botId: 'id613002203036_4_bot' }),
        );
        expect(maxClient.sendMessage).toHaveBeenCalledWith(
          'chat-1',
          expect.any(String),
          expect.objectContaining({
            textFormat: 'html',
          }),
          expect.objectContaining({
            botId: 'id613002203036_4_bot',
            sourceTag: 'moderation_notice',
          }),
        );
      });
    });

    it('passes message through when the user is subscribed to all required channels', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(true),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.hasChatMember).toHaveBeenCalledWith('channel-1', 'user-1', {
        trafficClass: 'critical',
        timeoutMs: 2_000,
        sourceTag: 'required_subscription_membership',
      });
      expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(prisma.violation.create).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    });

    it('enforces after a leave event invalidates a previously subscribed user', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      let isMember = true;
      const membershipLookupService = {
        getMembershipResolution: jest.fn(async () => ({ membership: isMember, fresh: true })),
        invalidateMemberships: jest.fn(async (_chatId: string, _userIds: readonly string[]) => {
          isMember = false;
        }),
      };
      const maxClient = {
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        membershipLookupService as never,
      );

      const secondUpdate = createUpdate();
      secondUpdate.updateId = 'upd-after-required-subscription-leave';
      if (secondUpdate.message) {
        secondUpdate.message.messageId = 'msg-after-required-subscription-leave';
      }

      await service.handleUpdate(createUpdate());
      await membershipLookupService.invalidateMemberships('channel-1', ['user-1']);
      await service.handleUpdate(secondUpdate);

      expect(membershipLookupService.invalidateMemberships).toHaveBeenCalledWith('channel-1', [
        'user-1',
      ]);
      expect(membershipLookupService.getMembershipResolution).toHaveBeenNthCalledWith(
        1,
        'channel-1',
        'user-1',
        'moderation_required_subscription',
        {},
      );
      expect(membershipLookupService.getMembershipResolution).toHaveBeenNthCalledWith(
        2,
        'channel-1',
        'user-1',
        'moderation_required_subscription',
        {},
      );
      expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
      expectImmediateDeleteMessage(
        maxClient.deleteMessage,
        'chat-1',
        'msg-after-required-subscription-leave',
      );
      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(maxClient.sendMessage.mock.calls[0]?.[1]).toContain('Новости MAX');
      expect(prisma.violation.create).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    });

    it('checks multiple required subscription channels with bounded parallelism', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const resolvers: Array<(value: boolean | null) => void> = [];
      const membershipLookupService = {
        getMembership: jest.fn().mockImplementation(
          () =>
            new Promise<boolean | null>((resolve) => {
              resolvers.push(resolve);
            }),
        ),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        membershipLookupService as never,
      );

      const lookupPromise = (
        service as unknown as {
          resolveRequiredSubscriptionMembership: (
            chatId: string,
            userId: string,
            requiredChannelIds: string[],
          ) => Promise<{ missingChannelIds: string[]; unresolvedChannelIds: string[] } | null>;
        }
      ).resolveRequiredSubscriptionMembership('chat-1', 'user-1', [
        'channel-1',
        'channel-2',
        'channel-3',
      ]);
      await Promise.resolve();
      await Promise.resolve();

      expect(membershipLookupService.getMembership).toHaveBeenCalledTimes(2);

      resolvers[0]?.(true);
      resolvers[1]?.(true);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(membershipLookupService.getMembership).toHaveBeenCalledTimes(3);

      resolvers[2]?.(true);
      await expect(lookupPromise).resolves.toEqual({
        missingChannelIds: [],
        unresolvedChannelIds: [],
        terminalChannelIds: [],
      });
    });

    it('fails open when required subscription membership checks exceed the hot-path budget', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-03T10:00:00.000Z'));
      const runtimeDiagnosticsService = {
        recordHotPathStageOutcome: jest.fn(),
      };
      const membershipLookupService = {
        getMembership: jest.fn(
          () =>
            new Promise<boolean | null>(() => {
              // Intentionally never resolves.
            }),
        ),
      };
      const service = createRequiredSubscriptionService(
        {} as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        {} as never,
        undefined,
        undefined,
        {
          get: jest.fn((key: string) =>
            key === 'WEBHOOK_USER_FACING_TIMEOUT_MS' ? 10_000 : undefined,
          ),
        } as never,
        undefined,
        undefined,
        undefined,
        membershipLookupService as never,
        undefined,
        undefined,
        undefined,
        undefined,
        runtimeDiagnosticsService as never,
      );
      (service as any).webhookUserFacingTimeoutMs = 10_000;
      const debugSpy = jest
        .spyOn((service as any).logger, 'debug')
        .mockImplementation(() => undefined);
      const hotPathProfile = {
        startedAtMs: Date.now() - 1_000,
        lastMarkedAtMs: Date.now() - 50,
        latestStage: 'required-subscription.membership',
        stages: new Map<string, number>(),
        stageTimelineMs: new Map<string, number>(),
        successBoundaryReached: false,
        successBoundaryStage: null,
      };

      try {
        const resultPromise = (
          service as unknown as {
            resolveRequiredSubscriptionMembershipWithHotPathBudget: (params: {
              chatId: string;
              userId: string;
              requiredChannelIds: string[];
              hotPathProfile: typeof hotPathProfile;
            }) => Promise<{
              missingChannelIds: string[];
              unresolvedChannelIds: string[];
              terminalChannelIds: string[];
            } | null>;
          }
        ).resolveRequiredSubscriptionMembershipWithHotPathBudget({
          chatId: 'chat-1',
          userId: 'user-1',
          requiredChannelIds: ['channel-1', 'channel-2'],
          hotPathProfile,
        });

        await Promise.resolve();
        await Promise.resolve();
        expect(membershipLookupService.getMembership).toHaveBeenCalledTimes(2);
        await jest.advanceTimersByTimeAsync(REQUIRED_SUBSCRIPTION_MEMBERSHIP_HOT_PATH_TIMEOUT_MS);

        await expect(resultPromise).resolves.toBeNull();
        expect(runtimeDiagnosticsService.recordHotPathStageOutcome).toHaveBeenCalledWith({
          stage: 'required-subscription.membership.deferred',
          outcome: 'skip',
          failOpen: true,
        });
        expect(debugSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            chatId: 'chat-1',
            userId: 'user-1',
            channelCount: 2,
            timeoutMs: REQUIRED_SUBSCRIPTION_MEMBERSHIP_HOT_PATH_TIMEOUT_MS,
          }),
          'Required subscription membership checks exceeded hot-path budget; continuing fail-open',
        );
      } finally {
        debugSpy.mockRestore();
        jest.useRealTimers();
      }
    });

    it('does not retry a fresh missing required subscription membership resolution', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const membershipLookupService = {
        getMembershipResolution: jest.fn().mockResolvedValue({ membership: false, fresh: true }),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        membershipLookupService as never,
      );

      await expect(
        (
          service as unknown as {
            resolveRequiredSubscriptionMembership: (
              chatId: string,
              userId: string,
              requiredChannelIds: string[],
            ) => Promise<{
              missingChannelIds: string[];
              unresolvedChannelIds: string[];
              terminalChannelIds: string[];
            }>;
          }
        ).resolveRequiredSubscriptionMembership('chat-1', 'user-1', ['channel-1']),
      ).resolves.toEqual({
        missingChannelIds: ['channel-1'],
        unresolvedChannelIds: [],
        terminalChannelIds: [],
      });
      expect(membershipLookupService.getMembershipResolution).toHaveBeenCalledTimes(1);
      expect(membershipLookupService.getMembershipResolution).toHaveBeenCalledWith(
        'channel-1',
        'user-1',
        'moderation_required_subscription',
        {},
      );
    });

    it('still retries a stale missing required subscription membership before enforcing', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const membershipLookupService = {
        getMembershipResolution: jest
          .fn()
          .mockResolvedValueOnce({ membership: false, fresh: false })
          .mockResolvedValueOnce({ membership: true, fresh: true }),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        membershipLookupService as never,
      );

      await expect(
        (
          service as unknown as {
            resolveRequiredSubscriptionMembership: (
              chatId: string,
              userId: string,
              requiredChannelIds: string[],
            ) => Promise<{
              missingChannelIds: string[];
              unresolvedChannelIds: string[];
              terminalChannelIds: string[];
            }>;
          }
        ).resolveRequiredSubscriptionMembership('chat-1', 'user-1', ['channel-1']),
      ).resolves.toEqual({
        missingChannelIds: [],
        unresolvedChannelIds: [],
        terminalChannelIds: [],
      });
      expect(membershipLookupService.getMembershipResolution).toHaveBeenCalledTimes(2);
      expect(membershipLookupService.getMembershipResolution).toHaveBeenLastCalledWith(
        'channel-1',
        'user-1',
        'moderation_required_subscription',
        { forceRefresh: true, allowStaleOnError: false },
      );
    });

    it('excludes terminal required subscription lookup issues from missing targets', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const membershipLookupService = {
        getMembership: jest.fn().mockResolvedValue(null),
        getLookupIssue: jest.fn().mockReturnValue({
          chatId: 'channel-1',
          policyName: 'moderation_required_subscription',
          kind: 'terminal',
          retryAfterMs: 60_000,
          observedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
          statusCode: 403,
          message: 'Request failed with status code 403',
        }),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        membershipLookupService as never,
      );

      await expect(
        (
          service as unknown as {
            resolveRequiredSubscriptionMembership: (
              chatId: string,
              userId: string,
              requiredChannelIds: string[],
            ) => Promise<{
              missingChannelIds: string[];
              unresolvedChannelIds: string[];
              terminalChannelIds: string[];
            }>;
          }
        ).resolveRequiredSubscriptionMembership('chat-1', 'user-1', ['channel-1']),
      ).resolves.toEqual({
        missingChannelIds: [],
        unresolvedChannelIds: ['channel-1'],
        terminalChannelIds: ['channel-1'],
      });
      expect(membershipLookupService.getMembership).toHaveBeenCalledTimes(2);
      expect(membershipLookupService.getLookupIssue).toHaveBeenCalledWith(
        'channel-1',
        'moderation_required_subscription',
      );
    });

    it('checks every configured required subscription chat or channel before passing the message', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1', 'channel-2', 'channel-3', 'channel-4'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockImplementation(async (channelId: string) => {
          return channelId !== 'channel-4';
        }),
        getChatSnapshot: jest.fn().mockImplementation(async (channelId: string) => ({
          title: channelId === 'channel-4' ? 'Нужный канал 4' : `Нужный канал ${channelId}`,
          link: `https://max.ru/channels/${channelId}`,
          participantsCount: 100,
          entityType: 'channel',
        })),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.hasChatMember.mock.calls.map((call) => call[0])).toEqual([
        'channel-1',
        'channel-2',
        'channel-3',
        'channel-4',
      ]);
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(ruleEngine.detect).not.toHaveBeenCalled();
      const [, noticeText, noticeOptions] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('Нужный канал 4');
      expect(noticeText).not.toContain('Нужный канал channel-1');
      expect(noticeOptions).toEqual(
        expect.objectContaining({
          buttons: [
            [
              {
                text: 'Нужный канал 4',
                url: 'https://max.ru/channels/channel-4',
              },
            ],
          ],
        }),
      );
    });

    it('caps required subscription targets read from persisted settings to the contract limit', async () => {
      const requiredSubscriptionChannelIds = Array.from(
        { length: REQUIRED_SUBSCRIPTION_MAX_CHANNELS + 2 },
        (_, index) => `channel-${index + 1}`,
      );
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds,
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(true),
        getChatSnapshot: jest.fn().mockImplementation(async (channelId: string) => ({
          title: `Нужный канал ${channelId}`,
          link: `https://max.ru/channels/${channelId}`,
          participantsCount: 100,
          entityType: 'channel',
        })),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );

      await service.handleUpdate(createUpdate());

      const expectedChannelIds = requiredSubscriptionChannelIds.slice(
        0,
        REQUIRED_SUBSCRIPTION_MAX_CHANNELS,
      );
      expect(maxClient.getChatSnapshot.mock.calls.map((call) => call[0])).toEqual(
        expectedChannelIds,
      );
      expect(maxClient.hasChatMember.mock.calls.map((call) => call[0])).toEqual(expectedChannelIds);
      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(REQUIRED_SUBSCRIPTION_MAX_CHANNELS);
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
    });

    it('confirms stale missing required subscription cache with a fresh lookup before deleting', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      redisCounter.stringCache.set('required-subscription:member:v1:channel-1:user-1', '0');
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(true),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(1);
      expect(maxClient.hasChatMember).toHaveBeenCalledWith('channel-1', 'user-1', {
        trafficClass: 'critical',
        timeoutMs: 2_000,
        sourceTag: 'required_subscription_membership',
      });
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(prisma.violation.create).not.toHaveBeenCalled();
      expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
    });

    it('does not force the active bot for required subscription membership lookups', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const membershipLookupService = {
        getMembership: jest.fn().mockResolvedValue(true),
      };
      const maxBotContextService = {
        getActiveBotId: jest.fn().mockReturnValue('id613002203036_4_bot'),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        membershipLookupService as never,
        undefined,
        maxBotContextService as never,
      );

      await expect(
        (
          service as unknown as {
            getRequiredSubscriptionMembership: (
              channelId: string,
              userId: string,
            ) => Promise<boolean | null>;
          }
        ).getRequiredSubscriptionMembership('channel-1', 'user-1'),
      ).resolves.toBe(true);

      expect(membershipLookupService.getMembership).toHaveBeenCalledWith(
        'channel-1',
        'user-1',
        'moderation_required_subscription',
      );
    });

    describe('subscription authority rejection boundaries', () => {
      function fixture() {
        const prisma = createPrismaForRequiredSubscription({
          requiredSubscriptionEnabled: true,
          requiredSubscriptionChannelIds: ['channel-1'],
        });
        const maxClient = createRequiredSubscriptionMaxClient();
        const ruleEngine = { detect: jest.fn().mockResolvedValue({ violations: [] }) };
        const redisCounter = createRequiredSubscriptionRedisCounter();
        const service = createRequiredSubscriptionService(
          prisma as never,
          ruleEngine as never,
          { resolveAction: jest.fn() } as never,
          maxClient as never,
          undefined,
          undefined,
          undefined,
          redisCounter as never,
        );
        const guard = (service as any).requiredSubscriptionExecutionGuard;
        const claim = jest.spyOn(service as any, 'claimAndPersistMessageScopedModerationViolation');
        const activeMute = jest.spyOn(service as any, 'handleActiveMuteMessage');
        const ensureIntent = jest.spyOn(service as any, 'ensureModerationDeleteIntent');
        const executeDelete = jest.spyOn(service as any, 'executeModerationDelete');
        return {
          service,
          prisma,
          maxClient,
          ruleEngine,
          redisCounter,
          guard,
          claim,
          activeMute,
          ensureIntent,
          executeDelete,
        };
      }

      it.each([
        [false, new RequiredSubscriptionMembershipUnavailableError()],
        [true, new RequiredSubscriptionMembershipUnavailableError()],
        [false, new RequiredSubscriptionExecutionRejectedError()],
        [true, new RequiredSubscriptionExecutionRejectedError()],
        [
          false,
          new RequiredSubscriptionInitialSourceUnavailableError(
            createMaxApiError(404, 'unavailable'),
          ),
        ],
        [
          true,
          new RequiredSubscriptionInitialSourceUnavailableError(
            createMaxApiError(404, 'unavailable'),
          ),
        ],
      ])(
        'stops the feature before writes without active-mute fallthrough (muted=%s, error=%s)',
        async (muted, error) => {
          const f = fixture();
          if (muted)
            jest.spyOn(f.service as any, 'getActiveMute').mockResolvedValue({
              ruleCode: 'REQUIRED_SUBSCRIPTION',
              durationHours: 6,
            });
          f.guard.authorize.mockRejectedValue(error);
          await expect(f.service.handleUpdate(createUpdate())).resolves.toBeUndefined();
          expect(f.guard.authorize).toHaveBeenCalledTimes(1);
          expect(f.guard.authorize).toHaveBeenCalledWith(
            expect.objectContaining({ initialQualification: true }),
          );
          expect(f.claim).not.toHaveBeenCalled();
          expect(f.prisma.violation.create).not.toHaveBeenCalled();
          expect(f.prisma.moderationEvent.create).not.toHaveBeenCalled();
          expect(f.prisma.moderationEvent.upsert).not.toHaveBeenCalled();
          expect(f.activeMute).not.toHaveBeenCalled();
          expect(f.maxClient.sendMessage).not.toHaveBeenCalled();
          expect(f.maxClient.deleteMessage).not.toHaveBeenCalled();
          expect(f.maxClient.banMember).not.toHaveBeenCalled();
          expect(f.ruleEngine.detect).not.toHaveBeenCalled();
        },
      );

      it.each([
        ['HTTP 404', createMaxApiError(404, 'Unknown exact message response')],
        [
          'matching code without the error type',
          Object.assign(new Error('unverified'), {
            code: 'required_subscription_no_longer_authorized',
          }),
        ],
        ['transient lookup', new Error('Required subscription fresh membership unavailable')],
      ])('preserves %s as a failure', async (_label, error) => {
        const f = fixture();
        f.guard.authorize.mockRejectedValue(error);
        await expect(f.service.handleUpdate(createUpdate())).rejects.toBe(error);
        expect(f.claim).not.toHaveBeenCalled();
        expect(f.maxClient.sendMessage).not.toHaveBeenCalled();
        expect(f.maxClient.deleteMessage).not.toHaveBeenCalled();
      });

      it.each([false, true])(
        'stops a revoked deletion after notice handoff without fallthrough (muted=%s)',
        async (muted) => {
          const f = fixture();
          if (muted)
            jest.spyOn(f.service as any, 'getActiveMute').mockResolvedValue({
              ruleCode: 'REQUIRED_SUBSCRIPTION',
              durationHours: 6,
            });
          f.guard.authorize
            .mockReset()
            .mockResolvedValueOnce({ reasonKeys: ['REQUIRED_SUBSCRIPTION:message-delete'] })
            .mockImplementation(async () => {
              expect(f.maxClient.sendMessage).toHaveBeenCalledTimes(1);
              throw new RequiredSubscriptionExecutionRejectedError();
            });

          await expect(f.service.handleUpdate(createUpdate())).resolves.toBeUndefined();

          expect(f.guard.authorize).toHaveBeenCalledTimes(2);
          expect(f.guard.authorize.mock.calls[0][0].initialQualification).toBe(true);
          expect(f.guard.authorize.mock.calls[1][0].initialQualification).toBeUndefined();
          expect(f.claim).toHaveBeenCalledTimes(1);
          expect(f.prisma.violation.create).toHaveBeenCalledTimes(1);
          expect(f.prisma.moderationEvent.upsert).toHaveBeenCalledTimes(1);
          expect(f.maxClient.sendMessage).toHaveBeenCalledTimes(1);
          expect(f.ensureIntent).not.toHaveBeenCalled();
          expect(f.executeDelete).not.toHaveBeenCalled();
          expect(f.maxClient.deleteMessage).not.toHaveBeenCalled();
          expect(f.maxClient.banMember).not.toHaveBeenCalled();
          expect(f.activeMute).not.toHaveBeenCalled();
          expect(f.ruleEngine.detect).not.toHaveBeenCalled();
          expect(
            f.prisma.moderationEvent.create.mock.calls.some(
              ([args]) => args?.data?.action === SanctionAction.DELETE_MESSAGE,
            ),
          ).toBe(false);
        },
      );

      it.each(
        [
          'committed',
          'off',
          'observed',
          'missing-id',
          'ambiguous',
          'sql-failed',
          'lease-lost',
        ].flatMap((state) => ['membership', 'source'].map((failure) => [state, failure])),
      )(
        'requires a committed guarded DELETE handoff after unavailable evidence: %s %s',
        async (state, failure) => {
          const f = fixture();
          const unavailable =
            failure === 'source'
              ? new RequiredSubscriptionDeleteSourceUnavailableError(
                  createMaxApiError(404, 'unavailable'),
                )
              : new RequiredSubscriptionMembershipUnavailableError();
          const storageError = new Error('Fixture DELETE persistence unavailable');
          const ensureIntent = jest.fn().mockResolvedValue({
            intentId: state === 'missing-id' ? null : 'fixture-delete',
            rollout: state === 'off' ? 'off' : state === 'observed' ? 'observed' : 'execute',
            status: state === 'ambiguous' ? 'AMBIGUOUS' : 'PENDING',
          });
          if (state === 'sql-failed') ensureIntent.mockRejectedValue(storageError);
          Object.assign(f.service, { moderationDeleteIntentService: { ensureIntent } });
          f.guard.authorize
            .mockReset()
            .mockResolvedValueOnce({ reasonKeys: ['REQUIRED_SUBSCRIPTION:message-delete'] })
            .mockImplementation(async () => {
              expect(f.maxClient.sendMessage).toHaveBeenCalledTimes(1);
              if (state === 'lease-lost') f.redisCounter.renewLock.mockResolvedValue(false);
              throw unavailable;
            });
          const result = f.service.handleUpdate(createUpdate());
          if (state === 'committed') await expect(result).resolves.toBeUndefined();
          else if (state === 'sql-failed') await expect(result).rejects.toBe(storageError);
          else if (state === 'lease-lost') await expect(result).rejects.toThrow('lease was lost');
          else await expect(result).rejects.toBe(unavailable);
          expect(ensureIntent).toHaveBeenCalledTimes(state === 'lease-lost' ? 0 : 1);
          if (state !== 'lease-lost')
            expect(ensureIntent).toHaveBeenCalledWith(
              expect.objectContaining({
                chatId: 'chat-1',
                messageId: 'msg-1',
                subjectUserId: 'user-1',
                ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
                reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete',
                retryUntilAt: expect.any(Date),
              }),
            );
          expect(f.executeDelete).not.toHaveBeenCalled();
          expect(f.maxClient.deleteMessage).not.toHaveBeenCalled();
          expect(f.maxClient.banMember).not.toHaveBeenCalled();
          expect(f.maxClient.sendMessage).toHaveBeenCalledTimes(1);
          expect(f.activeMute).not.toHaveBeenCalled();
          expect(f.ruleEngine.detect).not.toHaveBeenCalled();
        },
      );

      it.each([
        'committed',
        'off',
        'observed',
        'missing-id',
        'ambiguous',
        'null-status',
        'sql-failed',
        'lease-lost',
      ])(
        'always transfers an available post-notice DELETE to durable ownership: %s',
        async (state) => {
          const f = fixture();
          const storageError = new Error('Fixture DELETE storage failure');
          const ensureIntent = jest.fn().mockResolvedValue({
            intentId: state === 'missing-id' ? null : 'fixture-delete',
            rollout: state === 'off' ? 'off' : state === 'observed' ? 'observed' : 'execute',
            status:
              state === 'ambiguous' ? 'AMBIGUOUS' : state === 'null-status' ? null : 'PENDING',
          });
          if (state === 'sql-failed') ensureIntent.mockRejectedValue(storageError);
          Object.assign(f.service, { moderationDeleteIntentService: { ensureIntent } });
          if (state === 'lease-lost')
            f.guard.authorize
              .mockResolvedValueOnce({ reasonKeys: ['REQUIRED_SUBSCRIPTION:message-delete'] })
              .mockImplementation(async () => {
                f.redisCounter.renewLock.mockResolvedValue(false);
                return { reasonKeys: ['REQUIRED_SUBSCRIPTION:message-delete'] };
              });
          const result = f.service.handleUpdate(createUpdate());
          if (state === 'committed') await expect(result).resolves.toBeUndefined();
          else if (state === 'sql-failed') await expect(result).rejects.toBe(storageError);
          else if (state === 'lease-lost') await expect(result).rejects.toThrow('lease was lost');
          else await expect(result).rejects.toThrow('DELETE handoff is not executable');
          expect(ensureIntent).toHaveBeenCalledTimes(state === 'lease-lost' ? 0 : 1);
          expect(f.executeDelete).not.toHaveBeenCalled();
          expect(f.maxClient.deleteMessage).not.toHaveBeenCalled();
          expect(f.maxClient.sendMessage).toHaveBeenCalledTimes(1);
          expect(f.activeMute).not.toHaveBeenCalled();
        },
      );

      it.each([
        new RequiredSubscriptionInitialSourceUnavailableError(
          createMaxApiError(404, 'unavailable'),
        ),
        createMaxApiError(404, 'Unknown exact message response'),
        Object.assign(new Error('unverified'), {
          code: 'required_subscription_no_longer_authorized',
        }),
        new Error('Required subscription fresh membership unavailable'),
        new Error('Required subscription settings storage unavailable'),
      ])('preserves unverified authority failure after notice handoff: %s', async (error) => {
        const f = fixture();
        f.guard.authorize
          .mockReset()
          .mockResolvedValueOnce({ reasonKeys: ['REQUIRED_SUBSCRIPTION:message-delete'] })
          .mockRejectedValue(error);
        await expect(f.service.handleUpdate(createUpdate())).rejects.toBe(error);
        expect(f.guard.authorize).toHaveBeenCalledTimes(2);
        expect(f.guard.authorize.mock.calls[0][0].initialQualification).toBe(true);
        expect(f.guard.authorize.mock.calls[1][0].initialQualification).toBeUndefined();
        expect(f.claim).toHaveBeenCalledTimes(1);
        expect(f.prisma.violation.create).toHaveBeenCalledTimes(1);
        expect(f.maxClient.sendMessage).toHaveBeenCalledTimes(1);
        expect(f.ensureIntent).not.toHaveBeenCalled();
        expect(f.executeDelete).not.toHaveBeenCalled();
        expect(f.maxClient.deleteMessage).not.toHaveBeenCalled();
      });

      it('stops a revoked deletion covered by durable media evidence without another notice', async () => {
        const f = fixture();
        const createdAt = new Date().toISOString();
        const first = createRequiredSubscriptionMediaUpdate({
          messageId: 'revoked-coverage-first',
          createdAt,
          mediaGroupId: 'revoked-coverage-album',
        });
        const second = createRequiredSubscriptionMediaUpdate({
          messageId: 'revoked-coverage-second',
          createdAt,
          mediaGroupId: 'revoked-coverage-album',
        });
        await f.service.handleUpdate(first);
        await f.service.handleUpdate(second);
        expect(f.maxClient.sendMessage).toHaveBeenCalledTimes(1);
        expect(f.executeDelete).toHaveBeenCalledTimes(2);
        expect(
          f.prisma.moderationEvent.upsert.mock.calls.filter(
            ([args]) => args.create.ruleCode === 'REQUIRED_SUBSCRIPTION_NOTICE_COVERAGE',
          ),
        ).toHaveLength(1);
        for (const key of f.redisCounter.stringCache.keys()) {
          if (key.includes('media-notice-state')) f.redisCounter.stringCache.delete(key);
        }
        f.guard.authorize.mockClear();
        f.guard.authorize.mockRejectedValue(new RequiredSubscriptionExecutionRejectedError());
        f.claim.mockClear();
        f.ensureIntent.mockClear();
        f.executeDelete.mockClear();
        f.maxClient.sendMessage.mockClear();

        await expect(f.service.handleUpdate(second)).resolves.toBeUndefined();

        expect(f.guard.authorize).toHaveBeenCalledTimes(1);
        expect(f.guard.authorize.mock.calls[0][0].initialQualification).toBeUndefined();
        expect(f.claim).not.toHaveBeenCalled();
        expect(f.ensureIntent).not.toHaveBeenCalled();
        expect(f.executeDelete).not.toHaveBeenCalled();
        expect(f.maxClient.sendMessage).not.toHaveBeenCalled();
        expect(f.activeMute).not.toHaveBeenCalled();
        expect(f.ruleEngine.detect).not.toHaveBeenCalled();
      });

      it('preserves the notice lease failure before deletion authority', async () => {
        const f = fixture();
        const error = new Error('Required subscription notice lease was lost');
        jest
          .spyOn((f.service as any).requiredSubscriptionMediaNoticeCoordinator, 'run')
          .mockImplementation(async (params: any) => {
            await params.executeDelete(async () => {
              throw error;
            });
            return true;
          });

        await expect(f.service.handleUpdate(createUpdate())).rejects.toBe(error);
        expect(f.guard.authorize).not.toHaveBeenCalled();
        expect(f.ensureIntent).not.toHaveBeenCalled();
        expect(f.executeDelete).not.toHaveBeenCalled();
      });

      it('preserves a typed rejection from the earlier notice handoff guard', async () => {
        const f = fixture();
        const error = new RequiredSubscriptionExecutionRejectedError();
        f.guard.assertNoticeAllowed.mockRejectedValue(error);

        await expect(f.service.handleUpdate(createUpdate())).rejects.toBe(error);
        expect(f.guard.authorize).toHaveBeenCalledTimes(1);
        expect(f.ensureIntent).not.toHaveBeenCalled();
        expect(f.executeDelete).not.toHaveBeenCalled();
        expect(f.maxClient.sendMessage).not.toHaveBeenCalled();
      });

      it.each(['ensure', 'execute', 'delete-event'] as const)(
        'preserves a typed rejection after deletion authority at %s',
        async (stage) => {
          const f = fixture();
          const error = new RequiredSubscriptionExecutionRejectedError();
          if (stage === 'ensure') f.ensureIntent.mockRejectedValue(error);
          else if (stage === 'execute') f.executeDelete.mockRejectedValue(error);
          else
            f.prisma.moderationEvent.create
              .mockResolvedValueOnce(undefined)
              .mockRejectedValue(error);

          await expect(f.service.handleUpdate(createUpdate())).rejects.toBe(error);
          expect(f.guard.authorize).toHaveBeenCalledTimes(2);
          expect(f.ensureIntent).toHaveBeenCalledTimes(1);
          expect(f.executeDelete).toHaveBeenCalledTimes(stage === 'ensure' ? 0 : 1);
          expect(f.maxClient.sendMessage).toHaveBeenCalledTimes(1);
          expect(f.activeMute).not.toHaveBeenCalled();
          expect(f.ruleEngine.detect).not.toHaveBeenCalled();
        },
      );

      it('still awaits deferred action suppression after a revoked deletion', async () => {
        const f = fixture();
        const error = new Error('Deferred action suppression unavailable');
        const revokeActions = jest.fn().mockRejectedValue(error);
        Object.assign(f.service, { messageDuplicateService: { revokeActions } });
        f.guard.authorize
          .mockReset()
          .mockResolvedValueOnce({ reasonKeys: ['REQUIRED_SUBSCRIPTION:message-delete'] })
          .mockRejectedValue(new RequiredSubscriptionExecutionRejectedError());

        await expect(f.service.handleUpdate(createUpdate())).rejects.toBe(error);
        expect(revokeActions).toHaveBeenCalledTimes(1);
        expect(f.ensureIntent).not.toHaveBeenCalled();
        expect(f.executeDelete).not.toHaveBeenCalled();
        expect(f.maxClient.sendMessage).toHaveBeenCalledTimes(1);
        expect(f.ruleEngine.detect).not.toHaveBeenCalled();
      });

      it('keeps recovered deletion outside initial qualification', async () => {
        const f = fixture();
        const error = new RequiredSubscriptionInitialSourceUnavailableError(
          createMaxApiError(404, 'unavailable'),
        );
        f.guard.authorize.mockRejectedValue(error);
        jest
          .spyOn((f.service as any).requiredSubscriptionMediaNoticeCoordinator, 'run')
          .mockImplementation(async (params: any) => {
            await params.executeDelete(async () => undefined);
            return true;
          });
        await expect(f.service.handleUpdate(createUpdate())).rejects.toBe(error);
        expect(f.guard.authorize).toHaveBeenCalledTimes(1);
        expect(f.guard.authorize.mock.calls[0][0].initialQualification).toBeUndefined();
        expect(f.claim).not.toHaveBeenCalled();
        expect(f.maxClient.deleteMessage).not.toHaveBeenCalled();
      });
    });

    it('deletes the message, records violation, and sends buttons only for missing channels', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1', 'channel-2'],
        rulesAttachViolationsEnabled: true,
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest
          .fn()
          .mockResolvedValueOnce({
            title: 'Новости MAX',
            link: 'https://max.ru/channels/news-max',
            participantsCount: 100,
            entityType: 'channel',
          })
          .mockResolvedValueOnce({
            title: 'Афиша района',
            link: 'https://max.ru/channels/afisha',
            participantsCount: 42,
            entityType: 'channel',
          }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(ruleEngine.detect).not.toHaveBeenCalled();
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(prisma.violation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-1',
          ruleCode: 'REQUIRED_SUBSCRIPTION',
          score: 1,
        }),
      });
      expect(prisma.moderationEvent.create.mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.objectContaining({
              data: expect.objectContaining({
                chatId: 'chat-1',
                userId: 'user-1',
                messageId: 'msg-1',
                ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
                action: SanctionAction.DELETE_MESSAGE,
                metadata: expect.objectContaining({
                  requiredChannelIds: ['channel-1', 'channel-2'],
                  missingChannelIds: ['channel-1', 'channel-2'],
                  missingChannelTitles: ['Новости MAX', 'Афиша района'],
                }),
              }),
            }),
          ],
          [
            expect.objectContaining({
              data: expect.objectContaining({
                chatId: 'chat-1',
                userId: 'user-1',
                messageId: 'msg-1',
                ruleCode: 'REQUIRED_SUBSCRIPTION',
                action: SanctionAction.NONE,
                metadata: expect.objectContaining({
                  requiredSubscriptionViolationCount24h: 1,
                  requiredSubscriptionEscalationWindowHours: 24,
                  missingChannelTitles: ['Новости MAX', 'Афиша района'],
                }),
              }),
            }),
          ],
        ]),
      );
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText, noticeOptions] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('ожидает удаления');
      expect(noticeText).not.toMatch(/удалено/u);
      expect(noticeText).toContain('Новости MAX');
      expect(noticeText).toContain('Афиша района');
      expect(noticeOptions).toEqual(
        expect.objectContaining({
          textFormat: 'html',
          messageLink: {
            type: 'reply',
            mid: 'mid-rules-1',
          },
          buttons: [
            [
              {
                text: 'Новости MAX',
                url: 'https://max.ru/channels/news-max',
              },
            ],
            [
              {
                text: 'Афиша района',
                url: 'https://max.ru/channels/afisha',
              },
            ],
          ],
          debugContext: {
            screen: 'moderation',
            action: 'required-subscription-notice',
          },
        }),
      );
    });

    it('replays the idempotent notice and delete handoff when the persisted message claim already exists', async () => {
      const prisma = {
        ...createPrismaForRequiredSubscription({
          requiredSubscriptionEnabled: true,
          requiredSubscriptionChannelIds: ['channel-1'],
          requiredSubscriptionBotMessageEnabled: true,
        }),
        moderationViolationMessageClaim: {
          createMany: jest
            .fn()
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 }),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );

      await service.handleUpdate({
        ...createUpdate(),
        updateId: 'upd-owner-required-subscription-1',
        botId: 'bot-1',
      });
      await service.handleUpdate({
        ...createUpdate(),
        updateId: 'upd-standby-required-subscription-1',
        botId: 'bot-2',
      });

      expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledTimes(1);
      expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            chatId: 'chat-1',
            userId: 'user-1',
            messageId: 'msg-1',
            ruleCode: 'REQUIRED_SUBSCRIPTION',
            updateType: 'message_action',
          }),
        ],
        skipDuplicates: true,
      });
      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(2);
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(2);
      expect(maxClient.sendMessage.mock.calls.map((call) => call[3])).toEqual([
        expect.objectContaining({
          idempotencyKey: 'required-subscription:notice:v1:chat-1:msg-1',
        }),
        expect.objectContaining({
          idempotencyKey: 'required-subscription:notice:v1:chat-1:msg-1',
        }),
      ]);
      expect(maxClient.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
        maxClient.deleteMessage.mock.invocationCallOrder[0]!,
      );
      expect(maxClient.sendMessage.mock.invocationCallOrder[1]).toBeLessThan(
        maxClient.deleteMessage.mock.invocationCallOrder[1]!,
      );
      expect(prisma.violation.create).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(3);
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('renders markdown-heavy required subscription templates as html without visible markers', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionBotMessageText:
          '👋 {user}, приветствую. **Ваша публикация удалена.**\n\n**✏️ Что-бы иметь возможность писать сообщения в группе, задавать вопросы, необходимо выполнить условие. **\n\n**💙 **Нужно подписаться на {channels}',
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Нижегородский районный чат',
          link: 'https://max.ru/channels/nizhegorodskiy-chat',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText, noticeOptions] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeOptions).toEqual(expect.objectContaining({ textFormat: 'html' }));
      expect(noticeText).toContain('<strong>Ваша публикация удалена.</strong>');
      expect(noticeText).toContain('<a href="max://user/user-1">Алексей</a>');
      expect(noticeText).toContain('Нижегородский районный чат');
      expect(noticeText).not.toMatch(/(?:\*\*|__|\+\+|~~|\^\^)/u);
    });

    it('retries a required-subscription delete with the next eligible bot after a terminal 403', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest
          .fn()
          .mockRejectedValueOnce(
            createMaxApiError(403, 'Request failed with status code 403', 'chat.denied'),
          )
          .mockResolvedValueOnce(undefined),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const maxBotLinkService = {
        getDefaultBotId: jest.fn().mockReturnValue('id613002203036_bot'),
        getResolvedBotSync: jest.fn().mockReturnValue({
          id: 'id613002203036_bot',
          label: 'Майор Максимов',
          characterName: 'Майор Максимов',
          speechPersona: 'male',
        }),
        isKnownBotUserId: jest.fn().mockReturnValue(false),
        resolveBotId: jest.fn().mockResolvedValue(null),
        resolveContactIdSync: jest.fn().mockReturnValue(null),
        resolveBotIdsForModerationAction: jest
          .fn()
          .mockResolvedValue(['id613002203036_bot', 'id613002203036_4_bot']),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        maxBotLinkService as never,
      );

      await expect(service.handleUpdate(createUpdate())).resolves.toBeUndefined();

      expect(maxClient.deleteMessage).toHaveBeenNthCalledWith(1, 'chat-1', 'msg-1', {
        botId: 'id613002203036_bot',
        immediate: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: 'moderation_delete',
        timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
        ignoreFailureMetricStatuses: [403, 404],
      });
      expect(maxClient.deleteMessage).toHaveBeenNthCalledWith(2, 'chat-1', 'msg-1', {
        botId: 'id613002203036_4_bot',
        immediate: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: 'moderation_delete',
        timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
        ignoreFailureMetricStatuses: [403, 404],
      });
      expect(maxClient.sendMessage).toHaveBeenCalledWith(
        'chat-1',
        expect.any(String),
        expect.objectContaining({ textFormat: 'html' }),
        expect.objectContaining({
          idempotencyKey: 'required-subscription:notice:v1:chat-1:msg-1',
          trafficClass: 'interactive',
          actionHealthLane: 'interactive',
          sourceTag: 'moderation_notice',
        }),
      );
      expect(maxClient.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
        maxClient.deleteMessage.mock.invocationCallOrder[0]!,
      );
      expect(
        prisma.moderationEvent.create.mock.calls.some(
          ([args]) => args?.data?.ruleCode === 'REQUIRED_SUBSCRIPTION_DELETE',
        ),
      ).toBe(true);
    });

    it('fails open for required-subscription deletes after terminal 403 errors from every candidate bot', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest
          .fn()
          .mockRejectedValue(
            createMaxApiError(403, 'Request failed with status code 403', 'chat.denied'),
          ),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const maxBotLinkService = {
        getDefaultBotId: jest.fn().mockReturnValue('id613002203036_bot'),
        getResolvedBotSync: jest.fn().mockReturnValue({
          id: 'id613002203036_bot',
          label: 'Майор Максимов',
          characterName: 'Майор Максимов',
          speechPersona: 'male',
        }),
        isKnownBotUserId: jest.fn().mockReturnValue(false),
        resolveBotId: jest.fn().mockResolvedValue(null),
        resolveContactIdSync: jest.fn().mockReturnValue(null),
        resolveBotIdsForModerationAction: jest
          .fn()
          .mockResolvedValue(['id613002203036_bot', 'id613002203036_4_bot']),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        maxBotLinkService as never,
      );

      await expect(service.handleUpdate(createUpdate())).resolves.toBeUndefined();

      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(2);
      expect(prisma.violation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-1',
          ruleCode: 'REQUIRED_SUBSCRIPTION',
          score: 1,
        }),
      });
      expect(
        prisma.moderationEvent.create.mock.calls.some(
          ([args]) => args?.data?.ruleCode === 'REQUIRED_SUBSCRIPTION_DELETE',
        ),
      ).toBe(false);
      expect(
        prisma.moderationEvent.create.mock.calls.some(
          ([args]) =>
            args?.data?.ruleCode === 'REQUIRED_SUBSCRIPTION' &&
            args?.data?.action === SanctionAction.NONE,
        ),
      ).toBe(true);
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('refreshes fallback required subscription metadata before naming channels in the bot notice', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const chatContextCache = {
        getManagedEntityHeader: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Канал channel-1',
          entityType: 'channel',
          link: 'https://max.ru/channels/news-max',
          participantsCount: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        }),
        setManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
        invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
      };
      const maxClient = {
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        chatContextCache as never,
      );

      const channels = await (
        service as unknown as {
          resolveRequiredSubscriptionChannels: (
            channelIds: string[],
            options: { allowRemoteFetch: boolean },
          ) => Promise<Array<{ id: string; title: string; link: string | null; usable: boolean }>>;
        }
      ).resolveRequiredSubscriptionChannels(['channel-1'], {
        allowRemoteFetch: true,
      });

      expect(maxClient.getChatSnapshot).toHaveBeenCalledWith('channel-1', {
        trafficClass: 'background',
        timeoutMs: 2_500,
        sourceTag: 'required_subscription_metadata',
      });
      expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'channel-1',
          title: 'Новости MAX',
          entityType: 'channel',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
          accessDiagnostics: expect.objectContaining({
            state: 'ok',
            lastDetectedAt: null,
            lostBots: [],
          }),
        }),
      );
      expect(channels).toEqual([
        {
          id: 'channel-1',
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          usable: true,
          checkMembership: true,
        },
      ]);
    });

    it('uses the bound channel bot when refreshing required subscription metadata', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const chatContextCache = {
        getManagedEntityHeader: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Канал channel-1',
          entityType: 'channel',
          link: 'https://max.ru/channels/news-max',
          participantsCount: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        }),
        setManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
        invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
      };
      const maxClient = {
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
      };
      const maxBotLinkService = {
        resolveBotId: jest.fn().mockResolvedValue('id613002203036_bot'),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        chatContextCache as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        maxBotLinkService as never,
      );

      const channels = await (
        service as unknown as {
          resolveRequiredSubscriptionChannels: (
            channelIds: string[],
            options: { allowRemoteFetch: boolean },
          ) => Promise<Array<{ id: string; title: string; link: string | null; usable: boolean }>>;
        }
      ).resolveRequiredSubscriptionChannels(['channel-1'], {
        allowRemoteFetch: true,
      });

      expect(maxBotLinkService.resolveBotId).toHaveBeenCalledWith({
        chatId: 'channel-1',
      });
      expect(maxClient.getChatSnapshot).toHaveBeenCalledWith('channel-1', {
        trafficClass: 'background',
        timeoutMs: 2_500,
        sourceTag: 'required_subscription_metadata',
        botId: 'id613002203036_bot',
      });
      expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'channel-1',
          title: 'Новости MAX',
          entityType: 'channel',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          primaryBotId: 'id613002203036_bot',
          assignedBots: [],
          sharedMode: 'owned',
          accessDiagnostics: expect.objectContaining({
            state: 'ok',
            lastDetectedAt: null,
            lostBots: [],
          }),
        }),
      );
      expect(channels).toEqual([
        {
          id: 'channel-1',
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          usable: true,
          checkMembership: true,
        },
      ]);
    });

    it('reuses recent required subscription channel metadata in memory for ordinary moderation lookups', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const chatContextCache = {
        getManagedEntityHeader: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Новости MAX',
          entityType: 'channel',
          link: 'https://max.ru/channels/news-max',
          participantsCount: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        }),
        setManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
        invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        {} as never,
        chatContextCache as never,
      );

      const resolver = service as unknown as {
        resolveRequiredSubscriptionChannels: (
          channelIds: string[],
          options?: { allowRemoteFetch?: boolean },
        ) => Promise<
          Array<{
            id: string;
            title: string;
            link: string | null;
            usable: boolean;
            checkMembership: boolean;
          }>
        >;
      };

      const first = await resolver.resolveRequiredSubscriptionChannels(['channel-1'], {
        allowRemoteFetch: false,
      });
      const second = await resolver.resolveRequiredSubscriptionChannels(['channel-1'], {
        allowRemoteFetch: false,
      });

      expect(first).toEqual([
        {
          id: 'channel-1',
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          usable: true,
          checkMembership: true,
        },
      ]);
      expect(second).toEqual(first);
      expect(prisma.chat.findMany).toHaveBeenCalledTimes(1);
      expect(chatContextCache.getManagedEntityHeader).toHaveBeenCalledTimes(1);
    });

    it('does not let a cached local fallback suppress a later remote metadata refresh', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const chatContextCache = {
        getManagedEntityHeader: jest.fn().mockResolvedValue(null),
        setManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
        invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
      };
      const maxClient = {
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        chatContextCache as never,
      );

      const resolver = service as unknown as {
        resolveRequiredSubscriptionChannels: (
          channelIds: string[],
          options?: { allowRemoteFetch?: boolean },
        ) => Promise<Array<{ id: string; title: string; link: string | null; usable: boolean }>>;
      };

      const first = await resolver.resolveRequiredSubscriptionChannels(['channel-1'], {
        allowRemoteFetch: false,
      });
      const second = await resolver.resolveRequiredSubscriptionChannels(['channel-1'], {
        allowRemoteFetch: true,
      });

      expect(first).toEqual([
        {
          id: 'channel-1',
          title: 'Канал channel-1',
          link: null,
          usable: false,
          checkMembership: true,
        },
      ]);
      expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(1);
      expect(second).toEqual([
        {
          id: 'channel-1',
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          usable: true,
          checkMembership: true,
        },
      ]);
    });

    it('prefers cached required subscription metadata from chat context cache without remote metadata fetch', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const chatContextCache = {
        getChatContext: jest.fn().mockResolvedValue({
          chatId: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            requiredSubscriptionEnabled: true,
            requiredSubscriptionChannelIds: ['channel-1'],
            rulesAttachViolationsEnabled: true,
          }),
          domainAllowlist: [],
          adminUserIds: [],
          rulesPublishedUrl: null,
          rulesPublishedMessageId: 'mid-rules-1',
        }),
        getManagedEntityHeader: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Новости MAX',
          entityType: 'channel',
          link: 'https://max.ru/channels/news-max',
          participantsCount: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        }),
        setManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
        invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn(),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/c/chat-1/rules'),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        chatContextCache as never,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
      expect(maxClient.hasChatMember).toHaveBeenCalledWith('channel-1', 'user-1', {
        trafficClass: 'critical',
        timeoutMs: 2_000,
        sourceTag: 'required_subscription_membership',
      });
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText, noticeOptions] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('Новости MAX');
      expect(noticeOptions).toEqual(
        expect.objectContaining({
          textFormat: 'html',
          messageLink: {
            type: 'reply',
            mid: 'mid-rules-1',
          },
          buttons: [
            [
              {
                text: 'Новости MAX',
                url: 'https://max.ru/channels/news-max',
              },
            ],
          ],
        }),
      );
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('refreshes cold required subscription metadata before sending the user notice', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const chatContextCache = {
        getChatContext: jest.fn().mockResolvedValue({
          chatId: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            requiredSubscriptionEnabled: true,
            requiredSubscriptionChannelIds: ['channel-1'],
            rulesAttachViolationsEnabled: true,
          }),
          domainAllowlist: [],
          adminUserIds: [],
          rulesPublishedUrl: null,
          rulesPublishedMessageId: 'mid-rules-1',
        }),
        getManagedEntityHeader: jest.fn().mockResolvedValue(null),
        setManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
        invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/c/chat-1/rules'),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        chatContextCache as never,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.hasChatMember).toHaveBeenCalledWith('channel-1', 'user-1', {
        trafficClass: 'critical',
        timeoutMs: 2_000,
        sourceTag: 'required_subscription_membership',
      });
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(1);
      expect(maxClient.getChatSnapshot).toHaveBeenCalledWith('channel-1', {
        trafficClass: 'background',
        timeoutMs: 2_500,
        sourceTag: 'required_subscription_metadata',
      });
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText, noticeOptions] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('Новости MAX');
      expect(noticeOptions).toEqual(
        expect.objectContaining({
          textFormat: 'html',
          messageLink: {
            type: 'reply',
            mid: 'mid-rules-1',
          },
          buttons: [
            [
              {
                text: 'Новости MAX',
                url: 'https://max.ru/channels/news-max',
              },
            ],
          ],
        }),
      );
      expect(ruleEngine.detect).not.toHaveBeenCalled();
      expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'channel-1',
          title: 'Новости MAX',
          entityType: 'channel',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
        }),
      );
    });

    it('keeps required subscription notices out of the generic bot-notice bucket', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      redisCounter.incrementWithTtl.mockResolvedValue(999);
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(redisCounter.incrementWithTtl).not.toHaveBeenCalledWith(
        'moderation:bot-notice-bucket:v1:chat-1',
        60,
      );
    });

    it('prefers a cached required subscription channel header over a stale persisted chat entity type', async () => {
      const prisma = createPrismaForRequiredSubscription();
      prisma.chat.findMany.mockResolvedValue([
        {
          id: 'channel-1',
          title: 'Старое имя чата',
          entityType: ChatEntityType.CHAT,
        },
      ]);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const chatContextCache = {
        getChatContext: jest.fn().mockResolvedValue({
          chatId: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            requiredSubscriptionEnabled: true,
            requiredSubscriptionChannelIds: ['channel-1'],
            rulesAttachViolationsEnabled: true,
          }),
          domainAllowlist: [],
          adminUserIds: [],
          rulesPublishedUrl: null,
          rulesPublishedMessageId: 'mid-rules-1',
        }),
        getManagedEntityHeader: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Новости MAX',
          entityType: 'channel',
          link: 'https://max.ru/channels/news-max',
          participantsCount: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        }),
        setManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
        invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn(),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/c/chat-1/rules'),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        chatContextCache as never,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
      expect(maxClient.hasChatMember).toHaveBeenCalledWith('channel-1', 'user-1', {
        trafficClass: 'critical',
        timeoutMs: 2_000,
        sourceTag: 'required_subscription_membership',
      });
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('Новости MAX');
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('does not resolve rules links during ordinary chat context loads from cache', async () => {
      const prisma = createPrismaForRequiredSubscription();
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const chatContextCache = {
        getChatContext: jest.fn().mockResolvedValue({
          chatId: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domainAllowlist: [],
          adminUserIds: [],
          rulesPublishedUrl: null,
          rulesPublishedMessageId: 'mid-rules-1',
        }),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/c/chat-1/rules'),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        chatContextCache as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.resolveMessageLink).not.toHaveBeenCalled();
      expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
    });

    it('checks chats and channels in required subscription config', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['chat-2', 'channel-1'],
        requiredSubscriptionButtonText: 'Подписаться',
      });
      prisma.chat.findMany.mockResolvedValue([
        {
          id: 'chat-2',
          title: 'Общий чат',
          entityType: ChatEntityType.CHAT,
        },
      ]);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockImplementation(async (chatId: string) => {
          if (chatId === 'chat-2') {
            return {
              title: 'Общий чат',
              link: 'https://max.ru/chats/chat-2',
              participantsCount: 120,
              entityType: 'chat',
            };
          }

          return {
            title: 'Новости MAX',
            link: 'https://max.ru/channels/news-max',
            participantsCount: 100,
            entityType: 'channel',
          };
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(2);
      expect(maxClient.hasChatMember).toHaveBeenNthCalledWith(1, 'chat-2', 'user-1', {
        trafficClass: 'critical',
        timeoutMs: 2_000,
        sourceTag: 'required_subscription_membership',
      });
      expect(maxClient.hasChatMember).toHaveBeenNthCalledWith(2, 'channel-1', 'user-1', {
        trafficClass: 'critical',
        timeoutMs: 2_000,
        sourceTag: 'required_subscription_membership',
      });
      expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(2);
      expect(maxClient.getChatSnapshot).toHaveBeenNthCalledWith(1, 'chat-2', {
        trafficClass: 'background',
        timeoutMs: 2_500,
        sourceTag: 'required_subscription_metadata',
      });
      expect(maxClient.getChatSnapshot).toHaveBeenNthCalledWith(2, 'channel-1', {
        trafficClass: 'background',
        timeoutMs: 2_500,
        sourceTag: 'required_subscription_metadata',
      });
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(ruleEngine.detect).not.toHaveBeenCalled();
      const [, noticeText, noticeOptions] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('Новости MAX');
      expect(noticeText).toContain('Общий чат');
      expect(noticeOptions).toEqual(
        expect.objectContaining({
          buttons: [
            [
              {
                text: 'Подписаться',
                url: 'https://max.ru/chats/chat-2',
              },
            ],
            [
              {
                text: 'Подписаться',
                url: 'https://max.ru/channels/news-max',
              },
            ],
          ],
        }),
      );
    });

    it('enforces required subscription with a generic notice when metadata cannot produce a channel button and title', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: '',
          link: null,
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.getChatSnapshot).toHaveBeenCalledWith('channel-1', {
        trafficClass: 'background',
        timeoutMs: 2_500,
        sourceTag: 'required_subscription_metadata',
      });
      expect(maxClient.hasChatMember).toHaveBeenCalledWith('channel-1', 'user-1', {
        trafficClass: 'critical',
        timeoutMs: 2_000,
        sourceTag: 'required_subscription_membership',
      });
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('обязательные чаты или каналы');
      expect(prisma.violation.create).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('enforces required subscription with a generic notice when metadata only resolves an english fallback title', async () => {
      const channelId = '-71476678048456';
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: [channelId],
      });
      prisma.chat.findMany.mockResolvedValue([
        {
          id: channelId,
          title: `Chat ${channelId}`,
          entityType: ChatEntityType.CHANNEL,
        },
      ]);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: '',
          link: 'https://max.ru/join/fcg899ueBbNlZawe6eDPbUQALPBuNU6A7OHommknuqI',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(channelId, {
        trafficClass: 'background',
        timeoutMs: 2_500,
        sourceTag: 'required_subscription_metadata',
      });
      expect(maxClient.hasChatMember).toHaveBeenCalledWith(channelId, 'user-1', {
        trafficClass: 'critical',
        timeoutMs: 2_000,
        sourceTag: 'required_subscription_membership',
      });
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('обязательные чаты или каналы');
      expect(prisma.violation.create).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('sends an explanation for every deletion despite legacy notice suppression settings', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionBotMessageEnabled: false,
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      redisCounter.stringCache.set('required-subscription:notice:v1:chat-1:user-1', '1');
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      const secondUpdate = createUpdate();
      secondUpdate.updateId = 'upd-2';
      if (secondUpdate.message) {
        secondUpdate.message.messageId = 'msg-2';
      }

      await service.handleUpdate(createUpdate());
      await service.handleUpdate(secondUpdate);

      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(1);
      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(2);
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(2);
      expect(maxClient.sendMessage.mock.calls.map((call) => call[1])).toEqual([
        expect.stringContaining('Новости MAX'),
        expect.stringContaining('Новости MAX'),
      ]);
      expect(prisma.violation.create).toHaveBeenCalledTimes(2);
      expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(4);
    });

    it('coalesces an explicit MAX media group into one notice and one counted violation', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = { detect: jest.fn().mockResolvedValue({ violations: [] }) };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = createRequiredSubscriptionMaxClient();
      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );
      const anchorCreatedAt = Date.parse('2026-09-06T12:00:00.000Z');

      for (let index = 0; index < 10; index += 1) {
        await service.handleUpdate(
          createRequiredSubscriptionMediaUpdate({
            messageId: `album-message-${index + 1}`,
            createdAt: new Date(anchorCreatedAt + index * 60_000).toISOString(),
            mediaGroupId: 'album-1',
          }),
        );
      }

      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(1);
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(10);
      expect(prisma.violation.create).toHaveBeenCalledTimes(1);
      expect(
        prisma.moderationEvent.upsert.mock.calls.filter(
          ([args]) => args?.create?.ruleCode === 'REQUIRED_SUBSCRIPTION_NOTICE_COVERAGE',
        ),
      ).toHaveLength(9);
      const mediaLockKeys = redisCounter.acquireLock.mock.calls.map(([key]) => key);
      expect(mediaLockKeys[0]).toMatch(
        /^moderation:required-subscription:media-notice-lock:v1:[a-f0-9]{64}$/,
      );
      expect(new Set(mediaLockKeys)).toEqual(new Set([mediaLockKeys[0]]));
    });

    it('coalesces fallback media bursts by source time without extending the window', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = { detect: jest.fn().mockResolvedValue({ violations: [] }) };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = createRequiredSubscriptionMaxClient();
      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );
      const anchorCreatedAt = Date.parse('2026-09-06T12:00:00.000Z');

      for (const [messageId, offsetMs] of [
        ['burst-message-1', 0],
        ['burst-message-2', 9_999],
        ['burst-message-3', 10_001],
      ] as const) {
        await service.handleUpdate(
          createRequiredSubscriptionMediaUpdate({
            messageId,
            createdAt: new Date(anchorCreatedAt + offsetMs).toISOString(),
          }),
        );
      }

      expect(maxClient.sendMessage).toHaveBeenCalledTimes(2);
      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(3);
      expect(prisma.violation.create).toHaveBeenCalledTimes(2);
    });

    it('uses durable media coverage after the Redis delivered marker expires', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = { detect: jest.fn().mockResolvedValue({ violations: [] }) };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = createRequiredSubscriptionMaxClient();
      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );
      const createdAt = '2026-09-06T12:00:00.000Z';
      const first = createRequiredSubscriptionMediaUpdate({
        messageId: 'coverage-message-1',
        createdAt,
        mediaGroupId: 'coverage-album',
      });
      const second = createRequiredSubscriptionMediaUpdate({
        messageId: 'coverage-message-2',
        createdAt,
        mediaGroupId: 'coverage-album',
      });

      await service.handleUpdate(first);
      await service.handleUpdate(second);
      for (const key of redisCounter.stringCache.keys()) {
        if (key.includes('media-notice-state')) redisCounter.stringCache.delete(key);
      }
      await service.handleUpdate(second);

      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(prisma.violation.create).toHaveBeenCalledTimes(1);
      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(3);
    });

    it('recovers one planned media notice after send failure before deleting the package', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = { detect: jest.fn().mockResolvedValue({ violations: [] }) };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const sendMessage = jest
        .fn()
        .mockRejectedValueOnce(new Error('MAX send failed'))
        .mockResolvedValue(undefined);
      const maxClient = createRequiredSubscriptionMaxClient(sendMessage);
      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );
      const createdAt = '2026-09-06T12:00:00.000Z';
      const first = createRequiredSubscriptionMediaUpdate({
        messageId: 'recovery-message-1',
        createdAt,
        mediaGroupId: 'recovery-album',
      });
      const second = createRequiredSubscriptionMediaUpdate({
        messageId: 'recovery-message-2',
        createdAt,
        mediaGroupId: 'recovery-album',
      });

      await expect(service.handleUpdate(first)).rejects.toThrow('MAX send failed');
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();

      await service.handleUpdate(second);
      await service.handleUpdate(first);

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(sendMessage.mock.calls[1]?.[3]).toEqual(
        expect.objectContaining({
          idempotencyKey: 'required-subscription:notice:v1:chat-1:recovery-message-1',
        }),
      );
      expect(prisma.violation.create).toHaveBeenCalledTimes(1);
      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(2);
    });

    it('sends the required subscription explanation for every counted violation', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      prisma.violation.count.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      redisCounter.incrementWithTtl.mockResolvedValue(2);
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      const secondUpdate = createUpdate();
      secondUpdate.updateId = 'upd-2';
      if (secondUpdate.message) {
        secondUpdate.message.messageId = 'msg-2';
      }

      await service.handleUpdate(createUpdate());
      await service.handleUpdate(secondUpdate);

      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(2);
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(2);
      expect(prisma.violation.count).toHaveBeenCalledTimes(2);
      expect(redisCounter.incrementWithTtl).not.toHaveBeenCalled();
      const secondNoticeText = maxClient.sendMessage.mock.calls[1]?.[1] ?? '';
      expect(secondNoticeText).toContain('Новости MAX');
      expect(prisma.moderationEvent.create.mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.objectContaining({
              data: expect.objectContaining({
                ruleCode: 'REQUIRED_SUBSCRIPTION',
                action: SanctionAction.NONE,
                metadata: expect.objectContaining({
                  requiredSubscriptionViolationCount24h: 2,
                }),
              }),
            }),
          ],
        ]),
      );
    });

    it('ignores legacy required subscription expiry and keeps enforcing selected sources', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-04-16T12:00:00.000Z'));

      try {
        const prisma = createPrismaForRequiredSubscription({
          requiredSubscriptionEnabled: true,
          requiredSubscriptionChannelIds: ['channel-1'],
          requiredSubscriptionExpiresAt: '2026-04-10T12:00:00.000Z',
        });
        const ruleEngine = {
          detect: jest.fn().mockResolvedValue({ violations: [] }),
        };
        const maxClient = {
          hasChatMember: jest.fn().mockResolvedValue(false),
          getChatSnapshot: jest.fn().mockResolvedValue({
            title: 'Новости MAX',
            link: 'https://max.ru/channels/news-max',
            participantsCount: 100,
            entityType: 'channel',
          }),
          deleteMessage: jest.fn(),
          sendMessage: jest.fn(),
          kickMember: jest.fn(),
          banMember: jest.fn(),
          notifyModerators: jest.fn(),
          resolveMessageLink: jest.fn().mockResolvedValue(null),
        };

        const service = createRequiredSubscriptionService(
          prisma as never,
          ruleEngine as never,
          { resolveAction: jest.fn() } as never,
          maxClient as never,
        );

        await service.handleUpdate(createUpdate());

        expect(maxClient.hasChatMember).toHaveBeenCalledWith('channel-1', 'user-1', {
          trafficClass: 'critical',
          timeoutMs: 2_000,
          sourceTag: 'required_subscription_membership',
        });
        expect(maxClient.getChatSnapshot).toHaveBeenCalledWith('channel-1', {
          trafficClass: 'background',
          timeoutMs: 2_500,
          sourceTag: 'required_subscription_metadata',
        });
        expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1', expect.any(Object));
        expect(maxClient.sendMessage).toHaveBeenCalled();
        expect(prisma.violation.create).toHaveBeenCalled();
        expect(ruleEngine.detect).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('enforces required subscription while degraded under pressure', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const systemModeService = {
        getSnapshot: jest.fn().mockReturnValue({
          mode: 'degrade',
          source: 'auto',
          reason: 'queue lag 42s',
          updatedAt: '2026-03-30T14:55:00.000Z',
          manualMode: null,
          queueLagSec: 42,
          action: {
            windowSec: 60,
            total: 0,
            success: 0,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
          degraded: true,
        }),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        systemModeService as never,
        undefined,
        redisCounter as never,
      );
      const hotPathProfile = (service as any).createWebhookHotPathProfile();
      maxClient.deleteMessage.mockImplementation(async () => {
        hotPathProfile.startedAtMs =
          Date.now() - Math.max(1, (service as any).webhookUserFacingTimeoutMs - 500);
      });

      await service.handleUpdate(createUpdate(), hotPathProfile);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(1);
      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(1);
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(prisma.violation.create).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('does not delete before a successful notice handoff and retries an already-claimed message idempotently', async () => {
      const prisma = {
        ...createPrismaForRequiredSubscription({
          requiredSubscriptionEnabled: true,
          requiredSubscriptionChannelIds: ['channel-1'],
        }),
        moderationViolationMessageClaim: {
          createMany: jest
            .fn()
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 }),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest
          .fn()
          .mockRejectedValueOnce(new Error('MAX send failed'))
          .mockResolvedValueOnce(undefined),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );
      const ensureModerationDeleteIntent = jest.spyOn(
        service as any,
        'ensureModerationDeleteIntent',
      );

      await expect(service.handleUpdate(createUpdate())).rejects.toThrow('MAX send failed');

      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(ensureModerationDeleteIntent).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();

      await service.handleUpdate({
        ...createUpdate(),
        updateId: 'upd-required-subscription-retry',
      });

      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(1);
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(2);
      expect(maxClient.sendMessage.mock.calls.map((call) => call[3])).toEqual([
        expect.objectContaining({
          idempotencyKey: 'required-subscription:notice:v1:chat-1:msg-1',
        }),
        expect.objectContaining({
          idempotencyKey: 'required-subscription:notice:v1:chat-1:msg-1',
        }),
      ]);
      expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledTimes(1);
      expect(ensureModerationDeleteIntent).toHaveBeenCalledTimes(1);
      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
      expect(maxClient.sendMessage.mock.invocationCallOrder[1]).toBeLessThan(
        ensureModerationDeleteIntent.mock.invocationCallOrder[0]!,
      );
      expect(maxClient.sendMessage.mock.invocationCallOrder[1]).toBeLessThan(
        maxClient.deleteMessage.mock.invocationCallOrder[0]!,
      );
    });

    it('recovers the escalation decision after a crash between the durable claim and notice plan', async () => {
      const prisma = {
        ...createPrismaForRequiredSubscription({
          requiredSubscriptionEnabled: true,
          requiredSubscriptionChannelIds: ['channel-1'],
          requiredSubscriptionWarnEnabled: true,
          requiredSubscriptionWarnMessageText: 'Сохранённое предупреждение: {user}, {channels}.',
        }),
        moderationViolationMessageClaim: {
          createMany: jest
            .fn()
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 }),
        },
      };
      prisma.violation.count
        .mockRejectedValueOnce(new Error('simulated crash after claim'))
        .mockResolvedValueOnce(2);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await expect(service.handleUpdate(createUpdate())).rejects.toThrow(
        'simulated crash after claim',
      );

      expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledTimes(1);
      expect(prisma.violation.create).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.upsert).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();

      await service.handleUpdate({
        ...createUpdate(),
        updateId: 'upd-required-subscription-after-claim-crash',
      });

      expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledTimes(2);
      expect(prisma.violation.create).toHaveBeenCalledTimes(1);
      expect(prisma.violation.count).toHaveBeenCalledTimes(2);
      expect(prisma.moderationEvent.upsert).toHaveBeenCalledTimes(1);
      expect(
        prisma.moderationEvent.create.mock.calls.some(
          ([args]) =>
            args?.data?.ruleCode === 'REQUIRED_SUBSCRIPTION' &&
            args?.data?.action === SanctionAction.WARN &&
            args?.data?.metadata?.requiredSubscriptionViolationCount24h === 2,
        ),
      ).toBe(true);
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(maxClient.sendMessage.mock.calls[0]?.[1]).toContain('Сохранённое предупреждение');
      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
    });

    it.each([
      { storedDurationHours: 6, expectedDuration: '6ч' },
      { storedDurationHours: 0, expectedDuration: '24ч' },
      { storedDurationHours: 337, expectedDuration: '24ч' },
      { storedDurationHours: 1.5, expectedDuration: '24ч' },
      { storedDurationHours: '6', expectedDuration: '24ч' },
      { storedDurationHours: undefined, expectedDuration: '24ч' },
    ])(
      'recovers the recorded mute duration $storedDurationHours before a notice plan was persisted',
      async ({ storedDurationHours, expectedDuration }) => {
        const prisma = {
          ...createPrismaForRequiredSubscription({
            requiredSubscriptionEnabled: true,
            requiredSubscriptionChannelIds: ['channel-1'],
            requiredSubscriptionMuteEnabled: true,
            requiredSubscriptionMuteDurationHours: 24,
          }),
          moderationViolationMessageClaim: {
            createMany: jest.fn().mockResolvedValue({ count: 0 }),
          },
        };
        prisma.moderationEvent.findFirst.mockImplementation(async (args) =>
          args.where.ruleCode === 'REQUIRED_SUBSCRIPTION'
            ? {
                id: 'required-subscription-applied-mute',
                action: SanctionAction.MUTE,
                metadata: {
                  requiredSubscriptionViolationCount24h: 3,
                  muteDurationHours: storedDurationHours,
                  sanctionApplied: true,
                },
              }
            : null,
        );
        const maxClient = createRequiredSubscriptionMaxClient();
        const service = createRequiredSubscriptionService(
          prisma as never,
          { detect: jest.fn().mockResolvedValue({ violations: [] }) } as never,
          { resolveAction: jest.fn() } as never,
          maxClient as never,
          undefined,
          undefined,
          undefined,
          createRequiredSubscriptionRedisCounter() as never,
        );
        const applySanctionAction = jest.spyOn(service as any, 'applySanctionAction');

        await service.handleUpdate(createUpdate());

        expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledTimes(1);
        expect(prisma.violation.create).not.toHaveBeenCalled();
        expect(applySanctionAction).not.toHaveBeenCalled();
        expect(prisma.moderationEvent.upsert).toHaveBeenCalledTimes(1);
        expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
        expect(maxClient.sendMessage.mock.calls[0]?.[1]).toContain(`мут на ${expectedDuration}`);
        expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      {
        label: 'WARN',
        action: SanctionAction.WARN,
        violationCount: 2,
        actionSettings: { requiredSubscriptionWarnEnabled: true },
      },
      {
        label: 'MUTE',
        action: SanctionAction.MUTE,
        violationCount: 2,
        actionSettings: { requiredSubscriptionMuteEnabled: true },
      },
      {
        label: 'BAN',
        action: SanctionAction.BAN,
        violationCount: 2,
        actionSettings: { requiredSubscriptionBanEnabled: true },
      },
    ])(
      'replays the exact persisted $label notice after handoff failure without applying the action twice',
      async ({ action, violationCount, actionSettings }) => {
        let useChangedSettings = false;
        const prisma = createPrismaForRequiredSubscription();
        prisma.chat.upsert.mockImplementation(async () => ({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            requiredSubscriptionEnabled: true,
            requiredSubscriptionChannelIds: ['channel-1'],
            requiredSubscriptionButtonText: useChangedSettings ? 'Новая кнопка' : 'Первая кнопка',
            requiredSubscriptionWarnMessageText: useChangedSettings
              ? 'Новое предупреждение: {user}, {channels}.'
              : 'Первое предупреждение: {user}, {channels}.',
            requiredSubscriptionMuteDurationHours: useChangedSettings ? 12 : 6,
            ...actionSettings,
          }),
          domains: [],
          admins: [],
          rules: {
            publishedUrl: null,
            publishedMessageId: 'mid-rules-1',
          },
        }));
        prisma.violation.count.mockResolvedValue(violationCount);
        let eventSequence = 0;
        prisma.moderationEvent.create.mockImplementation(async () => ({
          id: `required-subscription-event-${++eventSequence}`,
        }));
        const ruleEngine = {
          detect: jest.fn().mockResolvedValue({ violations: [] }),
        };
        const redisCounter = createRequiredSubscriptionRedisCounter();
        const maxClient = {
          hasChatMember: jest.fn().mockResolvedValue(false),
          getChatSnapshot: jest.fn(async () => ({
            title: useChangedSettings ? 'Второй канал' : 'Первый канал',
            link: 'https://max.ru/channels/news-max',
            participantsCount: 100,
            entityType: 'channel',
          })),
          deleteMessage: jest.fn(),
          sendMessage: jest
            .fn()
            .mockRejectedValueOnce(new Error(`MAX ${action} notice failed`))
            .mockResolvedValueOnce(undefined),
          kickMember: jest.fn(),
          banMember: jest.fn(),
          notifyModerators: jest.fn(),
          resolveMessageLink: jest.fn().mockResolvedValue(null),
        };
        const firstService = createRequiredSubscriptionService(
          prisma as never,
          ruleEngine as never,
          { resolveAction: jest.fn() } as never,
          maxClient as never,
          undefined,
          undefined,
          undefined,
          redisCounter as never,
        );
        const firstApplySanctionAction = jest.spyOn(firstService as any, 'applySanctionAction');

        await expect(firstService.handleUpdate(createUpdate())).rejects.toThrow(
          `MAX ${action} notice failed`,
        );

        const firstNotice = maxClient.sendMessage.mock.calls[0];
        expect(firstNotice?.[1]).toContain('Первый канал');
        expect(firstNotice?.[2]).toEqual(
          expect.objectContaining({
            buttons: expect.arrayContaining([
              [{ text: 'Первая кнопка', url: 'https://max.ru/channels/news-max' }],
            ]),
          }),
        );
        expect(prisma.moderationEvent.upsert).toHaveBeenCalledTimes(1);
        const persistedPlanPayload = (
          prisma.moderationEvent.upsert.mock.calls[0]?.[0]?.create?.metadata as
            | { requiredSubscriptionNoticePlan?: { payload?: unknown } }
            | undefined
        )?.requiredSubscriptionNoticePlan?.payload;
        expect(typeof persistedPlanPayload).toBe('string');
        expect(JSON.parse(persistedPlanPayload as string)).toEqual(
          expect.objectContaining({ action }),
        );
        expect(maxClient.deleteMessage).not.toHaveBeenCalled();

        useChangedSettings = true;
        const retryService = createRequiredSubscriptionService(
          prisma as never,
          ruleEngine as never,
          { resolveAction: jest.fn() } as never,
          maxClient as never,
          undefined,
          undefined,
          undefined,
          redisCounter as never,
        );
        const retryApplySanctionAction = jest.spyOn(retryService as any, 'applySanctionAction');

        await retryService.handleUpdate({
          ...createUpdate(),
          updateId: `upd-required-subscription-${action.toLowerCase()}-retry`,
        });

        const retryNotice = maxClient.sendMessage.mock.calls[1];
        expect(retryNotice?.[1]).toBe(firstNotice?.[1]);
        expect(retryNotice?.[2]).toEqual(firstNotice?.[2]);
        expect(retryNotice?.[3]).toEqual(
          expect.objectContaining({
            idempotencyKey: 'required-subscription:notice:v1:chat-1:msg-1',
          }),
        );
        expect(prisma.moderationEvent.upsert).toHaveBeenCalledTimes(1);
        expect(retryApplySanctionAction).not.toHaveBeenCalled();
        expect(firstApplySanctionAction).toHaveBeenCalledTimes(
          action === SanctionAction.WARN ? 0 : 1,
        );
        expect(
          prisma.moderationEvent.create.mock.calls.filter(
            ([args]) =>
              args?.data?.ruleCode === 'REQUIRED_SUBSCRIPTION' && args?.data?.action === action,
          ),
        ).toHaveLength(1);
        expect(maxClient.banMember).toHaveBeenCalledTimes(action === SanctionAction.BAN ? 1 : 0);
        expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
      },
    );

    it('stops a MUTE before persistence when the notice lease is lost during sanction preparation', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionMuteEnabled: true,
      });
      prisma.violation.count.mockResolvedValue(2);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      let noticeLeaseOwned = true;
      redisCounter.renewLock.mockImplementation(async () => noticeLeaseOwned);
      const sanctionLeaseGuard = {
        assertOwned: jest.fn().mockResolvedValue(undefined),
      };
      const sanctionStateLock = {
        runExclusive: jest.fn(
          async (
            _subject: unknown,
            operation: (guard: typeof sanctionLeaseGuard) => Promise<unknown>,
          ) => operation(sanctionLeaseGuard),
        ),
      };
      const automaticFence = {
        version: 1,
        transitionId: 'required-subscription-blocked-mute',
        chatId: 'chat-1',
        userId: 'user-1',
        intendedAction: 'MUTE',
        operator: 'BOT',
        source: 'automatic_moderation',
        invalidatedSanctionEventIds: [],
      };
      const deferredFence = createDeferred<typeof automaticFence>();
      const sanctionStateFence = {
        prepare: jest.fn().mockReturnValue(deferredFence.promise),
        commit: jest.fn(),
        markRemoteConfirmedEventMissing: jest.fn(),
        abort: jest.fn().mockResolvedValue(undefined),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const service = createModerationServiceWithSanctionStateLock({
        prisma,
        ruleEngine,
        sanctionService: { resolveAction: jest.fn() },
        maxClient,
        redisCounter,
        sanctionStateLock,
        sanctionStateFence,
      });
      installRequiredSubscriptionFixtureGuards(service);
      const rememberActiveMuteState = jest.spyOn(service as any, 'rememberActiveMuteState');
      const ensureModerationDeleteIntent = jest.spyOn(
        service as any,
        'ensureModerationDeleteIntent',
      );

      const processing = service.handleUpdate(createUpdate());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(sanctionStateFence.prepare).toHaveBeenCalledTimes(1);

      noticeLeaseOwned = false;
      deferredFence.resolve(automaticFence);

      await expect(processing).rejects.toThrow('Required subscription notice lease was lost');
      expect(rememberActiveMuteState).not.toHaveBeenCalled();
      expect(
        prisma.moderationEvent.create.mock.calls.some(
          ([args]) => args?.data?.ruleCode === 'REQUIRED_SUBSCRIPTION',
        ),
      ).toBe(false);
      expect(prisma.moderationEvent.upsert).not.toHaveBeenCalled();
      expect(sanctionStateFence.commit).not.toHaveBeenCalled();
      expect(sanctionStateFence.abort).toHaveBeenCalledWith(automaticFence);
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(ensureModerationDeleteIntent).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.banMember).not.toHaveBeenCalled();
    });

    it('rejects retryably without notice or delete side effects when the message-scoped notice lease is busy', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      redisCounter.acquireLock.mockResolvedValue(null);
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );
      const ensureModerationDeleteIntent = jest.spyOn(
        service as any,
        'ensureModerationDeleteIntent',
      );

      const rejection = await service.handleUpdate(createUpdate()).then(
        () => null,
        (error: unknown) => error,
      );

      expect(rejection).toEqual(
        new Error('Required subscription notice handoff is already in progress'),
      );
      expect((service as any).isTerminalWebhookProcessingError(rejection)).toBe(false);
      expect(redisCounter.acquireLock).toHaveBeenCalledWith(
        'moderation:required-subscription:notice-lock:v1:chat-1:msg-1',
        60_000,
      );
      expect(redisCounter.releaseLock).not.toHaveBeenCalled();
      expect(prisma.violation.create).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(ensureModerationDeleteIntent).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('does not hand off a notice or delete when the message-scoped notice lease is lost before send', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      redisCounter.renewLock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );
      const ensureModerationDeleteIntent = jest.spyOn(
        service as any,
        'ensureModerationDeleteIntent',
      );

      await expect(service.handleUpdate(createUpdate())).rejects.toThrow(
        'Required subscription notice lease was lost',
      );

      const lockKey = 'moderation:required-subscription:notice-lock:v1:chat-1:msg-1';
      expect(redisCounter.renewLock).toHaveBeenNthCalledWith(1, lockKey, `lock-${lockKey}`, 60_000);
      expect(redisCounter.renewLock).toHaveBeenNthCalledWith(2, lockKey, `lock-${lockKey}`, 60_000);
      expect(redisCounter.releaseLock).toHaveBeenCalledWith(lockKey, `lock-${lockKey}`);
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(ensureModerationDeleteIntent).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('sends exactly one interactive required subscription notice for MUTE and bypasses the generic notice bucket', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionMuteEnabled: true,
      });
      prisma.violation.count.mockResolvedValue(3);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      redisCounter.incrementWithTtl.mockResolvedValue(999);
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText, noticeOptions, dispatchOptions] =
        maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('Новости MAX');
      expect(noticeOptions).toEqual(
        expect.objectContaining({
          textFormat: 'html',
          debugContext: {
            screen: 'moderation',
            action: 'required-subscription-notice',
          },
        }),
      );
      expect(dispatchOptions).toEqual(
        expect.objectContaining({
          trafficClass: 'interactive',
          actionHealthLane: 'interactive',
          sourceTag: 'moderation_notice',
          idempotencyKey: 'required-subscription:notice:v1:chat-1:msg-1',
        }),
      );
      expect(redisCounter.incrementWithTtl).not.toHaveBeenCalledWith(
        'moderation:bot-notice-bucket:v1:chat-1',
        60,
      );
      expect(prisma.moderationEvent.create.mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.objectContaining({
              data: expect.objectContaining({
                ruleCode: 'REQUIRED_SUBSCRIPTION',
                action: SanctionAction.MUTE,
              }),
            }),
          ],
        ]),
      );
    });

    it('does not create or execute a delete intent when the real required-subscription MUTE notice fails', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionMuteEnabled: true,
      });
      prisma.violation.count.mockResolvedValue(3);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn().mockRejectedValue(new Error('MAX MUTE notice failed')),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );
      const applySanctionAction = jest.spyOn(service as any, 'applySanctionAction');
      const ensureModerationDeleteIntent = jest.spyOn(
        service as any,
        'ensureModerationDeleteIntent',
      );

      await expect(service.handleUpdate(createUpdate())).rejects.toThrow('MAX MUTE notice failed');

      expect(applySanctionAction).toHaveBeenCalledTimes(1);
      expect(applySanctionAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: SanctionAction.MUTE,
          rethrowNoticeFailure: true,
          noticeBeforeSend: expect.any(Function),
        }),
      );
      expect(redisCounter.renewLock).toHaveBeenCalled();
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(ensureModerationDeleteIntent).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    });

    it('keeps the actual duration when rechecking an active required-subscription MUTE after settings change', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionMuteEnabled: true,
        requiredSubscriptionMuteDurationHours: 6,
      });
      prisma.violation.count.mockResolvedValue(3);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );
      const applySanctionAction = jest.spyOn(service as any, 'applySanctionAction');
      const handleActiveMuteMessage = jest.spyOn(service as any, 'handleActiveMuteMessage');
      const secondUpdate = createUpdate();
      secondUpdate.updateId = 'upd-active-required-subscription-mute-2';
      if (secondUpdate.message) {
        secondUpdate.message.messageId = 'msg-active-required-subscription-mute-2';
      }

      await service.handleUpdate(createUpdate());
      const storedChat = await prisma.chat.upsert.mock.results[0]?.value;
      storedChat.settings.requiredSubscriptionMuteDurationHours = 24;
      await service.handleUpdate(secondUpdate);

      expect(applySanctionAction).toHaveBeenCalledTimes(1);
      expect(applySanctionAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: SanctionAction.MUTE,
          activeMuteRuleCode: 'REQUIRED_SUBSCRIPTION',
        }),
      );
      expect(handleActiveMuteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(2);
      expect(maxClient.sendMessage.mock.calls[1]?.[1]).toContain('Новости MAX');
      expect(maxClient.sendMessage.mock.calls[1]?.[1]).toContain('мут на 6ч');
      expect(maxClient.sendMessage.mock.calls[1]?.[1]).not.toContain('24ч');
      expect(maxClient.sendMessage.mock.calls[1]?.[3]).toEqual(
        expect.objectContaining({
          idempotencyKey:
            'required-subscription:notice:v1:chat-1:msg-active-required-subscription-mute-2',
        }),
      );
      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(2);
      expectImmediateDeleteMessage(
        maxClient.deleteMessage,
        'chat-1',
        'msg-active-required-subscription-mute-2',
      );
      expect(maxClient.sendMessage.mock.invocationCallOrder[1]).toBeLessThan(
        maxClient.deleteMessage.mock.invocationCallOrder[1]!,
      );
      expect(maxClient.kickMember).not.toHaveBeenCalled();
      expect(maxClient.banMember).not.toHaveBeenCalled();
      expect(
        prisma.moderationEvent.create.mock.calls.some(
          ([args]) =>
            args?.data?.messageId === 'msg-active-required-subscription-mute-2' &&
            args?.data?.ruleCode === 'REQUIRED_SUBSCRIPTION',
        ),
      ).toBe(false);
    });

    it('sends the ordinary required subscription explanation when BAN is definitively rejected', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionBotMessageText: 'Обычное объяснение: подпишитесь на {channels}.',
        requiredSubscriptionBanEnabled: true,
      });
      prisma.violation.count.mockResolvedValue(2);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      redisCounter.incrementWithTtl.mockResolvedValue(2);
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );
      const applySanctionAction = jest
        .spyOn(service as never, 'applySanctionAction' as never)
        .mockResolvedValue(false as never);

      await service.handleUpdate(createUpdate());

      expect(applySanctionAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: SanctionAction.BAN,
          bypassNoticeBucket: true,
          noticeIdempotencyKey: 'required-subscription:notice:v1:chat-1:msg-1',
          rethrowNoticeFailure: true,
          activeMuteRuleCode: 'REQUIRED_SUBSCRIPTION',
          routeNoticeDynamically: true,
        }),
      );
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('Обычное объяснение');
      expect(noticeText).toContain('Новости MAX');
      expect(maxClient.banMember).not.toHaveBeenCalled();
    });

    it('issues WARN on second required subscription violation in 24h when warning stage is enabled', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionWarnEnabled: true,
      });
      prisma.violation.count.mockResolvedValue(2);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('предупреждение');
      expect(noticeText).toContain('Новости MAX');
      expect(prisma.moderationEvent.create.mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.objectContaining({
              data: expect.objectContaining({
                ruleCode: 'REQUIRED_SUBSCRIPTION',
                action: SanctionAction.WARN,
                metadata: expect.objectContaining({
                  requiredSubscriptionViolationCount24h: 2,
                }),
              }),
            }),
          ],
        ]),
      );
      expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
      expect(maxClient.kickMember).not.toHaveBeenCalled();
    });

    it('issues BAN on third required subscription violation without adding the user to global spammers', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionWarnEnabled: true,
        requiredSubscriptionBanEnabled: true,
      });
      prisma.violation.count.mockResolvedValue(3);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toMatch(/бан/i);
      expect(noticeText).toContain('Новости MAX');
      expect(prisma.moderationEvent.create.mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.objectContaining({
              data: expect.objectContaining({
                ruleCode: 'REQUIRED_SUBSCRIPTION',
                action: SanctionAction.BAN,
                metadata: expect.objectContaining({
                  requiredSubscriptionViolationCount24h: 3,
                }),
              }),
            }),
          ],
        ]),
      );
      expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
      expect(maxClient.kickMember).not.toHaveBeenCalled();
      expectImmediateBanMember(maxClient.banMember, 'chat-1', 'user-1');
    });

    it('issues BAN on fourth required subscription violation without adding the user to global spammers', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionWarnEnabled: true,
        requiredSubscriptionBanEnabled: true,
        requiredSubscriptionMuteEnabled: true,
      });
      prisma.violation.count.mockResolvedValue(4);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.kickMember).not.toHaveBeenCalled();
      expectImmediateBanMember(maxClient.banMember, 'chat-1', 'user-1');
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('Новости MAX');
      expect(prisma.moderationEvent.create.mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.objectContaining({
              data: expect.objectContaining({
                ruleCode: 'REQUIRED_SUBSCRIPTION',
                action: SanctionAction.BAN,
                metadata: expect.objectContaining({
                  requiredSubscriptionViolationCount24h: 4,
                }),
              }),
            }),
          ],
        ]),
      );
      expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    });

    it('fails open for terminal required subscription membership errors', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const terminalError = createMaxApiError(
        403,
        'Request failed with status code 403',
        'chat.denied',
      );
      const maxClient = {
        hasChatMember: jest.fn().mockRejectedValue(terminalError),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );
      const ensureDeleteIntent = jest.spyOn(service as any, 'ensureModerationDeleteIntent');

      await service.handleUpdate(createUpdate());

      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(2);
      expect(ensureDeleteIntent).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(prisma.violation.create).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
      expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        'timeout',
        Object.assign(new Error('MAX membership lookup timeout'), {
          code: 'ECONNABORTED',
        }),
      ],
      [
        'server error',
        Object.assign(new Error('MAX membership lookup unavailable'), {
          response: { status: 503 },
        }),
      ],
      [
        'connection reset',
        Object.assign(new Error('MAX membership connection reset'), {
          code: 'ECONNRESET',
        }),
      ],
    ])(
      'fails open and applies backoff after repeated transient required subscription membership errors: %s',
      async (_label, transientError) => {
        const prisma = createPrismaForRequiredSubscription({
          requiredSubscriptionEnabled: true,
          requiredSubscriptionChannelIds: ['channel-1'],
          requiredSubscriptionWarnEnabled: true,
          requiredSubscriptionBanEnabled: true,
          requiredSubscriptionMuteEnabled: true,
        });
        const ruleEngine = {
          detect: jest.fn().mockResolvedValue({ violations: [] }),
        };
        const redisCounter = createRequiredSubscriptionRedisCounter();
        const maxClient = {
          hasChatMember: jest.fn().mockRejectedValue(transientError),
          getChatSnapshot: jest.fn().mockResolvedValue({
            title: 'Новости MAX',
            link: 'https://max.ru/channels/news-max',
            participantsCount: 100,
            entityType: 'channel',
          }),
          deleteMessage: jest.fn(),
          sendMessage: jest.fn(),
          kickMember: jest.fn(),
          banMember: jest.fn(),
          notifyModerators: jest.fn(),
          resolveMessageLink: jest.fn().mockResolvedValue(null),
        };

        const service = createRequiredSubscriptionService(
          prisma as never,
          ruleEngine as never,
          { resolveAction: jest.fn() } as never,
          maxClient as never,
          undefined,
          undefined,
          undefined,
          redisCounter as never,
        );
        const ensureDeleteIntent = jest.spyOn(service as any, 'ensureModerationDeleteIntent');

        await service.handleUpdate(createUpdate());

        expect(maxClient.hasChatMember).toHaveBeenCalledTimes(2);
        expect(ensureDeleteIntent).not.toHaveBeenCalled();
        expect(maxClient.deleteMessage).not.toHaveBeenCalled();
        expect(maxClient.sendMessage).not.toHaveBeenCalled();
        expect(maxClient.kickMember).not.toHaveBeenCalled();
        expect(maxClient.banMember).not.toHaveBeenCalled();
        expect(prisma.violation.create).not.toHaveBeenCalled();
        expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
        expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
        expect((service as any).requiredSubscriptionMembershipBackoffUntilMs.size).toBe(1);
      },
    );

    it('enforces only explicitly missing targets when another membership lookup stays unresolved', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-missing', 'channel-unresolved'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const transientError = Object.assign(new Error('MAX membership lookup timeout'), {
        code: 'ECONNABORTED',
      });
      const maxClient = {
        hasChatMember: jest.fn((channelId: string) => {
          if (channelId === 'channel-missing') {
            return Promise.resolve(false);
          }
          return Promise.reject(transientError);
        }),
        getChatSnapshot: jest.fn((channelId: string) =>
          Promise.resolve({
            title: channelId,
            link: `https://max.ru/channels/${channelId}`,
            participantsCount: 100,
            entityType: 'channel',
          }),
        ),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(3);
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(prisma.violation.create).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.create.mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.objectContaining({
              data: expect.objectContaining({
                ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
                metadata: expect.objectContaining({
                  missingChannelIds: ['channel-missing'],
                  unresolvedChannelIds: ['channel-unresolved'],
                }),
              }),
            }),
          ],
        ]),
      );
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('enforces required subscription when the system is under pressure', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const systemModeService = {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'degrade',
          source: 'auto',
          reason: 'user-facing queue lag 42.0s',
          updatedAt: new Date().toISOString(),
          manualMode: null,
          queueLagSec: 42,
          action: {
            windowSec: 60,
            total: 50,
            success: 45,
            failure: 5,
            critical: 0,
            errorRate: 0.1,
            criticalRate: 0,
          },
        }),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        systemModeService as never,
      );

      await service.handleUpdate(createUpdate());

      expect(systemModeService.getEffectiveSnapshot).toHaveBeenCalled();
      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(1);
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(prisma.violation.create).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('enforces required subscription before skipping a chat in webhook hot-timeout backoff', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );
      (service as any).webhookHotTimeoutChatBackoffUntilMs.set('chat-1', Date.now() + 60_000);

      await service.handleUpdate(createUpdate());

      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(1);
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(prisma.violation.create).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('keeps ordinary message moderation active for a hot chat while the system is healthy', async () => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings(),
            domains: [],
            admins: [],
          }),
        },
        violation: {
          create: jest.fn(),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );
      (service as any).webhookHotTimeoutChatBackoffUntilMs.set('chat-1', Date.now() + 60_000);

      await service.handleUpdate(createUpdate());

      expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(prisma.violation.create).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    });

    it('keeps duplicate detection and known-spammer checks while skipping cross-chat tracking under pressure', async () => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({ deleteSpammersEnabled: true }),
            domains: [],
            admins: [],
          }),
        },
        violation: {
          create: jest.fn(),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
        globalSpammer: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const redisCounter = {
        addToSetWithTtl: jest.fn(),
        incrementWithTtl: jest.fn(),
      };
      const systemModeService = {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'degrade',
          source: 'auto',
          reason: 'user-facing queue lag 18.0s',
          updatedAt: new Date().toISOString(),
          manualMode: null,
          queueLagSec: 18,
          action: {
            windowSec: 60,
            total: 20,
            success: 16,
            failure: 4,
            critical: 0,
            errorRate: 0.2,
            criticalRate: 0,
          },
        }),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        systemModeService as never,
        undefined,
        redisCounter as never,
      );
      const trackingSpy = jest.spyOn(
        service as any,
        'trackAndRegisterGlobalSpammerWithHotPathBudget',
      );
      (service as any).webhookHotTimeoutChatBackoffUntilMs.set('chat-1', Date.now() + 60_000);

      await service.handleUpdate(createUpdate());

      expect(systemModeService.getEffectiveSnapshot).toHaveBeenCalled();
      expect(redisCounter.addToSetWithTtl).not.toHaveBeenCalled();
      expect(trackingSpy).not.toHaveBeenCalled();
      expect(prisma.globalSpammer.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.findFirst).toHaveBeenCalled();
      expect(ruleEngine.detect).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicateState: false }),
      );
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    });

    it('enforces a local admin block for a degraded hot chat without cross-chat tracking', async () => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({ deleteSpammersEnabled: true }),
            domains: [],
            admins: [{ userId: 'owner-1' }],
          }),
        },
        globalSpammer: { findUnique: jest.fn().mockResolvedValue(null) },
        adminGlobalSpammerExemption: {
          findMany: jest.fn().mockResolvedValue([
            {
              userId: 'user-1',
              decision: 'BLOCK',
              updatedAt: new Date(),
            },
          ]),
        },
        violation: {
          create: jest.fn(),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const systemModeService = {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'degrade',
          source: 'auto',
          reason: 'user-facing queue lag 18.0s',
          updatedAt: new Date().toISOString(),
          manualMode: null,
          queueLagSec: 18,
          action: {
            windowSec: 60,
            total: 20,
            success: 16,
            failure: 4,
            critical: 0,
            errorRate: 0.2,
            criticalRate: 0,
          },
        }),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        systemModeService as never,
      );
      const trackingSpy = jest.spyOn(
        service as any,
        'trackAndRegisterGlobalSpammerWithHotPathBudget',
      );
      const ensureDeleteIntent = jest
        .spyOn(service as any, 'ensureModerationDeleteIntent')
        .mockResolvedValue(undefined);
      (service as any).webhookHotTimeoutChatBackoffUntilMs.set('chat-1', Date.now() + 60_000);
      const update = createUpdate();
      update.message!.createdAt = new Date().toISOString();

      await service.handleUpdate(update);

      expect(prisma.adminGlobalSpammerExemption.findMany).toHaveBeenCalledTimes(1);
      expect(trackingSpy).not.toHaveBeenCalled();
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expectImmediateKickMember(maxClient.kickMember, 'chat-1', 'user-1');
      expect(ensureDeleteIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          ruleCode: 'LOCAL_ADMIN_BLOCK_MESSAGE_DELETE',
          sourceMessageAt: update.message!.createdAt,
        }),
      );
      expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'msg-1',
          ruleCode: 'LOCAL_ADMIN_BLOCK',
          action: SanctionAction.KICK,
        }),
      });
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('enforces an already-known spammer for a degraded hot chat without cross-chat tracking', async () => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({ deleteSpammersEnabled: true }),
            domains: [],
            admins: [],
          }),
        },
        violation: {
          create: jest.fn(),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const systemModeService = {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'degrade',
          source: 'auto',
          reason: 'user-facing queue lag 18.0s',
          updatedAt: new Date().toISOString(),
          manualMode: null,
          queueLagSec: 18,
          action: {
            windowSec: 60,
            total: 20,
            success: 16,
            failure: 4,
            critical: 0,
            errorRate: 0.2,
            criticalRate: 0,
          },
        }),
      };
      const globalSpammerIntelligence = {
        evaluatePolicy: jest.fn().mockResolvedValue({ action: 'DELETE_AND_KICK' }),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        systemModeService as never,
      );
      (service as any).globalSpammerIntelligence = globalSpammerIntelligence;
      const trackingSpy = jest.spyOn(
        service as any,
        'trackAndRegisterGlobalSpammerWithHotPathBudget',
      );
      (service as any).webhookHotTimeoutChatBackoffUntilMs.set('chat-1', Date.now() + 60_000);

      await service.handleUpdate(createUpdate());

      expect(trackingSpy).not.toHaveBeenCalled();
      expect(globalSpammerIntelligence.evaluatePolicy).toHaveBeenCalledWith({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        trigger: 'message',
        deleteSpammersEnabled: true,
        recordDecision: true,
      });
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expectImmediateKickMember(maxClient.kickMember, 'chat-1', 'user-1');
      expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'msg-1',
          ruleCode: 'GLOBAL_SPAMMER_KICK',
          action: SanctionAction.KICK,
        }),
      });
      expect(ruleEngine.detect).not.toHaveBeenCalled();
    });

    it('keeps duplicate state and the known-spammer check near the hot-path deadline', async () => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({ deleteSpammersEnabled: true }),
            domains: [],
            admins: [],
            rules: {
              publishedUrl: null,
              publishedMessageId: null,
            },
          }),
        },
        violation: {
          create: jest.fn(),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
        globalSpammer: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const redisCounter = {
        addToSetWithTtl: jest.fn(),
        incrementWithTtl: jest.fn(),
      };
      const systemModeService = {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'degrade',
          source: 'auto',
          reason: 'user-facing queue lag 12.0s',
          updatedAt: new Date().toISOString(),
          manualMode: null,
          queueLagSec: 12,
          action: {
            windowSec: 60,
            total: 20,
            success: 16,
            failure: 4,
            critical: 0,
            errorRate: 0.2,
            criticalRate: 0,
          },
        }),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        systemModeService as never,
        undefined,
        redisCounter as never,
      );
      const hotPathProfile = (service as any).createWebhookHotPathProfile();
      hotPathProfile.startedAtMs = Date.now() - 9_300;
      hotPathProfile.lastMarkedAtMs = hotPathProfile.startedAtMs;

      await service.handleUpdate(createUpdate(), hotPathProfile);

      expect(redisCounter.addToSetWithTtl).toHaveBeenCalled();
      expect(prisma.globalSpammer.findUnique).toHaveBeenCalledTimes(1);
      expect(ruleEngine.detect).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicateState: false }),
      );
    });

    it('keeps local message moderation active for a hot chat while optional stages are throttled', async () => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({ antiDuplicateEnabled: true }),
            domains: [],
            admins: [],
          }),
        },
        violation: {
          create: jest.fn(),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };
      const systemModeService = {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'degrade',
          source: 'auto',
          reason: 'user-facing queue lag 18.0s',
          updatedAt: new Date().toISOString(),
          manualMode: null,
          queueLagSec: 18,
          action: {
            windowSec: 60,
            total: 20,
            success: 16,
            failure: 4,
            critical: 0,
            errorRate: 0.2,
            criticalRate: 0,
          },
        }),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        systemModeService as never,
      );
      (service as any).webhookHotTimeoutChatBackoffUntilMs.set('chat-1', Date.now() + 60_000);

      await service.handleUpdate(createUpdate());

      expect(systemModeService.getEffectiveSnapshot).toHaveBeenCalled();
      expect(ruleEngine.detect).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicateState: false }),
      );
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(prisma.violation.create).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    });

    it('keeps admin bypass ahead of required subscription checks', async () => {
      const prisma = createPrismaForRequiredSubscription(
        {
          requiredSubscriptionEnabled: true,
          requiredSubscriptionChannelIds: ['channel-1'],
        },
        ['user-1'],
      );
      const ruleEngine = {
        detect: jest.fn(),
      };
      const maxClient = {
        hasChatMember: jest.fn(),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };

      const service = createRequiredSubscriptionService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.hasChatMember).not.toHaveBeenCalled();
      expect(ruleEngine.detect).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
    });
  });
  it.each([
    { operationalLagSec: 0, expected: null },
    { operationalLagSec: 32, expected: 'queue lag 32.0s' },
    { operationalLagSec: undefined, expected: 'queue lag 290.0s' },
  ])(
    'uses operational lag $operationalLagSec in the background-pressure fallback',
    async ({ operationalLagSec, expected }) => {
      const getOperationalSnapshot = jest.fn().mockResolvedValue({
        effectiveLagSec: 290,
        operationalLagSec,
        webhookDefaultWorkerGroups: {},
      });
      const getSnapshot = jest.fn().mockRejectedValue(new Error('full snapshot must not run'));
      const service = createRequiredSubscriptionService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { getOperationalSnapshot, getSnapshot } as never,
      );

      await expect((service as any).resolveBackgroundPressurePauseReason()).resolves.toBe(expected);

      expect(getOperationalSnapshot).toHaveBeenCalledWith({ maxAgeMs: 1_500 });
      expect(getSnapshot).not.toHaveBeenCalled();
    },
  );

  it('counts prioritized-only backlog in the background-pressure fallback', async () => {
    const getOperationalSnapshot = jest.fn().mockResolvedValue({
      effectiveLagSec: 0,
      webhookDefaultWorkerGroups: {
        'api-moderation': {
          counters: { waiting: 0, prioritized: 4, active: 0 },
        },
        'api-moderation-realtime-b': {
          counters: { waiting: 0, prioritized: 0, active: 0 },
        },
      },
    });
    const service = createRequiredSubscriptionService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { getOperationalSnapshot } as never,
    );

    await expect((service as any).resolveBackgroundPressurePauseReason()).resolves.toBe(
      'default worker skew api-moderation 4/4',
    );
  });

  it('throttles channel auto-post scans instead of pausing them completely when the runtime governor returns slow', async () => {
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockResolvedValue({
        action: 'slow',
        reason: 'background share 67.2%',
        retryAfterMs: 45_000,
      }),
    };

    const service = createRequiredSubscriptionService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      backgroundRuntimeGovernorService as never,
    );
    const loggerSpy = jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});

    const plan = await (service as any).resolveChannelAutoPostExecutionPlan();

    expect(plan).toEqual({
      batchSize: 4,
      interChannelDelayMs: 500,
      maxNewMessagesPerScan: 1,
    });
    expect(backgroundRuntimeGovernorService.decide).toHaveBeenCalledWith({
      component: 'moderation',
      sourceTag: 'channel_auto_post',
      allowRecoveryWindowRun: true,
      allowQueueLagSlowPathBelowSec: 5,
    });
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'channel-auto-post-buttons',
        action: 'slow',
        reason: 'background share 67.2%',
        retryAfterMs: 45_000,
        batchSize: 4,
        maxNewMessagesPerScan: 1,
      }),
      'Throttled moderation background work because the runtime governor detected pressure',
    );
  });

  it('pauses channel auto-post scans when the runtime governor is unavailable', async () => {
    const prisma = {
      channelSettings: {
        findMany: jest.fn(),
      },
    };
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockRejectedValue(new Error('timeout exceeded when trying to connect')),
    };

    const service = createRequiredSubscriptionService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      backgroundRuntimeGovernorService as never,
    );
    const loggerSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
    const beforeScanMs = Date.now();

    await expect((service as any).processChannelAutoPostButtons()).resolves.toBeUndefined();

    expect(backgroundRuntimeGovernorService.decide).toHaveBeenCalledWith({
      component: 'moderation',
      sourceTag: 'channel_auto_post',
      allowRecoveryWindowRun: true,
      allowQueueLagSlowPathBelowSec: 5,
    });
    expect(prisma.channelSettings.findMany).not.toHaveBeenCalled();
    expect((service as any).channelAutoPostBackoffUntilMs).toBeGreaterThanOrEqual(
      beforeScanMs + 180_000,
    );
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'channel-auto-post-buttons',
        retryAfterMs: 180_000,
        err: 'timeout exceeded when trying to connect',
      }),
      'Paused moderation background work because the runtime governor is unavailable',
    );
  });

  it('loads full channel auto-post contexts only for the selected scan batch', async () => {
    const candidateChannels = [
      { commentsEnabled: true, chatId: 'channel-1' },
      { commentsEnabled: true, chatId: 'channel-2' },
      { commentsEnabled: true, chatId: 'channel-3' },
      { commentsEnabled: true, chatId: 'channel-4' },
      { commentsEnabled: true, chatId: 'channel-5' },
      { commentsEnabled: true, chatId: 'channel-6' },
    ];
    const channelBatch = ['channel-1', 'channel-2', 'channel-3', 'channel-4'];
    const prisma = {
      channelSettings: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(candidateChannels)
          .mockResolvedValueOnce(
            channelBatch.map((chatId) => ({
              chatId,
              updatedAt: new Date('2026-04-13T00:00:00.000Z'),
              commentsEnabled: true,
              commentsAdminsEnabled: true,
              commentsAllEnabled: false,
              postSuggestionsEnabled: false,
              chat: {
                admins: [{ userId: 'admin-1' }],
              },
            })),
          ),
      },
    };
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockResolvedValue({
        action: 'slow',
        reason: 'background share 67.2%',
        retryAfterMs: 45_000,
      }),
    };
    const service = createRequiredSubscriptionService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      backgroundRuntimeGovernorService as never,
    );
    jest.spyOn(service as any, 'processManagedChannelAutoPostButtons').mockResolvedValue(undefined);

    await (service as any).processChannelAutoPostButtons();

    expect(prisma.channelSettings.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        select: {
          chatId: true,
          quickButtonsEnabled: true,
          postSignatureEnabled: true,
          commentsEnabled: true,
          postSuggestionsEnabled: true,
        },
        take: 64,
      }),
    );
    expect(prisma.channelSettings.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          chatId: {
            in: channelBatch,
          },
          chat: {
            entityType: ChatEntityType.CHANNEL,
          },
        },
      }),
    );
    expect((service as any).processManagedChannelAutoPostButtons).toHaveBeenCalledTimes(4);
  });

  it('uses the executable edit route when auto-attaching channel buttons during poll repair', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({ entityType: ChatEntityType.CHANNEL }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      getChatSnapshot: jest.fn().mockResolvedValue({ entityType: 'channel' }),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: '990002',
        isAdmin: true,
        isOwner: false,
        permissions: ['edit_message'],
      }),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      resolveBotRoutes: jest.fn().mockResolvedValue({
        purpose: 'moderation_action',
        chatId: 'channel-1',
        primaryBotId: 'scan-bot-2',
        botId: 'scan-bot-2',
        candidateBotIds: ['scan-bot-2'],
        reason: 'primary_confirmed',
        action: 'edit_message',
      }),
      getExecutableBotById: jest.fn((botId: string) =>
        botId === 'scan-bot-2' ? { id: botId, contactId: '990002' } : null,
      ),
      getBotTokenSync: jest.fn().mockReturnValue('test-bot-token'),
      buildMiniappStartUrlSync: jest
        .fn()
        .mockImplementation(
          (startParam: string, botId?: string | null) =>
            `https://max.ru/${encodeURIComponent(botId?.trim() || 'scan-bot-2')}?startapp=${startParam}`,
        ),
      buildEntryMiniappStartUrlSync: jest
        .fn()
        .mockImplementation(
          (startParam: string) => `https://max.ru/test-bot?startapp=${startParam}`,
        ),
      resolveContactIdSync: jest.fn((botId?: string | null) =>
        botId === 'scan-bot-2' ? '990002' : null,
      ),
    };

    const service = createRequiredSubscriptionService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn((key: string) => {
          if (key === 'MAX_BOT_ID') {
            return '777000_bot';
          }
          if (key === 'APP_BASE_URL') {
            return 'https://major-maksimov.ru';
          }
          return undefined;
        }),
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await (service as any).tryAutoAttachChannelMessageButtons({
      chatId: 'channel-1',
      messageId: 'mid-channel-1',
      text: 'Пост канала',
      linkType: null,
      managedChannel: {
        channelSettings: {
          updatedAt: new Date('2026-04-13T00:00:00.000Z'),
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          postSuggestionsButtonText: '',
        },
        adminUserIds: ['admin-1'],
      },
      source: 'poll',
      senderId: '990002',
      requiredAuthorUserId: '990002',
    });

    expect(maxBotLinkService.resolveBotRoutes).toHaveBeenCalledWith({
      purpose: 'moderation_action',
      chatId: 'channel-1',
      action: 'edit_message',
      fallbackToPrimary: true,
    });
    expect(maxBotLinkService.getExecutableBotById).toHaveBeenCalledWith('scan-bot-2');
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-1',
      'Пост канала',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              type: 'link',
              url: expect.stringContaining('https://max.ru/test-bot?startapp='),
            }),
          ],
        ],
      }),
      {
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'channel_auto_post',
        botId: 'scan-bot-2',
      },
    );
    expect(maxBotLinkService.buildEntryMiniappStartUrlSync).toHaveBeenCalledWith(
      expect.any(String),
    );
    expect(maxBotLinkService.buildMiniappStartUrlSync).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveContactIdSync).toHaveBeenCalledWith('scan-bot-2');
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'channel-1',
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        payload: expect.objectContaining({
          messageId: 'mid-channel-1',
          source: 'poll',
          botId: 'scan-bot-2',
        }),
      }),
    });
  });

  it('persists forwarded channel replacement cleanup as a durable delete intent', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({ entityType: ChatEntityType.CHANNEL }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      getChatSnapshot: jest.fn().mockResolvedValue({ entityType: 'channel' }),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: '990002',
        isAdmin: true,
        isOwner: false,
        permissions: ['delete_message', 'write'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'admin-1',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      sendMessageCopyWithInlineKeyboard: jest.fn(
        async (
          _chatId: string,
          _messageId: string,
          _text: string,
          options: { beforeSend?: () => Promise<void> },
        ) => {
          await options.beforeSend?.();
          return {
            messageId: 'mid-channel-copy-1',
            url: 'https://max.ru/chats/channel-1/message/mid-channel-copy-1',
          };
        },
      ),
      deleteMessage: jest.fn(),
    };
    const maxBotLinkService = {
      resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue({
        purpose: 'moderation_action',
        chatId: 'channel-1',
        primaryBotId: 'scan-bot-2',
        botId: 'scan-bot-2',
        candidateBotIds: ['scan-bot-2'],
        reason: 'primary_confirmed',
        action: 'delete_message',
      }),
      getExecutableBotById: jest.fn((botId: string) =>
        botId === 'scan-bot-2' ? { id: botId, contactId: '990002' } : null,
      ),
      getBotTokenSync: jest.fn().mockReturnValue('test-bot-token'),
      buildMiniappStartUrlSync: jest.fn().mockReturnValue('https://max.ru/bot?startapp=comments'),
      buildEntryMiniappStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/entry-bot?startapp=comments'),
      resolveContactIdSync: jest.fn().mockReturnValue('990002'),
    };
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('execute'),
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      getRolloutForInput: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn().mockResolvedValue({
        intentId: 'intent-chat-copy-1',
        rollout: 'execute',
        status: 'PENDING',
      }),
      ensureAndAttempt: jest.fn(
        async (_input: unknown, options?: { beforeDeleteMutation?: () => Promise<void> }) => {
          await options?.beforeDeleteMutation?.();
          return {
            kind: 'pending',
            confirmed: false,
            intentId: 'intent-channel-copy-1',
            status: 'RETRYABLE',
          };
        },
      ),
    };
    const service = createRequiredSubscriptionService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );
    (service as any).moderationDeleteIntentService = deleteIntents;

    await (service as any).tryAutoAttachChannelMessageButtons({
      chatId: 'channel-1',
      messageId: 'mid-channel-original-1',
      text: 'Forwarded post',
      linkType: 'forward',
      managedChannel: {
        channelSettings: {
          updatedAt: new Date('2026-04-13T00:00:00.000Z'),
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          postSuggestionsButtonText: '',
        },
        adminUserIds: ['admin-1'],
      },
      source: 'poll',
      senderId: 'admin-1',
      senderAdminVerified: true,
    });

    expect(deleteIntents.ensureAndAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'channel-1',
        messageId: 'mid-channel-original-1',
        entityType: 'CHANNEL',
        messageAuthorKind: 'user',
        originBotId: 'scan-bot-2',
        routingPolicy: 'origin_only',
        ruleCode: 'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
      }),
      { beforeDeleteMutation: expect.any(Function) },
    );
    expect(deleteIntents.ensureIntent.mock.calls[0]?.[0]).not.toHaveProperty('sourceMessageAt');
    expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(2);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(3);
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith('channel-1', {
      bypassCache: true,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: 'channel_auto_post',
      timeoutMs: 2_000,
      botId: 'scan-bot-2',
    });
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith('channel-1', {
      botId: 'scan-bot-2',
      bypassCache: true,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: 'channel_auto_post',
      timeoutMs: 2_000,
    });
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith('channel-1', 'admin-1', {
      bypassCache: true,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: 'channel_auto_post',
      timeoutMs: 2_000,
      botId: 'scan-bot-2',
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          messageId: 'mid-channel-original-1',
          replacementMessageId: 'mid-channel-copy-1',
          originalDeleted: false,
        }),
      }),
    });
  });

  it('passes the channel webhook message timestamp into replacement cleanup', async () => {
    const service = createRequiredSubscriptionService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service as any, 'resolveSystemModeSnapshot').mockResolvedValue({ mode: 'normal' });
    jest.spyOn(service as any, 'resolveSenderChatAdminCheck').mockResolvedValue({
      isAdmin: true,
      source: 'remote',
    });
    const attach = jest
      .spyOn(service as any, 'tryAutoAttachChannelMessageButtons')
      .mockResolvedValue('attached');
    const sourceMessageAt = '2026-08-15T09:40:00.000Z';
    const update: MaxUpdate = {
      updateId: 'channel-webhook-source-time-1',
      type: 'message_created',
      message: {
        chatId: 'channel-1',
        messageId: 'mid-channel-original-1',
        senderId: 'admin-1',
        text: 'Forwarded post',
        createdAt: sourceMessageAt,
      },
      raw: {
        message: {
          link: { type: 'forward' },
        },
      },
    };

    await (service as any).handleChannelUpdate(update, {
      channelSettings: {
        commentsEnabled: true,
        postSuggestionsEnabled: false,
        postSuggestionsButtonText: '',
        postSignatureEnabled: true,
        postSignaturePresentation: 'SIGNATURE',
      },
      adminUserIds: ['admin-1'],
    });

    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'webhook',
        senderAdminVerified: true,
        sourceMessageAt,
      }),
    );
  });

  it('records managed channel access loss when the background auto-post scan cannot read the channel', async () => {
    const maxError = createMaxApiError(403, 'Request failed with status code 403', 'chat.denied');
    const maxClient = {
      listMessages: jest.fn().mockRejectedValue(maxError),
    };
    const maxBotLinkService = {
      resolveBotIdForCapability: jest.fn().mockResolvedValue('scan-bot-2'),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
        classification: {
          kind: 'managed_entity_access_lost',
          reason: 'bot_denied',
          statusCode: 403,
          code: 'chat.denied',
          message: 'request failed with status code 403',
        },
        reason: 'bot_denied',
        recorded: {
          chatId: 'channel-1',
        },
      }),
    };

    const service = createRequiredSubscriptionService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntityAccessLossService as never,
    );
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

    await (service as any).processManagedChannelAutoPostButtons({
      channelSettings: {
        chatId: 'channel-1',
        updatedAt: new Date('2026-04-13T00:00:00.000Z'),
        commentsEnabled: true,
        postSuggestionsEnabled: false,
      },
      adminUserIds: ['admin-1'],
    });

    expect(maxClient.listMessages).toHaveBeenCalledWith('channel-1', {
      count: 10,
      trafficClass: 'background',
      sourceTag: 'channel_auto_post',
      botId: 'scan-bot-2',
    });
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'channel-1',
      botId: 'scan-bot-2',
      entityType: ChatEntityType.CHANNEL,
      source: 'channel_auto_post:scan',
      operation: 'read',
      lifecycleEventAt: expect.any(Date),
      lifecycleEventType: 'live_probe',
      lifecycleSource: 'live_probe',
      error: maxError,
    });
  });

  it('keeps message-not-found auto-post attach failures as per-message skips', async () => {
    const maxError = createMaxApiError(
      404,
      'Request failed with status code 404',
      'message.not.found',
    );
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({ entityType: ChatEntityType.CHANNEL }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      getChatSnapshot: jest.fn().mockResolvedValue({ entityType: 'channel' }),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: '990002',
        isAdmin: true,
        isOwner: false,
        permissions: ['edit_message'],
      }),
      editMessageInlineKeyboard: jest.fn().mockRejectedValue(maxError),
    };
    const maxBotLinkService = {
      resolveBotRoutes: jest.fn().mockResolvedValue({
        purpose: 'moderation_action',
        chatId: 'channel-1',
        primaryBotId: 'scan-bot-2',
        botId: 'scan-bot-2',
        candidateBotIds: ['scan-bot-2'],
        reason: 'primary_confirmed',
        action: 'edit_message',
      }),
      getExecutableBotById: jest.fn((botId: string) =>
        botId === 'scan-bot-2' ? { id: botId, contactId: '990002' } : null,
      ),
      getBotTokenSync: jest.fn().mockReturnValue('test-bot-token'),
      buildMiniappStartUrlSync: jest
        .fn()
        .mockImplementation(
          (startParam: string, botId?: string | null) =>
            `https://max.ru/${encodeURIComponent(botId?.trim() || 'scan-bot-2')}?startapp=${startParam}`,
        ),
      buildEntryMiniappStartUrlSync: jest
        .fn()
        .mockImplementation(
          (startParam: string) => `https://max.ru/test-bot?startapp=${startParam}`,
        ),
      resolveContactIdSync: jest.fn((botId?: string | null) =>
        botId === 'scan-bot-2' ? '990002' : null,
      ),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
        classification: {
          kind: 'message_not_found',
          statusCode: 404,
          code: 'message.not.found',
          message: 'request failed with status code 404',
        },
        reason: null,
        recorded: null,
      }),
    };

    const service = createRequiredSubscriptionService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn((key: string) => {
          if (key === 'MAX_BOT_ID') {
            return '777000_bot';
          }
          if (key === 'APP_BASE_URL') {
            return 'https://major-maksimov.ru';
          }
          return undefined;
        }),
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntityAccessLossService as never,
    );
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

    await (service as any).tryAutoAttachChannelMessageButtons({
      chatId: 'channel-1',
      messageId: 'mid-channel-1',
      text: 'Пост канала',
      linkType: null,
      managedChannel: {
        channelSettings: {
          updatedAt: new Date('2026-04-13T00:00:00.000Z'),
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          postSuggestionsButtonText: '',
        },
        adminUserIds: ['admin-1'],
      },
      source: 'poll',
      senderId: '990002',
      requiredAuthorUserId: '990002',
    });

    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'channel-1',
      botId: 'scan-bot-2',
      entityType: ChatEntityType.CHANNEL,
      source: 'channel_auto_post:poll_attach',
      operation: 'edit',
      lifecycleEventAt: expect.any(Date),
      lifecycleEventType: 'live_probe',
      lifecycleSource: 'live_probe',
      error: maxError,
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'channel-1',
        actorUserId: '990002',
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT_SKIPPED',
        payload: expect.objectContaining({
          messageId: 'mid-channel-1',
          reason: 'terminal_delivery_failure',
          source: 'poll',
          deliveryMode: 'edit_message',
          status: 404,
        }),
      }),
    });
  });
});

describe('ModerationService participant immunity', () => {
  it('recognizes full participant protection without spending a daily limit', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ expires_at: null }]),
    };
    const service = createRequiredSubscriptionService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const consumed = await (service as any).consumeChatParticipantModerationImmunity({
      chatId: 'chat-1',
      userId: 'user-1',
      nightModeTimezone: 'Europe/Moscow',
    });

    expect(consumed).toBe(true);
    const sqlText = extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(sqlText).toContain('WITH active_immunity AS');
    expect(sqlText).toContain('limited_update AS');
    expect(sqlText).toContain('WHERE "expires_at" IS NULL');
    expect(sqlText).toContain('AND "daily_violation_limit" IS NULL');
  });

  it('bypasses ordinary moderation when participant immunity is consumed', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            commentsEnabled: false,
          }),
          domains: [],
          admins: [],
          rules: {
            publishedUrl: null,
            publishedMessageId: null,
          },
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'PROFANITY',
            score: 0.91,
            reason: 'мат',
            metadata: null,
          },
        ],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
      resolveMessageLink: jest.fn().mockResolvedValue(null),
    };

    const service = createRequiredSubscriptionService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );
    const immunitySpy = jest
      .spyOn(service as any, 'consumeChatParticipantModerationImmunity')
      .mockResolvedValue(true);

    await service.handleUpdate(createUpdate());

    expect(immunitySpy).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'msg-1',
      nightModeTimezone: 'Europe/Moscow',
    });
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
  });
});
