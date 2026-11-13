import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  buildSuggestionRejectionText,
  suggestionRejectionRequestSchema,
  suggestionReviewDetailSchema,
  suggestionReviewWriteSchema,
  type MiniappProfile,
  type SuggestionReviewDetail,
} from '@maxim/contracts/publisher';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { Prisma, type AuditLog } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { ManagedEntitiesService } from './managed-entities.service';
import { PublisherPolicyService } from './publisher-policy.service';
import { PublisherSuggestionService } from './publisher-suggestion.service';
import { ChannelDialogService } from './channel-dialog.service';
import { PublisherDialogLinkService } from '../publisher/publisher-dialog-link.service';
import { ChannelPostSignatureService } from './channel-post-signature.service';
import { buildPublisherSuggestionPublicationText } from './publisher-suggestion-content';
import { buildUserProfileUrl, normalizeMaxProfileUrl } from './admin-profile-links';
import { normalizeMaxUserDisplayName } from '../common/max-user-display-name.util';
import {
  assertSuggestionPublicationLength,
  suggestionContentPatch,
  suggestionEditorText,
  suggestionRevision,
  hasSuggestionRequest,
  suggestionRequestPatch,
  publicationEditorInput,
} from './suggestion-review-content';
import {
  SuggestionReviewEffectsService,
  suggestionObject,
} from './suggestion-review-effects.service';

const actionFor = (profile: MiniappProfile) =>
  profile === 'publisher' ? 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION' : 'CHANNEL_DIALOG_SUGGESTION';
const string = (value: unknown) => (typeof value === 'string' ? value : '');

