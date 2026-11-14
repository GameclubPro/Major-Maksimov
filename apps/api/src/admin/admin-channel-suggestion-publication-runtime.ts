import type { SuggestionReviewWrite } from '@maxim/contracts/publisher';
import {
  assertSuggestionPublicationLength,
  suggestionContentPatch,
  suggestionRevision,
  hasSuggestionRequest,
  suggestionRequestPatch,
  publicationEditorInput,
} from './suggestion-review-content';
import type { ChannelSettings } from '@maxim/contracts';
import type { SuggestionSubscriptionService } from '../suggestions/suggestion-subscription.service';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  type Logger,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';

import type { AuthUser } from '../common/decorators/current-user.decorator';
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import { buildChannelPostActionRows } from '../common/channel-post-actions';
import {
  MAX_API_SOURCE_TAGS,
  type MaxAttachmentPayload,
  type MaxClientService,
  type MaxMessageButton,
  type MaxSendMessageOptions,
  wasMaxMessageSendAttempted,
} from '../max/max-client.service';
import type { MaxRoutedPublicationService } from '../max/max-routed-publication.service';
import { isAmbiguousMaxSendError } from '../max/max-send-ambiguity.util';
import {
  ChannelSuggestionAdminDeliveryStatus,
  MaxActionLedgerStatus,
  Prisma,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  PublisherReadinessService,
  PublisherReadyRoute,
} from '../publisher/publisher-readiness.service';
import type { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import type { PublisherDispatchHealthService } from '../publisher/publisher-dispatch-health.service';
import {
  hasChannelSuggestionBotScopedMediaToken,
  resolveChannelSuggestionMediaPublicationBotId,
  type ChannelSuggestionPublicationBotAssignment,
} from './admin-channel-suggestion-media-route';
import {
  buildChannelSuggestionPublicationLedgerJobId,
  CHANNEL_SUGGESTION_PUBLICATION_CLAIM_STALE_MS,
  CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
  CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG,
  classifyChannelSuggestionPublicationRecovery,
  readChannelSuggestionPublicationClaimV1,
  withChannelSuggestionPublicationContextDigest,
  type ChannelSuggestionPublicationClaimV1,
  type ChannelSuggestionPublicationContextV1,
  type ChannelSuggestionPublicationLedgerRow,
} from './admin-channel-suggestion-publication-protocol';
import { buildPublishedChannelSuggestionMessagePayload } from './admin-channel-suggestion-presentation';
import type { AdminChannelSuggestionImageRuntime } from './admin-channel-suggestion-image-runtime';
import { resolveManagedBroadcastSendRetryDelayMs } from './admin-managed-broadcast-media';
import {
  ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
  CHANNEL_DIALOG_ACTION_AUTO_ATTACH,
  CHANNEL_DIALOG_ACTION_SUGGEST,
  type ChannelSuggestionActor,
  type ChannelSuggestionAuthorAttribution,
  type ChannelSuggestionImageAsset,
  type ChannelSuggestionReviewAction,
  type ChannelSuggestionTextMarkup,
} from './admin.service.support';
import type { BroadcastTextFormat } from '@maxim/contracts';
import type { PublisherSuggestionPublicationQueueService } from './publisher-suggestion-publication-queue.service';
import type {
  PublisherDialogContextService,
  PublisherPreparedDialogContext,
} from './publisher-dialog-context.service';

const CHANNEL_SUGGESTION_AMBIGUOUS_SEND_ERROR = Symbol('channelSuggestionAmbiguousSendError');
const PUBLISHER_SUGGESTION_DISPATCH_PROFILE = 'PUBLIK_V1';

class ChannelSuggestionRecoveryConflictError extends Error {}

export type ChannelSuggestionReviewResult = {
  status: 'reviewed' | 'already_reviewed' | 'review_in_progress';
  reviewStatus: 'published' | 'cancelled' | 'processing';
  publishedUrl: string | null;
};

type StoredSuggestionRow = {
  id: string;
  chatId: string;
  actorUserId: string;
  payload: Prisma.JsonValue;
};

type PreparedSuggestionPublication = {
  text: string;
  options: Pick<MaxSendMessageOptions, 'buttons' | 'imagePayload' | 'attachments' | 'textFormat'>;
  context: ChannelSuggestionPublicationContextV1;
};

type PublishedSuggestion = {
  messageId: string | null;
  url: string | null;
  threadId: string | null;
  includeCommentsButton: boolean;
  includeSuggestButton: boolean;
  suggestButtonText: string | null;
  suggestionEntryMode: ChannelSettings['postSuggestionsEntryMode'];
  botId: string | null;
  authorAttribution: ChannelSuggestionAuthorAttribution;
  publicationContext?: ChannelSuggestionPublicationContextV1;
};

type SuggestionButtonContext = {
  buttons: MaxMessageButton[][];
  threadId: string | null;
  includeCommentsButton: boolean;
  includeSuggestButton: boolean;
  includeCtaButton: boolean;
  suggestButtonText: string | null;
  suggestionEntryMode: ChannelSettings['postSuggestionsEntryMode'];
};

type PublisherSuggestionRoute = PublisherReadyRoute & {
  dialogBotId: string;
  dialogContext: PublisherPreparedDialogContext;
};

export type AdminChannelSuggestionPublicationRuntimeContext = {
  readonly suggestionSubscriptions?: SuggestionSubscriptionService;
  readonly logger: Logger;
  readonly prisma: PrismaService;
  readonly maxClient: MaxClientService;
  readonly maxRoutedPublicationService?: MaxRoutedPublicationService;
  readonly channelSuggestionImageRuntime: AdminChannelSuggestionImageRuntime;
  readonly publisherReadinessService?: PublisherReadinessService;
  readonly publisherRuntimeBoundaryService?: PublisherRuntimeBoundaryService;
  readonly publisherDispatchHealthService?: PublisherDispatchHealthService;
  readonly publisherSuggestionPublicationQueue?: PublisherSuggestionPublicationQueueService;
  readonly publisherDialogContextService?: PublisherDialogContextService;
  readonly channelPostSignatureService?: {
    preparePostText(
      chatId: string,
      input: { text: string; textFormat: MaxSendMessageOptions['textFormat'] },
      options: {
        entityType: 'channel';
        trafficClass: 'interactive';
        sourceTag: string;
      },
    ): Promise<{ text: string; textFormat?: MaxSendMessageOptions['textFormat'] }>;
    buildPostButton?(
      chatId: string,
      options: {
        entityType: 'channel';
        trafficClass: 'interactive';
        sourceTag: string;
      },
    ): Promise<MaxMessageButton | null>;
  };
  assertChatAdmin(chatId: string, userId: string, expectedType: 'channel'): Promise<unknown>;
  ensureEntityType(chatId: string, userId: string, expectedType: 'channel'): Promise<unknown>;
  resolveChannelSuggestionPublicationBotAssignment(
    chatId: string,
  ): Promise<ChannelSuggestionPublicationBotAssignment>;
  resolveDeliveryBotAssignment(chatId: string): Promise<string | undefined>;
  resolveChannelSuggestionAuthorAttribution(
    chatId: string,
    actor: ChannelSuggestionActor,
    options: { botId?: string; trafficClass: 'interactive' },
  ): Promise<ChannelSuggestionAuthorAttribution>;
  resolveChannelSuggestionAttachments(
    suggestion: {
      images?: ChannelSuggestionImageAsset[] | null;
      mediaType?: 'image' | 'video' | null;
      mediaPayload?: Record<string, unknown> | null;
      mediaMimeType?: string | null;
      mediaFileName?: string | null;
    },
    botId?: string,
  ): Promise<{
    imagePayload?: Record<string, unknown>;
    attachments?: MaxAttachmentPayload[];
  }>;
  getPublicChannelSettings(chatId: string): Promise<ChannelSettings>;
  buildChannelDialogButton(
    chatId: string,
    type: 'comments' | 'suggest',
    threadId: string,
    text: string,
    botId?: string | null,
    suggestionEntryMode?: ChannelSettings['postSuggestionsEntryMode'],
  ): MaxMessageButton;
  syncChannelSuggestionAdminReviewMessages(
    suggestionId: string,
    chatId: string,
    payload: Record<string, unknown>,
  ): Promise<number | void>;
  readObjectPayload(value: Prisma.JsonValue): Record<string, unknown>;
  readObjectPayloadOrNull(value: unknown): Record<string, unknown> | null;
  readLowerString(value: unknown): string | null;
  readTrimmedString(value: unknown): string | null;
  readRawString(value: unknown): string | null;
  readChannelSuggestionMediaType(value: unknown): 'image' | 'video' | null;
  readChannelSuggestionTextMarkup(value: unknown): ChannelSuggestionTextMarkup[];
  readStoredChannelSuggestionActor(
    actorUserId: string,
    payload: Record<string, unknown>,
  ): ChannelSuggestionActor;
  normalizeBroadcastTextFormat(value: string): BroadcastTextFormat;
  sleep(ms: number): Promise<void>;
};

export function createAdminChannelSuggestionPublicationRuntimeContext(
  dependencies: AdminChannelSuggestionPublicationRuntimeContext,
): AdminChannelSuggestionPublicationRuntimeContext {
  return dependencies;
}

export class AdminChannelSuggestionPublicationRuntime {
  constructor(private readonly context: AdminChannelSuggestionPublicationRuntimeContext) {}

  // FLAG: Card refresh may reconcile retained receipts, but can never start a new SEND.
  async reconcileReview(suggestionId: string, user: AuthUser): Promise<void> {
    const row = await this.context.prisma.auditLog.findFirst({
      where: { id: suggestionId, action: CHANNEL_DIALOG_ACTION_SUGGEST },
      select: { id: true, chatId: true, actorUserId: true, payload: true },
    });
    if (!row) throw new BadRequestException('Предложка не найдена.');
    await this.context.assertChatAdmin(row.chatId, user.userId, 'channel');
    const payload = this.context.readObjectPayload(row.payload);
    if (payload.type === 'suggest' && payload.reviewStatus === 'publishing') {
      await this.recoverClaimedPublication({ row, payload });
    }
  }

  async review(
    suggestionId: string,
    user: AuthUser,
    action: ChannelSuggestionReviewAction,
    editor?: SuggestionReviewWrite,
  ): Promise<ChannelSuggestionReviewResult> {
    const normalizedSuggestionId = suggestionId.trim();
    if (!normalizedSuggestionId) {
      throw new BadRequestException('Предложка не найдена.');
    }

    const row = await this.context.prisma.auditLog.findFirst({
      where: {
        id: normalizedSuggestionId,
        action: CHANNEL_DIALOG_ACTION_SUGGEST,
      },
      select: {
        id: true,
        chatId: true,
        actorUserId: true,
        payload: true,
      },
    });
    if (!row) {
      throw new BadRequestException('Предложка не найдена.');
    }

    await this.context.assertChatAdmin(row.chatId, user.userId, 'channel');
    await this.context.ensureEntityType(row.chatId, user.userId, 'channel');

    const payload = this.context.readObjectPayload(row.payload);
    if (this.context.readLowerString(payload.type) !== 'suggest') {
      throw new BadRequestException('Предложка не найдена.');
    }
    const currentReviewStatus = this.context.readLowerString(payload.reviewStatus);
    if (editor) {
      const same = hasSuggestionRequest(payload, 'publish', user.userId, editor);
      if (currentReviewStatus && currentReviewStatus !== 'pending' && !same)
        throw new ConflictException('По предложке уже принято другое решение. Обновите её.');
    }
    if (currentReviewStatus === 'published' || currentReviewStatus === 'cancelled') {
      await this.syncCommittedReviewMessages(row, payload);
      return {
        status: 'already_reviewed',
        reviewStatus: currentReviewStatus,
        publishedUrl: this.context.readTrimmedString(payload.publishedUrl),
      };
    }
    if (currentReviewStatus === 'publishing') {
      const recovered = await this.recoverClaimedPublication({ row, payload });
      if (recovered.kind === 'result') {
        return recovered.result;
      }
    }

    const payloadActorUserId = this.context.readTrimmedString(payload.actorUserId);
    const hasActorMismatch = Boolean(payloadActorUserId && payloadActorUserId !== row.actorUserId);
    if (hasActorMismatch) {
      this.context.logger.warn(
        {
          suggestionId: row.id,
          chatId: row.chatId,
          actorUserId: row.actorUserId,
          payloadActorUserId,
        },
        'Channel suggestion payload actor differs from audit actor; using audit actor',
      );
    }
    const payloadWithoutTransientClaim = this.stripTransientPublicationClaim(payload);
    const canonicalPayload: Record<string, unknown> = {
      ...payloadWithoutTransientClaim,
      ...(hasActorMismatch
        ? {
            authorDisplayName: null,
            authorMentionDisplayName: null,
            authorUsername: null,
            authorProfileUrl: null,
            authorAvatarUrl: null,
          }
        : {}),
      actorUserId: row.actorUserId,
    };

    const reviewerLabel = user.displayName?.trim() || user.username?.trim() || user.userId;
    if (action === 'cancel') {
      return this.cancelPendingSuggestion({
        row,
        payload: canonicalPayload,
        reviewerUserId: user.userId,
        reviewerLabel,
        clearAuthorAvatar: hasActorMismatch,
      });
    }

    const contentPatch = suggestionContentPatch(
      canonicalPayload,
      editor
        ? publicationEditorInput(canonicalPayload, user.userId, editor)
        : { expectedRevision: 0, requestId: '00000000-0000-4000-8000-000000000000' },
      user.userId,
    );
    Object.assign(canonicalPayload, contentPatch);
    assertSuggestionPublicationLength(row.actorUserId, canonicalPayload);
    const publisherRoute = await this.resolvePublisherSuggestionRoute(row.chatId, canonicalPayload);
    if (publisherRoute && !this.context.publisherSuggestionPublicationQueue) {
      throw new ServiceUnavailableException(
        'Очередь Публика временно недоступна. Попробуйте позже.',
      );
    }
    if (!publisherRoute && !this.context.maxRoutedPublicationService) {
      throw new ServiceUnavailableException(
        'Сервис безопасной публикации временно недоступен. Попробуйте позже.',
      );
    }

    await this.context.suggestionSubscriptions?.assertCanSubmit(
      row.chatId,
      row.actorUserId,
      'moderation',
    );
    const claim = await this.claimReview({
      suggestionId: row.id,
      userId: user.userId,
      userDisplayName: reviewerLabel,
      publisherRoute,
      expectedRevision: editor
        ? publicationEditorInput(payload, user.userId, editor).expectedRevision
        : 0,
      contentPatch: {
        ...contentPatch,
        ...(editor
          ? {
              reviewContentRequestId: editor.requestId,
              ...suggestionRequestPatch(
                payload,
                'publish',
                user.userId,
                editor,
                suggestionRevision(canonicalPayload),
              ),
            }
          : {}),
      },
    });
    if (!claim) {
      return this.readReviewResult(row.id, { requireClaim: true, editor, userId: user.userId });
    }

    if (publisherRoute) {
      await this.context.publisherSuggestionPublicationQueue!.enqueue(row.id, claim.claimToken);
      return this.processingResult();
    }

    let published: PublishedSuggestion;
    try {
      published = await this.publishClaimedSuggestion({
        row,
        claim,
        payload: canonicalPayload,
      });
    } catch (error: unknown) {
      // FLAG: The owning attempt has returned; release only after rechecking the exact SQL fence.
      const released = await this.releasePreDispatchPublication({
        suggestionId: row.id,
        chatId: row.chatId,
        actorUserId: row.actorUserId,
        claim,
        completedAttempt: true,
      }).catch(() => {
        this.context.logger.warn(
          { suggestionId: row.id },
          'Failed to reconcile suggestion claim after completed publication attempt',
        );
        return false;
      });
      this.context.logger.warn(
        {
          suggestionId: row.id,
          chatId: row.chatId,
          userId: user.userId,
          err: error instanceof Error ? error.message : String(error),
          released,
        },
        released
          ? 'Channel suggestion failed before dispatch; released the completed attempt for retry'
          : this.isAmbiguousSendError(error)
            ? 'Channel suggestion publish send failed ambiguously; keeping versioned review claim for manual verification'
            : 'Channel suggestion publish failed before finalization; keeping versioned review claim for bounded recovery',
      );
      throw error;
    }

    return this.completePublishedSuggestion({
      row,
      claim,
      canonicalPayload,
      published,
      clearAuthorAvatar: hasActorMismatch,
    });
  }

  async processPublisherSuggestionPublicationJob(
    suggestionId: string,
    expectedClaimToken: string,
  ): Promise<void> {
    const row = await this.context.prisma.auditLog.findFirst({
      where: { id: suggestionId.trim(), action: CHANNEL_DIALOG_ACTION_SUGGEST },
      select: { id: true, chatId: true, actorUserId: true, payload: true },
    });
    if (!row) {
      return;
    }
    const payload = this.context.readObjectPayload(row.payload);
    const claim = readChannelSuggestionPublicationClaimV1(payload, row.id);
    const publisherRoute = this.readPublisherSuggestionRoute(payload, row.chatId);
    if (!claim || claim.claimToken !== expectedClaimToken.trim() || !publisherRoute) {
      return;
    }
    if (!this.context.publisherRuntimeBoundaryService) {
      throw new ServiceUnavailableException('Runtime Публика временно недоступен.');
    }
    await this.context.publisherRuntimeBoundaryService.assertDispatchEnabled();
    const readyRoute = await this.requirePublisherReadiness().assertEntityReady(
      row.chatId,
      'suggestion_publish',
    );
    if (readyRoute.requiredBotId !== publisherRoute.requiredBotId) {
      throw new ServiceUnavailableException('Маршрут Публика изменился. Отправка остановлена.');
    }

    const canonicalPayload = this.stripTransientPublicationClaim(payload);
    const hasActorMismatch =
      Boolean(this.context.readTrimmedString(payload.actorUserId)) &&
      this.context.readTrimmedString(payload.actorUserId) !== row.actorUserId;
    const published = await this.publishClaimedSuggestion({
      row,
      claim,
      payload: canonicalPayload,
    });
    await this.completePublishedSuggestion({
      row,
      claim,
      canonicalPayload,
      published,
      clearAuthorAvatar: hasActorMismatch,
    });
  }

  private async completePublishedSuggestion(params: {
    row: StoredSuggestionRow;
    claim: ChannelSuggestionPublicationClaimV1;
    canonicalPayload: Record<string, unknown>;
    published: PublishedSuggestion;
    clearAuthorAvatar: boolean;
  }): Promise<ChannelSuggestionReviewResult> {
    if (!params.published.publicationContext) {
      throw new ServiceUnavailableException(
        'MAX подтвердил публикацию без сохраненного контекста. Требуется ручная проверка.',
      );
    }
    const updatedPayload = {
      ...params.canonicalPayload,
      authorDisplayName: params.published.authorAttribution.displayName,
      authorMentionDisplayName: params.published.authorAttribution.mentionDisplayName,
      authorUsername: params.published.authorAttribution.username,
      authorProfileUrl: params.published.authorAttribution.profileUrl,
      reviewStatus: 'published',
      reviewedAt: new Date().toISOString(),
      reviewedByUserId: params.claim.claimedByUserId,
      reviewedByDisplayName: params.claim.claimedByDisplayName ?? params.claim.claimedByUserId,
      publishedMessageId: params.published.messageId,
      publishedUrl: params.published.url,
      reviewPublicationProtocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
      reviewPublicationLedgerJobId: params.claim.ledgerJobId,
      reviewPublicationContext: params.published.publicationContext,
    } as Prisma.InputJsonValue;
    const persistedCount = await this.finalizePublication({
      suggestionId: params.row.id,
      chatId: params.row.chatId,
      claim: params.claim,
      context: params.published.publicationContext,
      messageId: params.published.messageId,
      url: params.published.url,
      clearAuthorAvatar: params.clearAuthorAvatar,
    });
    if (persistedCount === 0) {
      this.context.logger.warn(
        {
          suggestionId: params.row.id,
          chatId: params.row.chatId,
          publishedMessageId: params.published.messageId,
        },
        'Channel suggestion disappeared before review persistence',
      );
      return this.readReviewResult(params.row.id);
    }
    await this.syncCommittedReviewMessages(params.row, updatedPayload as Record<string, unknown>);
    return {
      status: 'reviewed',
      reviewStatus: 'published',
      publishedUrl: params.published.url,
    };
  }

  private async publishClaimedSuggestion(params: {
    row: StoredSuggestionRow;
    claim: ChannelSuggestionPublicationClaimV1;
    payload: Record<string, unknown>;
  }): Promise<PublishedSuggestion> {
    const publisherRoute = this.readPublisherSuggestionRoute(params.payload, params.row.chatId);
    if (publisherRoute) {
      const images = await this.context.channelSuggestionImageRuntime.loadStoredImages(
        params.row.id,
        params.payload,
      );
      return this.publishStoredSuggestion({
        suggestionId: params.row.id,
        claim: params.claim,
        chatId: params.row.chatId,
        actorUserId: params.row.actorUserId,
        payload: params.payload,
        images,
        resolvedBotId: publisherRoute.requiredBotId,
        publisherRoute,
      });
    }
    const assignment = await this.context.resolveChannelSuggestionPublicationBotAssignment(
      params.row.chatId,
    );
    const images = await this.context.channelSuggestionImageRuntime.loadStoredImages(
      params.row.id,
      params.payload,
    );
    const resolvedBotId = await resolveChannelSuggestionMediaPublicationBotId({
      payload: params.payload,
      images,
      assignment,
      loadSentDeliveryBotIds: async () =>
        (
          await this.context.prisma.channelSuggestionAdminDelivery.findMany({
            where: {
              auditLogId: params.row.id,
              status: ChannelSuggestionAdminDeliveryStatus.SENT,
            },
            select: { botId: true },
          })
        ).map(({ botId }) => botId),
      onUnavailable: (reason) =>
        this.context.logger.warn(
          { suggestionId: params.row.id, chatId: params.row.chatId, reason },
          'Channel suggestion media token route is unverified',
        ),
    });
    return this.publishStoredSuggestion({
      suggestionId: params.row.id,
      claim: params.claim,
      chatId: params.row.chatId,
      actorUserId: params.row.actorUserId,
      payload: params.payload,
      images,
      resolvedBotId,
      publisherRoute: null,
    });
  }

  private async resolvePublisherSuggestionRoute(
    _chatId: string,
    _payload: Record<string, unknown>,
  ): Promise<PublisherSuggestionRoute | null> {
    // New Major suggestions remain on the Major route. Publisher-owned suggestions use the
    // dedicated Publisher inbox/publication pipeline; persisted Publisher claims are still read
    // and completed by processPublisherSuggestionPublicationJob for compatibility.
    return null;
  }

  private readPublisherSuggestionRoute(
    payload: Record<string, unknown>,
    chatId: string,
  ): PublisherSuggestionRoute | null {
    if (payload.reviewDispatchProfile !== PUBLISHER_SUGGESTION_DISPATCH_PROFILE) {
      return null;
    }
    const requiredBotId = this.context.readTrimmedString(payload.reviewRequiredBotId);
    const dialogBotId = this.context.readTrimmedString(payload.reviewDialogBotId);
    const policyRevision = payload.reviewPolicyRevision;
    const dialogContext = this.requirePublisherDialogContexts().read(
      payload.reviewPublisherDialogContext,
      dialogBotId ?? '',
    );
    if (
      !requiredBotId ||
      !dialogBotId ||
      !dialogContext ||
      typeof policyRevision !== 'number' ||
      !Number.isInteger(policyRevision) ||
      policyRevision < 0
    ) {
      throw new ServiceUnavailableException('Сохранённый маршрут Публика повреждён.');
    }
    return {
      chatId,
      entityType: 'channel',
      requiredBotId,
      policyRevision,
      dialogBotId,
      dialogContext,
    };
  }

  private requirePublisherReadiness(): PublisherReadinessService {
    if (!this.context.publisherReadinessService) {
      throw new ServiceUnavailableException('Readiness Публика временно недоступен.');
    }
    return this.context.publisherReadinessService;
  }

  private requirePublisherDialogContexts(): PublisherDialogContextService {
    if (!this.context.publisherDialogContextService) {
      throw new ServiceUnavailableException('Контекст кнопок Публика временно недоступен.');
    }
    return this.context.publisherDialogContextService;
  }

  private stripTransientPublicationClaim(
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const canonical = { ...payload };
    delete canonical.reviewClaimedAt;
    delete canonical.reviewClaimedByUserId;
    delete canonical.reviewClaimedByDisplayName;
    delete canonical.reviewClaimToken;
    delete canonical.reviewAction;
    delete canonical.reviewPublicationProtocol;
    delete canonical.reviewPublicationLedgerJobId;
    delete canonical.reviewPublicationContext;
    return canonical;
  }

  private async cancelPendingSuggestion(params: {
    row: StoredSuggestionRow;
    payload: Record<string, unknown>;
    reviewerUserId: string;
    reviewerLabel: string;
    clearAuthorAvatar: boolean;
  }): Promise<ChannelSuggestionReviewResult> {
    const resolvedBotId = await this.context.resolveDeliveryBotAssignment(params.row.chatId);
    const authorAttribution = await this.context.resolveChannelSuggestionAuthorAttribution(
      params.row.chatId,
      this.context.readStoredChannelSuggestionActor(params.row.actorUserId, params.payload),
      { botId: resolvedBotId, trafficClass: 'interactive' },
    );
    const authorAvatarPatch = params.clearAuthorAvatar
      ? Prisma.sql` || jsonb_build_object('authorAvatarUrl', null)`
      : Prisma.empty;
    const persisted = await this.context.prisma.$executeRaw(Prisma.sql`
      UPDATE audit_logs
      SET payload = (
        payload::jsonb
        || jsonb_build_object(
          'actorUserId', ${params.row.actorUserId}::text,
          'authorDisplayName', ${authorAttribution.displayName}::text,
          'authorMentionDisplayName', ${authorAttribution.mentionDisplayName}::text,
          'authorUsername', ${authorAttribution.username}::text,
          'authorProfileUrl', ${authorAttribution.profileUrl}::text,
          'reviewStatus', 'cancelled',
          'reviewedAt', ${new Date().toISOString()}::text,
          'reviewedByUserId', ${params.reviewerUserId}::text,
          'reviewedByDisplayName', ${params.reviewerLabel}::text,
          'publishedMessageId', null,
          'publishedUrl', null
        )
        ${authorAvatarPatch}
      )
        - 'reviewClaimedAt'
        - 'reviewClaimedByUserId'
        - 'reviewClaimedByDisplayName'
        - 'reviewClaimToken'
        - 'reviewAction'
        - 'reviewPublicationProtocol'
        - 'reviewPublicationLedgerJobId'
        - 'reviewPublicationContext'
      WHERE id = ${params.row.id}::text
        AND action = ${CHANNEL_DIALOG_ACTION_SUGGEST}::text
        AND payload->>'type' = 'suggest'
        AND COALESCE(NULLIF(payload->>'reviewStatus', ''), 'pending') = 'pending'
    `);
    if (Number(persisted) !== 1) {
      return this.readReviewResult(params.row.id);
    }

    const updatedPayload: Record<string, unknown> = {
      ...params.payload,
      actorUserId: params.row.actorUserId,
      authorDisplayName: authorAttribution.displayName,
      authorMentionDisplayName: authorAttribution.mentionDisplayName,
      authorUsername: authorAttribution.username,
      authorProfileUrl: authorAttribution.profileUrl,
      ...(params.clearAuthorAvatar ? { authorAvatarUrl: null } : {}),
      reviewStatus: 'cancelled',
      reviewedByUserId: params.reviewerUserId,
      reviewedByDisplayName: params.reviewerLabel,
      publishedMessageId: null,
      publishedUrl: null,
    };
    await this.syncCommittedReviewMessages(params.row, updatedPayload);
    return {
      status: 'reviewed',
      reviewStatus: 'cancelled',
      publishedUrl: null,
    };
  }

  private async claimReview(params: {
    suggestionId: string;
    userId: string;
    userDisplayName: string;
    publisherRoute: PublisherSuggestionRoute | null;
    expectedRevision?: number;
    contentPatch?: Record<string, unknown>;
  }): Promise<ChannelSuggestionPublicationClaimV1 | null> {
    const claimedAt = new Date().toISOString();
    const claimToken = randomUUID();
    const ledgerJobId = buildChannelSuggestionPublicationLedgerJobId(params.suggestionId);
    const updated = await this.context.prisma.$executeRaw(Prisma.sql`
      UPDATE audit_logs
      SET payload = payload::jsonb || ${JSON.stringify(params.contentPatch ?? {})}::jsonb || jsonb_strip_nulls(jsonb_build_object(
        'reviewStatus', 'publishing',
        'reviewClaimedAt', ${claimedAt}::text,
        'reviewClaimedByUserId', ${params.userId}::text,
        'reviewClaimedByDisplayName', ${params.userDisplayName}::text,
        'reviewClaimToken', ${claimToken}::text,
        'reviewAction', 'publish',
        'reviewPublicationProtocol', ${CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1}::text,
        'reviewPublicationLedgerJobId', ${ledgerJobId}::text,
        'reviewDispatchProfile', ${params.publisherRoute ? PUBLISHER_SUGGESTION_DISPATCH_PROFILE : null}::text,
        'reviewRequiredBotId', ${params.publisherRoute?.requiredBotId ?? null}::text,
        'reviewPolicyRevision', ${params.publisherRoute?.policyRevision ?? null}::integer,
        'reviewDialogBotId', ${params.publisherRoute?.dialogBotId ?? null}::text,
        'reviewPublisherDialogContext', ${params.publisherRoute ? JSON.stringify(params.publisherRoute.dialogContext) : null}::jsonb
      ))
      WHERE id = ${params.suggestionId}::text
        AND action = ${CHANNEL_DIALOG_ACTION_SUGGEST}::text
        AND payload->>'type' = 'suggest'
        AND COALESCE(NULLIF(payload->>'reviewStatus', ''), 'pending') = 'pending'
        AND COALESCE((payload->>'reviewContentRevision')::integer, 0) = ${params.expectedRevision ?? 0}
    `);
    if (Number(updated) === 0) {
      return null;
    }
    return {
      protocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
      ledgerJobId,
      claimToken,
      claimedAt,
      claimedByUserId: params.userId,
      claimedByDisplayName: params.userDisplayName,
    };
  }

  private async recoverClaimedPublication(params: {
    row: StoredSuggestionRow;
    payload: Record<string, unknown>;
  }): Promise<{ kind: 'released' } | { kind: 'result'; result: ChannelSuggestionReviewResult }> {
    const claim = readChannelSuggestionPublicationClaimV1(params.payload, params.row.id);
    const ledger = claim ? await this.readPublicationLedger(claim.ledgerJobId) : null;
    const decision = classifyChannelSuggestionPublicationRecovery({
      payload: params.payload,
      suggestionId: params.row.id,
      chatId: params.row.chatId,
      actorUserId: params.row.actorUserId,
      ledger,
    });

    if (decision.kind === 'waiting') {
      return { kind: 'result', result: this.processingResult() };
    }
    if (decision.kind === 'manual') {
      this.context.logger.warn(
        {
          suggestionId: params.row.id,
          chatId: params.row.chatId,
          recoveryReason: decision.reason,
          ledgerJobId: claim?.ledgerJobId ?? null,
        },
        'Channel suggestion publishing claim requires manual verification',
      );
      throw new BadRequestException(
        'Результат публикации предложки требует проверки. Проверьте канал и обратитесь в поддержку. Повторная отправка отключена, чтобы не создать дубль.',
      );
    }
    if (decision.kind === 'release_pre_dispatch') {
      const released = await this.releasePreDispatchPublication({
        suggestionId: params.row.id,
        chatId: params.row.chatId,
        actorUserId: params.row.actorUserId,
        claim: decision.claim,
      });
      return released
        ? { kind: 'released' }
        : { kind: 'result', result: await this.readReviewResult(params.row.id) };
    }

    const publishedUrl = await this.resolveRecoveredPublicationUrl({
      suggestionId: params.row.id,
      chatId: params.row.chatId,
      messageId: decision.ledger.remoteMessageId,
      botId: decision.ledger.dispatchBotId,
    });
    const persisted = await this.finalizePublication({
      suggestionId: params.row.id,
      chatId: params.row.chatId,
      claim: decision.claim,
      context: decision.context,
      messageId: decision.ledger.remoteMessageId,
      url: publishedUrl,
      clearAuthorAvatar: Boolean(
        this.context.readTrimmedString(params.payload.actorUserId) &&
        this.context.readTrimmedString(params.payload.actorUserId) !== params.row.actorUserId,
      ),
    });
    if (persisted === 0) {
      return { kind: 'result', result: await this.readReviewResult(params.row.id) };
    }

    const updatedPayload: Record<string, unknown> = {
      ...params.payload,
      actorUserId: decision.context.authorAttribution.userId,
      authorDisplayName: decision.context.authorAttribution.displayName,
      authorMentionDisplayName: decision.context.authorAttribution.mentionDisplayName,
      authorUsername: decision.context.authorAttribution.username,
      authorProfileUrl: decision.context.authorAttribution.profileUrl,
      reviewStatus: 'published',
      reviewedByUserId: decision.claim.claimedByUserId,
      reviewedByDisplayName: decision.claim.claimedByDisplayName ?? decision.claim.claimedByUserId,
      publishedMessageId: decision.ledger.remoteMessageId,
      publishedUrl,
      reviewPublicationContext: decision.context,
    };
    await this.syncCommittedReviewMessages(params.row, updatedPayload);
    return {
      kind: 'result',
      result: {
        status: 'reviewed',
        reviewStatus: 'published',
        publishedUrl,
      },
    };
  }

  private async readPublicationLedger(
    ledgerJobId: string,
  ): Promise<ChannelSuggestionPublicationLedgerRow | null> {
    return this.context.prisma.maxActionLedgerEntry.findUnique({
      where: { jobId: ledgerJobId },
      select: {
        jobId: true,
        actionType: true,
        chatId: true,
        sourceTag: true,
        status: true,
        ambiguous: true,
        terminal: true,
        dispatchToken: true,
        dispatchStartedAt: true,
        dispatchBotId: true,
        remoteMessageId: true,
        metadata: true,
      },
    });
  }

  // FLAG: Release only an ended owner attempt or stale claim with no context/dispatch/receipt fence.
  private async releasePreDispatchPublication(params: {
    suggestionId: string;
    chatId: string;
    actorUserId: string;
    claim: ChannelSuggestionPublicationClaimV1;
    completedAttempt?: boolean;
  }): Promise<boolean> {
    const staleBefore = new Date(
      Date.now() - CHANNEL_SUGGESTION_PUBLICATION_CLAIM_STALE_MS,
    ).toISOString();

    try {
      return await this.context.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<
          Array<{ id: string; actorUserId: string; payload: Prisma.JsonValue }>
        >(
          Prisma.sql`
          SELECT audit.id, audit.actor_user_id AS "actorUserId", audit.payload
          FROM audit_logs audit
          WHERE audit.id = ${params.suggestionId}::text
            AND audit.action = ${CHANNEL_DIALOG_ACTION_SUGGEST}::text
            AND audit.payload->>'type' = 'suggest'
            AND audit.payload->>'reviewStatus' = 'publishing'
            AND audit.payload->>'reviewAction' = 'publish'
            AND audit.payload->>'reviewPublicationProtocol' = ${CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1}::text
            AND audit.payload->>'reviewPublicationLedgerJobId' = ${params.claim.ledgerJobId}::text
            AND audit.payload->>'reviewClaimToken' = ${params.claim.claimToken}::text
            AND audit.payload->>'reviewClaimedAt' = ${params.claim.claimedAt}::text
            ${params.completedAttempt ? Prisma.empty : Prisma.sql`AND audit.payload->>'reviewClaimedAt' <= ${staleBefore}::text`}
          FOR UPDATE OF audit
        `,
        );
        const lockedPayload = locked[0] ? this.context.readObjectPayload(locked[0].payload) : null;
        if (!lockedPayload) {
          return false;
        }

        const ledger = await tx.maxActionLedgerEntry.findUnique({
          where: { jobId: params.claim.ledgerJobId },
          select: {
            jobId: true,
            actionType: true,
            chatId: true,
            sourceTag: true,
            status: true,
            ambiguous: true,
            terminal: true,
            dispatchToken: true,
            dispatchStartedAt: true,
            dispatchBotId: true,
            remoteMessageId: true,
            metadata: true,
          },
        });
        const lockedDecision = classifyChannelSuggestionPublicationRecovery({
          payload: lockedPayload,
          suggestionId: params.suggestionId,
          chatId: params.chatId,
          actorUserId: locked[0]?.actorUserId ?? params.actorUserId,
          ledger,
          ...(params.completedAttempt
            ? { completedAttemptClaimToken: params.claim.claimToken }
            : {}),
        });
        if (lockedDecision.kind !== 'release_pre_dispatch') {
          return false;
        }

        if (ledger) {
          const deleted = await tx.maxActionLedgerEntry.deleteMany({
            where: {
              jobId: params.claim.ledgerJobId,
              actionType: 'SEND_MESSAGE',
              chatId: params.chatId,
              sourceTag: CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG,
              status: {
                in: [
                  MaxActionLedgerStatus.ENQUEUED,
                  MaxActionLedgerStatus.IN_PROGRESS,
                  MaxActionLedgerStatus.FAILED_RETRYABLE,
                  MaxActionLedgerStatus.FAILED_TERMINAL,
                ],
              },
              ambiguous: false,
              dispatchToken: null,
              dispatchStartedAt: null,
              dispatchBotId: null,
              remoteMessageId: null,
            },
          });
          if (deleted.count !== 1) {
            return false;
          }
        }

        const released = await tx.$executeRaw(Prisma.sql`
        UPDATE audit_logs
        SET payload = (
          payload::jsonb
          || jsonb_build_object(
            'reviewStatus', 'pending',
            'reviewClaimReleasedAt', ${new Date().toISOString()}::text,
            'reviewLastError', 'stale versioned pre-dispatch claim recovered'
          )
        )
          - 'reviewClaimedAt'
          - 'reviewClaimedByUserId'
          - 'reviewClaimedByDisplayName'
          - 'reviewClaimToken'
          - 'reviewAction'
          - 'reviewPublicationProtocol'
          - 'reviewPublicationLedgerJobId'
          - 'reviewPublicationContext'
        WHERE id = ${params.suggestionId}::text
          AND actor_user_id = ${params.actorUserId}::text
          AND action = ${CHANNEL_DIALOG_ACTION_SUGGEST}::text
          AND payload->>'reviewStatus' = 'publishing'
          AND payload->>'reviewAction' = 'publish'
          AND payload->>'reviewPublicationProtocol' = ${CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1}::text
          AND payload->>'reviewPublicationLedgerJobId' = ${params.claim.ledgerJobId}::text
          AND payload->>'reviewClaimToken' = ${params.claim.claimToken}::text
      `);
        if (Number(released) !== 1) {
          throw new ChannelSuggestionRecoveryConflictError(
            'Channel suggestion claim changed during stale recovery',
          );
        }
        return true;
      });
    } catch (error: unknown) {
      if (error instanceof ChannelSuggestionRecoveryConflictError) {
        return false;
      }
      throw error;
    }
  }

  private async finalizePublication(params: {
    suggestionId: string;
    chatId: string;
    claim: ChannelSuggestionPublicationClaimV1;
    context: ChannelSuggestionPublicationContextV1;
    messageId: string | null;
    url: string | null;
    clearAuthorAvatar: boolean;
  }): Promise<number> {
    const messageId = this.context.readTrimmedString(params.messageId);
    if (!messageId || params.context.botId.trim().length === 0) {
      throw new ServiceUnavailableException(
        'MAX подтвердил публикацию без полного контекста. Требуется ручная проверка.',
      );
    }
    const reviewerDisplayName = params.claim.claimedByDisplayName ?? params.claim.claimedByUserId;
    const contextJson = JSON.stringify(params.context);
    const authorAvatarPatch = params.clearAuthorAvatar
      ? Prisma.sql` || jsonb_build_object('authorAvatarUrl', null)`
      : Prisma.empty;
    return this.context.prisma.$transaction(async (tx) => {
      const persisted = await tx.$executeRaw(Prisma.sql`
        UPDATE audit_logs
        SET payload = (
          payload::jsonb
          || jsonb_build_object(
            'actorUserId', ${params.context.authorAttribution.userId}::text,
            'authorDisplayName', ${params.context.authorAttribution.displayName}::text,
            'authorMentionDisplayName', ${params.context.authorAttribution.mentionDisplayName}::text,
            'authorUsername', ${params.context.authorAttribution.username}::text,
            'authorProfileUrl', ${params.context.authorAttribution.profileUrl}::text,
            'reviewStatus', 'published',
            'reviewedAt', ${new Date().toISOString()}::text,
            'reviewedByUserId', ${params.claim.claimedByUserId}::text,
            'reviewedByDisplayName', ${reviewerDisplayName}::text,
            'publishedMessageId', ${messageId}::text,
            'publishedUrl', ${params.url}::text,
            'reviewPublicationProtocol', ${CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1}::text,
            'reviewPublicationLedgerJobId', ${params.claim.ledgerJobId}::text,
            'reviewPublicationContext', ${contextJson}::jsonb
          )
          ${authorAvatarPatch}
        )
          - 'reviewClaimedAt'
          - 'reviewClaimedByUserId'
          - 'reviewClaimedByDisplayName'
          - 'reviewClaimToken'
          - 'reviewAction'
        WHERE id = ${params.suggestionId}::text
          AND actor_user_id = ${params.context.authorAttribution.userId}::text
          AND action = ${CHANNEL_DIALOG_ACTION_SUGGEST}::text
          AND payload->>'type' = 'suggest'
          AND payload->>'reviewStatus' = 'publishing'
          AND payload->>'reviewAction' = 'publish'
          AND payload->>'reviewPublicationProtocol' = ${CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1}::text
          AND payload->>'reviewPublicationLedgerJobId' = ${params.claim.ledgerJobId}::text
          AND payload->>'reviewClaimToken' = ${params.claim.claimToken}::text
          AND payload->'reviewPublicationContext'->>'protocol' = ${CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1}::text
          AND payload->'reviewPublicationContext'->>'botId' = ${params.context.botId}::text
          AND payload->'reviewPublicationContext'->>'messageDigest' = ${params.context.messageDigest}::text
          AND payload->'reviewPublicationContext'->>'contextDigest' = ${params.context.contextDigest}::text
          AND EXISTS (
            SELECT 1
            FROM max_action_ledger ledger
            WHERE ledger.job_id = ${params.claim.ledgerJobId}::text
              AND ledger.action_type = 'SEND_MESSAGE'
              AND ledger.chat_id = ${params.chatId}::text
              AND ledger.source_tag = ${CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG}::text
              AND ledger.dispatch_bot_id = ${params.context.botId}::text
              AND ledger.remote_message_id = ${messageId}::text
              AND ledger.metadata->'ledgerContext'->>'suggestionId' = ${params.suggestionId}::text
              AND ledger.metadata->'ledgerContext'->>'publicationProtocol' = ${CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1}::text
              AND ledger.metadata->'ledgerContext'->>'claimToken' = ${params.claim.claimToken}::text
              AND ledger.metadata->'ledgerContext'->>'actorUserId' = ${params.context.authorAttribution.userId}::text
              AND ledger.metadata->'ledgerContext'->>'messageDigest' = ${params.context.messageDigest}::text
              AND ledger.metadata->'ledgerContext'->>'contextDigest' = ${params.context.contextDigest}::text
          )
      `);
      if (Number(persisted) !== 1) {
        return 0;
      }
      await this.context.suggestionSubscriptions?.track(
        {
          id: params.suggestionId,
          chatId: params.chatId,
          authorUserId: params.context.authorAttribution.userId,
          profile: 'moderation',
          botId: params.context.botId,
          messageId,
        },
        tx,
      );
      await this.createAutoAttach({
        prisma: tx,
        chatId: params.chatId,
        reviewerUserId: params.claim.claimedByUserId,
        messageId,
        publishedUrl: params.url,
        context: params.context,
        persistedBotId: params.context.botId,
      });
      return 1;
    });
  }

  private async resolveRecoveredPublicationUrl(params: {
    suggestionId: string;
    chatId: string;
    messageId: string;
    botId: string;
  }): Promise<string | null> {
    try {
      return await this.context.maxClient.resolveMessageLink(params.messageId, {
        botId: params.botId,
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
        ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
      });
    } catch (error: unknown) {
      this.context.logger.warn(
        {
          suggestionId: params.suggestionId,
          chatId: params.chatId,
          messageId: params.messageId,
          botId: params.botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve a recovered channel suggestion publication URL',
      );
      return null;
    }
  }

  private async createAutoAttach(params: {
    prisma: Pick<PrismaService, 'auditLog'>;
    chatId: string;
    reviewerUserId: string;
    messageId: string;
    publishedUrl: string | null;
    context: ChannelSuggestionPublicationContextV1;
    persistedBotId: string | null;
  }): Promise<void> {
    if (
      !params.context.threadId ||
      (!params.context.includeCommentsButton && !params.context.includeSuggestButton)
    ) {
      return;
    }
    await params.prisma.auditLog.create({
      data: {
        chatId: params.chatId,
        actorUserId: params.reviewerUserId,
        action: CHANNEL_DIALOG_ACTION_AUTO_ATTACH,
        payload: {
          messageId: params.messageId,
          threadId: params.context.threadId,
          includeCommentsButton: params.context.includeCommentsButton,
          includeSuggestButton: params.context.includeSuggestButton,
          suggestionEntryMode: params.context.suggestionEntryMode,
          source: 'suggestion_review',
          ...(params.publishedUrl ? { publishedUrl: params.publishedUrl } : {}),
          ...(params.persistedBotId ? { botId: params.persistedBotId } : {}),
          ...(params.context.dialogBotId ? { dialogBotId: params.context.dialogBotId } : {}),
          ...(params.context.suggestButtonText
            ? { suggestButtonText: params.context.suggestButtonText }
            : {}),
          buttonRows: params.context.buttons,
          commentsButton: params.context.includeCommentsButton
            ? { rowIndex: 0, columnIndex: 0, baseText: '💬 Комментарии' }
            : null,
        },
      },
    });
  }

  private async readReviewResult(
    suggestionId: string,
    options?: { requireClaim: boolean; editor?: SuggestionReviewWrite; userId: string },
  ): Promise<ChannelSuggestionReviewResult> {
    const latest = await this.context.prisma.auditLog.findFirst({
      where: { id: suggestionId, action: CHANNEL_DIALOG_ACTION_SUGGEST },
      select: { payload: true },
    });
    if (!latest) {
      throw new BadRequestException('Предложка не найдена.');
    }
    const payload = this.context.readObjectPayload(latest.payload);
    const reviewStatus = this.context.readLowerString(payload.reviewStatus);
    if (
      options?.requireClaim &&
      (!reviewStatus ||
        reviewStatus === 'pending' ||
        (options.editor &&
          !hasSuggestionRequest(payload, 'publish', options.userId, options.editor)))
    )
      throw new ConflictException('Предложку уже изменили. Обновите её перед решением.');
    if (reviewStatus === 'published' || reviewStatus === 'cancelled') {
      return {
        status: 'already_reviewed',
        reviewStatus,
        publishedUrl: this.context.readTrimmedString(payload.publishedUrl),
      };
    }
    return this.processingResult();
  }

  private processingResult(): ChannelSuggestionReviewResult {
    return {
      status: 'review_in_progress',
      reviewStatus: 'processing',
      publishedUrl: null,
    };
  }

  private async syncCommittedReviewMessages(
    row: StoredSuggestionRow,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.context.syncChannelSuggestionAdminReviewMessages(row.id, row.chatId, payload);
    } catch {
      this.context.logger.warn(
        { suggestionId: row.id },
        'Suggestion review is committed; admin card synchronization will retry on the next review',
      );
    }
  }

  private async publishStoredSuggestion(params: {
    suggestionId: string;
    claim: ChannelSuggestionPublicationClaimV1;
    chatId: string;
    actorUserId: string;
    payload: Record<string, unknown>;
    images: ChannelSuggestionImageAsset[];
    resolvedBotId: string | undefined;
    publisherRoute: PublisherSuggestionRoute | null;
  }): Promise<PublishedSuggestion> {
    const tokenScopedMedia = hasChannelSuggestionBotScopedMediaToken(params.payload, params.images);
    const preparedByBotId = new Map<string, PreparedSuggestionPublication>();
    const routedPublicationService = this.context.maxRoutedPublicationService;
    if (!routedPublicationService) {
      throw new ServiceUnavailableException(
        'Сервис безопасной публикации временно недоступен. Попробуйте позже.',
      );
    }
    let lastPrepared: PreparedSuggestionPublication | undefined;
    let publisherAttemptedAt: Date | null = null;
    let attempt = 1;
    for (;;) {
      try {
        const published = await routedPublicationService.publish({
          entityId: params.chatId,
          logicalIdempotencyKey: params.claim.ledgerJobId,
          text: this.context.readRawString(params.payload.text) ?? '',
          trafficClass: 'interactive',
          actionHealthLane: 'interactive',
          sourceTag: CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG,
          timeoutMs: 10_000,
          ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
          ...(params.resolvedBotId ? { preferredBotId: params.resolvedBotId } : {}),
          ...(params.publisherRoute
            ? { publisherExactBotId: params.publisherRoute.requiredBotId }
            : {}),
          ...((params.publisherRoute || tokenScopedMedia) && params.resolvedBotId
            ? { requiredBotId: params.resolvedBotId }
            : {}),
          prepareAttempt: async ({ botId }) => {
            const prepared = await this.preparePublication({
              chatId: params.chatId,
              actorUserId: params.actorUserId,
              payload: params.payload,
              images: params.images,
              botId,
              dialogBotId: params.publisherRoute?.dialogBotId ?? botId,
              preparedButtonContext: params.publisherRoute
                ? this.adaptPublisherDialogContext(params.publisherRoute.dialogContext)
                : undefined,
            });
            preparedByBotId.set(botId, prepared);
            lastPrepared = prepared;
            return {
              text: prepared.text,
              options: {
                ...prepared.options,
                marketplacePublication: { purpose: 'APPROVED_SUGGESTION', entityId: params.chatId },
              },
              ledgerContext: {
                suggestionId: params.suggestionId,
                publicationProtocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
                claimToken: params.claim.claimToken,
                actorUserId: params.actorUserId,
                messageDigest: prepared.context.messageDigest,
                contextDigest: prepared.context.contextDigest,
              },
            };
          },
          onDispatchAttempt: ({ botId }) => {
            if (params.publisherRoute && botId === params.publisherRoute.requiredBotId) {
              publisherAttemptedAt = new Date();
            }
          },
          beforeSendMutation: async ({ botId }) => {
            const prepared = preparedByBotId.get(botId);
            if (!prepared || prepared.context.botId !== botId) {
              throw new ServiceUnavailableException(
                'Контекст предложки изменился перед публикацией. Повторите позже.',
              );
            }
            await this.context.assertChatAdmin(
              params.chatId,
              params.claim.claimedByUserId,
              'channel',
            );
            if (params.publisherRoute) {
              if (!this.context.publisherRuntimeBoundaryService) {
                throw new ServiceUnavailableException('Runtime Публика временно недоступен.');
              }
              await this.context.publisherRuntimeBoundaryService.assertDispatchEnabled();
              if (!this.context.publisherDispatchHealthService) {
                throw new ServiceUnavailableException('Health guard Публика недоступен.');
              }
              await this.context.publisherDispatchHealthService.assertDispatchAllowed();
              const readyRoute = await this.requirePublisherReadiness().assertEntityReady(
                params.chatId,
                'suggestion_publish',
              );
              if (
                botId !== params.publisherRoute.requiredBotId ||
                readyRoute.requiredBotId !== params.publisherRoute.requiredBotId
              ) {
                throw new ServiceUnavailableException('Маршрут Публика изменился перед отправкой.');
              }
            }
            await this.persistPublicationContext({
              suggestionId: params.suggestionId,
              chatId: params.chatId,
              claim: params.claim,
              context: prepared.context,
            });
          },
        });
        const prepared = preparedByBotId.get(published.botId);
        if (!prepared) {
          throw new ServiceUnavailableException(
            'MAX подтвердил публикацию без сохраненного контекста. Требуется ручная проверка.',
          );
        }
        if (params.publisherRoute && publisherAttemptedAt) {
          await this.context.publisherDispatchHealthService?.recordSendSuccess(
            params.chatId,
            publisherAttemptedAt,
          );
        }
        return {
          messageId: published.messageId,
          url: published.url,
          threadId: prepared.context.threadId,
          includeCommentsButton: prepared.context.includeCommentsButton,
          includeSuggestButton: prepared.context.includeSuggestButton,
          suggestButtonText: prepared.context.suggestButtonText,
          suggestionEntryMode: prepared.context.suggestionEntryMode,
          botId: published.botId,
          authorAttribution: prepared.context.authorAttribution,
          publicationContext: prepared.context,
        };
      } catch (error: unknown) {
        if (params.publisherRoute) {
          await this.context.publisherDispatchHealthService?.recordSendFailure(
            params.chatId,
            error,
            publisherAttemptedAt ?? new Date(),
          );
        }
        if (wasMaxMessageSendAttempted(error) || isAmbiguousMaxSendError(error)) {
          this.markAmbiguousSendError(error);
          throw error;
        }
        const delayMs = resolveManagedBroadcastSendRetryDelayMs(
          error,
          attempt,
          lastPrepared?.options,
        );
        if (delayMs === null) {
          throw error;
        }
        await this.context.sleep(delayMs);
        attempt += 1;
      }
    }
  }

  private async preparePublication(params: {
    chatId: string;
    actorUserId: string;
    payload: Record<string, unknown>;
    images: ChannelSuggestionImageAsset[];
    botId?: string;
    dialogBotId?: string;
    preparedButtonContext?: SuggestionButtonContext;
  }): Promise<PreparedSuggestionPublication> {
    const botId = params.botId?.trim();
    if (!botId) {
      throw new ServiceUnavailableException(
        'Не найден исполняемый бот для безопасной публикации предложки.',
      );
    }
    const text = this.context.readRawString(params.payload.text) ?? '';
    const authorAttribution = await this.context.resolveChannelSuggestionAuthorAttribution(
      params.chatId,
      this.context.readStoredChannelSuggestionActor(params.actorUserId, params.payload),
      { botId, trafficClass: 'interactive' },
    );
    if (authorAttribution.userId !== params.actorUserId) {
      throw new ServiceUnavailableException(
        'Автор предложки изменился перед публикацией. Публикация остановлена.',
      );
    }
    const media = await this.context.resolveChannelSuggestionAttachments(
      {
        images: params.images,
        mediaType: this.context.readChannelSuggestionMediaType(params.payload.mediaType),
        mediaPayload: this.context.readObjectPayloadOrNull(params.payload.mediaPayload),
        mediaMimeType: this.context.readTrimmedString(params.payload.mediaMimeType),
        mediaFileName: this.context.readTrimmedString(params.payload.mediaFileName),
      },
      botId,
    );
    const dialogBotId = params.dialogBotId?.trim() || botId;
    const buttonContext =
      params.preparedButtonContext ??
      (await this.buildButtonContext(params.chatId, params.payload, dialogBotId));
    const textFormat = this.context.normalizeBroadcastTextFormat(
      this.context.readTrimmedString(params.payload.textFormat) ?? 'plain',
    );
    const messageTextPayload = buildPublishedChannelSuggestionMessagePayload(
      authorAttribution,
      text,
      textFormat,
      this.context.readChannelSuggestionTextMarkup(params.payload.textMarkup),
    );
    if (!text.trim() && !media.imagePayload && !media.attachments?.length) {
      throw new BadRequestException('В предложке нет текста или медиа для публикации.');
    }

    const preparedMessageText = this.context.channelPostSignatureService
      ? await this.context.channelPostSignatureService.preparePostText(
          params.chatId,
          {
            text: messageTextPayload.text,
            textFormat: messageTextPayload.textFormat,
          },
          {
            entityType: 'channel',
            trafficClass: 'interactive',
            sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
          },
        )
      : messageTextPayload;
    const options: PreparedSuggestionPublication['options'] = {
      ...(buttonContext.buttons.length > 0 ? { buttons: buttonContext.buttons } : {}),
      ...(media.imagePayload ? { imagePayload: media.imagePayload } : {}),
      ...(media.attachments?.length ? { attachments: media.attachments } : {}),
      ...(preparedMessageText.textFormat ? { textFormat: preparedMessageText.textFormat } : {}),
    };
    const messageDigest = createHash('sha256')
      .update(JSON.stringify({ text: preparedMessageText.text, options }))
      .digest('hex');
    return {
      text: preparedMessageText.text,
      options,
      context: withChannelSuggestionPublicationContextDigest({
        protocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
        preparedAt: new Date().toISOString(),
        messageDigest,
        botId,
        ...(dialogBotId !== botId ? { dialogBotId } : {}),
        threadId: buttonContext.threadId,
        buttons: buttonContext.buttons,
        includeCommentsButton: buttonContext.includeCommentsButton,
        includeSuggestButton: buttonContext.includeSuggestButton,
        ...(buttonContext.includeCtaButton ? { includeCtaButton: true } : {}),
        suggestButtonText: buttonContext.suggestButtonText,
        suggestionEntryMode: buttonContext.suggestionEntryMode,
        authorAttribution,
      }),
    };
  }

  private async buildButtonContext(
    chatId: string,
    _payload: Record<string, unknown>,
    botId?: string | null,
  ): Promise<SuggestionButtonContext> {
    const settings = await this.context.getPublicChannelSettings(chatId);
    const includeCommentsButton = settings.commentsEnabled;
    const includeSuggestButton = settings.postSuggestionsEnabled;
    const ctaButton =
      (await this.context.channelPostSignatureService?.buildPostButton?.(chatId, {
        entityType: 'channel',
        trafficClass: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
      })) ?? null;
    const includeCtaButton = ctaButton !== null;
    if (!includeCommentsButton && !includeSuggestButton && !includeCtaButton) {
      return {
        buttons: [],
        threadId: null,
        includeCommentsButton,
        includeSuggestButton,
        includeCtaButton,
        suggestButtonText: null,
        suggestionEntryMode: settings.postSuggestionsEntryMode,
      };
    }

    const threadId = includeCommentsButton || includeSuggestButton ? randomUUID() : null;
    const suggestButtonText = settings.postSuggestionsButtonText.trim() || '📰 Предложить пост';
    const commentsButton =
      includeCommentsButton && threadId
        ? this.context.buildChannelDialogButton(
            chatId,
            'comments',
            threadId,
            formatCommentsButtonText('💬 Комментарии', 0),
            botId,
          )
        : null;
    const suggestButton =
      includeSuggestButton && threadId
        ? this.context.buildChannelDialogButton(
            chatId,
            'suggest',
            threadId,
            suggestButtonText,
            botId,
            settings.postSuggestionsEntryMode,
          )
        : null;
    const buttons = buildChannelPostActionRows({ commentsButton, suggestButton, ctaButton });
    return {
      buttons,
      threadId,
      includeCommentsButton,
      includeSuggestButton,
      includeCtaButton,
      suggestButtonText: includeSuggestButton ? suggestButtonText : null,
      suggestionEntryMode: settings.postSuggestionsEntryMode,
    };
  }

  private adaptPublisherDialogContext(
    context: PublisherPreparedDialogContext,
  ): SuggestionButtonContext {
    const reference = context.reference;
    if (!reference) {
      if (context.buttons.length > 1) {
        throw new ServiceUnavailableException('Сохранённый контекст кнопок Публика повреждён.');
      }
      return {
        buttons: context.buttons,
        threadId: null,
        includeCommentsButton: false,
        includeSuggestButton: false,
        includeCtaButton: context.buttons.length === 1,
        suggestButtonText: null,
        suggestionEntryMode: 'BOT',
      };
    }
    if (reference.entityType !== 'channel' || reference.dialogBotId !== context.dialogBotId) {
      throw new ServiceUnavailableException('Сохранённый контекст кнопок Публика повреждён.');
    }
    return {
      buttons: context.buttons,
      threadId: reference.threadId,
      includeCommentsButton: reference.includeCommentsButton,
      includeSuggestButton: reference.includeSuggestButton,
      includeCtaButton:
        context.buttons.length >
        Number(reference.includeCommentsButton) + Number(reference.includeSuggestButton),
      suggestButtonText: reference.suggestButtonText,
      suggestionEntryMode: reference.suggestionEntryMode ?? 'BOT',
    };
  }

  // FLAG: The exact prepared context is persisted after the send fence and immediately before HTTP.
  private async persistPublicationContext(params: {
    suggestionId: string;
    chatId: string;
    claim: ChannelSuggestionPublicationClaimV1;
    context: ChannelSuggestionPublicationContextV1;
  }): Promise<void> {
    const contextJson = JSON.stringify(params.context);
    const persisted = await this.context.prisma.$executeRaw(Prisma.sql`
      UPDATE audit_logs
      SET payload = payload::jsonb || jsonb_build_object(
        'reviewPublicationContext', ${contextJson}::jsonb
      )
      WHERE id = ${params.suggestionId}::text
        AND actor_user_id = ${params.context.authorAttribution.userId}::text
        AND action = ${CHANNEL_DIALOG_ACTION_SUGGEST}::text
        AND payload->>'type' = 'suggest'
        AND payload->>'reviewStatus' = 'publishing'
        AND payload->>'reviewAction' = 'publish'
        AND payload->>'reviewPublicationProtocol' = ${CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1}::text
        AND payload->>'reviewPublicationLedgerJobId' = ${params.claim.ledgerJobId}::text
        AND payload->>'reviewClaimToken' = ${params.claim.claimToken}::text
        AND EXISTS (
          SELECT 1
          FROM max_action_ledger ledger
          WHERE ledger.job_id = ${params.claim.ledgerJobId}::text
            AND ledger.action_type = 'SEND_MESSAGE'
            AND ledger.chat_id = ${params.chatId}::text
            AND ledger.source_tag = ${CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG}::text
            AND ledger.status = 'IN_PROGRESS'::"MaxActionLedgerStatus"
            AND ledger.ambiguous = false
            AND ledger.terminal = false
            AND ledger.dispatch_token IS NOT NULL
            AND ledger.dispatch_started_at IS NOT NULL
            AND ledger.dispatch_bot_id = ${params.context.botId}::text
            AND ledger.remote_message_id IS NULL
            AND ledger.metadata->'ledgerContext'->>'suggestionId' = ${params.suggestionId}::text
            AND ledger.metadata->'ledgerContext'->>'publicationProtocol' = ${CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1}::text
            AND ledger.metadata->'ledgerContext'->>'claimToken' = ${params.claim.claimToken}::text
            AND ledger.metadata->'ledgerContext'->>'actorUserId' = ${params.context.authorAttribution.userId}::text
            AND ledger.metadata->'ledgerContext'->>'messageDigest' = ${params.context.messageDigest}::text
            AND ledger.metadata->'ledgerContext'->>'contextDigest' = ${params.context.contextDigest}::text
        )
    `);
    if (Number(persisted) !== 1) {
      throw new ServiceUnavailableException(
        'Состояние предложки изменилось перед отправкой. Публикация остановлена.',
      );
    }
  }

  private markAmbiguousSendError(error: unknown): void {
    if (error && (typeof error === 'object' || typeof error === 'function')) {
      Object.defineProperty(error, CHANNEL_SUGGESTION_AMBIGUOUS_SEND_ERROR, {
        value: true,
        configurable: true,
      });
    }
  }

  private isAmbiguousSendError(error: unknown): boolean {
    return Boolean(
      error &&
      (typeof error === 'object' || typeof error === 'function') &&
      (error as Record<typeof CHANNEL_SUGGESTION_AMBIGUOUS_SEND_ERROR, unknown>)[
        CHANNEL_SUGGESTION_AMBIGUOUS_SEND_ERROR
      ],
    );
  }
}
