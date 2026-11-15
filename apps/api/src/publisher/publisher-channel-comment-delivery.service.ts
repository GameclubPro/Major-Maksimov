import { channelCustomButtonsEligible } from '../common/channel-custom-post-buttons';
import { checkPublisherCommentReadiness } from './publisher-comment-readiness';
import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { isDeepStrictEqual } from 'node:util';
import { ChannelPostSignatureService } from '../admin/channel-post-signature.service';
import { readManagedBroadcastButtonRows } from '../admin/admin-managed-broadcast-ledger';
import { countPublisherChatComments } from '../admin/publisher-chat-comment-store';
import {
  readInternalChannelDialogButtonIdentitiesFromMessage,
  readInternalChannelDialogButtonIdentity,
} from '../common/channel-dialog-button-identity.util';
import { buildChannelPostActionRows } from '../common/channel-post-actions';
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxMessageButton,
} from '../max/max-client.service';
import { hasConfirmedEditMessageAccess } from '../max/max-delete-message-access.util';
import { readStrictEditableAttachments } from '../max/max-editable-message-preservation';
import {
  ChannelPostSignaturePresentation,
  ChatEntityType,
  type Prisma,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherActionCredentialService } from './publisher-action-credential.service';
import type { PublisherChannelCommentAttachJob } from './publisher-chat-comment.queue';
import { PublisherDialogLinkService } from './publisher-dialog-link.service';
import { PublisherReadinessService } from './publisher-readiness.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import { PublisherDispatchHealthService } from './publisher-dispatch-health.service';
import { withMaxFinalAuthorityCheckpoint } from '../max/max-action-pre-dispatch-guard';