@Injectable()
export class SuggestionReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entities: ManagedEntitiesService,
    private readonly policy: PublisherPolicyService,
    private readonly publisher: PublisherSuggestionService,
    private readonly dialogs: ChannelDialogService,
    private readonly publisherLinks: PublisherDialogLinkService,
    private readonly signatures: ChannelPostSignatureService,
    private readonly effects: SuggestionReviewEffectsService,
  ) {}

  async authorize(id: string, profile: MiniappProfile, user: AuthUser): Promise<AuditLog> {
    const row = await this.prisma.auditLog.findFirst({ where: { id, action: actionFor(profile) } });
    if (!row || suggestionObject(row.payload).type !== 'suggest')
      throw new NotFoundException('Предложка не найдена.');
    if (profile === 'publisher') await this.policy.getEntity('channel', row.chatId, user);
    else await this.entities.assertChannelAdminAccess(row.chatId, user);
    return row;
  }

  async get(id: string, profile: MiniappProfile, user: AuthUser): Promise<SuggestionReviewDetail> {
    const row = await this.authorize(id, profile, user);
    return this.present(row, profile);
  }

  async save(id: string, profile: MiniappProfile, user: AuthUser, body: unknown) {
    const input = suggestionReviewWriteSchema.safeParse(body);
    if (!input.success) throw new BadRequestException(input.error.format());
    await this.authorize(id, profile, user);
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lock(tx, id, profile);
      const payload = suggestionObject(row.payload);
      if (hasSuggestionRequest(payload, 'save', user.userId, input.data)) return;
      this.assertPending(payload);
      const patch = suggestionContentPatch(payload, input.data, user.userId);
      const effective = {
        ...payload,
        ...patch,
        reviewContentRequestId: input.data.requestId,
        ...suggestionRequestPatch(
          payload,
          'save',
          user.userId,
          input.data,
          suggestionRevision({ ...payload, ...patch }),
        ),
      };
      await this.validateContent(row, effective);
      await tx.auditLog.update({
        where: { id },
        data: { payload: effective as Prisma.InputJsonObject },
      });
      await this.effects.recordSync(tx, id, suggestionRevision(effective), profile);
    });
    await this.effects.enqueueForSuggestion(id);
    return this.get(id, profile, user);
  }

  async publish(id: string, profile: MiniappProfile, user: AuthUser, body: unknown) {
    const parsed = suggestionReviewWriteSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.format());
    const row = await this.authorize(id, profile, user);
    const payload = suggestionObject(row.payload);
    if ((payload.reviewStatus ?? 'pending') === 'pending') {
      await this.validateContent(row, {
        ...payload,
        ...suggestionContentPatch(
          payload,
          publicationEditorInput(payload, user.userId, parsed.data),
          user.userId,
        ),
      });
    }
    // FLAG: The existing publisher claims atomically save and freeze this exact revision.
    if (profile === 'publisher')
      await this.publisher.review(row.chatId, id, user, {
        action: 'publish',
        responseVersion: 2,
        editor: parsed.data,
      });
    else await this.dialogs.reviewSuggestion(id, user, parsed.data);
    return this.get(id, profile, user);
  }

  async preview(id: string, profile: MiniappProfile, user: AuthUser, body: unknown) {
    const parsed = suggestionReviewWriteSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.format());
    const row = await this.authorize(id, profile, user);
    const payload = suggestionObject(row.payload);
    const effective = { ...payload, ...suggestionContentPatch(payload, parsed.data, user.userId) };
    await this.validateContent(row, effective);
    return this.signatures.preparePostText(row.chatId, {
      text: buildPublisherSuggestionPublicationText(row.actorUserId, effective),
      textFormat: 'markdown',
    });
  }

  async reject(id: string, profile: MiniappProfile, user: AuthUser, body: unknown) {
    const parsed = suggestionRejectionRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.format());
    const input = parsed.data;
    await this.authorize(id, profile, user);
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lock(tx, id, profile);
      const payload = suggestionObject(row.payload);
      if (hasSuggestionRequest(payload, 'reject', user.userId, input)) return;
      this.assertPending(payload);
      if (suggestionRevision(payload) !== input.expectedRevision)
        throw new ConflictException('Предложку уже изменили. Обновите её перед решением.');
      const chat = await tx.chat.findUniqueOrThrow({
        where: { id: row.chatId },
        select: { title: true },
      });
      const text =
        input.notifyAuthor && input.reason
          ? buildSuggestionRejectionText(input.reason, chat.title, input.comment)
          : null;
      const botId =
        profile === 'publisher'
          ? this.publisherLinks.getBotId()
          : string(payload.suggestionSourceBotId) || string(payload.mediaBotId);
      if (input.notifyAuthor && !botId)
        throw new BadRequestException(
          'Не удалось определить бота для ответа автору. Можно отклонить без сообщения.',
        );
      const revision = suggestionRevision(payload) + 1;
      await tx.auditLog.update({
        where: { id },
        data: {
          payload: {
            ...payload,
            reviewStatus: 'cancelled',
            reviewContentRevision: revision,
            reviewedAt: new Date().toISOString(),
            reviewedByUserId: user.userId,
            reviewedByDisplayName: user.displayName || user.username || user.userId,
            reviewRejectionRequestId: input.requestId,
            ...suggestionRequestPatch(payload, 'reject', user.userId, input, revision),
            reviewRejectionReason: input.reason ?? null,
            reviewRejectionTemplateVersion: 1,
            reviewRejectionText: text,
            reviewRejectionContactUrl: input.reason === 'paid' ? input.contactUrl || null : null,
          } as Prisma.InputJsonObject,
        },
      });
      if (text)
        await tx.suggestionReviewEffect.create({
          data: {
            suggestionId: id,
            profile,
            botId,
            kind: 'notify',
            revision,
            payload: {
              authorId: row.actorUserId,
              text,
              contactUrl: input.reason === 'paid' ? input.contactUrl : '',
              reviewerId: user.userId,
              requestId: input.requestId,
            },
          },
        });
      await this.effects.recordSync(tx, id, revision, profile);
    });
    await this.effects.enqueueForSuggestion(id);
    return this.get(id, profile, user);
  }

  async asset(id: string, assetId: string, profile: MiniappProfile, user: AuthUser) {
    await this.authorize(id, profile, user);
    const row = await this.prisma.channelSuggestionImageAsset.findFirst({
      where: { auditLogId: id, id: assetId },
    });
    if (
      !row?.bytes ||
      !row.mimeType ||
      !/^(image\/(jpeg|png|webp|avif)|video\/mp4)$/u.test(row.mimeType)
    )
      throw new NotFoundException('Предпросмотр вложения недоступен.');
    return { bytes: Buffer.from(row.bytes), mimeType: row.mimeType };
  }

  private async lock(tx: Prisma.TransactionClient, id: string, profile: MiniappProfile) {
    const rows = await tx.$queryRaw<AuditLog[]>(
      Prisma.sql`SELECT id, chat_id AS "chatId", actor_user_id AS "actorUserId", action, payload, created_at AS "createdAt" FROM audit_logs WHERE id = ${id} AND action = ${actionFor(profile)} FOR UPDATE`,
    );
    if (!rows[0]) throw new NotFoundException('Предложка не найдена.');
    return rows[0];
  }

  private assertPending(payload: Record<string, unknown>) {
    if ((payload.reviewStatus ?? 'pending') !== 'pending' || payload.reviewClaimToken)
      throw new ConflictException('По этой предложке уже принято решение.');
  }

  private async validateContent(row: AuditLog, payload: Record<string, unknown>) {
    if (
      !string(payload.text).trim() &&
      !payload.hasImage &&
      !payload.hasVideo &&
      !Number(payload.imageCount)
    )
      throw new BadRequestException('Добавьте текст публикации.');
    assertSuggestionPublicationLength(row.actorUserId, payload);
    await this.signatures.preparePostText(row.chatId, {
      text: buildPublisherSuggestionPublicationText(row.actorUserId, payload),
      textFormat: 'markdown',
    });
  }

  private async present(row: AuditLog, profile: MiniappProfile): Promise<SuggestionReviewDetail> {
    const payload = suggestionObject(row.payload);
    const original = payload.reviewOriginalContent
      ? suggestionObject(payload.reviewOriginalContent)
      : payload;
    const chat = await this.prisma.chat.findUniqueOrThrow({
      where: { id: row.chatId },
      select: { title: true },
    });
    const identity =
      typeof payload.actorUserId === 'string' && payload.actorUserId !== row.actorUserId
        ? {}
        : payload;
    const name =
      normalizeMaxUserDisplayName(identity.authorDisplayName, row.actorUserId) ??
      normalizeMaxUserDisplayName(identity.authorMentionDisplayName, row.actorUserId) ??
      row.actorUserId;
    const profileUrl =
      normalizeMaxProfileUrl(string(identity.authorProfileUrl)) ??
      buildUserProfileUrl(string(identity.authorUsername));
    const url =
      profileUrl ||
      (name !== row.actorUserId ? `max://user/${encodeURIComponent(row.actorUserId)}` : null);
    const assets = await this.prisma.channelSuggestionImageAsset.findMany({
      where: { auditLogId: row.id },
      orderBy: { position: 'asc' },
      select: { id: true, mimeType: true, fileName: true, sizeBytes: true },
    });
    const preview = await this.signatures.preparePostText(row.chatId, {
      text: buildPublisherSuggestionPublicationText(row.actorUserId, payload),
      textFormat: 'markdown',
    });
    const notification = await this.prisma.suggestionReviewEffect.findFirst({
      where: { suggestionId: row.id, kind: 'notify' },
      orderBy: { createdAt: 'desc' },
      select: { status: true },
    });
    return suggestionReviewDetailSchema.parse({
      id: row.id,
      profile,
      channelId: row.chatId,
      channelTitle: chat.title,
      revision: suggestionRevision(payload),
      text: suggestionEditorText(payload),
      originalText: suggestionEditorText(original),
      status: payload.reviewStatus ?? 'pending',
      author: { userId: row.actorUserId, name, url },
      previewText: preview.text,
      previewFormat: preview.textFormat ?? 'plain',
      media: assets.length
        ? assets.map((asset) => ({
            id: asset.id,
            type: asset.mimeType?.startsWith('video/') ? 'video' : 'image',
            name: asset.fileName ?? 'Вложение',
            available: Boolean(asset.sizeBytes),
          }))
        : payload.hasVideo || payload.hasImage
          ? [
              {
                id: 'original',
                type: payload.hasVideo ? 'video' : 'image',
                name: 'Вложение в сообщении бота',
                available: false,
              },
            ]
          : [],
      contactUrl: string(payload.reviewRejectionContactUrl),
      notification: !notification
        ? 'none'
        : notification.status === 'SENT'
          ? 'sent'
          : notification.status === 'FAILED'
            ? 'failed'
            : notification.status === 'AMBIGUOUS'
              ? 'ambiguous'
              : 'pending',
      rejectionText:
        typeof payload.reviewRejectionText === 'string' ? payload.reviewRejectionText : null,
    });
  }
}
