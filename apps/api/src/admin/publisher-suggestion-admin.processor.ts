import { SuggestionNativeService } from './suggestion-native.service';
import { SuggestionReviewEffectsService } from './suggestion-review-effects.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ForbiddenException, HttpException, Logger, Optional } from '@nestjs/common';
import { VkBotReviewService } from './vk-bot-review.service';
import type { VkBotReviewJob } from '../publisher/publisher-vk-bot-review.queue';
import { UnrecoverableError, type Job } from 'bullmq';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import {
  ChannelSuggestionAdminDeliveryStatus,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherDispatchHealthService } from '../publisher/publisher-dispatch-health.service';
import { PublisherActionCredentialService } from '../publisher/publisher-action-credential.service';
import {
  assertPublisherDispatchAllowedOrDelay,
  assertPublisherRuntimeEnabledOrDelay,
} from '../publisher/publisher-dispatch-job-guard';
import { PublisherIdentityAttestationService } from '../publisher/publisher-identity-attestation.service';
import { assertPublisherIdentityOrDelay } from '../publisher/publisher-identity-attestation-job-guard';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import {
  PUBLISHER_SUGGESTION_ADMIN_QUEUE,
  PublisherSuggestionAdminQueueService,
  type PublisherSuggestionAdminJob,
  type PublisherSuggestionAdminReviewStatus,
} from '../publisher/publisher-suggestion-admin.queue';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { ChannelDialogService } from './channel-dialog.service';
import { PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST } from './admin.service.support';
import { PublisherSuggestionService } from './publisher-suggestion.service';

@Processor(PUBLISHER_SUGGESTION_ADMIN_QUEUE, { concurrency: 1 })
export class PublisherSuggestionAdminProcessor extends WorkerHost {
  private readonly logger = new Logger(PublisherSuggestionAdminProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly channelDialogs: ChannelDialogService,
    private readonly suggestions: PublisherSuggestionService,
    private readonly queue: PublisherSuggestionAdminQueueService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly credentials: PublisherActionCredentialService,
    @Optional() private readonly vkReviews?: VkBotReviewService,
    @Optional() private readonly reviewEffects?: SuggestionReviewEffectsService,
    @Optional() private readonly links?: MaxBotLinkService,
    @Optional() private readonly nativeReview?: SuggestionNativeService,
  ) {
    super();
  }

  async process(job: Job<PublisherSuggestionAdminJob>, token?: string): Promise<void | boolean> {
    // FLAG: Recovered jobs retain their old options across retries. Bound only BullMQ's
    // diagnostic stack history; SQL delivery receipts, job data and retry authority stay intact.
    job.opts = { ...job.opts, stackTraceLimit: 16 };
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('Publisher suggestion admin job received by a non-publisher API role');
    }
    if (job.data.requiredBotId !== this.credentials.getBotId()) {
      throw new UnrecoverableError('Publisher suggestion admin job targets another bot');
    }
    await assertPublisherRuntimeEnabledOrDelay(this.runtimeBoundary, job, token);
    await assertPublisherIdentityOrDelay(this.identityAttestation, job, token);
    await assertPublisherDispatchAllowedOrDelay(this.dispatchHealth, job, token);

    if (job.data.kind === 'suggestion-native') {
      if (!this.nativeReview || job.data.profile !== 'publisher')
        throw new Error('Native review unavailable');
      await this.nativeReview.process(job.data);
      return;
    }
    if (job.data.kind === 'review-effect') {
      if (!this.reviewEffects) throw new Error('Review effect worker unavailable');
      await this.reviewEffects.process(job.data.effectId, 'publisher', job.data.requiredBotId);
      return;
    }

    if (job.data.kind === 'subscription') {
      if (Date.now() - Date.parse(job.data.requestedAt) > 8_000) {
        throw new UnrecoverableError('Subscription request expired');
      }
      const binding = await this.prisma.publisherEntityBinding.findFirst({
        where: {
          chatId: job.data.chatId,
          publisherBotId: job.data.requiredBotId,
          status: 'ACTIVE',
        },
        select: { chatId: true },
      });
      if (!binding) throw new UnrecoverableError('Publisher binding unavailable');
      try {
        const members = await this.maxClient.getChatMembersAccess(
          job.data.chatId,
          [job.data.userId],
          {
            botId: job.data.requiredBotId,
            trafficClass: 'interactive',
            sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
            bypassCache: true,
            timeoutMs: 3_000,
          },
        );
        return members.has(job.data.userId);
      } catch {
        throw new Error('Subscription verification unavailable');
      }
    }

    if (job.data.kind === 'vk-bot-review') {
      if (!this.vkReviews) throw new Error('VK review worker is unavailable');
      await this.vkReviews.process(job as Job<VkBotReviewJob>);
      return;
    }

