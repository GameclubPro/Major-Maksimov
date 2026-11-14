import { InjectQueue } from '@nestjs/bullmq';
import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import { Prisma, type SuggestionReviewEffect } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { PublisherReadinessService } from '../publisher/publisher-readiness.service';
import {
  ADMIN_SUGGESTION_DELIVERY_QUEUE,
  type AdminSuggestionDeliveryJob,
} from './admin-suggestion-delivery.queue';
import {
  PUBLISHER_SUGGESTION_ADMIN_QUEUE,
  type PublisherSuggestionAdminJob,
} from '../publisher/publisher-suggestion-admin.queue';
import { buildChannelSuggestionAdminMessagePayload } from './admin-channel-suggestion-presentation';
import { readChannelSuggestionTextMarkup } from './admin-channel-dialog-values';
import {
  buildPublishedSuggestionButton,
  buildSuggestionReviewButtons,
} from './suggestion-review-links';
import { suggestionRevision } from './suggestion-review-content';
import { privateSuggestionReviewErrorDiagnostic } from '../moderation/private-control-channel-suggestion';

export const suggestionObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) => (typeof value === 'string' ? value : '');
const STALE_MS = 120_000;
const PREPARATION_DEADLINE_MS = 24 * 60 * 60_000;

class SuggestionReviewRecipientAccessRemoved extends ForbiddenException {}

@Injectable()
export class SuggestionReviewEffectsService {
  private readonly logger = new Logger(SuggestionReviewEffectsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly links: MaxBotLinkService,
    @InjectQueue(ADMIN_SUGGESTION_DELIVERY_QUEUE)
    private readonly majorQueue: Queue<AdminSuggestionDeliveryJob>,
    @InjectQueue(PUBLISHER_SUGGESTION_ADMIN_QUEUE)
    private readonly publisherQueue: Queue<PublisherSuggestionAdminJob>,
    private readonly registry: MaxBotRegistryService,
    private readonly readiness: PublisherReadinessService,
  ) {}

  async recordSync(
    tx: Prisma.TransactionClient,
    suggestionId: string,
    revision: number,
    profile: MiniappProfile,
  ): Promise<void> {
    const cards = await tx.channelSuggestionAdminDelivery.findMany({
      where: { auditLogId: suggestionId, status: 'SENT', botId: { not: null } },
      select: { botId: true },
      distinct: ['botId'],
    });
    for (const card of cards) {
      if (!card.botId) continue;
      await tx.suggestionReviewEffect.upsert({
        where: {
          suggestionId_kind_revision_botId: {
            suggestionId,
            kind: 'sync',
            revision,
            botId: card.botId,
          },
        },
        create: { suggestionId, profile, botId: card.botId, revision, kind: 'sync', payload: {} },
        update: {},
      });
    }
  }

