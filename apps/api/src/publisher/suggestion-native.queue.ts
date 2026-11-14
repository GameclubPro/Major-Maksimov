import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import type { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { PrismaService } from '../prisma/prisma.service';
import { ADMIN_SUGGESTION_DELIVERY_QUEUE } from '../admin/admin-suggestion-delivery.queue';
import { PUBLISHER_SUGGESTION_ADMIN_QUEUE } from './publisher-suggestion-admin.queue';
import { readPublisherPrivateCallback } from './publisher-private-flow-update-reader';
import { readWebhookEventTimestamp } from '../webhook/webhook-semantic-event-key';
import {
  extractIncomingMessageNode,
  extractIncomingMessageMarkup,
} from '../moderation/private-control-markup-importer';
import {
  parseSuggestionNativeCallback,
  SUGGESTION_NATIVE_PREFIX,
  type SuggestionNativeCallback,
} from '../admin/suggestion-native-protocol';
import type { NativeSuggestionContent } from '../admin/suggestion-native-content';

export type SuggestionNativeJob = {
  version: 1;
  kind: 'suggestion-native';
  profile: MiniappProfile;
  requiredBotId: string;
  actorId: string;
  privateChatId: string;
  messageId: string;
  callbackId?: string;
  callback?: SuggestionNativeCallback;
  deliveryId?: string;
  input?: NativeSuggestionContent;
  inputError?: string;
  edited?: boolean;
  openedAt?: string;
  eventId: string;
  requestedAt: string;
};
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const id = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

@Injectable()
export class SuggestionNativeQueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: MaxBotRegistryService,
    @InjectQueue(ADMIN_SUGGESTION_DELIVERY_QUEUE)
    private readonly major: Queue<SuggestionNativeJob>,
    @InjectQueue(PUBLISHER_SUGGESTION_ADMIN_QUEUE)
    private readonly publisher: Queue<SuggestionNativeJob>,
  ) {}

  async observeWebhook(update: MaxUpdate): Promise<boolean> {
    const botId = update.botId;
    const message = update.message;
    if (
      !botId ||
      !message ||
      !/^[1-9]\d{0,30}$/u.test(message.chatId) ||
      message.entityType === 'channel'
    )
      return false;
    const profile =
      botId === this.registry.getPublisherBotDescriptor().id ? 'publisher' : 'moderation';
    if (
      profile === 'moderation' &&
      !this.registry.getActionableBots().some((bot) => bot.id === botId)
    )
      return false;
    const cb = readPublisherPrivateCallback(update);
    let callback = cb ? parseSuggestionNativeCallback(cb.payload) : null;
    const old =
      cb &&
      (profile === 'publisher'
        ? /^psa:v1:(cancel|publish):([A-Za-z0-9_-]{1,160})$/u.exec(cb.payload)
        : /^pc2\|suggestion_review_(cancel|publish)\|([A-Za-z0-9_-]{1,160})$/u.exec(cb.payload));
    if (old)
      callback = {
        action: old[1] === 'publish' ? 'publish' : 'reject',
        id: old[2]!,
        // FLAG: Old publish cards display revision zero; never approve unseen later edits.
        revision: old[1] === 'publish' ? 0 : -1,
        version: 0,
      };
    if (cb && !callback) return cb.payload.startsWith(SUGGESTION_NATIVE_PREFIX);
    if (!cb && !['message_created', 'message_edited'].includes(update.type)) return false;
    const actorId = cb ? cb.actorUserId : message.senderId;
    if (!actorId || !/^[1-9]\d{0,30}$/u.test(actorId) || this.registry.isKnownBotUserId(actorId))
      return Boolean(cb);
    const at = readWebhookEventTimestamp(update);
    if (!at || at.getTime() > Date.now() + 60_000 || Date.now() - at.getTime() > 5 * 60_000)
      return Boolean(cb);
    const job: SuggestionNativeJob = {
      version: 1,
      kind: 'suggestion-native',
      profile,
      requiredBotId: botId,
      actorId,
      privateChatId: message.chatId,
      messageId: message.messageId,
      eventId: update.updateId,
      requestedAt: at.toISOString(),
    };
    if (callback) {
      if (!cb?.callbackId) return true;
      job.callback = callback;
      job.callbackId = cb.callbackId;
    } else {
      const node = extractIncomingMessageNode(update);
      const link = record(node?.link);
      const linked = record(link.message);
      const reply =
        link.type === 'reply' ? id(record(linked.body).mid ?? linked.mid ?? link.mid) : '';
      const edited = update.type === 'message_edited';
      if (!reply && !edited) return false;
      // FLAG: Only an explicit reply to this actor's card, or its bound edit source, owns input.
      const dialog = await this.prisma.suggestionReviewDialog.findFirst({
        where: {
          botId,
          actorId,
          privateChatId: message.chatId,
          ...(edited ? { inputMessageId: message.messageId } : { cardMessageId: reply }),
        },
      });
      if (!dialog) return false;
      job.deliveryId = dialog.deliveryId;
      job.openedAt = dialog.openedAt.toISOString();
      job.edited = edited;
      const body = record(node?.body);
      const text = typeof body.text === 'string' ? body.text : message.text;
      const markup = extractIncomingMessageMarkup(node);
      job.input = { text, markup };
      const rawMarkup = body.markup;
      if (rawMarkup != null && (!Array.isArray(rawMarkup) || rawMarkup.length !== markup.length))
        job.inputError = 'Не удалось прочитать оформление. Пришлите исправленный текст ещё раз.';
      if (text.trimStart().startsWith('/'))
        job.inputError = 'Команда не заменяет текст предложки. Пришлите текст ответом на карточку.';
      if (markup.length > 400) {
        job.input = undefined;
        job.inputError =
          'Слишком много элементов оформления. Упростите оформление и пришлите текст ещё раз.';
      }
      if (text.length > 4000) {
        job.input = undefined;
        job.inputError = 'Текст должен быть не длиннее 4000 символов.';
      }
    }
    const digest = createHash('sha256')
      .update(`${botId}\0${cb?.callbackId ?? update.updateId}`)
      .digest('hex');
    await (profile === 'publisher' ? this.publisher : this.major).add('suggestion-native', job, {
      jobId: `suggestion-native-${digest}`,
      priority: 1,
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 2 * 24 * 3600, count: 5000 },
      removeOnFail: { age: 2 * 24 * 3600, count: 5000 },
    });
    return true;
  }
}