    if (job.data.kind === 'deliver') {
      await this.channelDialogs.processPublisherSuggestionAdminDeliveryJob(
        job.data.suggestionId,
        job.data.requiredBotId,
      );
      await this.reviewEffects?.syncAfterDelivery(job.data.suggestionId, 'publisher');
      return;
    }
    if (job.data.kind === 'sync') {
      await this.channelDialogs.syncPublisherSuggestionAdminReviewMessages(
        job.data.suggestionId,
        job.data.requiredBotId,
      );
      return;
    }
    await this.processReview(job.data);
  }

  private async processReview(job: Extract<PublisherSuggestionAdminJob, { kind: 'review' }>) {
    const row = await this.prisma.auditLog.findFirst({
      where: {
        id: job.suggestionId,
        action: PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST,
      },
      select: { id: true, chatId: true },
    });
    if (!row) {
      await this.answerCallback(job, 'Предложка не найдена.');
      return;
    }

    const deliveredCard = await this.prisma.channelSuggestionAdminDelivery.findFirst({
      where: {
        auditLogId: row.id,
        adminUserId: job.actor.userId,
        botKey: `publisher:${job.requiredBotId}`,
        botId: job.requiredBotId,
        privateChatId: job.privateChatId,
        remoteMessageId: job.messageId,
        status: ChannelSuggestionAdminDeliveryStatus.SENT,
      },
      select: { id: true },
    });
    if (!deliveredCard) {
      await this.answerCallback(job, 'Эта кнопка больше недоступна.');
      return;
    }

    try {
      const accessEdge = await this.prisma.managedEntityAccessEdge.findFirst({
        where: {
          chatId: row.chatId,
          userId: job.actor.userId,
          botId: job.requiredBotId,
          state: ManagedEntityAccessState.GRANTED,
          userRole: { in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN] },
        },
        select: { chatId: true },
      });
      if (!accessEdge) {
        throw new ForbiddenException('Publisher administrator access is not granted.');
      }

      if (job.action === 'cancel') {
        if (!this.nativeReview) throw new Error('Native review unavailable');
        await this.nativeReview.process({
          version: 1,
          kind: 'suggestion-native',
          profile: 'publisher',
          requiredBotId: job.requiredBotId,
          actorId: job.actor.userId,
          privateChatId: job.privateChatId,
          messageId: job.messageId,
          callbackId: job.callbackId,
          callback: { action: 'reject', id: row.id, revision: -1, version: 0 },
          eventId: job.updateId,
          requestedAt: job.requestedAt,
        });
        return;
      }
      const result = await this.suggestions.review(
        row.chatId,
        row.id,
        {
          userId: job.actor.userId,
          launchBotId: job.requiredBotId,
          username: job.actor.username,
          displayName: job.actor.displayName,
          avatarUrl: job.actor.avatarUrl,
          profileUrl: job.actor.profileUrl,
          chatId: job.privateChatId,
          chatType: 'dialog',
        },
        { action: job.action, responseVersion: 2 },
      );
      const reviewStatus = result.suggestion.reviewStatus;
      if (isTerminalReviewStatus(reviewStatus)) {
        await this.queue.enqueueSync({
          suggestionId: row.id,
          requiredBotId: job.requiredBotId,
          reviewStatus,
          recoverExisting: true,
        });
      }
      await this.answerCallback(job, reviewNotification(reviewStatus));
    } catch (error: unknown) {
      const rejection = reviewErrorDetails(error);
      await this.answerCallback(job, rejection.notification);
      if (isTerminalReviewError(error)) {
        // FLAG: Preserve the rejection reason without logging the exception, actor or card content.
        this.logger.warn(
          {
            suggestionId: row.id,
            botId: job.requiredBotId,
            action: job.action,
            statusCode: error instanceof HttpException ? error.getStatus() : null,
            reason: rejection.reason,
          },
          'Publisher suggestion review rejected',
        );
      } else {
        throw error;
      }
    }
  }

  private async answerCallback(
    job: Extract<PublisherSuggestionAdminJob, { kind: 'review' }>,
    notification: string,
  ): Promise<void> {
    try {
      await this.maxClient.answerCallback(job.callbackId, notification, undefined, {
        botId: job.requiredBotId,
        rateLimitEntityId: job.privateChatId,
        actionHealthLane: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.CALLBACK_ANSWER,
      });
    } catch {
      // Review state and card synchronization remain authoritative if callback UI expires.
    }
  }
}

function isTerminalReviewStatus(value: string): value is PublisherSuggestionAdminReviewStatus {
  return value === 'published' || value === 'drafted' || value === 'cancelled';
}

function reviewNotification(status: string): string {
  if (status === 'published') return 'Предложка передана в публикацию.';
  if (status === 'cancelled') return 'Предложка отклонена.';
  if (status === 'drafted') return 'Черновик создан.';
  return 'Предложка отправлена в публикацию.';
}

function isTerminalReviewError(error: unknown): boolean {
  if (!(error instanceof HttpException)) return false;
  const status = error.getStatus();
  return status >= 400 && status < 500 && status !== 429;
}

function reviewErrorDetails(error: unknown): {
  notification: string;
  reason:
    | 'author_subscription_required'
    | 'administrator_access_required'
    | 'review_conflict'
    | 'request_rejected';
} {
  if (error instanceof HttpException && error.getStatus() === 403) {
    const response = error.getResponse();
    if (
      typeof response === 'object' &&
      response !== null &&
      'code' in response &&
      response.code === 'SUGGESTION_SUBSCRIPTION_REQUIRED'
    ) {
      return {
        notification:
          'Подписка автора предложки на канал не подтверждена. Включено требование подписки.',
        reason: 'author_subscription_required',
      };
    }
  }
  if (error instanceof ForbiddenException) {
    return {
      notification: 'Права администратора не подтверждены.',
      reason: 'administrator_access_required',
    };
  }
  if (error instanceof HttpException && error.getStatus() === 409) {
    return {
      notification: 'Состояние предложки уже изменилось.',
      reason: 'review_conflict',
    };
  }
  return {
    notification: 'Не удалось обработать предложку. Повторите позже.',
    reason: 'request_rejected',
  };
}