  async syncAfterDelivery(suggestionId: string, profile: MiniappProfile): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.auditLog.findUnique({
        where: { id: suggestionId },
        select: { action: true, payload: true },
      });
      if (
        !row ||
        row.action !==
          (profile === 'publisher'
            ? 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
            : 'CHANNEL_DIALOG_SUGGESTION')
      )
        return;
      const revision = suggestionRevision(suggestionObject(row.payload));
      if (!revision) return;
      await this.recordSync(tx, suggestionId, revision, profile);
      // FLAG: A new receipt may arrive after an earlier sync completed; editing a card is repeatable.
      await tx.suggestionReviewEffect.updateMany({
        where: { suggestionId, profile, kind: 'sync', revision, status: 'SENT' },
        data: { status: 'PENDING', nextAttemptAt: new Date() },
      });
    });
    await this.enqueueForSuggestion(suggestionId);
  }

  async enqueueForSuggestion(suggestionId: string): Promise<void> {
    const rows = await this.prisma.suggestionReviewEffect.findMany({
      where: { suggestionId, status: 'PENDING' },
      take: 25,
    });
    for (const row of rows) {
      try {
        await this.enqueue(row);
      } catch {
        this.logger.warn({ effectId: row.id }, 'Suggestion review effect awaits queue recovery');
      }
    }
  }

  private async enqueue(row: SuggestionReviewEffect): Promise<void> {
    const options = {
      jobId: `suggestion-review-${row.id}`,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    };
    if (row.profile === 'publisher') {
      await this.publisherQueue.add(
        'review-effect',
        {
          kind: 'review-effect',
          version: 1,
          effectId: row.id,
          requiredBotId: row.botId,
          requestedAt: new Date().toISOString(),
        },
        options,
      );
    } else {
      await this.majorQueue.add(
        'review-effect',
        { kind: 'review-effect', effectId: row.id },
        options,
      );
    }
  }

  async upgradeNativeCards(profile: MiniappProfile): Promise<void> {
    const upgradeProfile = profile === 'moderation' ? 'moderation:published-link-v1' : profile;
    const state = await this.prisma.suggestionReviewCardUpgrade.upsert({
      where: { profile: upgradeProfile },
      create: { profile: upgradeProfile },
      update: {},
    });
    if (state.completed) return;
    // FLAG: Walk primary keys before payload/status predicates; historical density cannot enlarge a page.
    const cards = await this.prisma.channelSuggestionAdminDelivery.findMany({
      where: { id: { gt: state.cursor } },
      orderBy: { id: 'asc' },
      take: 25,
      select: { id: true, auditLogId: true, status: true, botId: true, botKey: true },
    });
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.suggestionReviewCardUpgrade.updateMany({
        where: { profile: upgradeProfile, cursor: state.cursor, completed: false },
        data: { cursor: cards.at(-1)?.id ?? state.cursor, completed: cards.length < 25 },
      });
      if (changed.count !== 1) return;
      for (const card of cards) {
        if (
          card.status !== 'SENT' ||
          !card.botId ||
          card.botKey.startsWith('publisher:') !== (profile === 'publisher')
        )
          continue;
        const row = await tx.auditLog.findUnique({
          where: { id: card.auditLogId },
          select: { action: true, payload: true },
        });
        const payload = suggestionObject(row?.payload);
        const published = buildPublishedSuggestionButton(profile, payload);
        if (
          row?.action !==
            (profile === 'publisher'
              ? 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
              : 'CHANNEL_DIALOG_SUGGESTION') ||
          ((payload.reviewStatus ?? 'pending') !== 'pending' && !published)
        )
          continue;
        const revision = suggestionRevision(payload);
        const effect = await tx.suggestionReviewEffect.upsert({
          where: {
            suggestionId_kind_revision_botId: {
              suggestionId: card.auditLogId,
              kind: 'native-sync',
              revision,
              botId: card.botId,
            },
          },
          create: {
            suggestionId: card.auditLogId,
            profile,
            botId: card.botId,
            kind: 'native-sync',
            revision,
            payload: published ? { publishedLinkVersion: 1 } : {},
          },
          update: {},
        });
        // FLAG: The versioned cursor refreshes confirmed cards once; only repeatable PUT work reopens.
        if (published && suggestionObject(effect.payload).publishedLinkVersion !== 1)
          await tx.suggestionReviewEffect.updateMany({
            where: {
              id: effect.id,
              kind: 'native-sync',
              status: { in: ['PENDING', 'SENT'] },
              attemptedAt: null,
            },
            data: {
              status: 'PENDING',
              nextAttemptAt: new Date(),
              payload: {
                ...suggestionObject(effect.payload),
                publishedLinkVersion: 1,
              } as Prisma.InputJsonObject,
            },
          });
      }
    });
  }

  async recover(profile: MiniappProfile): Promise<void> {
    const stale = new Date(Date.now() - STALE_MS);
    for (const status of ['PROCESSING', 'SENDING']) {
      const rows = await this.prisma.suggestionReviewEffect.findMany({
        where: { profile, status, lockedAt: { lt: stale } },
        orderBy: [{ lockedAt: 'asc' }, { id: 'asc' }],
        take: 25,
      });
      for (const row of rows) {
        // FLAG: A persisted SEND start is never replay authority, including after a worker crash.
        await this.prisma.suggestionReviewEffect.updateMany({
          where: { id: row.id, status, lockToken: row.lockToken, lockedAt: row.lockedAt },
          data: {
            status: row.attemptedAt ? 'AMBIGUOUS' : 'PENDING',
            nextAttemptAt: new Date(),
            lockedAt: null,
            lockToken: null,
          },
        });
      }
    }
    const due = await this.prisma.suggestionReviewEffect.findMany({
      where: { profile, status: 'PENDING', nextAttemptAt: { lte: new Date() } },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: 25,
    });
    for (const row of due) {
      try {
        await this.enqueue(row);
        await this.prisma.suggestionReviewEffect.updateMany({
          where: { id: row.id, status: 'PENDING', nextAttemptAt: row.nextAttemptAt },
          data: { nextAttemptAt: new Date(Date.now() + 60_000) },
        });
      } catch {
        this.logger.warn({ effectId: row.id }, 'Suggestion review effect queue unavailable');
      }
    }
  }

  async process(id: string, profile: MiniappProfile, requiredBotId?: string): Promise<void> {
    const row = await this.prisma.suggestionReviewEffect.findUnique({ where: { id } });
    if (!row || row.profile !== profile || (requiredBotId && row.botId !== requiredBotId)) return;
    const token = randomUUID();
    const claimed = await this.prisma.suggestionReviewEffect.updateMany({
      where: { id, status: 'PENDING', attemptedAt: null },
      data: { status: 'PROCESSING', lockToken: token, lockedAt: new Date() },
    });
    if (claimed.count !== 1) return;
    let attempted = false;
    let remoteMessageId: string | null = null;
    try {
      if (row.kind === 'sync' || row.kind === 'native-sync') {
        await this.sync(row, token);
        await this.finish(id, token, 'SENT');
        return;
      }
      const payload = suggestionObject(row.payload);
      const source = await this.prisma.auditLog.findUnique({
        where: { id: row.suggestionId },
        select: { actorUserId: true, chatId: true, action: true, payload: true },
      });
      if (
        !source ||
        source.actorUserId !== payload.authorId ||
        suggestionObject(source.payload).reviewRejectionRequestId !== payload.requestId ||
        suggestionObject(source.payload).reviewStatus !== 'cancelled' ||
        source.action !==
          (profile === 'publisher'
            ? 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
            : 'CHANNEL_DIALOG_SUGGESTION')
      )
        throw new Error('Suggestion rejection binding changed');
      const contact = string(payload.contactUrl);
      const result = await this.max.sendMessageImmediateToUser(
        source.actorUserId,
        string(payload.text),
        {
          ...(contact
            ? {
                buttons: [
                  [{ type: 'link' as const, text: 'Связаться с администратором', url: contact }],
                ],
              }
            : {}),
          beforeSend: async () => {
            await this.assertDispatchAccess(
              source.chatId,
              row.botId,
              profile,
              string(payload.reviewerId),
            );
            if (Date.now() - row.createdAt.getTime() > PREPARATION_DEADLINE_MS)
              throw new Error('Suggestion reply preparation expired');
            const started = await this.prisma.suggestionReviewEffect.updateMany({
              where: { id, status: 'PROCESSING', lockToken: token, attemptedAt: null },
              data: { status: 'SENDING', attemptedAt: new Date(), lockedAt: new Date() },
            });
            if (started.count !== 1) throw new Error('Suggestion reply dispatch ownership lost');
            attempted = true;
          },
        },
        { botId: row.botId, sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY, timeoutMs: 8_000 },
      );
      remoteMessageId = result.messageId;
      await this.prisma.suggestionReviewEffect.updateMany({
        where: { id, lockToken: token, status: 'SENDING' },
        data: {
          status: 'SENT',
          remoteMessageId: result.messageId,
          lockedAt: null,
          lockToken: null,
        },
      });
    } catch (error) {
      // FLAG: Unknown errors after SEND and failures persisting a positive receipt stay fenced.
      const httpStatus = (error as { response?: { status?: number } })?.response?.status;
      const definiteRejection =
        !remoteMessageId &&
        typeof httpStatus === 'number' &&
        httpStatus >= 400 &&
        httpStatus < 500 &&
        httpStatus !== 408;
      const status = remoteMessageId
        ? 'SENT'
        : attempted
          ? definiteRejection
            ? 'FAILED'
            : 'AMBIGUOUS'
          : error instanceof ForbiddenException ||
              Date.now() - row.createdAt.getTime() > PREPARATION_DEADLINE_MS
            ? 'FAILED'
            : 'PENDING';
      await this.prisma.suggestionReviewEffect.updateMany({
        where: { id, lockToken: token, status: { in: ['PROCESSING', 'SENDING'] } },
        data: {
          status,
          ...(remoteMessageId ? { remoteMessageId } : {}),
          nextAttemptAt: new Date(Date.now() + 60_000),
          lockedAt: null,
          lockToken: null,
          lastError: attempted
            ? 'Не удалось подтвердить доставку ответа.'
            : 'Ожидает повторной подготовки.',
        },
      });
      this.logger.warn(
        {
          effectId: id,
          kind: row.kind,
          status,
          attempted,
          ...privateSuggestionReviewErrorDiagnostic(error),
        },
        'Suggestion review effect did not complete',
      );
    }
  }

  private async finish(id: string, token: string, status: string) {
    await this.prisma.suggestionReviewEffect.updateMany({
      where: { id, lockToken: token, status: 'PROCESSING' },
      data: { status, lockToken: null, lockedAt: null },
    });
  }

  private async sync(effect: SuggestionReviewEffect, token: string): Promise<void> {
    const row = await this.prisma.auditLog.findUnique({
      where: { id: effect.suggestionId },
      include: { chat: { select: { title: true } } },
    });
    if (!row) return;
    const payload = suggestionObject(row.payload);
    const storedStatus = string(payload.reviewStatus);
    if (storedStatus === 'publishing') throw new Error('Awaiting committed publication state');
    const status =
      storedStatus === 'published' || storedStatus === 'drafted' || storedStatus === 'cancelled'
        ? storedStatus
        : 'pending';
    const profile = effect.profile as MiniappProfile;
    const published = buildPublishedSuggestionButton(profile, payload);
    const buttons =
      status === 'pending'
        ? buildSuggestionReviewButtons(
            this.links,
            profile,
            row.id,
            undefined,
            suggestionRevision(payload),
          )
        : published
          ? [[published]]
          : [];
    const message = buildChannelSuggestionAdminMessagePayload({
      status,
      publishedPresentation: profile === 'publisher' ? 'publication_created' : 'confirmed',
      channelTitle: row.chat.title,
      authorAttribution: {
        userId: row.actorUserId,
        displayName: string(payload.authorDisplayName),
        mentionDisplayName: string(payload.authorMentionDisplayName),
        username: string(payload.authorUsername),
        profileUrl: string(payload.authorProfileUrl),
      },
      text: string(payload.text),
      textFormat: payload.textFormat === 'markdown' ? 'markdown' : 'plain',
      textMarkup: readChannelSuggestionTextMarkup(payload.textMarkup),
      reviewedBy: string(payload.reviewedByDisplayName) || null,
      publishedUrl: string(payload.publishedUrl) || null,
    });
    const cards = await this.prisma.channelSuggestionAdminDelivery.findMany({
      where: { auditLogId: row.id, botId: effect.botId, status: 'SENT' },
    });
    for (const card of cards) {
      if (!card.privateChatId || !card.remoteMessageId) continue;
      const dialog = await this.prisma.suggestionReviewDialog.findUnique({
        where: { deliveryId: card.id },
      });
      // FLAG: Synchronization must not erase a private draft of this same revision.
      if (
        status === 'pending' &&
        dialog &&
        dialog.mode !== 'idle' &&
        dialog.revision === suggestionRevision(payload) &&
        dialog.expiresAt > new Date()
      )
        continue;
      const current = await this.prisma.auditLog.findUnique({
        where: { id: row.id },
        select: { payload: true },
      });
      if (
        !current ||
        suggestionRevision(suggestionObject(current.payload)) !== suggestionRevision(payload) ||
        suggestionObject(current.payload).reviewStatus !== payload.reviewStatus
      )
        throw new Error('Suggestion changed during card sync');
      try {
        await this.max.editMessageInlineKeyboard(
          card.privateChatId,
          card.remoteMessageId,
          message.text,
          {
            buttons,
            textFormat: message.textFormat,
            requireAllAttachmentsPreserved: true,
            replaceOwnedInlineKeyboard: true,
            beforeEditMutation: async () => {
              await this.assertDispatchAccess(row.chatId, effect.botId, profile, card.adminUserId);
              const active = await this.prisma.suggestionReviewDialog.findUnique({
                where: { deliveryId: card.id },
              });
              // FLAG: This checkpoint runs under the MAX message lock, before any competing editor PUT.
              if (
                active &&
                (active.lockToken ||
                  (status === 'pending' &&
                    active.mode !== 'idle' &&
                    active.revision === suggestionRevision(payload) &&
                    active.expiresAt > new Date()))
              )
                throw new Error('Native editor owns this card');
              const owned = await this.prisma.suggestionReviewEffect.updateMany({
                where: { id: effect.id, status: 'PROCESSING', lockToken: token },
                data: { lockedAt: new Date() },
              });
              if (owned.count !== 1) throw new Error('Suggestion sync ownership lost');
              const current = await this.prisma.auditLog.findUnique({
                where: { id: row.id },
                select: { payload: true },
              });
              if (
                !current ||
                suggestionRevision(suggestionObject(current.payload)) !==
                  suggestionRevision(payload) ||
                suggestionObject(current.payload).reviewStatus !== payload.reviewStatus
              )
                throw new Error('Suggestion changed before card edit');
            },
          },
          {
            botId: effect.botId,
            sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
            timeoutMs: 8_000,
          },
        );
      } catch (error) {
        if (error instanceof SuggestionReviewRecipientAccessRemoved) continue;
        throw error;
      }
      const after = await this.prisma.auditLog.findUnique({
        where: { id: row.id },
        select: { payload: true },
      });
      if (
        !after ||
        suggestionRevision(suggestionObject(after.payload)) !== suggestionRevision(payload) ||
        suggestionObject(after.payload).reviewStatus !== payload.reviewStatus
      )
        throw new Error('Suggestion changed during card sync');
    }
  }

  async assertDispatchAccess(
    chatId: string,
    botId: string,
    profile: MiniappProfile,
    actorId: string,
  ) {
    if (!actorId) throw new ForbiddenException('Administrator identity unavailable');
    if (profile === 'publisher') {
      const route = await this.readiness.assertEntityReady(chatId, 'suggestion_publish');
      if (route.requiredBotId !== botId) throw new ForbiddenException('Publisher bot changed');
    } else if (!this.registry.getActionableBots().some((bot) => bot.id === botId)) {
      throw new ForbiddenException('Suggestion bot is not active');
    }
    await this.links.assertChatBotAccessProbeAllowed(chatId, botId);
    const options = {
      botId,
      bypassCache: true,
      timeoutMs: 8_000,
      sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
    };
    const bot = await this.max.getCurrentChatMemberAccess(chatId, options);
    if (!bot.isAdmin && !bot.isOwner) throw new ForbiddenException('Bot admin access removed');
    const actor = await this.max.getChatMemberAccess(chatId, actorId, options);
    if (!actor || (!actor.isAdmin && !actor.isOwner) || this.registry.isKnownBotUserId(actorId))
      throw new SuggestionReviewRecipientAccessRemoved('Administrator access removed');
  }
}
