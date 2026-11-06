import { duplicatePublicationTime } from './message-duplicate-publication-time';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import type { DuplicateObservationOutcome } from '@maxim/contracts/settings';
import type { ChatSettings } from '../../prisma/prisma-client';
import { classifyDuplicateEventTime } from '../duplicate-enforcement-safety';
import { resolveDuplicateFlowConfig } from '../duplicate-flow-policy';
import {
  extractDuplicateMessageContent,
  isExactImageContent,
  isDuplicateContentComparable,
} from './message-duplicate-content';
import {
  MessageDuplicateEnforcementService,
  duplicateEnforcementObservation,
} from './message-duplicate-enforcement.service';
import { MessageDuplicateHistoryService } from './message-duplicate-history.service';
import { MessageDuplicatePolicyService } from './message-duplicate-policy.service';
import { messageDuplicateActionsEnabled } from './message-duplicate-policy.service';
import type { ExecuteDuplicateModerationAction } from '../duplicate-moderation.actions';
import { MessageDuplicateEnqueueService } from './message-duplicate.queue';
import {
  messageDuplicateSettingsDigest,
  exactImageSettingsDigest,
} from './message-duplicate-state';
import {
  MessageDuplicateMetricsService,
  measureDuplicatePhase,
} from './message-duplicate-metrics.service';
import { isDuplicateScheduleOpen } from './message-duplicate-schedule';
import { MessageDuplicateAuthorizationService } from './message-duplicate-authorization.service';
import { resolveTrustedDuplicateStateRevision } from '../duplicate-message-revision';
import { DUPLICATE_JOB_MAX_LIFETIME_MS } from '../photo-duplicate/photo-duplicate-ordering.store';
import { MESSAGE_DUPLICATE_HISTORY_RETENTION_MS } from './message-duplicate-window.script';

@Injectable()
export class MessageDuplicateService {
  private readonly logger = new Logger(MessageDuplicateService.name);
  constructor(
    private readonly policy: MessageDuplicatePolicyService,
    private readonly history: MessageDuplicateHistoryService,
    private readonly enforcement: MessageDuplicateEnforcementService,
    private readonly queue: MessageDuplicateEnqueueService,
    private readonly authorization: MessageDuplicateAuthorizationService,
    @Optional() private readonly metrics?: MessageDuplicateMetricsService,
  ) {}

  async isAuthoritative(_chatId: string): Promise<boolean> {
    // FLAG: Off/shadow are real kill switches; never fall back to retired rolling evidence.
    return true;
  }

  async observeLifecycle(update: MaxUpdate): Promise<void> {
    const message = update.message;
    if (!message || !['message_edited', 'message_removed'].includes(update.type)) return;
    if (update.type === 'message_removed') {
      await this.history.remove(message.chatId, message.messageId);
      return;
    }
    const eventTimestampMs = Date.parse(message.createdAt);
    if (
      update.eventTimestampSource === 'ingress' ||
      !Number.isSafeInteger(eventTimestampMs) ||
      eventTimestampMs > Date.now() + 60_000 ||
      eventTimestampMs < Date.now() - MESSAGE_DUPLICATE_HISTORY_RETENTION_MS
    )
      return;
    await this.history.observeLifecycle({
      chatId: message.chatId,
      messageId: message.messageId,
      eventTimestampMs,
      publishedAtMs: duplicatePublicationTime(update),
      content: extractDuplicateMessageContent(update.raw),
    });
  }

  async revokeActions(update: MaxUpdate): Promise<void> {
    const message = update.message;
    if (!message || !['message_created', 'message_edited'].includes(update.type)) return;
    const revision = resolveTrustedDuplicateStateRevision(
      update.type,
      message.createdAt,
      update.eventTimestampSource,
    );
    if (!revision.duplicateStateEventTimestampMs) return;
    await this.authorization.revoke({
      chatId: message.chatId,
      messageId: message.messageId,
      senderId: message.senderId,
      eventTimestampMs: revision.duplicateStateEventTimestampMs,
    });
  }

