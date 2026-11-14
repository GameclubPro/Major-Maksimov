import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  buildSuggestionRejectionText,
  suggestionRejectionRequestSchema,
  SUGGESTION_REJECTION_LABELS,
  type SuggestionRejectionReason,
  type SuggestionReviewDetail,
} from '@maxim/contracts/publisher';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxMessageButton,
} from '../max/max-client.service';
import {
  Prisma,
  type SuggestionReviewDialog,
  type ChannelSuggestionAdminDelivery,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { SuggestionNativeJob } from '../publisher/suggestion-native.queue';
import {
  describePrivateSuggestionReviewError,
  privateSuggestionReviewErrorDiagnostic,
} from '../moderation/private-control-channel-suggestion';
import { SuggestionReviewService } from './suggestion-review.service';
import {
  SuggestionReviewEffectsService,
  suggestionObject,
} from './suggestion-review-effects.service';
import { hasSuggestionRequest, suggestionRevision } from './suggestion-review-content';
import { readPendingSuggestionInput, retainSuggestionNativeInput } from './suggestion-native-input';
import { buildPublishedSuggestionButton } from './suggestion-review-links';
import {
  nativeContentSchema,
  nativeSuggestionMarkdown,
  readSuggestionNativeContent,
  mergeSuggestionNativeContent,
  type NativeSuggestionDraft,
} from './suggestion-native-content';
import {
  suggestionNativeButton,
  suggestionNativeButtons,
  type SuggestionNativeAction,
} from './suggestion-native-protocol';

const SESSION_MS = 2 * 60 * 60_000;
const LOCK_MS = 2 * 60_000;
const draftSchema = nativeContentSchema.extend({ warnings: z.array(z.string()).max(400) });
const requestId = (value: string) => {
  const hash = createHash('sha256').update(value).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
type Card = ChannelSuggestionAdminDelivery & {
  privateChatId: string;
  remoteMessageId: string;
  botId: string;
};

@Injectable()
export class SuggestionNativeService {
  private readonly logger = new Logger(SuggestionNativeService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly review: SuggestionReviewService,
    private readonly effects: SuggestionReviewEffectsService,
    private readonly max: MaxClientService,
  ) {}

  async process(job: SuggestionNativeJob, options: { finalAttempt?: boolean } = {}): Promise<void> {
    const responseJob = job;
    let requestedAt = Date.parse(job.requestedAt);
    if (
      !Number.isFinite(requestedAt) ||
      requestedAt > Date.now() + 60_000 ||
      Date.now() - requestedAt > 5 * 60_000
    ) {
      await this.answer(job, 'Кнопка устарела. Нажмите ещё раз.');
      return;
    }
    const card = await this.prisma.channelSuggestionAdminDelivery.findFirst({
      where: {
        ...(job.deliveryId
          ? { id: job.deliveryId }
          : { auditLogId: job.callback?.id, remoteMessageId: job.messageId }),
        botId: job.requiredBotId,
        adminUserId: job.actorId,
        privateChatId: job.privateChatId,
        status: 'SENT',
      },
    });
    if (!card?.botId || !card.privateChatId || !card.remoteMessageId) {
      await this.answer(job, 'Эта карточка больше недоступна.');
      return;
    }
    const bound = card as Card;
    const actor: AuthUser = {
      userId: job.actorId,
      launchBotId: job.requiredBotId,
      username: null,
      displayName: null,
      chatId: job.privateChatId,
      chatType: 'dialog',
    };
    let token: string | null = null;
    let notice = '';
    let stage = 'authorization';
    try {
      const row = await this.review.authorize(card.auditLogId, job.profile, actor);
      await this.effects.assertDispatchAccess(
        row.chatId,
        job.requiredBotId,
        job.profile,
        job.actorId,
      );
      const revision = suggestionRevision(suggestionObject(row.payload));
      await this.prisma.suggestionReviewDialog.upsert({
        where: { deliveryId: card.id },
        update: {},
        create: {
          deliveryId: card.id,
          botId: job.requiredBotId,
          actorId: job.actorId,
          privateChatId: job.privateChatId,
          cardMessageId: card.remoteMessageId,
          profile: job.profile,
          revision,
          expiresAt: new Date(Date.now() + SESSION_MS),
        },
      });
      await retainSuggestionNativeInput(this.prisma, job);
      token = randomUUID();
      const claim = await this.prisma.suggestionReviewDialog.updateMany({
        where: {
          deliveryId: card.id,
          OR: [{ lockToken: null }, { lockedAt: { lt: new Date(Date.now() - LOCK_MS) } }],
        },
        data: { lockToken: token, lockedAt: new Date() },
      });
      if (claim.count !== 1) {
        if (!job.callback) throw new ServiceUnavailableException('Карточка обновляется.');
        throw new ConflictException('Карточка обновляется. Повторите нажатие.');
      }
      let session = await this.prisma.suggestionReviewDialog.findUniqueOrThrow({
        where: { deliveryId: card.id },
      });
      const pendingInput = readPendingSuggestionInput(session.draft);
      // FLAG: A queued callback may overtake an input retry or a failed Redis handoff.
      // Consume only the retained latest input; this callback cannot approve its unseen preview.
      if (
        pendingInput &&
        !(job.callback?.action === 'back' && job.callback.version === session.version)
      ) {
        job = { ...job, ...pendingInput, callback: undefined, callbackId: undefined };
        requestedAt = Date.parse(job.requestedAt);
        notice = 'Текст обновлён. Проверьте предпросмотр перед публикацией.';
        if (Date.now() - requestedAt > 5 * 60_000)
          throw new BadRequestException('Правка устарела. Пришлите исправленный текст ещё раз.');
      }
      let detail = await this.review.get(card.auditLogId, job.profile, actor);
      stage = 'review';
      if (detail.status === 'publishing') {
        await this.review.reconcilePublication(card.auditLogId, job.profile, actor);
        detail = await this.review.get(card.auditLogId, job.profile, actor);
      }
      // FLAG: A failed pre-dispatch publication may already have saved this exact edit.
      // Only its original actor/action/body receipt permits crossing that revision change.
      const retainedPublishInput = {
        requestId: requestId(`${card.id}\0${session.revision}\0${session.version}\0publish`),
        expectedRevision: session.revision,
        ...(session.mode === 'preview'
          ? { text: nativeSuggestionMarkdown(this.readDraft(session)) }
          : {}),
      };
      const acceptedPublishRetry =
        job.callback?.action === 'publish' &&
        ['idle', 'preview'].includes(session.mode) &&
        hasSuggestionRequest(
          suggestionObject(row.payload),
          'publish',
          actor.userId,
          retainedPublishInput,
        );
      if (session.lastEventId !== job.eventId && detail.status === 'pending') {
        if (session.mode !== 'idle' && session.expiresAt < new Date()) {
          session = await this.change(session, token, job, {
            mode: 'idle',
            revision: detail.revision,
            draft: Prisma.DbNull,
            inputMessageId: null,
            inputAt: null,
          });
          notice = 'Время редактирования истекло. Нажмите «Править», чтобы начать снова.';
        } else if (job.callback?.action === 'hint') notice = this.hint(session.mode);
        else if (job.callback?.action === 'back' && job.callback.version === session.version) {
          session = await this.change(session, token, job, {
            mode: 'idle',
            revision: detail.revision,
            draft: Prisma.DbNull,
            inputMessageId: null,
            inputAt: null,
          });
        } else if (
          (job.callback &&
            job.callback.revision >= 0 &&
            job.callback.revision !== detail.revision &&
            !acceptedPublishRetry) ||
          (!job.callback && session.revision !== detail.revision)
        ) {
          notice =
            'Предложку уже изменил другой администратор. Ваш текст сохранён в сообщении; откройте актуальную карточку.';
          session = await this.change(session, token, job, {
            mode: 'idle',
            revision: detail.revision,
            inputMessageId: null,
            inputAt: null,
          });
        } else if (
          job.callback &&
          job.callback.version !== session.version &&
          !(job.callback.version === 0 && session.mode === 'idle')
        ) {
          notice = 'Используйте текущие кнопки под постом.';
        } else if (
          !job.callback &&
          (job.openedAt !== session.openedAt.toISOString() ||
            requestedAt < session.openedAt.getTime())
        ) {
          notice = 'Этот ответ относится к предыдущему редактированию.';
        } else if (
          !job.callback &&
          (session.expiresAt < new Date() ||
            !['edit', 'preview', 'format', 'contact', 'contact_confirm'].includes(session.mode))
        ) {
          notice = 'Редактирование завершено. Нажмите «Править», чтобы начать снова.';
        } else {
          const action = job.callback?.action;
          const identity = requestId(
            `${card.id}\0${session.revision}\0${session.version}\0${action ?? job.eventId}`,
          );
          if (action === 'edit') {
            session = await this.change(session, token, job, {
              mode: 'edit',
              openedAt: new Date(job.requestedAt),
              revision: detail.revision,
              draft: Prisma.DbNull,
              inputMessageId: null,
              inputAt: null,
            });
            notice = this.hint('edit');
          } else if (action === 'reject') {
            session = await this.change(session, token, job, {
              mode: 'reject',
              revision: detail.revision,
              draft: Prisma.DbNull,
              inputMessageId: null,
              inputAt: null,
            });
            notice = 'Выберите причину — ответ будет отправлен автору.';
          } else if (action === 'contact') {
            session = await this.change(session, token, job, {
              mode: 'contact',
              openedAt: new Date(job.requestedAt),
              draft: Prisma.DbNull,
              inputMessageId: null,
              inputAt: null,
            });
            notice = this.hint('contact');
          } else if (action === 'accept_format' && session.mode === 'format') {
            const draft = this.readDraft(session);
            session = await this.change(session, token, job, {
              mode: 'preview',
              draft: { ...draft, warnings: [] },
            });
          } else if (action === 'publish' || action === 'save') {
            if (!['idle', 'preview'].includes(session.mode))
              throw new BadRequestException('Сначала проверьте исправленный текст.');
            const draft = session.mode === 'preview' ? this.readDraft(session) : null;
            const input = {
              requestId: identity,
              expectedRevision: acceptedPublishRetry ? session.revision : detail.revision,
              ...(draft ? { text: nativeSuggestionMarkdown(draft) } : {}),
            };
            await this.assertLock(session, token);
            if (action === 'publish')
              await this.review.publish(card.auditLogId, job.profile, actor, input);
            else await this.review.save(card.auditLogId, job.profile, actor, input);
            detail = await this.review.get(card.auditLogId, job.profile, actor);
            session = await this.change(session, token, job, {
              mode: 'idle',
              revision: detail.revision,
              draft: Prisma.DbNull,
              inputMessageId: null,
              inputAt: null,
            });
            notice = action === 'save' ? 'Правки сохранены.' : 'Предложка передана в публикацию.';
          } else if (action === 'confirm_contact' && session.mode === 'contact_confirm') {
            const contactUrl = z.object({ contactUrl: z.string() }).parse(session.draft).contactUrl;
            const input = this.rejection(identity, detail.revision, 'paid', contactUrl);
            await this.assertLock(session, token);
            await this.prisma.suggestionReviewContact.upsert({
              where: { channelId: detail.channelId },
              create: { channelId: detail.channelId, url: contactUrl, actorId: job.actorId },
              update: { url: contactUrl, actorId: job.actorId },
            });
            await this.review.reject(card.auditLogId, job.profile, actor, input);
            session = await this.change(session, token, job, {
              mode: 'idle',
              draft: Prisma.DbNull,
              inputMessageId: null,
              inputAt: null,
            });
          } else if (action && (action === 'silent' || action in SUGGESTION_REJECTION_LABELS)) {
            if (session.mode !== 'reject')
              throw new BadRequestException('Сначала выберите «Отклонить».');
            const contact =
              action === 'paid'
                ? await this.prisma.suggestionReviewContact.findUnique({
                    where: { channelId: detail.channelId },
                  })
                : null;
            if (action === 'paid' && !contact) {
              session = await this.change(session, token, job, {
                mode: 'contact',
                openedAt: new Date(job.requestedAt),
                draft: Prisma.DbNull,
              });
              notice = this.hint('contact');
            } else {
              const input = this.rejection(
                identity,
                detail.revision,
                action as SuggestionRejectionReason | 'silent',
                contact?.url ?? '',
              );
              await this.assertLock(session, token);
              await this.review.reject(card.auditLogId, job.profile, actor, input);
              session = await this.change(session, token, job, {
                mode: 'idle',
                draft: Prisma.DbNull,
                inputMessageId: null,
                inputAt: null,
              });
            }
          } else if (!job.callback) {
            if (job.inputError) throw new BadRequestException(job.inputError);
            if (!job.input) return;
            if (!pendingInput && session.inputAt && requestedAt <= session.inputAt.getTime())
              return;
            if (job.edited && session.inputMessageId !== job.messageId) return;
            if (['contact', 'contact_confirm'].includes(session.mode)) {
              const contactUrl = job.input.text.trim();
              this.rejection(identity, detail.revision, 'paid', contactUrl);
              session = await this.change(session, token, job, {
                mode: 'contact_confirm',
                draft: { contactUrl },
                inputMessageId: job.messageId,
                inputAt: new Date(job.requestedAt),
              });
            } else {
              const stored = await this.review.authorize(card.auditLogId, job.profile, actor);
              // FLAG: Compare every replacement with saved content so resending plain text cannot erase a link warning.
              const base = readSuggestionNativeContent(suggestionObject(stored.payload));
              const draft = mergeSuggestionNativeContent(base, job.input);
              await this.review.preview(card.auditLogId, job.profile, actor, {
                requestId: identity,
                expectedRevision: detail.revision,
                text: nativeSuggestionMarkdown(draft),
              });
              session = await this.change(session, token, job, {
                mode: draft.warnings.length ? 'format' : 'preview',
                draft,
                inputMessageId: job.messageId,
                inputAt: new Date(job.requestedAt),
              });
            }
          }
        }
      }
      detail = await this.review.get(card.auditLogId, job.profile, actor);
      stage = 'card_update';
      await this.render(job, bound, session, token, detail, actor);
      await this.answer(responseJob, notice || this.status(detail));
    } catch (error) {
      this.logger.warn(
        {
          suggestionId: card.auditLogId,
          profile: job.profile,
          stage,
          ...privateSuggestionReviewErrorDiagnostic(error),
        },
        'Native suggestion review did not complete',
      );
      const message = describePrivateSuggestionReviewError(error);
      if (!(error instanceof HttpException) || error.getStatus() >= 500) {
        if (options.finalAttempt) await this.answer(responseJob, message);
        throw error;
      }
      await this.answer(responseJob, message);
      // FLAG: A text reply has no callback toast: display the error on the same card without saving it.
      if (!job.callbackId && token) {
        let session = await this.prisma.suggestionReviewDialog.findUnique({
          where: { deliveryId: card.id },
        });
        if (session?.lockToken === token) {
          if (readPendingSuggestionInput(session.draft)?.eventId === job.eventId) {
            session = await this.change(session, token, job, { draft: Prisma.DbNull });
          }
          const detail = await this.review.get(card.auditLogId, job.profile, actor);
          await this.render(job, bound, session, token, detail, actor, message);
        }
      }
    } finally {
      if (token)
        await this.prisma.suggestionReviewDialog.updateMany({
          where: { deliveryId: card.id, lockToken: token },
          data: { lockToken: null, lockedAt: null },
        });
    }
  }

  private rejection(
    request: string,
    revision: number,
    reason: SuggestionRejectionReason | 'silent',
    contactUrl = '',
  ) {
    const input = {
      requestId: request,
      expectedRevision: revision,
      notifyAuthor: reason !== 'silent',
      ...(reason !== 'silent' ? { reason } : {}),
      contactUrl,
    };
    const parsed = suggestionRejectionRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new BadRequestException('Пришлите ссылку на контакт в MAX: https://max.ru/…');
    return parsed.data;
  }

  private readDraft(session: SuggestionReviewDialog): NativeSuggestionDraft {
    const parsed = draftSchema.safeParse(session.draft);
    if (!parsed.success) throw new BadRequestException('Пришлите исправленный текст ещё раз.');
    return parsed.data;
  }

  private async change(
    session: SuggestionReviewDialog,
    token: string,
    job: SuggestionNativeJob,
    data: Prisma.SuggestionReviewDialogUpdateManyMutationInput,
  ) {
    const changed = await this.prisma.suggestionReviewDialog.updateMany({
      where: { deliveryId: session.deliveryId, lockToken: token, version: session.version },
      data: {
        ...data,
        version: { increment: 1 },
        lastEventId: job.eventId,
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + SESSION_MS),
      },
    });
    if (changed.count !== 1) throw new ConflictException('Карточку уже обновили.');
    return this.prisma.suggestionReviewDialog.findUniqueOrThrow({
      where: { deliveryId: session.deliveryId },
    });
  }

  private async assertLock(session: SuggestionReviewDialog, token: string) {
    const current = await this.prisma.suggestionReviewDialog.findUnique({
      where: { deliveryId: session.deliveryId },
    });
    if (current?.lockToken !== token || current.version !== session.version)
      throw new ConflictException('Карточку уже обновили.');
  }

  private hint(mode: string) {
    return mode === 'contact'
      ? 'Пришлите ссылку на администратора ответом на эту карточку. Контакт сохранится для канала.'
      : 'Скопируйте текст, исправьте и отправьте ответом на эту карточку. Автор и вложения сохранятся.';
  }

  private status(detail: SuggestionReviewDetail) {
    if (detail.status === 'cancelled')
      return detail.notification === 'sent'
        ? 'Отклонено · ответ отправлен'
        : detail.notification === 'pending'
          ? 'Отклонено · ответ отправляется'
          : detail.notification === 'ambiguous'
            ? 'Отклонено · доставка не подтверждена'
            : detail.notification === 'failed'
              ? 'Отклонено · ответ не доставлен'
              : 'Отклонено без сообщения';
    if (detail.status === 'published')
      return detail.profile === 'publisher' ? 'Передано в публикацию' : 'Опубликовано';
    if (detail.status === 'publishing') return 'Публикация обрабатывается';
    if (detail.status === 'drafted') return 'Передано в черновик';
    return 'Предложка на рассмотрении';
  }

  private async render(
    job: SuggestionNativeJob,
    card: Card,
    session: SuggestionReviewDialog,
    token: string,
    detail: SuggestionReviewDetail,
    actor: AuthUser,
    error = '',
  ) {
    const button = (label: string, action: SuggestionNativeAction) =>
      suggestionNativeButton(label, action, detail.id, detail.revision, session.version);
    let text = detail.previewText;
    let banner = error;
    let format: 'markdown' | 'html' | undefined =
      detail.previewFormat === 'plain' ? undefined : detail.previewFormat;
    let buttons: MaxMessageButton[][] = suggestionNativeButtons(
      detail.id,
      detail.revision,
      session.version,
    );
    if (detail.status !== 'pending') {
      const published =
        detail.status === 'published' && detail.profile === 'moderation'
          ? buildPublishedSuggestionButton(
              detail.profile,
              suggestionObject(
                (await this.review.authorize(detail.id, job.profile, actor)).payload,
              ),
            )
          : null;
      buttons = [[published ?? button(this.status(detail), 'hint')]];
    } else if (session.mode === 'edit') {
      const row = await this.review.authorize(detail.id, job.profile, actor);
      const content = readSuggestionNativeContent(suggestionObject(row.payload));
      text = nativeSuggestionMarkdown(content) || 'Пришлите подпись ответом на эту карточку.';
      format = 'markdown';
      buttons = [
        [button('Как править', 'hint')],
        ...(content.text.length && content.text.length <= 1024
          ? [[{ type: 'clipboard' as const, text: 'Скопировать текст', payload: content.text }]]
          : []),
        [button('Отмена', 'back')],
      ];
    } else if (session.mode === 'preview' || session.mode === 'format') {
      const draft = this.readDraft(session);
      const preview = await this.review.preview(detail.id, job.profile, actor, {
        requestId: randomUUID(),
        expectedRevision: detail.revision,
        text: nativeSuggestionMarkdown(draft),
      });
      text = preview.text;
      format = preview.textFormat;
      buttons =
        session.mode === 'format'
          ? [[button('Принять новое оформление', 'accept_format')], [button('Отмена', 'back')]]
          : [
              [button('Опубликовать', 'publish')],
              [button('Сохранить', 'save'), button('Отмена', 'back')],
            ];
      if (draft.warnings.length)
        banner = [
          banner,
          `Не удалось однозначно сохранить:\n${draft.warnings.slice(0, 5).join('\n')}\n\nПришлите текст с нужным оформлением или примите новый вариант.`,
        ]
          .filter(Boolean)
          .join('\n\n');
    } else if (session.mode === 'reject') {
      buttons = Object.entries(SUGGESTION_REJECTION_LABELS).map(([reason, label]) => [
        button(label, reason as SuggestionRejectionReason),
      ]);
      buttons.push([button('Без сообщения', 'silent'), button('Назад', 'back')]);
      const contact = await this.prisma.suggestionReviewContact.findUnique({
        where: { channelId: detail.channelId },
      });
      if (contact) buttons.push([button('Изменить контакт', 'contact')]);
    } else if (session.mode === 'contact') {
      text =
        'Пришлите ссылку на администратора в MAX ответом на эту карточку.\n\nКонтакт сохранится для платных объявлений этого канала.';
      format = undefined;
      buttons = [[button('Назад', 'reject')]];
    } else if (session.mode === 'contact_confirm') {
      const contact = z.object({ contactUrl: z.string() }).parse(session.draft);
      text = `${buildSuggestionRejectionText('paid', detail.channelTitle)}\n\nКонтакт: ${contact.contactUrl}`;
      format = undefined;
      buttons = [
        [button('Сохранить и отправить', 'confirm_contact')],
        [button('Изменить контакт', 'contact'), button('Назад', 'reject')],
      ];
    }
    if (banner) {
      const escaped =
        format === 'markdown'
          ? nativeSuggestionMarkdown({ text: banner, markup: [] })
          : format === 'html'
            ? banner.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
            : banner;
      if (escaped.length + text.length + 2 <= 4000) text = `${escaped}\n\n${text}`;
      else {
        // FLAG: Never offer publication while showing a different or truncated draft.
        text = `${banner}\n\nСократите текст и пришлите его ответом на эту карточку.`;
        format = undefined;
        buttons = [[button('Отмена', 'back')]];
      }
    }
    const edited = await this.max.editMessageInlineKeyboard(
      card.privateChatId,
      card.remoteMessageId,
      text,
      {
        buttons,
        textFormat: format,
        requireAllAttachmentsPreserved: true,
        replaceOwnedInlineKeyboard: true,
        beforeEditMutation: async () => {
          await this.assertLock(session, token);
          await this.effects.assertDispatchAccess(
            detail.channelId,
            job.requiredBotId,
            job.profile,
            job.actorId,
          );
          const row = await this.review.authorize(detail.id, job.profile, actor);
          if (suggestionRevision(suggestionObject(row.payload)) !== detail.revision)
            throw new ConflictException('Предложку уже изменили.');
        },
      },
      {
        botId: job.requiredBotId,
        sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
        timeoutMs: 8000,
      },
    );
    if (edited !== true) throw new Error('Native suggestion card edit was not confirmed');
  }

  private async answer(job: SuggestionNativeJob, text: string) {
    if (!job.callbackId) return;
    try {
      await this.max.answerCallback(job.callbackId, text.slice(0, 200), undefined, {
        botId: job.requiredBotId,
        rateLimitEntityId: job.privateChatId,
        sourceTag: MAX_API_SOURCE_TAGS.CALLBACK_ANSWER,
      });
    } catch {
      /* The persisted card remains authoritative after the toast expires. */
    }
  }
}
