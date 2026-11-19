import type { PublicationContentInput } from '@maxim/contracts/publication';
import type {
  PublisherPostImportFailureCode,
  PublisherPostImportOmission,
  PublisherPostImportWarning,
} from '@maxim/contracts/publisher';
import { maxUpdateSchema } from '@maxim/contracts';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  EmptyResponseBodyError,
  readBoundedResponseBuffer,
  ResponseByteLimitExceededError,
} from '../common/bounded-response-buffer';
import {
  extractIncomingMessageMarkup,
  renderIncomingMarkupAsMarkdown,
} from '../moderation/private-control-markup-importer';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import {
  MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES,
  MaxImageUploadNormalizationError,
  normalizeUnsupportedMaxImageUpload,
} from '../max/max-image-upload-normalization';
import {
  MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES,
  MaxMediaUploadValidationError,
} from '../max/max-media-upload-validation';
import {
  PublicationAudienceMode,
  PublicationAudienceSelection,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublisherPostImportStatus,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  PUBLISHER_POST_IMPORT_RESULT_TTL_MS,
  PUBLISHER_POST_IMPORT_SECOND_FORWARD_GUARD_MS,
} from '../publisher/publisher-post-import.service';
import {
  PublicationContentService,
  type PublicationBinaryContentInput,
  type PublicationBinaryMediaInput,
} from './publication-content.service';
import {
  PUBLICATION_MAX_IMAGE_BYTES,
  PUBLICATION_MAX_TOTAL_IMAGE_BYTES,
} from './publication-media-limits';
import {
  assertPublicationDraftQuota,
  lockPublicationDraftQuota,
  PublicationDraftQuotaError,
} from './publication-draft-quota';
import {
  PUBLISHER_POST_IMPORT_COLLECTION_LIMIT,
  readPublisherPostImportInputMessages,
} from '../publisher/publisher-post-import-input';
import { extractMaxVideoDownloadUrl } from '../max/max-video-download-url.util';
import { BROADCAST_IMAGE_MAX_BYTES } from './admin.service.support';
import { PUBLICATION_MAX_VIDEO_BYTES } from './publication-video-media';

const POST_IMPORT_LEASE_MS = 2 * 60_000;
const POST_IMPORT_MAX_IMAGES = 10;
const POST_IMPORT_MAX_TEXT_LENGTH = 4_000;
const POST_IMPORT_FETCH_TIMEOUT_MS = 20_000;
const POST_IMPORT_ALLOWED_MEDIA_HOSTS = ['max.ru', 'oneme.ru', 'mycdn.me', 'okcdn.ru'] as const;

type ImportSource = {
  message: Record<string, unknown>;
  outer?: Record<string, unknown>;
  absent?: boolean;
  messageIndex: number;
};
type ImportedContent = PublicationBinaryContentInput & {
  omissions: PublisherPostImportOmission[];
  warnings: PublisherPostImportWarning[];
};
type MediaCandidate = {
  attachment: Record<string, unknown>;
  kind: 'image' | 'video';
  messageIndex: number;
  itemIndex: number;
  mediaPosition: number;
};

type ProcessResult = 'ready' | 'failed' | 'noop';
type PublisherPostImportSnapshotSource = 'webhook_receipt' | 'remote_exact';
type PublisherPostImportRejectionKind =
  | PublisherPostImportFailureCode
  | 'content_validation'
  | 'image_decode_budget_exceeded'
  | 'image_dimensions_exceeded'
  | 'image_format_unsupported_after_normalization'
  | 'image_invalid_payload'
  | 'image_normalization_dimensions_exceeded'
  | 'image_normalization_input_pixel_limit_exceeded'
  | 'image_normalization_output_too_large'
  | 'image_transcode_failed'
  | 'receipt_bot_mismatch'
  | 'captured_message_absent'
  | 'receipt_identity_missing'
  | 'receipt_normalized_identity_mismatch'
  | 'receipt_payload_invalid'
  | 'receipt_raw_identity_mismatch';

class PublisherPostImportTerminalError extends Error {
  constructor(
    readonly code: PublisherPostImportFailureCode,
    message: string,
    readonly rejectionKind: PublisherPostImportRejectionKind = code,
  ) {
    super(message);
    this.name = 'PublisherPostImportTerminalError';
  }
}

class PublisherPostImportTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublisherPostImportTransientError';
  }
}

class PublisherPostImportSupersededError extends Error {}

@Injectable()
export class PublisherPostImportProcessingService {
  private readonly logger = new Logger(PublisherPostImportProcessingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly publicationContentService: PublicationContentService,
  ) {}

