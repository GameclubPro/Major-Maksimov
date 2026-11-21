import { bindStateVoiceSource } from './state-voice-delete-source';
import type { VoiceSourceInput } from './voice-webhook-source';
import { EventType, Operator, SanctionAction, type Prisma } from '../prisma/prisma-client';
import { maskText } from './text-mask.util';
import type { EnsureModerationDeleteIntentInput } from './moderation-delete-intent.types';
import type { ModerationDeleteExecutionResult } from './profanity/profanity-delete-execution';
import {
  normalizeDayMinutes,
  normalizeNightModeTimezone,
  formatMinutesAsTime,
} from './night-mode-transition-time.util';

export type NightClosedChatMessage = {
  chatId: string;
  userId: string;
  messageId: string;
  text: string;
  createdAt: string;
  voiceSource?: VoiceSourceInput | null;
  nightModeStartTimeMinutes: number;
  nightModeEndTimeMinutes: number;
  nightModeTimezone: string;
};
export type ManuallyClosedChatMessage = {
  chatId: string;
  userId: string;
  messageId: string;
  text: string;
  createdAt: string;
  voiceSource?: VoiceSourceInput | null;
  nightModeForceCloseForever: boolean;
  nightModeForceCloseUntil: string;
};

export interface ClosedChatMessageDependencies {
  ensureIntent(input: EnsureModerationDeleteIntentInput): Promise<void>;
  ensureBothReasons(
    manual: EnsureModerationDeleteIntentInput,
    night: EnsureModerationDeleteIntentInput,
  ): Promise<void>;
  claimAction(input: {
    chatId: string;
    userId: string;
    messageId: string;
    ruleCode: string;
  }): Promise<boolean>;
  executeDelete(input: EnsureModerationDeleteIntentInput): Promise<ModerationDeleteExecutionResult>;
  createEvent(input: { data: Prisma.ModerationEventUncheckedCreateInput }): Promise<unknown>;
  warn(
    context: { chatId: string; userId: string; messageId: string; error: string },
    message: string,
  ): void;
}

/** FLAG: Receives chat messages only after the caller's bot/admin immunity and access gates. */
export class ClosedChatMessageModerationService {
  constructor(private readonly dependencies: ClosedChatMessageDependencies) {}

  // FLAG: Persist intent before claiming; append an event only if the executor did not own it.
  async handleNightModeMessage(params: NightClosedChatMessage) {
    const deleteIntent = this.buildNightReason(params);
    const { chatId, userId, messageId, text } = params;
    await this.dependencies.ensureIntent(deleteIntent);
    const claimed = await this.dependencies.claimAction({
      chatId,
      userId,
      messageId,
      ruleCode: 'NIGHT_MODE_DELETE',
    });
    if (!claimed) {
      return;
    }

    try {
      const deleteResult = await this.dependencies.executeDelete(deleteIntent);
      if (deleteResult.deleted && !deleteResult.eventPersistedByIntent) {
        await this.dependencies.createEvent({
          data: {
            chatId,
            userId,
            messageId,
            eventType: EventType.MESSAGE,
            ruleCode: 'NIGHT_MODE_DELETE',
            action: SanctionAction.DELETE_MESSAGE,
            maskedExcerpt: maskText(text),
            score: 0.6,
            operator: Operator.BOT,
            metadata: deleteIntent.event!.metadata as Prisma.InputJsonObject,
          },
        });
      }
    } catch (error: unknown) {
      this.dependencies.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to delete message during night mode',
      );
    }
  }

  private buildNightReason(params: NightClosedChatMessage): EnsureModerationDeleteIntentInput {
    const {
      chatId,
      userId,
      messageId,
      text,
      createdAt,
      nightModeStartTimeMinutes,
      nightModeEndTimeMinutes,
      nightModeTimezone,
    } = params;
    const startMinutes = normalizeDayMinutes(nightModeStartTimeMinutes, 23 * 60);
    const endMinutes = normalizeDayMinutes(nightModeEndTimeMinutes, 8 * 60);
    const timezone = normalizeNightModeTimezone(nightModeTimezone);
    return bindStateVoiceSource(
      {
        chatId,
        messageId,
        reasonKey: 'NIGHT_MODE_DELETE',
        ruleCode: 'NIGHT_MODE_DELETE',
        subjectUserId: userId,
        sourceMessageAt: createdAt,
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        event: {
          userId,
          eventType: 'MESSAGE',
          maskedExcerpt: maskText(text),
          score: 0.6,
          metadata: {
            reason: 'Message removed while chat is closed for the night',
            nightModeTimezone: timezone,
            nightModeStartTime: formatMinutesAsTime(startMinutes),
            nightModeEndTime: formatMinutesAsTime(endMinutes),
          },
        },
      },
      params.voiceSource,
    );
  }

  async handleNightModeForceCloseMessage(
    params: ManuallyClosedChatMessage,
    night?: NightClosedChatMessage,
  ) {
    const { chatId, userId, messageId, text, createdAt } = params;
    const deleteIntent = bindStateVoiceSource(
      {
        chatId,
        messageId,
        reasonKey: 'MANUAL_GROUP_CLOSE_DELETE',
        ruleCode: 'MANUAL_GROUP_CLOSE_DELETE',
        subjectUserId: userId,
        sourceMessageAt: createdAt,
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        event: {
          userId,
          eventType: 'MESSAGE',
          maskedExcerpt: maskText(text),
          score: 0.6,
          metadata: {
            reason: 'Message removed while group is manually closed',
            closeMode: params.nightModeForceCloseForever ? 'forever' : 'timed',
            closeUntil: params.nightModeForceCloseForever ? null : params.nightModeForceCloseUntil,
          },
        },
      },
      params.voiceSource,
    );
    // FLAG: The worker may run as soon as the first pending row is visible.
    // Both restrictions must be durable before either wakes that same DELETE.
    if (night)
      await this.dependencies.ensureBothReasons(deleteIntent, this.buildNightReason(night));
    else await this.dependencies.ensureIntent(deleteIntent);
    const claimed = await this.dependencies.claimAction({
      chatId,
      userId,
      messageId,
      ruleCode: 'MANUAL_GROUP_CLOSE_DELETE',
    });
    if (!claimed) {
      return;
    }

    try {
      const deleteResult = await this.dependencies.executeDelete(deleteIntent);
      if (deleteResult.deleted && !deleteResult.eventPersistedByIntent) {
        await this.dependencies.createEvent({
          data: {
            chatId,
            userId,
            messageId,
            eventType: EventType.MESSAGE,
            ruleCode: 'MANUAL_GROUP_CLOSE_DELETE',
            action: SanctionAction.DELETE_MESSAGE,
            maskedExcerpt: maskText(text),
            score: 0.6,
            operator: Operator.BOT,
            metadata: {
              reason: 'Message removed while group is manually closed',
              closeMode: params.nightModeForceCloseForever ? 'forever' : 'timed',
              closeUntil: params.nightModeForceCloseForever
                ? null
                : params.nightModeForceCloseUntil,
            },
          },
        });
      }
    } catch (error: unknown) {
      this.dependencies.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to delete message during manual group close',
      );
    }
  }
}
