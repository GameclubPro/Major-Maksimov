import {
  buildManagedHandshakeConfirmationText,
  MANAGED_HANDSHAKE_CONFIRMATION_AUTO_DELETE_DELAY_MS,
} from './managed-handshake-confirmation';
import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  GroupCommandAuthorityService,
  type GroupCommandPermit,
} from '../common/group-command-authority.service';
import type { ManagedEntityType, MaxUpdate } from '@maxim/contracts';
import { ChatEntityType, ManagedEntityHandshakeOutcomeStatus } from '../prisma/prisma-client';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import {
  extractManagedEntityForwardedRecoveryCandidate,
  type ManagedEntityForwardedRecoveryCandidate,
} from '../common/managed-entity-forwarded-recovery.util';
import { isManagedEntityHandshakeStartCommand } from '../common/managed-entity-handshake-command.util';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxChatMemberAccess,
} from './max-client.service';
import { normalizePermissionName } from './max-bot-access-policy.util';
import { hasConfirmedDeleteMessageAccess } from './max-delete-message-access.util';
import { MaxBotLinkService } from './max-bot-link.service';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { MaxChatAdminRosterSyncService } from './max-chat-admin-roster-sync.service';
import type { MaxChatAdminRosterSyncJob } from './max-chat-admin-roster-sync.queue';
import {
  ManagedEntityAccessWriter,
  MANAGED_ENTITY_HANDSHAKE_SOURCE,
  type ManagedEntityAccessWriteContext,
} from './managed-entity-access-writer.service';
import { ManagedEntityHandshakeOutcomeService } from './managed-entity-handshake-outcome.service';
import {
  isExplicitManagedEntityActivationCurrent,
  ManagedEntityActivationRequiredError,
  type ManagedEntityExplicitActivation,
} from './managed-entity-activation.util';
import { readWebhookEventTimestamp } from '../webhook/webhook-semantic-event-key';
import { withMaxFinalAuthorityCheckpoint } from './max-action-pre-dispatch-guard';

export const MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD =
  'managed_entity_handshake:start_hint';
const HANDSHAKE_RATE_LIMIT_MS = 3 * 60 * 1_000;
const HANDSHAKE_RATE_LIMIT_MAX_KEYS = 2_048;
const HANDSHAKE_FORWARDED_ACTOR_BURST_LIMIT_MS = 5_000;
const HANDSHAKE_ACCESS_TIMEOUT_MS = 1_500;
const HANDSHAKE_SEND_TIMEOUT_MS = 1_500;
const HANDSHAKE_DELETE_TIMEOUT_MS = 1_500;
const HANDSHAKE_SOURCE = MANAGED_ENTITY_HANDSHAKE_SOURCE;

export type ManagedEntityHandshakeResult =
  | 'ignored'
  | 'rate_limited'
  | 'bootstrapped_without_user'
  | 'denied'
  | 'connected'
  | 'already_connected'
  | 'failed';

type ManagedEntityHandshakeContext = {
  update: MaxUpdate;
  chatId: string;
  replyChatId: string;
  botId: string;
  replyBotId: string;
  senderId: string | null;
  title: string;
  link?: string | null;
  avatarUrl?: string | null;
  entityType: ManagedEntityType;
  prismaEntityType: ChatEntityType;
  createdAt: string | null;
  commandMessageId: string | null;
  interactionMessageId: string | null;
  interaction: 'in_chat' | 'forwarded_private';
};

type HandshakeBotProbe = {
  access: MaxChatMemberAccess;
  startedAt: Date;
  channelReadVerified: boolean;
};

@Injectable()
export class ManagedEntityHandshakeService {
  private readonly logger = new Logger(ManagedEntityHandshakeService.name);
  private readonly rateLimitUntilMs = new Map<string, number>();
  private readonly forwardedActorBurstUntilMs = new Map<string, number>();

  constructor(
    private readonly accessWriter: ManagedEntityAccessWriter,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly maxBotRegistry: MaxBotRegistryService,
    private readonly maxChatAdminRosterSyncService: MaxChatAdminRosterSyncService,
    private readonly handshakeOutcomes: ManagedEntityHandshakeOutcomeService,
    @Optional() private readonly groupCommandAuthority?: GroupCommandAuthorityService,
  ) {}

  async handleWebhookUpdate(update: MaxUpdate): Promise<ManagedEntityHandshakeResult> {
    const forwardedCandidate = extractManagedEntityForwardedRecoveryCandidate(update);
    if (forwardedCandidate) {
      return this.handleForwardedRecovery(update, forwardedCandidate);
    }

    const context = this.buildContext(update);
    if (!context) {
      return 'ignored';
    }

    return this.processContext(context);
  }