  async process(sessionId: string, lastAttempt = false): Promise<ProcessResult> {
    const now = new Date();
    const lockToken = randomUUID();
    const claimed = await this.prisma.publisherPostImportSession.updateMany({
      where: {
        id: sessionId,
        status: PublisherPostImportStatus.PROCESSING,
        OR: [
          { lockedAt: null },
          { lockedAt: { lt: new Date(now.getTime() - POST_IMPORT_LEASE_MS) } },
        ],
      },
      data: { lockedAt: now, lockToken },
    });
    if (claimed.count === 0) {
      return 'noop';
    }

    const session = await this.prisma.publisherPostImportSession.findFirst({
      where: { id: sessionId, status: PublisherPostImportStatus.PROCESSING, lockToken },
    });
    if (!session) {
      return 'noop';
    }
    const inputMode =
      session.inputMode === 'message' || session.inputMode === 'collection'
        ? session.inputMode
        : 'forward';
    const outcomeTiming = () => ({
      inputMode,
      elapsedMs: session.capturedAt ? Math.max(0, Date.now() - session.capturedAt.getTime()) : null,
    });
    let snapshotSource: PublisherPostImportSnapshotSource = 'remote_exact';

    try {
      if (session.expiresAt <= now) {
        throw new PublisherPostImportTerminalError(
          'processing_timeout',
          'Publisher post import processing deadline expired',
        );
      }
      const privateChatId = session.privateChatId?.trim() ?? '';
      const incomingMessageId = session.incomingMessageId?.trim() ?? '';
      if (!privateChatId || !incomingMessageId) {
        throw new PublisherPostImportTerminalError(
          'message_unavailable',
          'Exact forwarded message identity is unavailable',
        );
      }
      const captured = session.inputMessages;
      const storedEntries = readPublisherPostImportInputMessages(captured);
      if (
        (captured != null &&
          (!Array.isArray(captured) || captured.length !== storedEntries.length)) ||
        storedEntries.length > PUBLISHER_POST_IMPORT_COLLECTION_LIMIT ||
        new Set(storedEntries.map((entry) => entry.messageId)).size !== storedEntries.length ||
        (storedEntries.length > 0 && storedEntries[0]!.messageId !== incomingMessageId)
      ) {
        throw new PublisherPostImportTerminalError(
          'message_unavailable',
          'Invalid captured message list',
        );
      }
      const entries = storedEntries.length
        ? storedEntries
        : [{ messageId: incomingMessageId, webhookEventId: session.sourceWebhookEventId }];
      const allowDirect = session.inputMode === 'message' || session.inputMode === 'collection';
      let nextRenewal = Date.now() + POST_IMPORT_LEASE_MS / 3;
      const renew = async () => {
        if (Date.now() >= session.expiresAt.getTime()) {
          throw new PublisherPostImportTerminalError(
            'processing_timeout',
            'Import deadline expired',
          );
        }
        if (Date.now() < nextRenewal) return;
        const current = await this.prisma.publisherPostImportSession.updateMany({
          where: { id: sessionId, lockToken, status: PublisherPostImportStatus.PROCESSING },
          data: { lockedAt: new Date() },
        });
        if (current.count !== 1) throw new PublisherPostImportSupersededError();
        nextRenewal = Date.now() + POST_IMPORT_LEASE_MS / 3;
      };
      const sources: ImportSource[] = [];
      for (const [index, entry] of entries.entries()) {
        await renew();
        let exactMessage: Record<string, unknown> | null = null;
        if (entry.webhookEventId) {
          snapshotSource = 'webhook_receipt';
          exactMessage = await this.loadPersistedForwardReceipt({
            sourceWebhookEventId: entry.webhookEventId,
            publisherBotId: session.publisherBotId,
            actorUserId: session.actorUserId,
            privateChatId,
            incomingMessageId: entry.messageId,
            allowDirect,
          });
        }
        if (!exactMessage) {
          snapshotSource = 'remote_exact';
          try {
            exactMessage = await this.loadRemoteIncomingMessage(
              privateChatId,
              entry.messageId,
              session.publisherBotId,
            );
          } catch (error: unknown) {
            if (
              entries.length > 1 &&
              error instanceof PublisherPostImportTerminalError &&
              error.rejectionKind === 'captured_message_absent'
            ) {
              sources.push({ message: {}, messageIndex: index + 1, absent: true });
              continue;
            }
            throw error;
          }
        }
        this.assertExactSender(exactMessage, session.actorUserId);
        const linked = this.extractLinkedForward(exactMessage);
        if (
          !linked &&
          (!allowDirect ||
            this.readString(this.asRecord(exactMessage.link)?.type)?.toLowerCase() === 'forward')
        ) {
          throw new PublisherPostImportTerminalError('invalid_forward', 'Incomplete forward');
        }
        sources.push({
          message: linked ?? exactMessage,
          outer: linked ? exactMessage : undefined,
          messageIndex: index + 1,
        });
      }
      const content = await this.buildContent(sources, session.publisherBotId, lastAttempt, renew);
      await renew();
      const prepared = await this.publicationContentService.prepareBinaryContentRevision(content);
      await this.publicationContentService.assertPublisherCompatibleContent(
        prepared,
        session.actorUserId,
      );
      const publicationId = await this.prisma.$transaction(async (tx: any) => {
        await lockPublicationDraftQuota(tx, session.actorUserId);
        await assertPublicationDraftQuota(tx, session.actorUserId, null, prepared);
        const publicationRequestId = `post-import-${session.id}`;
        const publication = await tx.publication.create({
          data: {
            actorUserId: session.actorUserId,
            requestId: publicationRequestId,
            title: '',
            lifecycle: PublicationLifecycle.DRAFT,
            audienceSelection: PublicationAudienceSelection.SELECTED,
            audienceMode: PublicationAudienceMode.SNAPSHOT,
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            requiredBotId: session.publisherBotId,
          },
          select: { id: true },
        });
        const revision = await this.publicationContentService.persistPreparedContentRevision(
          tx,
          publication.id,
          1,
          prepared,
          session.actorUserId,
        );
        await tx.publication.update({
          where: { id: publication.id },
          data: { canonicalContentRevisionId: revision.id },
        });
        if (content.warnings.length || content.omissions.length) {
          await tx.publicationSchedule.create({
            data: {
              publicationId: publication.id,
              mode: 'NOW',
              timezone: 'Europe/Moscow',
              status: 'DRAFT',
              rule: {
                formatVersion: 1,
                timingMode: 'now',
                scheduleKind: 'slots',
                scheduleTimezone: 'Europe/Moscow',
                scheduledSlots: [],
                onceDate: '',
                onceTime: '',
                recurrence: {
                  frequency: 'weekly',
                  interval: 1,
                  weekdays: [],
                  times: [],
                  startsAt: null,
                  endsAt: null,
                  maxOccurrences: null,
                },
                importReview: {
                  omissions: content.omissions,
                  warnings: content.warnings,
                  resolved: [],
                },
              },
            },
          });
        }
        await tx.publicationMutationRecord.create({
          data: {
            actorUserId: session.actorUserId,
            requestId: publicationRequestId,
            requestHash: createHash('sha256')
              .update(
                JSON.stringify({
                  kind: 'publisher_post_import',
                  sessionId: session.id,
                  incomingMessageId: session.incomingMessageId,
                }),
              )
              .digest('hex'),
            publicationId: publication.id,
            resultingVersion: 1,
          },
        });
        const completed = await tx.publisherPostImportSession.updateMany({
          where: {
            id: session.id,
            status: PublisherPostImportStatus.PROCESSING,
            lockToken,
          },
          data: {
            status: PublisherPostImportStatus.READY,
            publicationId: publication.id,
            failureCode: null,
            omissions: content.omissions,
            warnings: content.warnings,
            notificationKind: 'ready',
            notificationPending: true,
            notificationLockedAt: null,
            notificationLockToken: null,
            notificationDispatchStartedAt: null,
            captureGuardUntil: new Date(Date.now() + PUBLISHER_POST_IMPORT_SECOND_FORWARD_GUARD_MS),
            lockedAt: null,
            lockToken: null,
            expiresAt: new Date(Date.now() + PUBLISHER_POST_IMPORT_RESULT_TTL_MS),
          },
        });
        if (completed.count !== 1) {
          throw new PublisherPostImportSupersededError();
        }
        return publication.id as string;
      });
      const mediaKinds = new Set(content.media.map((item) => item.type));
      const mediaKind =
        mediaKinds.size > 1
          ? 'mixed'
          : (content.media[0]?.type ?? (content.text.trim() ? 'text' : null));
      this.logger.log(
        {
          sessionId,
          publicationId,
          snapshotSource,
          ...outcomeTiming(),
          mediaKind,
          mediaCount: content.media.length,
          warningCount: content.warnings.length,
        },
        'Publisher forwarded post import completed',
      );
      return 'ready';
    } catch (error: unknown) {
      if (error instanceof PublisherPostImportSupersededError) {
        return 'noop';
      }
      if (error instanceof PublisherPostImportTerminalError) {
        if (await this.fail(session.id, lockToken, error.code)) {
          this.logTerminalFailure(
            session.id,
            error.code,
            error.rejectionKind,
            snapshotSource,
            outcomeTiming(),
          );
        }
        return 'failed';
      }
      if (error instanceof BadRequestException) {
        const code = error instanceof PublicationDraftQuotaError ? 'draft_quota' : 'media_invalid';
        if (await this.fail(session.id, lockToken, code)) {
          this.logTerminalFailure(
            session.id,
            code,
            'content_validation',
            snapshotSource,
            outcomeTiming(),
          );
        }
        return 'failed';
      }
      await this.prisma.publisherPostImportSession.updateMany({
        where: {
          id: session.id,
          status: PublisherPostImportStatus.PROCESSING,
          lockToken,
        },
        data: { lockedAt: null, lockToken: null },
      });
      throw error;
    }
  }