  async observe(params: {
    update: MaxUpdate;
    webhookEventId?: string;
    eventTimestampMs?: number;
    settings: ChatSettings;
    botId: string;
    readSelectedBotId?: () => string | undefined;
    actionEligible: boolean;
    track: boolean;
    executeFullAction?: ExecuteDuplicateModerationAction;
  }): Promise<DuplicateObservationOutcome | undefined> {
    const message = params.update.message;
    if (
      !message ||
      !params.settings.antiDuplicateEnabled ||
      !['message_created', 'message_edited'].includes(params.update.type)
    )
      return;
    let supported = false;
    let comparedOutcome: DuplicateObservationOutcome | null = null;
    const finish = (outcome: DuplicateObservationOutcome) => {
      try {
        this.metrics?.recordObservation?.(message.chatId, outcome, supported);
      } catch {
        /* FLAG: Telemetry cannot replace the moderation outcome. */
      }
      return outcome;
    };
    try {
      if (!params.actionEligible || !params.track) await this.revokeActions(params.update);
      const policy = await measureDuplicatePhase(this.metrics, 'policy', () =>
        this.policy.resolve(message.chatId),
      );
      if (policy.mode === 'off') {
        this.metrics?.record('admission.off');
        return finish('OFF');
      }
      const eventTimestampMs = params.eventTimestampMs;
      if (eventTimestampMs && !isDuplicateScheduleOpen(params.settings, eventTimestampMs)) {
        this.metrics?.record('admission.schedule_closed');
        return finish('SCHEDULE_CLOSED');
      }
      if (
        !Number.isSafeInteger(eventTimestampMs) ||
        !eventTimestampMs ||
        eventTimestampMs < policy.effectiveAtMs ||
        classifyDuplicateEventTime({
          eventTimestampMs,
          windowSec:
            params.settings.duplicateWindowMode === 'DAILY'
              ? 172800
              : resolveDuplicateFlowConfig(params.settings).windowSec,
        })
      ) {
        this.metrics?.record('admission.event_time_rejected');
        this.logger.debug(
          { chatId: message.chatId },
          'Message duplicate skipped: untrusted event time',
        );
        return finish('EVENT_TIME_REJECTED');
      }
      const publishedAtMs = duplicatePublicationTime(params.update);
      if (!publishedAtMs || publishedAtMs > eventTimestampMs + 60_000)
        return finish('EVENT_TIME_REJECTED');
      const content = extractDuplicateMessageContent(params.update.raw);
      if (!content.complete) this.metrics?.recordContentRejection(content.reason);
      const hasPhotos = content.media.some((media) => media.kind === 'photo');
      const invalidContent = { ...content, complete: false, reason: 'invalid_content' as const };
      const imageOnly = isExactImageContent(content);
      // FLAG: Text is independent evidence for every message. Optional image analysis must
      // never delay or suppress a caption match, including for retained legacy settings.
      supported = params.track && isDuplicateContentComparable(content, 'TEXT');
      const observedContent = params.track ? content : invalidContent;
      const observation = await measureDuplicatePhase(this.metrics, 'history', () =>
        this.history.observeWithOutcome({
          content: observedContent,
          comparison: 'TEXT',
          chatId: message.chatId,
          userId: message.senderId,
          messageId: message.messageId,
          eventTimestampMs,
          publishedAtMs,
          controlRevision: policy.revision,
          settings: params.settings,
        }),
      );
      const result = observation.match;
      if (supported && observation.outcome === 'MATCHED') comparedOutcome = 'MATCHED_ACTION_FAILED';
      if (supported && observation.outcome === 'COMPARED_NO_MATCH')
        comparedOutcome = 'COMPARED_NO_MATCH';
      // FLAG: One revision invalidates both histories when an edit changes the attachment kind.
      // Old message/photo jobs are never promoted into the new explicit IMAGE job authority.
      if (hasPhotos || params.update.type === 'message_edited') {
        await measureDuplicatePhase(this.metrics, 'history', () =>
          this.history.observe({
            content: params.track && imageOnly ? content : invalidContent,
            imageScope: params.settings.duplicatePhotoScope,
            chatId: message.chatId,
            userId: message.senderId,
            messageId: message.messageId,
            eventTimestampMs,
            publishedAtMs,
            controlRevision: policy.revision,
            settings: params.settings,
          }),
        );
      }
      if (!params.track) {
        this.metrics?.record('admission.untracked');
        return finish('UNTRACKED');
      }
      if (!content.complete && !result)
        this.logger.debug(
          { chatId: message.chatId, reason: content.reason },
          'Message duplicate content could not be verified',
        );
      if (result && params.actionEligible && messageDuplicateActionsEnabled(policy.mode)) {
        result.binding.authorization = {
          eventTimestampMs,
          deadlineAtMs:
            Math.min(eventTimestampMs, result.binding.eventTimestampMs) +
            DUPLICATE_JOB_MAX_LIFETIME_MS,
        };
        const enforcement = await measureDuplicatePhase(this.metrics, 'enforcement', () =>
          this.enforcement.enqueue({
            ...result,
            chatId: message.chatId,
            botId: params.botId,
            readSelectedBotId: params.readSelectedBotId,
            sourceCreatedAt: message.createdAt,
            text: content.text,
            settings: params.settings,
            update: params.update,
            executeFullAction: params.executeFullAction,
            deferQualification: params.webhookEventId
              ? () =>
                  this.queue.enqueue({
                    webhookEventId: params.webhookEventId!,
                    comparison: 'TEXT',
                    chatId: message.chatId,
                    messageId: message.messageId,
                    eventTimestampMs,
                    sourceCreatedAt: new Date(eventTimestampMs).toISOString(),
                    controlRevision: policy.revision,
                    policyRevision: params.settings.duplicatePolicyRevision,
                    settingsDigest: result.binding.settingsDigest,
                    actionEligible: true,
                    // FLAG: Persist before acknowledging the handler, retaining the inline
                    // owner's deadline. No new observation or action is admitted by this handoff.
                    deadlineAtMs: result.binding.authorization!.deadlineAtMs,
                  })
              : undefined,
          }),
        );
        return finish(duplicateEnforcementObservation(enforcement));
      } else if (result) {
        this.metrics?.record(
          params.actionEligible ? 'admission.shadow' : 'admission.action_ineligible',
        );
        return finish(params.actionEligible ? 'MATCHED_OBSERVE' : 'MATCHED_INELIGIBLE');
      }
      if ((imageOnly || !hasPhotos) && content.complete && content.media.length > 0) {
        if (!params.webhookEventId) {
          this.metrics?.record('admission.missing_receipt');
          this.logger.debug(
            { chatId: message.chatId },
            'Message duplicate media skipped: missing durable receipt',
          );
          return finish('SOURCE_UNAVAILABLE');
        }
        await this.queue.enqueue({
          webhookEventId: params.webhookEventId,
          chatId: message.chatId,
          messageId: message.messageId,
          eventTimestampMs,
          sourceCreatedAt: new Date(eventTimestampMs).toISOString(),
          controlRevision: policy.revision,
          policyRevision: params.settings.duplicatePolicyRevision,
          settingsDigest: imageOnly
            ? exactImageSettingsDigest(params.settings)
            : messageDuplicateSettingsDigest(params.settings),
          ...(imageOnly ? { comparison: 'IMAGE' as const } : {}),
          actionEligible:
            params.actionEligible &&
            (imageOnly ? policy.mode === 'full' : messageDuplicateActionsEnabled(policy.mode)),
          deadlineAtMs: eventTimestampMs + DUPLICATE_JOB_MAX_LIFETIME_MS,
        });
        this.metrics?.record('admission.media_queued');
        return finish('MEDIA_QUEUED');
      }
      return finish(observation.outcome === 'MATCHED' ? 'CONTENT_UNVERIFIED' : observation.outcome);
    } catch (error) {
      finish(comparedOutcome ?? (supported ? 'COMPARISON_FAILED' : 'UNAVAILABLE'));
      throw error;
    }
  }
}