  private async handleForwardedRecovery(
    update: MaxUpdate,
    candidate: ManagedEntityForwardedRecoveryCandidate,
  ): Promise<ManagedEntityHandshakeResult> {
    const resolvedBot = this.maxBotRegistry.getBotById(update.botId ?? null);
    if (!resolvedBot || this.maxBotRegistry.isKnownBotUserId(candidate.forwarderUserId)) {
      return 'ignored';
    }
    if (
      !this.buildExplicitActivation(
        update,
        'forwarded_message',
        candidate.sourceChatId,
        resolvedBot.id,
        candidate.forwarderUserId,
      )
    )
      return 'denied';

    const rateLimitKey = this.buildForwardedRateLimitKey(
      candidate.sourceChatId,
      candidate.forwarderUserId,
      resolvedBot.id,
    );
    if (
      this.isRateLimitKeyBlocked(this.rateLimitUntilMs, rateLimitKey) ||
      !this.reserveForwardedActorBurstSlot(resolvedBot.id, candidate.forwarderUserId) ||
      !this.reserveRateLimitKey(rateLimitKey)
    ) {
      this.logger.log(
        {
          chatId: candidate.sourceChatId,
          botId: resolvedBot.id,
          entityType: null,
          hasSender: true,
          interaction: 'forwarded_private',
          outcome: 'rate_limited',
        },
        'Managed entity handshake outcome',
      );
      return 'rate_limited';
    }

    try {
      const { context, probe } = await this.resolveForwardedSource(
        update,
        candidate,
        resolvedBot.id,
      );
      return this.processContext(context, true, probe);
    } catch (error: unknown) {
      this.releaseRateLimitKey(rateLimitKey);
      const denied = this.isBotAccessDeniedError(error);
      await this.sendReplySafely({
        update,
        botId: resolvedBot.id,
        replyChatId: candidate.privateChatId,
        sourceChatId: candidate.sourceChatId,
        text: denied
          ? 'Не удалось проверить доступ к источнику пересылки. Перешлите сообщение непосредственно из нужного чата или канала. Если бот уже администратор, повторно добавлять его не нужно.'
          : 'Не удалось проверить доступ. Перешлите сообщение еще раз позже.',
      });
      this.logger.warn(
        {
          updateId: update.updateId,
          chatId: candidate.sourceChatId,
          botId: resolvedBot.id,
          status: this.extractStatusCode(error),
          code: this.extractErrorCode(error),
        },
        'Failed to resolve forwarded managed entity handshake source',
      );
      return denied ? 'denied' : 'failed';
    }
  }

  private async resolveForwardedSource(
    update: MaxUpdate,
    candidate: ManagedEntityForwardedRecoveryCandidate,
    replyBotId: string,
  ): Promise<{ context: ManagedEntityHandshakeContext; probe: HandshakeBotProbe }> {
    // FLAG: A forward activates only the bot that received the administrator's DM.
    // Membership of another bot never authorizes probing or reactivating it here.
    const botId = replyBotId;
    const explicitActivation = this.buildExplicitActivation(
      update,
      'forwarded_message',
      candidate.sourceChatId,
      botId,
      candidate.forwarderUserId,
    );
    const options = {
      botId,
      explicitActivation,
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.MANAGED_HANDSHAKE,
      timeoutMs: HANDSHAKE_ACCESS_TIMEOUT_MS,
      bypassCache: true,
      ignoreFailureMetricStatuses: [403, 404],
    } as const;
    const startedAt = new Date();
    const snapshot = await this.maxClient.getChatSnapshot(candidate.sourceChatId, options);
    if (snapshot.chatId !== candidate.sourceChatId)
      throw new Error('Forwarded source identity changed');
    const access = await this.maxClient.getCurrentChatMemberAccess(candidate.sourceChatId, options);
    const entityType = snapshot.entityType;
    const context: ManagedEntityHandshakeContext = {
      update,
      chatId: candidate.sourceChatId,
      replyChatId: candidate.privateChatId,
      botId,
      replyBotId,
      senderId: candidate.forwarderUserId,
      title:
        snapshot.title?.trim() ||
        (entityType === 'channel'
          ? `Channel ${candidate.sourceChatId}`
          : `Chat ${candidate.sourceChatId}`),
      link: snapshot.link,
      avatarUrl: snapshot.avatarUrl,
      entityType,
      prismaEntityType: entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT,
      createdAt: update.message?.createdAt?.trim() || null,
      commandMessageId: null,
      interactionMessageId: candidate.incomingMessageId,
      interaction: 'forwarded_private',
    };
    return { context, probe: { access, startedAt, channelReadVerified: entityType === 'channel' } };
  }