  async failInternalAfterFinalAttempt(sessionId: string): Promise<boolean> {
    const now = new Date();
    const failed = await this.prisma.publisherPostImportSession.updateMany({
      where: {
        id: sessionId,
        status: PublisherPostImportStatus.PROCESSING,
        lockedAt: null,
        lockToken: null,
      },
      data: {
        status: PublisherPostImportStatus.FAILED,
        failureCode: 'internal_error',
        notificationKind: 'failed',
        notificationPending: true,
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
        captureGuardUntil: new Date(now.getTime() + PUBLISHER_POST_IMPORT_SECOND_FORWARD_GUARD_MS),
        expiresAt: new Date(now.getTime() + PUBLISHER_POST_IMPORT_RESULT_TTL_MS),
      },
    });
    return failed.count > 0;
  }

  private async buildContent(
    input: Record<string, unknown> | ImportSource[],
    publisherBotId: string,
    lastAttempt = false,
    renew?: () => Promise<void>,
  ): Promise<ImportedContent> {
    const sources: ImportSource[] = Array.isArray(input)
      ? input
      : [{ message: input, messageIndex: 1 }];
    const warnings: PublisherPostImportWarning[] = [];
    const omissions = new Set<PublisherPostImportOmission>();
    const candidates: MediaCandidate[] = [];
    const paragraphs: { raw: string; markdown: string | null }[] = [];
    const shareCards: { url: string; messageIndex: number; itemIndex: number }[] = [];
    const warn = (warning: PublisherPostImportWarning) => {
      if (warnings.length < 128) warnings.push(warning);
    };
    let nextMediaPosition = 0;
    let lastFailure: PublisherPostImportTerminalError | undefined;
    for (const { message, outer, messageIndex, absent } of sources) {
      if (absent) {
        warn({ kind: 'attachment', messageIndex, reason: 'unavailable' });
        lastFailure = new PublisherPostImportTerminalError(
          'message_unavailable',
          'Captured message unavailable',
        );
        continue;
      }
      const raw = this.extractText(message);
      if (raw.length > POST_IMPORT_MAX_TEXT_LENGTH) {
        lastFailure = new PublisherPostImportTerminalError('text_too_long', 'Text exceeds limit');
        warn({ messageIndex, kind: 'text', reason: 'too_large' });
      } else if (raw.trim()) {
        const markup = extractIncomingMessageMarkup(message);
        const markdown = markup.length ? renderIncomingMarkupAsMarkdown(raw, markup) : null;
        if (markup.length && (!markdown || markdown.length > POST_IMPORT_MAX_TEXT_LENGTH))
          omissions.add('formatting_not_preserved');
        paragraphs.push({
          raw,
          markdown: markdown && markdown.length <= POST_IMPORT_MAX_TEXT_LENGTH ? markdown : null,
        });
      }
      let attachments = this.extractAttachments(message);
      if (outer) {
        const comment = this.extractText(outer);
        if (comment.trim() && comment !== raw) {
          if (comment.length <= POST_IMPORT_MAX_TEXT_LENGTH)
            warn({ messageIndex, kind: 'text', reason: 'outer_comment', value: comment });
          else warn({ messageIndex, kind: 'text', reason: 'too_large' });
        }
        const extra = this.extractAttachments(outer);
        if (extra.length) {
          if (!attachments.length) {
            attachments = extra;
            warn({ messageIndex, kind: 'attachment', reason: 'outer_media' });
          } else {
            warn({ messageIndex, kind: 'attachment', reason: 'unsupported' });
          }
        }
      }
      for (const [index, attachment] of attachments.entries()) {
        const type = this.readAttachmentType(attachment);
        const itemIndex = index + 1;
        if (type === 'inline_keyboard') {
          omissions.add('buttons_not_imported');
          continue;
        }
        if (type === 'share') {
          const url = this.extractSafeShareUrl(attachment);
          if (url) shareCards.push({ url, messageIndex, itemIndex });
          else warn({ messageIndex, itemIndex, kind: 'link', reason: 'invalid' });
          continue;
        }
        if (type !== 'photo' && type !== 'image' && type !== 'video') {
          omissions.add('attachments_not_imported');
          warn({ messageIndex, itemIndex, kind: 'attachment', reason: 'unsupported' });
          continue;
        }
        const kind = type === 'photo' ? 'image' : type;
        const mediaPosition = nextMediaPosition++;
        if (candidates.length >= POST_IMPORT_MAX_IMAGES) {
          warn({ messageIndex, itemIndex, mediaPosition, kind, reason: 'limit' });
          continue;
        }
        candidates.push({ attachment, kind, itemIndex, messageIndex, mediaPosition });
      }
    }
    const media: PublicationBinaryMediaInput[] = [];
    const hashes = new Set<string>();
    let retainedBytes = 0;
    const accept = (candidate: MediaCandidate, item: PublicationBinaryMediaInput) => {
      const { messageIndex, itemIndex, kind, mediaPosition } = candidate;
      const hash = createHash('sha256').update(item.bytes).digest('hex');
      if (hashes.has(hash)) {
        warn({ messageIndex, itemIndex, mediaPosition, kind, reason: 'duplicate' });
        return;
      }
      if (retainedBytes + item.bytes.length > PUBLICATION_MAX_TOTAL_IMAGE_BYTES) {
        lastFailure = new PublisherPostImportTerminalError(
          'media_too_large',
          'Album exceeds size limit',
        );
        warn({ messageIndex, itemIndex, mediaPosition, kind, reason: 'too_large' });
        return;
      }
      hashes.add(hash);
      retainedBytes += item.bytes.length;
      media.push(item);
    };
    const rejected = (candidate: MediaCandidate, e: unknown) => {
      // FLAG: Retry transient transport failures; only known terminal item failures can be omitted.
      if (e instanceof PublisherPostImportTransientError && lastAttempt) {
        e = new PublisherPostImportTerminalError(
          'media_download_failed',
          'Media temporarily unavailable after retries',
        );
      }
      if (!(e instanceof PublisherPostImportTerminalError)) throw e;
      lastFailure = e;
      const { messageIndex, itemIndex, kind, mediaPosition } = candidate;
      const reason =
        e.code === 'media_too_large' ||
        e.code === 'image_too_large' ||
        e.code === 'image_dimensions'
          ? 'too_large'
          : e.code === 'media_invalid'
            ? 'invalid'
            : 'unavailable';
      warn({ messageIndex, itemIndex, mediaPosition, kind, reason });
    };
    for (let index = 0; index < candidates.length; ) {
      await renew?.();
      const first = candidates[index]!;
      if (first.kind === 'video') {
        try {
          accept(
            first,
            await this.downloadImportedVideo(
              first.attachment,
              publisherBotId,
              PUBLICATION_MAX_TOTAL_IMAGE_BYTES - retainedBytes,
            ),
          );
        } catch (e: unknown) {
          rejected(first, e);
        }
        index++;
        continue;
      }
      let end = index + 1;
      while (end < candidates.length && candidates[end]!.kind === 'image') end++;
      const batch = candidates.slice(index, end);
      const results = await this.downloadImportedImages(
        batch.map((x) => x.attachment),
        PUBLICATION_MAX_TOTAL_IMAGE_BYTES - retainedBytes,
        lastAttempt,
      );
      for (const [offset, row] of results.entries()) {
        const candidate = batch[offset]!;
        if ('error' in row) {
          rejected(candidate, row.error);
          continue;
        }
        accept(candidate, {
          type: 'image',
          bytes: row.bytes,
          mimeType: row.mimeType,
          fileName: `forwarded-image-${index + offset + 1}.${row.extension}`,
        });
      }
      index = end;
    }
    const rawParagraphs = paragraphs.map((p) => p.raw);
    let text = rawParagraphs.join('\n\n');
    let textFormat: PublicationContentInput['textFormat'] = 'plain';
    if (paragraphs.length === 1 && paragraphs[0]!.markdown) {
      text = paragraphs[0]!.markdown;
      textFormat = 'markdown';
    } else if (paragraphs.some((p) => p.markdown)) {
      omissions.add('formatting_not_preserved');
    }
    if (text.length > POST_IMPORT_MAX_TEXT_LENGTH) {
      throw new PublisherPostImportTerminalError(
        'text_too_long',
        'Combined message text exceeds limit',
      );
    }
    for (const { url, messageIndex, itemIndex } of shareCards) {
      if (!text.trim() && !media.length) text = url;
      else if (!text.includes(url))
        warn({ messageIndex, itemIndex, kind: 'link', reason: 'optional_link', value: url });
    }
    if (!text.trim() && !media.length && !warnings.some((w) => w.reason === 'outer_comment')) {
      throw (
        lastFailure ??
        new PublisherPostImportTerminalError('empty_content', 'No transferable content')
      );
    }
    return { text, textFormat, buttons: [], media, warnings, omissions: [...omissions] };
  }

