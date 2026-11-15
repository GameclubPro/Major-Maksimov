import { channelCustomButtonsEligible } from '../common/channel-custom-post-buttons';
import type { MaxUpdate } from '@maxim/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChannelPostSignaturePresentation,
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookLegacyHoldService } from '../webhook/webhook-legacy-hold.service';
import {
  buildChatAutoCommentAuditId,
  ReplacementAttachMarkerStore,
} from '../moderation/replacement-attach-marker.store';
import {
  WEBHOOK_PREPARATION_DEFER_DEFAULT_MS,
  WebhookPreparationDeferredError,
} from '../common/webhook-preparation-deferred.error';
import { buildPublisherBotDescriptor } from './publisher-bot-descriptor';
import { isChannelAutoPostMessage } from '../moderation/channel-auto-post-runtime';
import {
  PublisherChatCommentAdmissionError,
  PublisherChatCommentQueueService,
} from './publisher-chat-comment.queue';

export class PublisherChatCommentClaimPendingError extends WebhookPreparationDeferredError {
  constructor(cause?: unknown) {
    super(
      'Publisher chat-comment durable job is not confirmed yet',
      WEBHOOK_PREPARATION_DEFER_DEFAULT_MS,
      cause,
    );
    this.name = 'PublisherChatCommentClaimPendingError';
  }
}