  private async processContext(
    context: ManagedEntityHandshakeContext,
    rateLimitReserved = false,
    verifiedProbe?: HandshakeBotProbe,
  ): Promise<ManagedEntityHandshakeResult> {
    const groupStart =
      context.interaction === 'in_chat' && isManagedEntityHandshakeStartCommand(context.update);
    const explicitActivation =
      context.senderId && (groupStart || context.interaction === 'forwarded_private')
        ? this.buildExplicitActivation(
            context.update,
            groupStart ? 'start_in_chat' : 'forwarded_message',
            context.chatId,
            context.botId,
            context.senderId,
          )
        : undefined;
    // FLAG: A malformed explicit request must not fall back to passive persistence
    // or spend remote probe capacity. Legacy navigation has no activation authority.
    if ((groupStart || context.interaction === 'forwarded_private') && !explicitActivation)
      return 'denied';
    const rateLimitAllowed =
      rateLimitReserved ||
      (groupStart
        ? this.reserveRateLimitKey(
            `group-start:${context.botId}:${this.buildRateLimitKey(context)}`,
          )
        : this.reserveRateLimitSlot(context));
    if (!rateLimitAllowed) {
      await this.recordOutcome(
        context,
        ManagedEntityHandshakeOutcomeStatus.RATE_LIMITED,
        'duplicate_recently',
      );
      this.logOutcome(context, 'rate_limited');
      return 'rate_limited';
    }

    let checkingBotAccess = !verifiedProbe;
    let commandPermit: GroupCommandPermit | null = null;
    let legacyStart: 'fresh' | 'recovered' | 'hold' = 'fresh';
    try {
      if (groupStart) {
        if (!this.groupCommandAuthority) throw new Error('Group Start authority is unavailable');
        await this.groupCommandAuthority.observeStart(context.update);
      }
      const probeStartedAt = verifiedProbe?.startedAt ?? new Date();
      const botAccess =
        verifiedProbe?.access ??
        (await this.maxClient.getCurrentChatMemberAccess(context.chatId, {
          botId: context.botId,
          explicitActivation,
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_HANDSHAKE,
          timeoutMs: HANDSHAKE_ACCESS_TIMEOUT_MS,
          bypassCache: true,
          ignoreFailureMetricStatuses: [403, 404],
        }));
      checkingBotAccess = false;
      if (
        !this.isAdminOrOwner(botAccess) ||
        (explicitActivation && botAccess.explicitPrivilegeEvidence !== true)
      ) {
        await this.recordOutcome(
          context,
          ManagedEntityHandshakeOutcomeStatus.BOT_DENIED,
          'bot_not_admin',
        );
        this.logOutcome(context, 'bot_denied');
        this.releaseForwardedRateLimitSlot(context);
        await this.replyToForwardedDenial(context, 'bot');
        return 'denied';
      }

      if (!this.hasRequiredBotReadAccess(context, botAccess)) {
        await this.recordOutcome(
          context,
          ManagedEntityHandshakeOutcomeStatus.BOT_DENIED,
          'bot_missing_read_all_messages',
        );
        this.logOutcome(context, 'bot_missing_read_all_messages');
        this.releaseForwardedRateLimitSlot(context);
        await this.replyToForwardedDenial(context, 'bot_read');
        return 'denied';
      }

      if (
        explicitActivation &&
        !hasConfirmedDeleteMessageAccess(
          { ...botAccess, checkedAt: probeStartedAt.toISOString() },
          context.prismaEntityType,
        )
      ) {
        await this.recordOutcome(
          context,
          ManagedEntityHandshakeOutcomeStatus.BOT_DENIED,
          'bot_missing_delete_permission',
        );
        this.releaseForwardedRateLimitSlot(context);
        await this.replyToForwardedDenial(context, 'bot_permissions');
        return 'denied';
      }

      if (!context.senderId) {
        if (groupStart) return 'denied';
        const bootstrapped = await this.accessWriter.bootstrapChat(
          this.toWriteContext(context),
          botAccess,
          probeStartedAt,
        );
        if (!bootstrapped) {
          return this.handleSupersededProbe(context);
        }
        await this.recordOutcome(
          context,
          ManagedEntityHandshakeOutcomeStatus.BOOTSTRAPPED_WITHOUT_USER,
          'sender_missing',
        );
        this.logOutcome(context, 'bootstrapped_without_user');
        return 'bootstrapped_without_user';
      }

      const accessByUser = await this.maxClient.getChatMembersAccess(
        context.chatId,
        [context.senderId],
        {
          botId: context.botId,
          explicitActivation,
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_HANDSHAKE,
          timeoutMs: HANDSHAKE_ACCESS_TIMEOUT_MS,
          bypassCache: true,
          ignoreFailureMetricStatuses: [403, 404],
        },
      );
      const userAccess = accessByUser.get(context.senderId) ?? null;
      if (
        !userAccess ||
        !this.isAdminOrOwner(userAccess) ||
        (explicitActivation &&
          (userAccess.explicitPrivilegeEvidence !== true || userAccess.isBot !== false))
      ) {
        await this.recordOutcome(
          context,
          ManagedEntityHandshakeOutcomeStatus.USER_DENIED,
          'user_not_admin',
        );
        this.logOutcome(context, 'user_denied');
        this.releaseForwardedRateLimitSlot(context);
        await this.replyToForwardedDenial(context, 'user');
        return 'denied';
      }

      let channelReadVerified = verifiedProbe?.channelReadVerified === true;
      if (explicitActivation && context.entityType === 'channel' && !channelReadVerified) {
        const snapshot = await this.maxClient.getChatSnapshot(context.chatId, {
          botId: context.botId,
          explicitActivation,
          bypassCache: true,
          timeoutMs: HANDSHAKE_ACCESS_TIMEOUT_MS,
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_HANDSHAKE,
          ignoreFailureMetricStatuses: [403, 404],
        });
        if (snapshot.chatId !== context.chatId || snapshot.entityType !== 'channel')
          return 'denied';
        channelReadVerified = true;
      }

      // FLAG: An explicit command activates only this freshly verified receiving bot.
      // Shared confirmation ownership below must neither substitute another bot nor
      // suppress a healthy observer's silent activation. Every send keeps its authority.
      const wasConnected = await this.accessWriter.persistGrantedAccess(
        this.toWriteContextWithSender(context),
        botAccess,
        userAccess,
        probeStartedAt,
        { explicitActivation, channelReadVerified },
      );
      if (wasConnected === null) return this.handleSupersededProbe(context);
      await this.refreshRosterSync(context);

      if (groupStart) {
        if (!this.groupCommandAuthority) throw new Error('Group Start authority is unavailable');
        commandPermit = await this.groupCommandAuthority.claim(context.update, context.botId);
        if (!commandPermit) return this.completeGrantedContext(context, wasConnected);
        if (!commandPermit.result)
          legacyStart = await this.groupCommandAuthority.inspectLegacyStart(
            commandPermit,
            this.maxBotRegistry.getAllBots().map((bot) => bot.id),
          );
        if (commandPermit.executionBotId !== context.botId) {
          await this.groupCommandAuthority.release(commandPermit);
          return this.completeGrantedContext(context, wasConnected);
        }
        await this.groupCommandAuthority.assertOwned(commandPermit);
        if (commandPermit.result) {
          await this.groupCommandAuthority.complete(commandPermit);
          return 'rate_limited';
        }
        if (legacyStart === 'hold') {
          await this.groupCommandAuthority.prepareResult(commandPermit, {
            action: 'START_HOLD',
            noticeText: null,
            applied: false,
          });
          await this.groupCommandAuthority.complete(commandPermit);
          return 'rate_limited';
        }
      }
      await this.deleteCommandMessageSafely(context, botAccess);
      if (context.interaction === 'forwarded_private') {
        await this.replySafely(
          context,
          this.buildSuccessReply(context, wasConnected),
          this.buildSettingsButton(context),
        );
      } else if (isManagedEntityHandshakeStartCommand(context.update) && legacyStart === 'fresh') {
        await this.replyToStartCommandSafely(context, wasConnected, commandPermit!);
      }
      if (commandPermit) {
        if (!commandPermit.result)
          await this.groupCommandAuthority!.prepareResult(commandPermit, {
            action: legacyStart === 'fresh' ? 'START' : 'START_RECOVERED',
            noticeText: null,
            applied: true,
          });
        await this.groupCommandAuthority!.complete(commandPermit);
      }
      return this.completeGrantedContext(context, wasConnected);
    } catch (error: unknown) {
      if (commandPermit) await this.groupCommandAuthority!.release(commandPermit);
      // FLAG: A legacy callback has no activation authority. The typed initial
      // access refusal is terminal for this check, not a transient preparation failure.
      if (checkingBotAccess && error instanceof ManagedEntityActivationRequiredError) {
        await this.recordOutcome(
          context,
          ManagedEntityHandshakeOutcomeStatus.BOT_DENIED,
          'explicit_activation_required',
        );
        this.logOutcome(context, 'bot_denied');
        return 'denied';
      }
      if (checkingBotAccess && this.isBotAccessDeniedError(error)) {
        await this.recordOutcome(
          context,
          ManagedEntityHandshakeOutcomeStatus.BOT_DENIED,
          'bot_access_denied',
        );
        this.logOutcome(context, 'bot_denied');
        this.releaseForwardedRateLimitSlot(context);
        await this.replyToForwardedDenial(context, 'bot');
        return 'denied';
      }

      this.releaseRateLimitSlot(context);
      await this.recordOutcome(context, ManagedEntityHandshakeOutcomeStatus.FAILED, 'exception');
      if (context.interaction === 'forwarded_private') {
        await this.replySafely(context, 'Не удалось проверить доступ. Попробуйте еще раз.');
      }
      this.logger.warn(
        {
          updateId: context.update.updateId,
          chatId: context.chatId,
          botId: context.botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to process managed entity handshake',
      );
      return 'failed';
    }
  }

  private buildExplicitActivation(
    update: MaxUpdate,
    kind: ManagedEntityExplicitActivation['kind'],
    chatId: string,
    botId: string,
    actorUserId: string,
  ): ManagedEntityExplicitActivation | undefined {
    const sourceAt = readWebhookEventTimestamp(update);
    if (!sourceAt || update.botId !== botId || !update.updateId) return undefined;
    const proof = { kind, sourceAt, updateId: update.updateId, actorUserId, botId, chatId };
    return isExplicitManagedEntityActivationCurrent(proof, chatId, botId) ? proof : undefined;
  }

  private async completeGrantedContext(
    context: ManagedEntityHandshakeContext,
    wasConnected: boolean,
  ): Promise<ManagedEntityHandshakeResult> {
    await this.recordSuccessfulOutcomeSafely(
      context,
      wasConnected
        ? ManagedEntityHandshakeOutcomeStatus.ALREADY_CONNECTED
        : ManagedEntityHandshakeOutcomeStatus.CONNECTED,
    );
    this.logOutcome(context, wasConnected ? 'already_connected' : 'connected');
    return wasConnected ? 'already_connected' : 'connected';
  }

  private async handleSupersededProbe(
    context: ManagedEntityHandshakeContext,
  ): Promise<ManagedEntityHandshakeResult> {
    this.releaseRateLimitSlot(context);
    await this.recordOutcome(
      context,
      ManagedEntityHandshakeOutcomeStatus.FAILED,
      'bot_access_probe_superseded',
    );
    this.logOutcome(context, 'bot_access_probe_superseded');
    await this.replySafely(
      context,
      context.interaction === 'forwarded_private'
        ? 'Доступ изменился во время проверки. Перешлите сообщение еще раз.'
        : 'Доступ изменился во время проверки. Отправьте «Старт» еще раз.',
    );
    return 'failed';
  }

  private buildContext(update: MaxUpdate): ManagedEntityHandshakeContext | null {
    const updateType = update.type.trim().toLowerCase();
    if (updateType !== 'message_created' && updateType !== 'message_callback') {
      return null;
    }

    if (updateType === 'message_created') {
      if (!isManagedEntityHandshakeStartCommand(update)) {
        return null;
      }
    } else if (
      this.readCallbackPayload(update) !== MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD
    ) {
      return null;
    }

    const chatId = update.message?.chatId?.trim() ?? '';
    if (!chatId || isPrivateDirectChatId(chatId)) {
      return null;
    }

    const resolvedBot = this.maxBotRegistry.getBotById(update.botId ?? null);
    if (!resolvedBot) {
      return null;
    }

    const rawSenderId =
      updateType === 'message_callback'
        ? (this.readCallbackUserId(update) ?? update.message?.senderId?.trim() ?? '')
        : (update.message?.senderId?.trim() ?? '');
    const senderId =
      rawSenderId && !this.maxBotRegistry.isKnownBotUserId(rawSenderId) ? rawSenderId : null;
    const entityType = update.message?.entityType === 'channel' ? 'channel' : 'chat';
    const prismaEntityType =
      entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
    const title =
      update.message?.chatTitle?.trim() ||
      (entityType === 'channel' ? `Channel ${chatId}` : `Chat ${chatId}`);

    return {
      update,
      chatId,
      replyChatId: chatId,
      botId: resolvedBot.id,
      replyBotId: resolvedBot.id,
      senderId,
      title,
      entityType,
      prismaEntityType,
      createdAt: update.message?.createdAt?.trim() || null,
      commandMessageId:
        updateType === 'message_created' ? update.message?.messageId?.trim() || null : null,
      interactionMessageId:
        updateType === 'message_created' ? update.message?.messageId?.trim() || null : null,
      interaction: 'in_chat',
    };
  }

  private readCallbackPayload(update: MaxUpdate): string | null {
    const callback = this.asRecord(update.raw?.callback);
    const payload = callback?.payload ?? callback?.data;
    return typeof payload === 'string' ? payload.trim() || null : null;
  }

  private readCallbackUserId(update: MaxUpdate): string | null {
    const callback = this.asRecord(update.raw?.callback);
    const user = this.asRecord(callback?.user);
    const value =
      user?.user_id ??
      user?.userId ??
      user?.id ??
      callback?.user_id ??
      callback?.userId ??
      callback?.sender_id ??
      callback?.senderId;
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private reserveRateLimitSlot(context: ManagedEntityHandshakeContext): boolean {
    return this.reserveRateLimitKey(this.buildRateLimitKey(context));
  }

  private reserveRateLimitKey(key: string): boolean {
    return this.reserveBoundedRateLimitKey(this.rateLimitUntilMs, key, HANDSHAKE_RATE_LIMIT_MS);
  }

  private reserveForwardedActorBurstSlot(botId: string, forwarderId: string): boolean {
    return this.reserveBoundedRateLimitKey(
      this.forwardedActorBurstUntilMs,
      `forwarded-actor:${botId}:${forwarderId}`,
      HANDSHAKE_FORWARDED_ACTOR_BURST_LIMIT_MS,
    );
  }

  private reserveBoundedRateLimitKey(
    slots: Map<string, number>,
    key: string,
    ttlMs: number,
  ): boolean {
    const now = Date.now();
    this.pruneExpiredRateLimitKeys(slots, now);
    const blockedUntil = slots.get(key) ?? 0;
    if (blockedUntil > now) {
      return false;
    }

    slots.delete(key);
    while (slots.size >= HANDSHAKE_RATE_LIMIT_MAX_KEYS) {
      const oldestKey = slots.keys().next().value;
      if (typeof oldestKey !== 'string') {
        break;
      }
      slots.delete(oldestKey);
    }
    slots.set(key, now + ttlMs);
    return true;
  }

  private isRateLimitKeyBlocked(slots: Map<string, number>, key: string): boolean {
    const now = Date.now();
    this.pruneExpiredRateLimitKeys(slots, now);
    return (slots.get(key) ?? 0) > now;
  }

  private pruneExpiredRateLimitKeys(slots: Map<string, number>, now: number): void {
    for (const [key, blockedUntil] of slots) {
      if (blockedUntil <= now) {
        slots.delete(key);
      }
    }
  }

  private releaseRateLimitSlot(context: ManagedEntityHandshakeContext): void {
    const key = this.buildRateLimitKey(context);
    this.releaseRateLimitKey(key);
    this.releaseRateLimitKey(`group-start:${context.botId}:${key}`);
  }

  private releaseForwardedRateLimitSlot(context: ManagedEntityHandshakeContext): void {
    if (context.interaction === 'forwarded_private') {
      this.releaseRateLimitSlot(context);
    }
  }

  private releaseRateLimitKey(key: string): void {
    this.rateLimitUntilMs.delete(key);
  }

  private buildRateLimitKey(context: ManagedEntityHandshakeContext): string {
    const actorId = context.senderId ?? context.botId;
    if (context.interaction === 'forwarded_private') {
      return this.buildForwardedRateLimitKey(context.chatId, actorId, context.botId);
    }
    return this.buildRateLimitKeyFromValues(context.chatId, actorId, context.interactionMessageId);
  }

  private buildForwardedRateLimitKey(
    sourceChatId: string,
    forwarderId: string,
    botId: string,
  ): string {
    return `forwarded:${botId}:${sourceChatId}:${forwarderId}`;
  }

  private buildRateLimitKeyFromValues(
    chatId: string,
    actorId: string,
    interactionMessageId: string | null,
  ): string {
    return interactionMessageId
      ? `${chatId}:${actorId}:${interactionMessageId}`
      : `${chatId}:${actorId}`;
  }

  private async recordOutcome(
    context: ManagedEntityHandshakeContext,
    status: ManagedEntityHandshakeOutcomeStatus,
    reason: string | null = null,
  ): Promise<void> {
    await this.handshakeOutcomes.recordOutcome({
      chatId: context.chatId,
      userId: context.senderId ?? context.botId,
      botId: context.botId,
      entityType: context.prismaEntityType,
      status,
      reason,
      title: context.title,
      source: HANDSHAKE_SOURCE,
    });
  }

  private async recordSuccessfulOutcomeSafely(
    context: ManagedEntityHandshakeContext,
    status: ManagedEntityHandshakeOutcomeStatus,
  ): Promise<void> {
    try {
      await this.recordOutcome(context, status);
    } catch (error: unknown) {
      this.logger.warn(
        {
          updateId: context.update.updateId,
          chatId: context.chatId,
          botId: context.botId,
          status,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to record successful managed entity handshake outcome',
      );
    }
  }

  private logOutcome(context: ManagedEntityHandshakeContext, outcome: string): void {
    this.logger.log(
      {
        chatId: context.chatId,
        botId: context.botId,
        hasSender: Boolean(context.senderId),
        entityType: context.entityType,
        interaction: context.interaction,
        outcome,
      },
      'Managed entity handshake outcome',
    );
  }

  private isAdminOrOwner(access: MaxChatMemberAccess | null): boolean {
    return access?.isOwner === true || access?.isAdmin === true;
  }

  private hasRequiredBotReadAccess(
    context: ManagedEntityHandshakeContext,
    access: MaxChatMemberAccess,
  ): boolean {
    if (
      context.interaction !== 'forwarded_private' &&
      !isManagedEntityHandshakeStartCommand(context.update)
    )
      return true;
    if (access.permissionsKnown !== true) return false;
    if (context.entityType === 'channel') return true;

    return access.permissions.some((permission) => {
      const normalized = normalizePermissionName(permission);
      return normalized === 'read_all_messages' || normalized === 'can_read_all_messages';
    });
  }

  private isBotAccessDeniedError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status !== 403 && status !== 404) {
      return false;
    }

    const code = this.extractErrorCode(error);
    if (!code) {
      return true;
    }

    return code === 'chat.denied' || code === 'chat.not.found' || code === 'bot.denied';
  }

  private extractStatusCode(error: unknown): number | null {
    const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
    return typeof status === 'number' && Number.isInteger(status) ? status : null;
  }

  private extractErrorCode(error: unknown): string | null {
    const data = (error as { response?: { data?: unknown } } | null)?.response?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return null;
    }

    const code = (data as Record<string, unknown>).code;
    return typeof code === 'string' && code.trim().length > 0 ? code.trim() : null;
  }