  private async downloadImportedVideo(
    attachment: Record<string, unknown>,
    botId: string,
    remainingBytes: number,
  ): Promise<PublicationBinaryMediaInput> {
    if (remainingBytes <= 0)
      throw new PublisherPostImportTerminalError('media_too_large', 'Album exceeds size limit');
    const direct = this.extractAttachmentUrl(attachment, 'video');
    const token = this.extractVideoToken(attachment);
    const limit = Math.min(PUBLICATION_MAX_VIDEO_BYTES, remainingBytes);
    const fetchVideo = async (url: string): Promise<PublicationBinaryMediaInput> => {
      const result = await this.downloadMedia(url, limit, 'video');
      try {
        const validated = await this.maxClient.validateMediaUploadPayload('video', result.bytes);
        return {
          type: 'video',
          bytes: result.bytes,
          mimeType: validated.mimeType,
          fileName: `forwarded-video.${validated.extension}`,
        };
      } catch (e: unknown) {
        if (e instanceof MaxMediaUploadValidationError)
          throw new PublisherPostImportTerminalError(
            'media_invalid',
            'Forwarded video is not valid',
          );
        throw e;
      }
    };
    if (direct) {
      try {
        return await fetchVideo(direct);
      } catch (e: unknown) {
        if (
          !token ||
          !(e instanceof PublisherPostImportTerminalError) ||
          !['media_invalid', 'media_download_failed'].includes(e.code)
        )
          throw e;
      }
    }
    if (!token)
      throw new PublisherPostImportTerminalError(
        'media_download_failed',
        'Video source unavailable',
      );
    let url: string | null;
    try {
      url = await this.maxClient.getVideoDownloadUrl(token, {
        botId,
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.PUBLISHER_POST_IMPORT,
        timeoutMs: 5000,
      });
    } catch (e: unknown) {
      if ([400, 403, 404].includes(this.readHttpStatus(e) ?? 0))
        throw new PublisherPostImportTerminalError(
          'media_download_failed',
          'Video no longer available',
        );
      throw new PublisherPostImportTransientError('MAX video token lookup failed');
    }
    if (!url || url === direct)
      throw new PublisherPostImportTerminalError(
        'media_download_failed',
        'No playable video source',
      );
    return fetchVideo(url);
  }
  private async downloadImportedImages(
    attachments: readonly Record<string, unknown>[],
    remainingBytes: number,
    lastAttempt: boolean,
  ): Promise<Array<{ bytes: Buffer; mimeType: string; extension: string } | { error: unknown }>> {
    const controller = new AbortController();
    const images = new Array<
      { bytes: Buffer; mimeType: string; extension: string } | { error: unknown }
    >(attachments.length);
    let cursor = 0;
    let totalBytes = 0;
    let failure: { error: unknown } | null = null;
    // FLAG: Keep the existing three download lanes and lease timing. Charge normalized
    // results immediately, stop new work on failure, and settle cancelled sibling downloads.
    // Raw input keeps its own limit because normalization can shrink it below the album budget.
    const workers = Array.from({ length: Math.min(3, attachments.length) }, async () => {
      try {
        while (!controller.signal.aborted) {
          const index = cursor++;
          if (index >= attachments.length) return;
          try {
            const url = this.extractAttachmentUrl(attachments[index]!, 'image');
            if (!url) {
              throw new PublisherPostImportTerminalError(
                'media_download_failed',
                'Forwarded image has no durable download URL',
              );
            }
            const raw = await this.downloadMedia(
              url,
              PUBLICATION_MAX_IMAGE_BYTES,
              'image',
              controller.signal,
            );
            if (controller.signal.aborted) return;
            const downloaded = await this.prepareImportedImage(raw);
            if (controller.signal.aborted) return;
            totalBytes += downloaded.bytes.length;
            if (totalBytes > remainingBytes) {
              throw new PublisherPostImportTerminalError(
                'media_too_large',
                'Forwarded images exceed the total media limit',
              );
            }
            images[index] = downloaded;
          } catch (error: unknown) {
            if (lastAttempt && error instanceof PublisherPostImportTransientError) {
              images[index] = { error };
              continue;
            }
            if (!(error instanceof PublisherPostImportTerminalError)) throw error;
            images[index] = { error };
            if (error.code === 'media_too_large') {
              controller.abort(error);
              return;
            }
          }
        }
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        if (!failure) {
          failure = { error };
          controller.abort(error);
        }
      }
    });
    await Promise.all(workers);
    if (failure) throw (failure as { error: unknown }).error;
    return Array.from(images, (image) => image ?? { error: controller.signal.reason });
  }