@Injectable()
export class PublisherChatCommentProducerService {
  private readonly logger = new Logger(PublisherChatCommentProducerService.name);
  private readonly markerStore: ReplacementAttachMarkerStore;
  private readonly publisherBotId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PublisherChatCommentQueueService,
    configService: ConfigService,
    private readonly legacyHolds: WebhookLegacyHoldService,
  ) {
    this.markerStore = new ReplacementAttachMarkerStore(prisma);
    this.publisherBotId = buildPublisherBotDescriptor({
      id: configService.get<string>('MAX_PUBLISHER_BOT_ID'),
    }).id;
  }

  async observeWebhook(update: MaxUpdate): Promise<void> {
    if (
      update.botId?.trim() !== this.publisherBotId ||
      update.type.trim().toLowerCase() !== 'message_created'
    ) {
      return;
    }

    if (update.message?.entityType === 'channel') {
      await this.observeChannelPost(update);
      return;
    }

    const chatId = update.message?.chatId?.trim() ?? '';
    const messageId = update.message?.messageId?.trim() ?? '';
    const senderId = update.message?.senderId?.trim() ?? '';
    if (!chatId || !messageId || !senderId) {
      return;
    }

    // FLAG: Duplicate webhook repair reaches this producer without canonical preparation.
    // Automatic effects retain the original author scope; explicit publications are independent.
    if (
      (await this.legacyHolds.isMessageHeld(chatId, messageId)) ||
      (await this.legacyHolds.isMemberHeld(chatId, senderId)) ||
      (await this.legacyHolds.isGlobalUserHeld(senderId))
    )
      return;

    const sourceCreatedAt = new Date(update.message?.createdAt ?? '');

    const now = new Date();
    const entity = await this.prisma.chat.findFirst({
      where: {
        id: chatId,
        entityType: ChatEntityType.CHAT,
        OR: [
          { publicationPolicy: { is: null } },
          { publicationPolicy: { is: { publikEnabled: true } } },
        ],
        publisherBinding: {
          is: {
            publisherBotId: this.publisherBotId,
            status: ChatBotMembershipStatus.ACTIVE,
            botAccessState: {
              in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER],
            },

            OR: [{ sendRouteQuarantinedUntil: null }, { sendRouteQuarantinedUntil: { lte: now } }],
          },
        },
      },
      select: {
        publicationPolicy: {
          select: {
            publikEnabled: true,
            revision: true,
          },
        },
        publisherSettings: {
          select: {
            chatCommentsEnabled: true,
            chatCommentsAdminsEnabled: true,
            revision: true,
          },
        },
        accessEdges: {
          where: {
            botId: this.publisherBotId,
            userId: senderId,
            entityType: ChatEntityType.CHAT,
            // FLAG: Existing ADMIN/OWNER evidence remains valid until explicit revocation.
          },
          orderBy: { checkedAt: 'desc' },
          take: 1,
          select: { state: true, userRole: true },
        },
      },
    });
    if (
      !entity?.publisherSettings?.chatCommentsEnabled ||
      !entity.publisherSettings.chatCommentsAdminsEnabled
    ) {
      return;
    }
    const access = entity.accessEdges[0];
    if (
      !access ||
      access.state !== ManagedEntityAccessState.GRANTED ||
      (access.userRole !== ManagedEntityAccessRole.OWNER &&
        access.userRole !== ManagedEntityAccessRole.ADMIN)
    ) {
      return;
    }
    const publicationPolicyRevision = entity.publicationPolicy?.revision ?? 0;

    const claim = await this.markerStore.claimChatAutoComment({
      chatId,
      messageId,
      source: 'webhook',
      botId: this.publisherBotId,
      publisherSettingsRevision: entity.publisherSettings.revision,
      publicationPolicyRevision,
    });
    if (claim.status === 'in_progress') {
      try {
        const identity = await this.markerStore.readChatAutoCommentPendingJobIdentity({
          chatId,
          messageId,
        });
        if (
          identity &&
          (await this.queue.hasMatchingAttachJob({
            ...identity,
            chatId,
            messageId,
            senderId,
            dialogBotId: this.publisherBotId,
          }))
        ) {
          return;
        }
      } catch (error: unknown) {
        throw new PublisherChatCommentClaimPendingError(error);
      }
      throw new PublisherChatCommentClaimPendingError();
    }
    if (claim.status !== 'claimed') {
      return;
    }

    const markerId = claim.markerId?.trim() ?? '';
    if (!buildChatAutoCommentAuditId(markerId)) {
      await this.markerStore.releaseChatAutoComment({
        chatId,
        messageId,
        lockToken: claim.lockToken,
        source: 'webhook',
        botId: this.publisherBotId,
        lastError: 'Publisher chat-comment claim did not provide a valid marker id',
        lastStatusCode: null,
      });
      throw new Error('Publisher chat-comment claim did not provide a valid marker id');
    }

    try {
      await this.queue.enqueueAttach({
        markerId,
        lockToken: claim.lockToken,
        chatId,
        messageId,
        senderId,
        dialogBotId: this.publisherBotId,
        publisherSettingsRevision: entity.publisherSettings.revision,
        publicationPolicyRevision,
        ...(Number.isFinite(sourceCreatedAt.getTime()) ? { sourceCreatedAt } : {}),
      });
    } catch (error: unknown) {
      if (error instanceof PublisherChatCommentAdmissionError) {
        await this.markerStore.skipChatAutoCommentAfterPublisherAdmissionFailure({
          markerId,
          chatId,
          messageId,
          lockToken: claim.lockToken,
          botId: this.publisherBotId,
          reason: error.reason,
        });
        return;
      }
      this.logger.warn(
        { chatId, messageId, err: this.errorSummary(error) },
        'Deferred Publisher chat-comment until its durable job can be confirmed',
      );
      throw new WebhookPreparationDeferredError(
        'Publisher chat-comment durable enqueue is unavailable',
        WEBHOOK_PREPARATION_DEFER_DEFAULT_MS,
        error,
      );
    }
  }

  private async observeChannelPost(update: MaxUpdate): Promise<void> {
    if (!isChannelAutoPostMessage(update)) return;
    const chatId = update.message?.chatId?.trim();
    const messageId = update.message?.messageId?.trim();
    const createdAt = new Date(update.message?.createdAt ?? '');
    const now = new Date();
    if (
      !chatId ||
      !messageId ||
      !Number.isFinite(createdAt.getTime()) ||
      createdAt.getTime() < now.getTime() - 24 * 60 * 60_000 ||
      createdAt.getTime() > now.getTime() + 60_000
    )
      return;

    const entity = await this.prisma.chat.findFirst({
      where: {
        id: chatId,
        entityType: ChatEntityType.CHANNEL,
        publisherBinding: {
          is: { publisherBotId: this.publisherBotId, status: ChatBotMembershipStatus.ACTIVE },
        },
      },
      select: {
        publicationPolicy: { select: { publikEnabled: true, revision: true, updatedAt: true } },
        channelSettings: {
          select: {
            postSignatureEnabled: true,
            postSignaturePresentation: true,
            updatedAt: true,
            customPostButtonsEnabled: true,
            customPostButtonsSince: true,
          },
        },
        publisherSettings: {
          select: {
            channelCommentsEnabled: true,
            channelSuggestionsEnabled: true,
            revision: true,
            updatedAt: true,
          },
        },
      },
    });
    const settings = entity?.publisherSettings;
    const hasPostButton =
      entity?.channelSettings?.postSignatureEnabled === true &&
      entity.channelSettings.postSignaturePresentation ===
        ChannelPostSignaturePresentation.BUTTON &&
      createdAt >= entity.channelSettings.updatedAt;
    const hasCustomButtons = channelCustomButtonsEligible(
      entity?.channelSettings,
      createdAt.toISOString(),
    );
    if (
      entity?.publicationPolicy?.publikEnabled === false ||
      (!settings?.channelCommentsEnabled &&
        !settings?.channelSuggestionsEnabled &&
        !hasPostButton &&
        !hasCustomButtons) ||
      (settings && createdAt < settings.updatedAt) ||
      (entity?.publicationPolicy && createdAt < entity.publicationPolicy.updatedAt)
    )
      return;
    try {
      await this.queue.enqueueChannelAttach({
        chatId,
        messageId,
        publisherSettingsRevision: settings?.revision ?? 0,
        publicationPolicyRevision: entity?.publicationPolicy?.revision ?? 0,
        createdAt,
      });
    } catch (error: unknown) {
      if (error instanceof PublisherChatCommentAdmissionError) return;
      throw new WebhookPreparationDeferredError(
        'Publisher channel keyboard durable enqueue is unavailable',
        WEBHOOK_PREPARATION_DEFER_DEFAULT_MS,
        error,
      );
    }
  }

  private errorSummary(error: unknown): string {
    return (error instanceof Error ? error.message : String(error ?? 'Unknown error'))
      .trim()
      .slice(0, 500);
  }
}