  private buildRosterSyncJob(context: ManagedEntityHandshakeContext): MaxChatAdminRosterSyncJob {
    return {
      chatId: context.chatId,
      botIds: [context.botId],
      title: context.title,
      entityType: context.entityType,
      source: HANDSHAKE_SOURCE,
    };
  }

  private async refreshRosterSync(context: ManagedEntityHandshakeContext): Promise<void> {
    const job = this.buildRosterSyncJob(context);
    if (context.interaction === 'forwarded_private') {
      try {
        await this.maxChatAdminRosterSyncService.scheduleChatAdminRosterSync(job);
      } catch (error: unknown) {
        this.logger.warn(
          {
            updateId: context.update.updateId,
            chatId: context.chatId,
            botId: context.botId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to schedule managed entity roster refresh after forwarded recovery',
        );
      }
      return;
    }

    // FLAG: The exact bot/actor grant is already committed. The remaining full
    // roster must have a durable handoff before confirmation, without holding
    // the command open for every administrator's remote refresh.
    if (!(await this.maxChatAdminRosterSyncService.scheduleChatAdminRosterSync(job)))
      throw new Error('Managed entity roster refresh handoff unavailable');
  }

  private async deleteCommandMessageSafely(
    context: ManagedEntityHandshakeContext,
    botAccess: MaxChatMemberAccess,
  ): Promise<void> {
    // FLAG: An explicit fresh Start may confirm connection, but the held author's
    // source message keeps its permanent protection from automatic cleanup.
    if (await this.groupCommandAuthority?.isHeldSource(context.update)) return;
    if (!context.commandMessageId) {
      return;
    }

    if (!this.canDeleteMessages(botAccess, context.prismaEntityType)) {
      this.logger.debug(
        {
          updateId: context.update.updateId,
          chatId: context.chatId,
          botId: context.botId,
          permissions: botAccess.permissions,
        },
        'Skipped managed entity handshake command deletion because bot lacks delete permission',
      );
      return;
    }

    try {
      await this.maxClient.deleteMessage(context.chatId, context.commandMessageId, {
        immediate: true,
        botId: context.botId,
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_HANDSHAKE,
        timeoutMs: HANDSHAKE_DELETE_TIMEOUT_MS,
        ignoreFailureMetricStatuses: [403, 404],
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          updateId: context.update.updateId,
          chatId: context.chatId,
          botId: context.botId,
          messageId: context.commandMessageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to delete managed entity handshake command message',
      );
    }
  }

  private canDeleteMessages(access: MaxChatMemberAccess, entityType: ChatEntityType): boolean {
    return hasConfirmedDeleteMessageAccess(
      {
        checkedAt: null,
        isAdmin: access.isAdmin,
        isOwner: access.isOwner,
        permissions: access.permissions,
      },
      entityType,
    );
  }

  private async replyToStartCommandSafely(
    context: ManagedEntityHandshakeContext,
    wasConnected: boolean,
    permit: GroupCommandPermit,
  ): Promise<void> {
    // FLAG: Only an explicit Start command with confirmed bot AND actor admin access
    // may publish a connection confirmation. Failures and passive onboarding stay silent.
    try {
      await this.groupCommandAuthority!.assertOwned(permit);
      await this.maxClient.sendMessage(
        context.chatId,
        this.buildSuccessReply(context, wasConnected),
        { buttons: this.buildSettingsButton(context) },
        {
          immediate: true,
          // FLAG: This command completes after the notice; no SEND retry owner remains.
          immediateFailurePolicy: 'terminal',
          botId: context.botId,
          candidateBotIds: [permit.executionBotId],
          routing: { purpose: 'send_message', requiredBotId: permit.executionBotId },
          beforeImmediateSendMutation: withMaxFinalAuthorityCheckpoint(
            async (beforeFinalAuthority) => {
              await this.groupCommandAuthority!.assertFreshHeldCommandAccess(
                permit,
                this.maxClient,
              );
              await beforeFinalAuthority?.();
              await this.groupCommandAuthority!.assertOwned(permit);
              if (permit.executionDeadlineAt && permit.executionDeadlineAt.getTime() <= Date.now())
                throw new Error('Start command expired before transport');
            },
          ),
          idempotencyKey: `managed-handshake-start:${permit.semanticKey}`,
          autoDeleteDelayMs: MANAGED_HANDSHAKE_CONFIRMATION_AUTO_DELETE_DELAY_MS,
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_HANDSHAKE,
          timeoutMs: HANDSHAKE_SEND_TIMEOUT_MS,
          ignoreFailureMetricStatuses: [403, 404],
        },
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          updateId: context.update.updateId,
          chatId: context.chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to send managed entity Start confirmation',
      );
    }
  }

  private async replySafely(
    context: ManagedEntityHandshakeContext,
    text: string,
    buttons?: NonNullable<Parameters<MaxClientService['sendMessageImmediateWithId']>[2]>['buttons'],
  ): Promise<void> {
    // FLAG: Generic connection replies go only to the initiating private dialog.
    // Public success confirmations use the explicit, admin-verified Start path above.
    if (context.interaction !== 'forwarded_private') return;
    await this.sendReplySafely({
      update: context.update,
      botId: context.replyBotId,
      replyChatId: context.replyChatId,
      sourceChatId: context.chatId,
      text,
      buttons,
    });
  }

  private async sendReplySafely({
    update,
    botId,
    replyChatId,
    sourceChatId,
    text,
    buttons,
  }: {
    update: MaxUpdate;
    botId: string;
    replyChatId: string;
    sourceChatId: string;
    text: string;
    buttons?: NonNullable<Parameters<MaxClientService['sendMessageImmediateWithId']>[2]>['buttons'];
  }): Promise<void> {
    if (!isPrivateDirectChatId(replyChatId)) return;
    try {
      await this.maxClient.sendMessageImmediateWithId(
        replyChatId,
        text,
        buttons && buttons.length > 0
          ? {
              buttons,
              debugContext: {
                screen: 'managed_entity_handshake',
                action: 'reply',
              },
            }
          : undefined,
        {
          botId,
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_HANDSHAKE,
          timeoutMs: HANDSHAKE_SEND_TIMEOUT_MS,
        },
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          updateId: update.updateId,
          chatId: sourceChatId,
          replyChatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to send managed entity handshake reply',
      );
    }
  }

  private async replyToForwardedDenial(
    context: ManagedEntityHandshakeContext,
    actor: 'bot' | 'bot_read' | 'bot_permissions' | 'user',
  ): Promise<void> {
    if (context.interaction !== 'forwarded_private') {
      return;
    }

    const entityLabel = context.entityType === 'channel' ? 'канала' : 'чата';
    const entityAccusative = context.entityType === 'channel' ? 'канал' : 'чат';
    const text =
      actor === 'bot'
        ? `Бот не администратор ${entityLabel}. Назначьте бота администратором и перешлите сообщение еще раз.`
        : actor === 'bot_read'
          ? `У бота нет доступа ко всем сообщениям ${entityLabel}. Включите это право и перешлите сообщение еще раз.`
          : actor === 'bot_permissions'
            ? `У бота нет права удалять сообщения ${entityLabel}. Включите это право и перешлите сообщение еще раз.`
            : `Подключить ${entityAccusative} может только владелец или администратор.`;
    await this.replySafely(context, text);
  }

  private buildSuccessReply(context: ManagedEntityHandshakeContext, wasConnected: boolean): string {
    return buildManagedHandshakeConfirmationText(context.entityType, wasConnected);
  }

  private buildSettingsButton(
    context: ManagedEntityHandshakeContext,
  ): NonNullable<Parameters<MaxClientService['sendMessageImmediateWithId']>[2]>['buttons'] {
    const route = `/${context.entityType}/${encodeURIComponent(context.chatId)}/settings`;
    const startParam = `mr-${Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'route',
        r: route,
      }),
      'utf8',
    ).toString('base64url')}`;
    const url =
      this.maxBotLinkService.buildEntryMiniappStartUrlSync(startParam) ??
      this.maxBotLinkService.buildMiniappStartUrlSync(startParam, context.botId);
    return url
      ? [
          [
            {
              type: 'link',
              text: 'Открыть настройки',
              url,
            },
          ],
        ]
      : [];
  }

  private toWriteContext(context: ManagedEntityHandshakeContext): ManagedEntityAccessWriteContext {
    return {
      chatId: context.chatId,
      title: context.title,
      link: context.link,
      avatarUrl: context.avatarUrl,
      botId: context.botId,
      senderId: context.senderId,
      entityType: context.entityType,
      prismaEntityType: context.prismaEntityType,
      createdAt: context.createdAt,
    };
  }

  private toWriteContextWithSender(
    context: ManagedEntityHandshakeContext,
  ): ManagedEntityAccessWriteContext & { senderId: string } {
    return {
      ...this.toWriteContext(context),
      senderId: context.senderId!,
    };
  }
}