  private async prepareImportedImage(downloaded: {
    bytes: Buffer;
    mimeType: string;
  }): Promise<{ bytes: Buffer; mimeType: string; extension: string }> {
    try {
      const validated = await this.maxClient.validateMediaUploadPayload('image', downloaded.bytes);
      if (downloaded.bytes.length <= BROADCAST_IMAGE_MAX_BYTES) {
        return {
          bytes: downloaded.bytes,
          mimeType: validated.mimeType,
          extension: validated.extension,
        };
      }
    } catch (error: unknown) {
      if (!(error instanceof MaxMediaUploadValidationError)) {
        throw error;
      }
      if (error.code !== MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.UNSUPPORTED_FORMAT) {
        throw this.mapImageValidationFailure(error);
      }
    }

    try {
      return await normalizeUnsupportedMaxImageUpload(downloaded.bytes, BROADCAST_IMAGE_MAX_BYTES);
    } catch (error: unknown) {
      if (error instanceof MaxMediaUploadValidationError) {
        throw this.mapImageValidationFailure(error);
      }
      if (error instanceof MaxImageUploadNormalizationError) {
        if (error.code !== MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES.TRANSCODE_FAILED) {
          const rejectionKind: PublisherPostImportRejectionKind =
            error.code === MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES.DIMENSIONS_EXCEEDED
              ? 'image_normalization_dimensions_exceeded'
              : error.code === MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES.INPUT_PIXEL_LIMIT_EXCEEDED
                ? 'image_normalization_input_pixel_limit_exceeded'
                : 'image_normalization_output_too_large';
          throw new PublisherPostImportTerminalError(
            rejectionKind === 'image_normalization_output_too_large'
              ? 'image_too_large'
              : 'image_dimensions',
            'Forwarded image cannot be normalized within the image limits',
            rejectionKind,
          );
        }
        throw new PublisherPostImportTerminalError(
          'media_download_failed',
          'Forwarded image could not be normalized',
          'image_transcode_failed',
        );
      }
      throw error;
    }
  }

