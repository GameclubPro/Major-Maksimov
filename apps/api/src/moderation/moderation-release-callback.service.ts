import { BadRequestException, Logger } from '@nestjs/common';
import { formatManualModerationUserLabel } from '../admin/manual-moderation-notice.util';
import type { MaxUpdate } from '@maxim/contracts';
import type { ManualModerationService } from '../admin/manual-moderation.service';
import {
  MAX_API_SOURCE_TAGS,
  type MaxCallbackMessageEdit,
  type MaxChatMemberAccess,
  type MaxClientService,
} from '../max/max-client.service';
import { MaxMemberRestoreUnavailableError } from '../max/max-member-restore-capability';
import { SanctionAction } from '../prisma/prisma-client';
import { LOCAL_CHAT_BAN_MODE } from './local-chat-ban';
import { resolveModerationSanctionExpiry } from './moderation-sanction-expiry.util';
import type { PrismaService } from '../prisma/prisma.service';
import {
  extractMaxCallbackId,
  extractMaxCallbackPayloadRaw,
  extractMaxCallbackUserId,
} from './max-callback-update.util';
import {
  buildModerationReleaseCallbackPayload,
  parseModerationReleaseCallbackPayload,
  type ModerationReleaseCallback,
} from './moderation-release-callback.util';
import {
  ModerationSanctionStateChangedError,
  ModerationSanctionStateLockBusyError,
  ModerationSanctionStateLockLeaseLostError,
  ModerationSanctionStateLockUnavailableError,
} from './moderation-sanction-state-lock.service';
import { ModerationSanctionStateFenceService } from './moderation-sanction-state-fence.service';
import { CALLBACK_TERMINAL_FAILURE_METRIC_STATUSES } from './moderation.service.support';

type ManualModerationReleaseBridge = Pick<ManualModerationService, 'applyManualModerationAction'>;
type ModerationSanctionStateFenceBridge = Pick<
  ModerationSanctionStateFenceService,
  'isSanctionEventInvalidated'
>;

type ModerationReleaseSanctionEvent = {
  id: string;
  chatId: string;
  userId: string;
  action: SanctionAction;
  ruleCode: string;
  metadata: unknown;
  createdAt: Date;
};

