import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MaxActionLedgerService } from '../max/max-action-ledger.service';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import { NightModeTransitionEventService } from './night-mode-transition-event.service';
import {
  NIGHT_MODE_OPEN_NOTICE_CLEANUP_RULE_CODE,
  NIGHT_MODE_OPEN_NOTICE_CLEANUP_STALE_CODE,
  NIGHT_MODE_OPEN_NOTICE_TRIGGER_MAX_AGE_MS,
  resolveNightModeOpenNoticeCleanupSession,
  type NightModeOpenNoticeCleanupBinding,
  type NightModeOpenNoticeCleanupSettings,
} from './night-mode-open-notice-cleanup-binding';

export type NightModeOpeningHumanMessage = {
  type: string | null;
  messageId: string;
  userId: string | null;
  createdAt: string;
  isBot: boolean;
};

@Injectable()
export class NightModeOpenNoticeCleanupService {
  private readonly logger = new Logger(NightModeOpenNoticeCleanupService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: MaxActionLedgerService,
    private readonly events: NightModeTransitionEventService,
    private readonly deletes: ModerationDeleteIntentService,
  ) {}

  /** Called only after the canonical handler excludes bots, service events and held sources. */
  async observeHumanMessage(
    settings: NightModeOpenNoticeCleanupSettings,
    message: NightModeOpeningHumanMessage,
  ): Promise<void> {
    try {
      await this.registerHumanMessage(settings, message);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: settings.chatId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Opening notice cleanup handoff failed; keeping participant moderation available',
      );
    }
  }

  private async registerHumanMessage(
    settings: NightModeOpenNoticeCleanupSettings,
    message: NightModeOpeningHumanMessage,
  ): Promise<void> {
    if (
      message.isBot ||
      message.type !== 'message_created' ||
      !message.messageId.trim() ||
      !message.userId?.trim()
    )
      return;
    const now = new Date();
    const sessionKey = resolveNightModeOpenNoticeCleanupSession(settings, now);
    const sourceAt = new Date(message.createdAt);
    if (
      !sessionKey ||
      !Number.isFinite(sourceAt.getTime()) ||
      sourceAt > now ||
      now.getTime() - sourceAt.getTime() > NIGHT_MODE_OPEN_NOTICE_TRIGGER_MAX_AGE_MS ||
      resolveNightModeOpenNoticeCleanupSession(settings, sourceAt) !== sessionKey
    )
      return;

    const proof = await this.ledger.inspectCompletedNightModeOpenNoticeDispatch({
      chatId: settings.chatId,
      sessionKey,
    });
    // FLAG: Source creation time must follow confirmed SEND completion. A delayed pre-opening
    // webhook, an in-flight SEND or its uncertain result never authorizes deleting a notice.
    if (proof.kind !== 'completed' || sourceAt <= proof.completedAt) return;
    const owned = await this.prisma.moderationDeleteIntent.findUnique({
      where: { chatId_messageId: { chatId: settings.chatId, messageId: proof.remoteMessageId } },
      select: {
        id: true,
        status: true,
        lastErrorCode: true,
        reasons: {
          where: { ruleCode: NIGHT_MODE_OPEN_NOTICE_CLEANUP_RULE_CODE },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (owned?.reasons.length) {
      if (
        owned.status === 'FAILED_TERMINAL' &&
        owned.lastErrorCode === NIGHT_MODE_OPEN_NOTICE_CLEANUP_STALE_CODE
      )
        await this.deletes.rearmNightModeOpenNoticeCleanup(owned.id);
      return;
    }
    const event = await this.events.ensureTransitionEvent({
      chatId: settings.chatId,
      messageId: proof.remoteMessageId,
      botId: proof.dispatchBotId,
      ruleCode: 'NIGHT_MODE_OPEN_NOTICE',
      sessionKey,
      timezone: settings.nightModeTimezone,
      startMinutes: settings.nightModeStartTimeMinutes,
      endMinutes: settings.nightModeEndTimeMinutes,
    });
    const binding: NightModeOpenNoticeCleanupBinding = {
      version: 1,
      sessionKey,
      eventId: event.id,
      messageId: proof.remoteMessageId,
      botId: proof.dispatchBotId,
      sendCompletedAt: proof.completedAt.toISOString(),
      trigger: {
        messageId: message.messageId,
        userId: message.userId,
        createdAt: sourceAt.toISOString(),
      },
    };
    await this.deletes.ensureIntent({
      chatId: settings.chatId,
      messageId: proof.remoteMessageId,
      reasonKey: NIGHT_MODE_OPEN_NOTICE_CLEANUP_RULE_CODE,
      ruleCode: NIGHT_MODE_OPEN_NOTICE_CLEANUP_RULE_CODE,
      entityType: 'CHAT',
      messageAuthorKind: 'bot',
      originBotId: proof.dispatchBotId,
      routingPolicy: 'origin_only',
      retryUntilAt: new Date(sourceAt.getTime() + 24 * 60 * 60_000),
      event: { eventType: 'SYSTEM', metadata: { nightModeOpenNoticeCleanup: binding } },
    });
  }
}