  private mapImageValidationFailure(
    error: MaxMediaUploadValidationError,
  ): PublisherPostImportTerminalError {
    if (
      error.code === MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DIMENSIONS_EXCEEDED ||
      error.code === MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DECODE_BUDGET_EXCEEDED
    ) {
      return new PublisherPostImportTerminalError(
        'image_dimensions',
        'Forwarded image exceeds the decode or dimension limit',
        error.code === MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DIMENSIONS_EXCEEDED
          ? 'image_dimensions_exceeded'
          : 'image_decode_budget_exceeded',
      );
    }
    return new PublisherPostImportTerminalError(
      'media_download_failed',
      'Forwarded image bytes are invalid or unsupported after normalization',
      error.code === MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.UNSUPPORTED_FORMAT
        ? 'image_format_unsupported_after_normalization'
        : 'image_invalid_payload',
    );
  }

  private async downloadMedia(
    sourceUrl: string,
    maxBytes: number,
    expectedType: 'image' | 'video',
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; mimeType: string }> {
    let current = this.parseAllowedMediaUrl(sourceUrl);
    const controller = new AbortController();
    const downloadSignal = signal
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal;
    const timeout = setTimeout(() => controller.abort(), POST_IMPORT_FETCH_TIMEOUT_MS);
    try {
      for (let redirect = 0; redirect <= 2; redirect += 1) {
        downloadSignal.throwIfAborted();
        const response = await fetch(current, { signal: downloadSignal, redirect: 'manual' });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          await response.body?.cancel().catch(() => undefined);
          if (!location || redirect === 2) {
            throw new PublisherPostImportTerminalError(
              'media_download_failed',
              'MAX media redirect could not be followed safely',
            );
          }
          current = this.parseAllowedMediaUrl(new URL(location, current).toString());
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          if (
            response.status === 408 ||
            response.status === 425 ||
            response.status === 429 ||
            response.status >= 500
          ) {
            throw new PublisherPostImportTransientError(
              `MAX media download temporarily returned HTTP ${response.status}`,
            );
          }
          throw new PublisherPostImportTerminalError(
            'media_download_failed',
            `MAX media download returned HTTP ${response.status}`,
          );
        }
        const declaredSize = Number(response.headers.get('content-length') ?? 0);
        if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
          await response.body?.cancel().catch(() => undefined);
          throw new PublisherPostImportTerminalError(
            expectedType === 'image' ? 'image_too_large' : 'media_too_large',
            'Forwarded media exceeds its size limit',
          );
        }
        const bytes = await this.readResponseWithLimit(
          response,
          maxBytes,
          expectedType,
          downloadSignal,
        );
        const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
        const mimeType = contentType.toLowerCase().startsWith(`${expectedType}/`)
          ? contentType.toLowerCase()
          : expectedType === 'image'
            ? 'image/jpeg'
            : 'video/mp4';
        return { bytes, mimeType };
      }
      throw new PublisherPostImportTerminalError(
        'media_download_failed',
        'MAX media redirect limit exceeded',
      );
    } catch (error: unknown) {
      if (error instanceof PublisherPostImportTerminalError) {
        throw error;
      }
      if (error instanceof PublisherPostImportTransientError) {
        throw error;
      }
      throw new PublisherPostImportTransientError(
        error instanceof Error ? error.message : 'MAX media transport failed',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readResponseWithLimit(
    response: Response,
    maxBytes: number,
    expectedType: 'image' | 'video',
    signal?: AbortSignal,
  ): Promise<Buffer> {
    try {
      return await readBoundedResponseBuffer(response, maxBytes, signal);
    } catch (error: unknown) {
      if (error instanceof ResponseByteLimitExceededError) {
        throw new PublisherPostImportTerminalError(
          expectedType === 'image' ? 'image_too_large' : 'media_too_large',
          'Forwarded media exceeds its size limit',
        );
      }
      if (error instanceof EmptyResponseBodyError) {
        throw new PublisherPostImportTerminalError('media_download_failed', 'MAX media is empty');
      }
      throw error;
    }
  }

  private parseAllowedMediaUrl(value: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new PublisherPostImportTerminalError('media_download_failed', 'Invalid MAX media URL');
    }
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '');
    const allowed = POST_IMPORT_ALLOWED_MEDIA_HOSTS.some(
      (root) => hostname === root || hostname.endsWith(`.${root}`),
    );
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      (parsed.port !== '' && parsed.port !== '443') ||
      !allowed
    ) {
      throw new PublisherPostImportTerminalError('media_download_failed', 'Unsafe MAX media URL');
    }
    return parsed;
  }

  private extractAttachmentUrl(
    attachment: Record<string, unknown>,
    expectedType: 'image' | 'video',
  ): string | null {
    const payload = this.asRecord(attachment.payload) ?? attachment;
    if (expectedType === 'video') return extractMaxVideoDownloadUrl(payload);
    const candidates: Array<{ url: string; score: number }> = [];
    const visit = (value: unknown, key: string, depth: number): void => {
      if (depth > 4) {
        return;
      }
      if (typeof value === 'string' && /^https:\/\//iu.test(value.trim())) {
        const normalizedKey = key.toLowerCase();
        let score = normalizedKey.includes('download') ? 500 : normalizedKey === 'url' ? 300 : 100;
        if (expectedType === 'image' && normalizedKey.includes('preview')) {
          score -= 50;
        }
        candidates.push({ url: value.trim(), score });
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, key, depth + 1));
        return;
      }
      const row = this.asRecord(value);
      if (!row) {
        return;
      }
      const width = this.readNumber(row.width ?? row.w) ?? 0;
      const height = this.readNumber(row.height ?? row.h) ?? 0;
      for (const [nestedKey, nestedValue] of Object.entries(row)) {
        const before = candidates.length;
        visit(nestedValue, nestedKey, depth + 1);
        for (let index = before; index < candidates.length; index += 1) {
          candidates[index]!.score += Math.min(200, Math.floor((width * height) / 100_000));
        }
      }
    };
    visit(payload, 'payload', 0);
    candidates.sort((left, right) => right.score - left.score);
    return candidates[0]?.url ?? null;
  }

  private extractVideoToken(attachment: Record<string, unknown>): string | null {
    const payload = this.asRecord(attachment.payload) ?? attachment;
    return this.readString(
      payload.token ?? payload.video_token ?? payload.videoToken ?? payload.id,
    );
  }

  private extractSafeShareUrl(attachment: Record<string, unknown>): string | null {
    const payload = this.asRecord(attachment.payload);
    const candidate = this.readString(payload?.url);
    if (!candidate || candidate.length > POST_IMPORT_MAX_TEXT_LENGTH) {
      return null;
    }
    try {
      const parsed = new URL(candidate);
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.username ||
        parsed.password
      ) {
        return null;
      }
      const normalized = parsed.toString();
      return normalized.length <= POST_IMPORT_MAX_TEXT_LENGTH ? normalized : null;
    } catch {
      return null;
    }
  }

  private async loadRemoteIncomingMessage(
    privateChatId: string,
    incomingMessageId: string,
    publisherBotId: string,
  ): Promise<Record<string, unknown>> {
    const exactResponse = await this.maxClient.getExactMessageRow(
      privateChatId,
      incomingMessageId,
      {
        botId: publisherBotId,
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.PUBLISHER_POST_IMPORT,
        timeoutMs: 5_000,
      },
    );
    if (!exactResponse) {
      throw new PublisherPostImportTerminalError(
        'message_unavailable',
        'Forwarded message disappeared before import',
        'captured_message_absent',
      );
    }
    return this.resolveExactMessage(exactResponse, incomingMessageId);
  }

  private async loadPersistedForwardReceipt(params: {
    sourceWebhookEventId: string | null;
    allowDirect?: boolean;
    publisherBotId: string;
    actorUserId: string;
    privateChatId: string;
    incomingMessageId: string;
  }): Promise<Record<string, unknown> | null> {
    const sourceWebhookEventId = params.sourceWebhookEventId?.trim() ?? '';
    if (!sourceWebhookEventId) {
      throw new PublisherPostImportTerminalError(
        'message_unavailable',
        'Forward receipt identity is unavailable',
        'receipt_identity_missing',
      );
    }
    const receipt = await this.prisma.webhookEvent.findUnique({
      where: { id: sourceWebhookEventId },
      select: { botId: true, normalizedPayload: true },
    });
    if (!receipt) {
      return null;
    }
    if (receipt.botId?.trim() !== params.publisherBotId) {
      throw new PublisherPostImportTerminalError(
        'message_unavailable',
        'Forward receipt does not belong to Publisher',
        'receipt_bot_mismatch',
      );
    }
    const parsed = maxUpdateSchema.safeParse(receipt.normalizedPayload);
    if (!parsed.success) {
      throw new PublisherPostImportTerminalError(
        'message_unavailable',
        'Forward receipt payload is invalid',
        'receipt_payload_invalid',
      );
    }
    const update = parsed.data;
    const normalizedMessage = update.message;
    if (
      update.botId?.trim() !== params.publisherBotId ||
      update.type.trim().toLowerCase() !== 'message_created' ||
      normalizedMessage?.messageId !== params.incomingMessageId ||
      normalizedMessage.chatId !== params.privateChatId ||
      normalizedMessage.senderId !== params.actorUserId
    ) {
      throw new PublisherPostImportTerminalError(
        'message_unavailable',
        'Forward receipt identity does not match the import session',
        'receipt_normalized_identity_mismatch',
      );
    }
    const raw = this.asRecord(update.raw);
    const rawType = this.readString(raw?.update_type ?? raw?.type)?.toLowerCase();
    const rawMessage = this.extractRawWebhookMessage(raw);
    const recipient = this.asRecord(rawMessage?.recipient);
    const sender = this.asRecord(rawMessage?.sender);
    const link = this.asRecord(rawMessage?.link);
    const rawMessageId = rawMessage ? this.readMessageId(rawMessage) : null;
    const rawMessageIdMatches = rawMessageId
      ? rawMessageId === params.incomingMessageId
      : params.incomingMessageId === `message_created:${update.updateId}`;
    if (
      rawType !== 'message_created' ||
      this.readString(recipient?.chat_id ?? recipient?.chatId) !== params.privateChatId ||
      this.readString(recipient?.chat_type ?? recipient?.chatType)?.toLowerCase() !== 'dialog' ||
      this.readString(sender?.user_id ?? sender?.userId ?? sender?.id) !== params.actorUserId ||
      !rawMessageIdMatches ||
      (!params.allowDirect &&
        (this.readString(link?.type)?.toLowerCase() !== 'forward' || !this.asRecord(link?.message)))
    ) {
      throw new PublisherPostImportTerminalError(
        'message_unavailable',
        'Forward raw identity does not match the authenticated receipt',
        'receipt_raw_identity_mismatch',
      );
    }
    return rawMessage!;
  }

  private extractRawWebhookMessage(
    raw: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    const direct = this.asRecord(raw?.message);
    if (direct) {
      return direct;
    }
    for (const key of ['message_created', 'data', 'event']) {
      const envelope = this.asRecord(raw?.[key]);
      const message = this.asRecord(envelope?.message);
      if (message) {
        return message;
      }
    }
    return null;
  }

  private resolveExactMessage(
    response: Record<string, unknown>,
    expectedMessageId: string,
  ): Record<string, unknown> {
    const nested = this.asRecord(response.message);
    if (nested && this.readMessageId(nested) === expectedMessageId) {
      return nested;
    }
    return response;
  }

  private assertExactSender(message: Record<string, unknown>, actorUserId: string): void {
    const sender = this.asRecord(message.sender);
    const senderId = this.readString(
      sender?.user_id ?? sender?.userId ?? sender?.id ?? message.sender_id ?? message.senderId,
    );
    if (senderId !== actorUserId) {
      throw new PublisherPostImportTerminalError(
        'message_unavailable',
        'Exact message sender does not match the import owner',
      );
    }
  }

  private extractLinkedForward(message: Record<string, unknown>): Record<string, unknown> | null {
    const link = this.asRecord(message.link);
    return this.readString(link?.type)?.toLowerCase() === 'forward'
      ? this.asRecord(link?.message)
      : null;
  }

  private extractText(message: Record<string, unknown>): string {
    const body = this.asRecord(message.body);
    return this.readText(message.text ?? body?.text) ?? '';
  }

  private extractAttachments(message: Record<string, unknown>): Record<string, unknown>[] {
    const body = this.asRecord(message.body);
    const value = Array.isArray(message.attachments)
      ? message.attachments
      : Array.isArray(body?.attachments)
        ? body.attachments
        : [];
    return value.flatMap((item) => {
      const row = this.asRecord(item);
      return row ? [row] : [];
    });
  }

  private readAttachmentType(attachment: Record<string, unknown>): string {
    return this.readString(attachment.type)?.toLowerCase() ?? '';
  }

  private readMessageId(message: Record<string, unknown>): string | null {
    const body = this.asRecord(message.body);
    return this.readString(
      message.mid ?? message.id ?? message.message_id ?? message.messageId ?? body?.mid,
    );
  }

  private extensionForMime(mimeType: string, fallback: string): string {
    const subtype = mimeType
      .split('/')[1]
      ?.split('+')[0]
      ?.replace(/[^a-z0-9]/giu, '');
    return subtype || fallback;
  }

  private async fail(
    sessionId: string,
    lockToken: string,
    failureCode: PublisherPostImportFailureCode,
  ): Promise<boolean> {
    const failed = await this.prisma.publisherPostImportSession.updateMany({
      where: {
        id: sessionId,
        status: PublisherPostImportStatus.PROCESSING,
        lockToken,
      },
      data: {
        status: PublisherPostImportStatus.FAILED,
        failureCode,
        notificationKind: 'failed',
        notificationPending: true,
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
        captureGuardUntil: new Date(Date.now() + PUBLISHER_POST_IMPORT_SECOND_FORWARD_GUARD_MS),
        lockedAt: null,
        lockToken: null,
        expiresAt: new Date(Date.now() + PUBLISHER_POST_IMPORT_RESULT_TTL_MS),
      },
    });
    return failed.count > 0;
  }

  private logTerminalFailure(
    sessionId: string,
    failureCode: PublisherPostImportFailureCode,
    rejectionKind: PublisherPostImportRejectionKind,
    snapshotSource: PublisherPostImportSnapshotSource,
    timing: { inputMode: string; elapsedMs: number | null },
  ): void {
    this.logger.log(
      { sessionId, failureCode, rejectionKind, snapshotSource, ...timing },
      'Publisher forwarded post import rejected',
    );
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }
    const normalized = String(value).trim();
    return normalized || null;
  }

  private readText(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private readNumber(value: unknown): number | null {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
  }

  private readHttpStatus(error: unknown): number | null {
    const status = (error as { response?: { status?: unknown }; status?: unknown })?.response
      ?.status;
    const direct = (error as { status?: unknown })?.status;
    const value = typeof status === 'number' ? status : direct;
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
  }
}