export class ModerationReleaseCallbackService {
  private readonly logger = new Logger(ModerationReleaseCallbackService.name);
  private readonly sanctionStateFence: ModerationSanctionStateFenceBridge;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly manualModeration: ManualModerationReleaseBridge | null,
    sanctionStateFence?: ModerationSanctionStateFenceBridge,
  ) {
    this.sanctionStateFence = sanctionStateFence ?? new ModerationSanctionStateFenceService(prisma);
  }

  async tryHandle(update: MaxUpdate): Promise<boolean> {
    const release = parseModerationReleaseCallbackPayload(extractMaxCallbackPayloadRaw(update));
    if (!release) {
      return false;
    }

    await this.handle(update, release);
    return true;
  }

  private async handle(update: MaxUpdate, release: ModerationReleaseCallback): Promise<void> {
    const callbackId = extractMaxCallbackId(update);
    const actorUserId = extractMaxCallbackUserId(update);
    const messageChatId = update.message?.chatId.trim() ?? '';
    const botId = readString(update.botId) ?? undefined;
    const acknowledgeSilently = async () => {
      if (callbackId) {
        await this.answerCallbackSafe(callbackId, undefined, botId, messageChatId);
      }
    };

    if (
      !callbackId ||
      !actorUserId ||
      readLowerString(update.type) !== 'message_callback' ||
      !messageChatId ||
      !this.manualModeration
    ) {
      await acknowledgeSilently();
      return;
    }

    let actorAccess: MaxChatMemberAccess | null;
    try {
      actorAccess = await this.maxClient.getChatMemberAccess(messageChatId, actorUserId, {
        bypassCache: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: MAX_API_SOURCE_TAGS.MODERATION_SANCTION,
        ...(botId ? { botId } : {}),
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: messageChatId,
          actorUserId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to verify moderation release callback actor',
      );
      await acknowledgeSilently();
      return;
    }

    if (!actorAccess || (!actorAccess.isAdmin && !actorAccess.isOwner)) {
      await acknowledgeSilently();
      return;
    }

    const sanctionEvent = await this.loadSanctionEvent(release, messageChatId);
    if (!sanctionEvent) {
      await this.answerCallbackSafe(
        callbackId,
        'Санкция уже снята или изменилась',
        botId,
        messageChatId,
      );
      return;
    }

    try {
      if (!(await this.hasMatchingActiveSanction(release, sanctionEvent))) {
        await this.answerCallbackSafe(
          callbackId,
          'Санкция уже снята или изменилась',
          botId,
          messageChatId,
        );
        return;
      }

      let unbanRecorded = false;
      const result = await this.manualModeration.applyManualModerationAction(
        sanctionEvent.chatId,
        sanctionEvent.userId,
        {
          userId: actorUserId,
          launchBotId: botId ?? null,
          username: null,
          displayName: null,
          chatId: sanctionEvent.chatId,
          chatTitle: update.message?.chatTitle ?? null,
          chatType: 'chat',
        },
        { action: release.action },
        'group_command',
        {
          actorAlreadyVerified: true,
          allowTargetDisplayNameRemoteLookup: false,
          expectedSanctionEventId: sanctionEvent.id,
          ...(release.action === 'UNBAN'
            ? { onModerationEventRecorded: () => (unbanRecorded = true) }
            : {}),
        },
      );
      if (release.action === 'UNBAN') {
        await this.answerUnban(callbackId, update, sanctionEvent, release, unbanRecorded);
      } else {
        await this.answerCallbackSafe(callbackId, result.message, botId, messageChatId);
      }
    } catch (error: unknown) {
      const response = error instanceof BadRequestException ? error.getResponse() : null;
      if (
        release.action === 'UNBAN' &&
        (error instanceof MaxMemberRestoreUnavailableError ||
          readField(response, 'code') === 'MAX_MEMBER_RESTORE_UNAVAILABLE')
      ) {
        await this.answerUnban(callbackId, update, sanctionEvent, release, false);
        return;
      }
      if (error instanceof ModerationSanctionStateChangedError) {
        await this.answerCallbackSafe(
          callbackId,
          'Санкция уже снята или изменилась',
          botId,
          messageChatId,
        );
        return;
      }
      if (
        error instanceof ModerationSanctionStateLockBusyError ||
        error instanceof ModerationSanctionStateLockUnavailableError ||
        error instanceof ModerationSanctionStateLockLeaseLostError
      ) {
        await acknowledgeSilently();
        return;
      }

      this.logger.warn(
        {
          chatId: sanctionEvent.chatId,
          targetUserId: sanctionEvent.userId,
          actorUserId,
          action: release.action,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to apply moderation release callback action',
      );
      await this.answerCallbackSafe(
        callbackId,
        'Не удалось выполнить действие',
        botId,
        messageChatId,
      );
    }
  }

  private async answerUnban(
    callbackId: string,
    update: MaxUpdate,
    event: ModerationReleaseSanctionEvent,
    release: ModerationReleaseCallback,
    recorded: boolean,
  ): Promise<void> {
    const localBan = readField(event.metadata, 'mode') === LOCAL_CHAT_BAN_MODE;
    const status = recorded
      ? localBan
        ? 'Бан снят. Можно добавить в чат.'
        : 'Бан снят. Участник уже в чате.'
      : 'Добавьте в чат, затем нажмите «Проверить».';
    const botId = readString(update.botId) ?? undefined;
    const messageId = readString(update.message?.messageId);
    if (!botId || !messageId) {
      await this.answerCallbackSafe(
        callbackId,
        recorded ? status : 'Добавьте участника в MAX, затем проверьте.',
        botId,
        event.chatId,
      );
      return;
    }

    const label = formatManualModerationUserLabel(
      readString(readField(event.metadata, 'targetDisplayName')),
      event.userId,
    );
    const payload = buildModerationReleaseCallbackPayload(release.action, release.sanctionEventId);
    // FLAG: The callback edits its own notice. Keep unrelated attachments and replace only this
    // sanction's button. A native unban without a recorded event still needs verification.
    await this.answerCallbackSafe(callbackId, undefined, botId, event.chatId, {
      messageId,
      text: `${label}\n${status}`,
      options: {
        textFormat: 'markdown',
        replaceCallbackPayloadPrefixes: [payload],
        ...(recorded
          ? {}
          : { buttons: [[{ type: 'callback', text: 'Проверить', payload, intent: 'positive' }]] }),
      },
    });
  }

  private async loadSanctionEvent(
    release: ModerationReleaseCallback,
    messageChatId: string,
  ): Promise<ModerationReleaseSanctionEvent | null> {
    const expectedAction = release.action === 'UNBAN' ? SanctionAction.BAN : SanctionAction.MUTE;
    const event = await this.prisma.moderationEvent.findUnique({
      where: { id: release.sanctionEventId },
      select: {
        id: true,
        chatId: true,
        userId: true,
        action: true,
        ruleCode: true,
        metadata: true,
        createdAt: true,
      },
    });

    if (!event || event.chatId !== messageChatId || event.action !== expectedAction) {
      return null;
    }

    return event;
  }

  private async hasMatchingActiveSanction(
    release: ModerationReleaseCallback,
    sanctionEvent: ModerationReleaseSanctionEvent,
  ): Promise<boolean> {
    if (release.action === 'UNMUTE' && !this.isActiveMuteEvent(sanctionEvent)) {
      return false;
    }

    if (
      await this.sanctionStateFence.isSanctionEventInvalidated({
        chatId: sanctionEvent.chatId,
        userId: sanctionEvent.userId,
        sanctionEventId: sanctionEvent.id,
        eventCreatedAt: sanctionEvent.createdAt,
      })
    ) {
      return false;
    }

    const latestEvent = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId: sanctionEvent.chatId,
        userId: sanctionEvent.userId,
        OR: [
          { action: { in: [SanctionAction.BAN, SanctionAction.MUTE] } },
          { ruleCode: { in: ['MANUAL_UNBAN', 'MANUAL_UNMUTE'] } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
      },
    });

    return latestEvent?.id === sanctionEvent.id;
  }

  private isActiveMuteEvent(event: ModerationReleaseSanctionEvent): boolean {
    const expiry = resolveModerationSanctionExpiry(event.action, event.metadata, event.createdAt);
    return expiry.permanent || !!(expiry.expiresAt && expiry.expiresAt.getTime() > Date.now());
  }

  private async answerCallbackSafe(
    callbackId: string,
    notification?: string,
    botId?: string,
    rateLimitEntityId?: string,
    messageEdit?: MaxCallbackMessageEdit,
  ): Promise<void> {
    try {
      await this.maxClient.answerCallback(callbackId, notification, messageEdit, {
        ignoreFailureMetricStatuses: CALLBACK_TERMINAL_FAILURE_METRIC_STATUSES,
        ...(botId ? { botId } : {}),
        ...(rateLimitEntityId?.trim() ? { rateLimitEntityId: rateLimitEntityId.trim() } : {}),
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          callbackId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to answer callback',
      );
    }
  }
}

function readField(value: unknown, field: string): unknown {
  return value && typeof value === 'object' && Object.hasOwn(value, field)
    ? (value as Record<string, unknown>)[field]
    : undefined;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}

function readLowerString(value: unknown): string | null {
  return readString(value)?.toLowerCase() ?? null;
}