@Injectable()
export class PublisherChannelCommentDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly readiness: PublisherReadinessService,
    private readonly runtime: PublisherRuntimeBoundaryService,
    private readonly credentials: PublisherActionCredentialService,
    private readonly links: PublisherDialogLinkService,
    private readonly health: PublisherDispatchHealthService,
    private readonly postSignature: ChannelPostSignatureService,
  ) {}

  async process(job: PublisherChannelCommentAttachJob): Promise<void> {
    const age = Date.now() - Date.parse(job.createdAt);
    if (
      job.requiredBotId !== this.credentials.getBotId() ||
      job.dialogBotId !== job.requiredBotId ||
      !Number.isSafeInteger(job.publisherSettingsRevision) ||
      job.publisherSettingsRevision < 0 ||
      !Number.isSafeInteger(job.publicationPolicyRevision) ||
      job.publicationPolicyRevision < 0 ||
      !Number.isFinite(age) ||
      age < -60_000 ||
      age > 24 * 60 * 60_000
    ) {
      throw new UnrecoverableError('Invalid or expired Publisher channel keyboard identity');
    }
    const settings = await this.readCurrentSettings(job);
    if (!settings) return;
    await this.assertReady(job);
    const requestOptions = {
      botId: job.requiredBotId,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
    } as const;
    let reference: Prisma.InputJsonObject | null = null;
    let ctaButton: MaxMessageButton | null = null;
    let channelButtonRows: MaxMessageButton[][] = [];
    const postButtonOptions = {
      entityType: 'channel',
      botId: job.requiredBotId,
      trafficClass: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
    } as const;
    try {
      await this.maxClient.editMessageInlineKeyboard(
        job.chatId,
        job.messageId,
        null,
        {
          mergeExistingInlineKeyboard: true,
          rejectKeyboardTrimming: true,
          requireAllAttachmentsPreserved: true,
          prepareInlineKeyboard: async (message) => {
            const recipient = message?.recipient as Record<string, unknown> | undefined;
            if (
              !message ||
              !recipient ||
              String(recipient.chat_id) !== job.chatId ||
              recipient.chat_type !== 'channel' ||
              recipient.post_id != null
            ) {
              throw new UnrecoverableError(
                'Publisher keyboard source is not the exact channel post',
              );
            }
            // FLAG: Resolve Publisher threads inside the shared edit lock. Existing Major
            // entries stay visible but never donate a Publisher thread/token or count reference.
            const identities = readInternalChannelDialogButtonIdentitiesFromMessage(
              message,
              job.chatId,
              'publisher',
              job.requiredBotId,
            );
            const threadId =
              identities.find((item) => item.kind === 'comments')?.threadId ??
              identities[0]?.threadId ??
              job.threadId;
            const existingIdentities = readInternalChannelDialogButtonIdentitiesFromMessage(
              message,
              job.chatId,
              'all',
              job.requiredBotId,
            );
            const existingComments = existingIdentities.find((item) => item.kind === 'comments');
            const existingSuggestion = existingIdentities.find((item) => item.kind === 'suggest');
            const includeCommentsButton =
              settings.channelCommentsEnabled &&
              (!existingComments || existingComments.profile === 'publisher');
            const includeSuggestButton =
              settings.channelSuggestionsEnabled &&
              (!existingSuggestion || existingSuggestion.profile === 'publisher');
            const existingButtons = readPostButtonRows(message).flat();
            const findExistingDialog = (kind: 'comments' | 'suggest') =>
              existingButtons.find((button) => {
                const identity = readInternalChannelDialogButtonIdentity(button, job.requiredBotId);
                return identity?.chatId === job.chatId && identity.kind === kind;
              });
            const count = includeCommentsButton
              ? await countPublisherChatComments(this.prisma, job.chatId, threadId)
              : 0;
            const commentsText = '💬 Комментарии';
            const suggestText = '✍️ Предложить объявление';
            const comments = includeCommentsButton
              ? this.links.buildChannelDialogButton(
                  job.chatId,
                  'comments',
                  threadId,
                  formatCommentsButtonText(commentsText, count),
                  'MINIAPP',
                )
              : null;
            const suggest = includeSuggestButton
              ? this.links.buildChannelDialogButton(
                  job.chatId,
                  'suggest',
                  threadId,
                  suggestText,
                  'MINIAPP',
                )
              : null;
            ctaButton = await this.postSignature.buildPostButton(job.chatId, postButtonOptions);
            channelButtonRows = await this.postSignature.buildCustomPostButtons(job.chatId, {
              entityType: 'channel',
              sourceAt: job.createdAt,
            });
            // FLAG: Counter refresh matches the installed opaque link, not a regenerated
            // signature. Preserve the same Publisher button that the locked edit keeps;
            // a retained Major button must never become a Publisher count reference.
            const buttonRows = buildChannelPostActionRows({
              commentsButton: comments ? (findExistingDialog('comments') ?? comments) : null,
              suggestButton: suggest ? (findExistingDialog('suggest') ?? suggest) : null,
              ctaButton,
              customButtonRows: channelButtonRows,
            });
            reference = {
              messageId: job.messageId,
              threadId,
              botId: job.requiredBotId,
              dialogBotId: job.dialogBotId,
              publisherProfile: true,
              source: 'publisher_channel_webhook',
              includeCommentsButton,
              includeSuggestButton,
              suggestionEntryMode: 'MINIAPP',
              suggestButtonText: suggestText,
              buttonRows: buttonRows as Prisma.InputJsonValue,
              commentsButton: comments
                ? { rowIndex: 0, columnIndex: 0, baseText: commentsText }
                : null,
            };
            const seenDialogKinds = new Set<'comments' | 'suggest'>();
            const hasDuplicateDialogs = existingButtons.some((button) => {
              const identity = readInternalChannelDialogButtonIdentity(button, job.requiredBotId);
              if (identity?.chatId !== job.chatId) return false;
              if (seenDialogKinds.has(identity.kind)) return true;
              seenDialogKinds.add(identity.kind);
              return false;
            });
            const missingComments = comments && !existingComments;
            const missingSuggest = suggest && !existingSuggestion;
            const ctaUrl = ctaButton?.type === 'link' ? ctaButton.url : null;
            const missingCta =
              ctaButton &&
              !existingButtons.some((button) => button.type === 'link' && button.url === ctaUrl);
            const missingCustom = channelButtonRows.filter((row) =>
              row.some(
                (button) =>
                  button.type === 'link' &&
                  !existingButtons.some(
                    (existing) => existing.type === 'link' && existing.url === button.url,
                  ),
              ),
            );
            if (
              !missingComments &&
              !missingSuggest &&
              !missingCta &&
              !missingCustom.length &&
              !hasDuplicateDialogs
            )
              return null;
            return buildChannelPostActionRows({
              commentsButton: findExistingDialog('comments') ?? comments,
              suggestButton: findExistingDialog('suggest') ?? suggest,
              ctaButton: missingCta ? ctaButton : null,
              customButtonRows: missingCustom,
            });
          },
          beforeEditMutation: withMaxFinalAuthorityCheckpoint(async (beforeFinalAuthority) => {
            await this.assertReady(job);
            const snapshot = await this.maxClient.getChatSnapshot(job.chatId, {
              ...requestOptions,
              bypassCache: true,
              timeoutMs: 2_000,
            });
            const access = await this.maxClient.getCurrentChatMemberAccess(job.chatId, {
              ...requestOptions,
              bypassCache: true,
              timeoutMs: 2_000,
            });
            if (
              snapshot.entityType !== 'channel' ||
              !hasConfirmedEditMessageAccess({ ...access, checkedAt: null }, ChatEntityType.CHANNEL)
            ) {
              throw new UnrecoverableError('Publisher cannot edit this channel post');
            }
            const currentCtaButton = ctaButton
              ? await this.postSignature.buildPostButton(job.chatId, postButtonOptions)
              : null;
            await beforeFinalAuthority?.();
            const currentSettings = await this.readCurrentSettings(job);
            if (
              channelButtonRows.length &&
              !isDeepStrictEqual(
                channelButtonRows,
                await this.postSignature.buildCustomPostButtons(job.chatId, {
                  entityType: 'channel',
                  sourceAt: job.createdAt,
                }),
              )
            )
              throw new UnrecoverableError('Channel custom buttons changed before keyboard edit');
            if (!currentSettings) {
              throw new UnrecoverableError(
                'Publisher channel settings changed before keyboard edit',
              );
            }
            if (
              ctaButton &&
              (!isDeepStrictEqual(ctaButton, currentCtaButton) ||
                currentSettings.postSignatureUpdatedAtMs !== settings.postSignatureUpdatedAtMs)
            ) {
              throw new UnrecoverableError('Channel post button changed before keyboard edit');
            }
          }),
        },
        requestOptions,
      );
      if (reference) {
        await this.prisma.auditLog.upsert({
          where: { id: job.idempotencyKey },
          create: {
            id: job.idempotencyKey,
            chatId: job.chatId,
            actorUserId: job.requiredBotId,
            action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
            payload: reference,
          },
          update: {},
        });
      }
    } catch (error: unknown) {
      await this.health.recordSendFailure(job.chatId, error).catch(() => undefined);
      throw error;
    }
  }

  private async assertReady(job: PublisherChannelCommentAttachJob): Promise<void> {
    this.runtime.assertDispatchEnabled();
    await this.health.assertDispatchAllowed();
    const route = await checkPublisherCommentReadiness(() =>
      this.readiness.assertEntityReady(job.chatId, 'publication'),
    );
    if (route.entityType !== 'channel' || route.requiredBotId !== job.requiredBotId) {
      throw new UnrecoverableError('Publisher channel readiness selected another route');
    }
  }

  private async readCurrentSettings(job: PublisherChannelCommentAttachJob) {
    const entity = await this.prisma.chat.findUnique({
      where: { id: job.chatId },
      select: {
        entityType: true,
        publicationPolicy: { select: { publikEnabled: true, revision: true } },
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
          select: { channelCommentsEnabled: true, channelSuggestionsEnabled: true, revision: true },
        },
      },
    });
    const settings = entity?.publisherSettings;
    const hasPostButton =
      entity?.channelSettings?.postSignatureEnabled === true &&
      entity.channelSettings.postSignaturePresentation ===
        ChannelPostSignaturePresentation.BUTTON &&
      Date.parse(job.createdAt) >= entity.channelSettings.updatedAt.getTime();
    const hasCustomButtons = channelCustomButtonsEligible(entity?.channelSettings, job.createdAt);
    return entity?.entityType === ChatEntityType.CHANNEL &&
      (settings?.channelCommentsEnabled ||
        settings?.channelSuggestionsEnabled ||
        hasPostButton ||
        hasCustomButtons) &&
      (settings?.revision ?? 0) === job.publisherSettingsRevision &&
      entity.publicationPolicy?.publikEnabled !== false &&
      (entity.publicationPolicy?.revision ?? 0) === job.publicationPolicyRevision
      ? {
          ...(settings ?? {
            channelCommentsEnabled: false,
            channelSuggestionsEnabled: false,
            revision: 0,
          }),
          // FLAG: Bind prepared signature/link evidence across transport admission without
          // repeating a MAX link lookup after its final local policy check.
          postSignatureUpdatedAtMs: entity.channelSettings?.updatedAt.getTime() ?? null,
        }
      : null;
  }
}

function readPostButtonRows(message: Record<string, unknown>): MaxMessageButton[][] {
  return readStrictEditableAttachments(message, false).flatMap((attachment) => {
    const row = attachment as { type?: unknown; payload?: { buttons?: unknown } } | null;
    return row?.type === 'inline_keyboard'
      ? (readManagedBroadcastButtonRows(row.payload?.buttons) ?? [])
      : [];
  });
}
