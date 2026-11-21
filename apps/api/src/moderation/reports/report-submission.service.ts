import { Injectable, Optional } from '@nestjs/common';
import type { MaxUpdate, ReportSettings } from '@maxim/contracts';
import { MaxClientService } from '../../max/max-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { RedisCounterService } from '../redis-counter.service';
import { extractRawMessageNode } from '../moderation-update-extractors';
import { ReportStateService } from './report-state.service';
import { ReportTelemetryService } from './report-telemetry.service';
import {
  isEligibleReporter,
  matchesReportTrigger,
  record,
  REPORT_COMMAND_RULE,
  REPORT_DAY_MS,
  ReportRejectedError,
  reportReplyTarget,
  reportContentHash,
  reportLinkedMessageId,
  ReportStaleStateError,
} from './report.util';

@Injectable()
export class ReportSubmissionService {
  constructor(
    private readonly state: ReportStateService,
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly deletes: ModerationDeleteIntentService,
    private readonly redis: RedisCounterService,
    @Optional() private readonly telemetry?: ReportTelemetryService,
  ) {}

  isCommand(
    update: MaxUpdate,
    settings: Pick<ReportSettings, 'reportsEnabled' | 'reportsAliases'>,
  ): boolean {
    return Boolean(update.message && reportReplyTarget(update, settings));
  }

  async handle(
    update: MaxUpdate,
    settings: Pick<ReportSettings, 'reportsEnabled' | 'reportsAliases'>,
  ): Promise<boolean> {
    const message = update.message;
    if (!message || message.entityType === 'channel') return false;
    if (update.type === 'message_edited') {
      return false;
    }
    if (
      !settings.reportsEnabled ||
      update.type !== 'message_created' ||
      !matchesReportTrigger(message.text, settings.reportsAliases)
    )
      return false;
    const botId = update.botId;
    if (!botId) return false;
    let newVote = false;
    let reachedThreshold = false;
    try {
      if (!this.state.enabled(message.chatId))
        throw new ReportRejectedError('Приём жалоб приостановлен. Жалоба не учтена.');
      const targetId = reportReplyTarget(update, settings);
      if (!targetId) {
        await this.feedback(
          update,
          'Жалоба принимается только ответом без вложений на сообщение участника.',
        );
        return false;
      }
      const source = await this.state.source(message.chatId, targetId, botId);
      if (!source) throw new ReportRejectedError('Исходное сообщение уже удалено.', 'source');
      if (source.authorId === message.senderId)
        throw new ReportRejectedError('Нельзя пожаловаться на своё сообщение.', 'source');
      const now = new Date();
      if (
        source.createdAt.getTime() > now.getTime() ||
        source.createdAt.getTime() + REPORT_DAY_MS <= now.getTime()
      )
        throw new ReportRejectedError('Жалобы принимаются на сообщения не старше суток.', 'source');
      const member = await this.max.getChatMemberAccess(message.chatId, message.senderId, {
        botId,
        bypassCache: true,
        timeoutMs: 5000,
        trafficClass: 'interactive',
      });
      if (!isEligibleReporter(member, message.senderId, now.getTime()))
        throw new ReportRejectedError(
          'Для жалобы нужно быть участником чата не менее суток.',
          'membership',
        );
      if (await this.state.hasActiveSanction(message.chatId, message.senderId))
        throw new ReportRejectedError('Во время мута жалобы не учитываются.', 'sanction');
      await this.state.assertAuthor(message.chatId, source.authorId, botId);
      const report = await this.state.transaction(message.chatId, async (tx) => {
        const acceptedAt = new Date();
        const policy = await tx.chatSettings.findUniqueOrThrow({
          where: { chatId: message.chatId },
        });
        if (!policy.reportsEnabled || !this.state.enabled(message.chatId))
          throw new ReportRejectedError('Модуль жалоб выключен.');
        if (!reportReplyTarget(update, policy))
          throw new ReportRejectedError('Команды жалоб изменились. Жалоба не учтена.');
        const where = { chatId_messageId: { chatId: message.chatId, messageId: targetId } };
        let current = await tx.chatReportCase.findUnique({ where });
        if (current?.detailsArchivedAt)
          throw new ReportRejectedError('Сбор жалоб по этому сообщению уже закрыт.', 'closed');
        if (
          current &&
          current.contentHash !== source.hash &&
          current.updatedAt >= source.readStartedAt
        )
          throw new ReportStaleStateError('Сообщение изменилось во время проверки жалобы.');
        if (
          current &&
          current.policyRevision !== policy.reportsRevision &&
          ['COLLECTING', 'PENDING', 'CANCELLED'].includes(current.status)
        ) {
          const action = await tx.chatReportAction.findFirst({
            where: { caseId: current.id },
            select: { id: true },
          });
          if (current.muteProcessed || current.muteEventId || action) {
            await tx.chatReportCase.update({
              where,
              data: { status: 'CANCELLED', dueAt: acceptedAt },
            });
            return null;
          }
          // FLAG: Only untouched collections may restart. Dismissals and executed actions stay closed.
          current = await tx.chatReportCase.update({
            where,
            data: {
              contentHash: source.hash,
              contentVersion: { increment: 1 },
              policyRevision: policy.reportsRevision,
              threshold: policy.reportsThreshold,
              deleteMode: policy.reportsDeleteMode,
              muteHours: policy.reportsMuteEnabled ? policy.reportsMuteDurationHours : null,
              status: 'COLLECTING',
              decidedAt: null,
              dueAt: acceptedAt,
              lastError: null,
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
        }
        if (current && !['COLLECTING', 'PENDING'].includes(current.status))
          throw new ReportRejectedError('Сбор жалоб по этому сообщению уже закрыт.', 'closed');
        if (current && current.contentHash !== source.hash) {
          current = await tx.chatReportCase.update({
            where,
            data: {
              contentHash: source.hash,
              contentVersion: { increment: 1 },
              status: 'COLLECTING',
              decidedAt: null,
              dueAt: now,
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
        }
        if (!current)
          current = await tx.chatReportCase.create({
            data: {
              chatId: message.chatId,
              messageId: targetId,
              authorId: source.authorId,
              originBotId: botId,
              contentHash: source.hash,
              policyRevision: policy.reportsRevision,
              messageCreatedAt: source.createdAt,
              expiresAt: new Date(source.createdAt.getTime() + REPORT_DAY_MS),
              threshold: policy.reportsThreshold,
              deleteMode: policy.reportsDeleteMode,
              muteHours: policy.reportsMuteEnabled ? policy.reportsMuteDurationHours : null,
            },
          });
        if (current.expiresAt <= acceptedAt)
          throw new ReportRejectedError('Срок сбора жалоб истёк.', 'closed');
        const duplicate = await tx.chatReportVote.findFirst({
          where: {
            OR: [
              {
                caseId: current.id,
                contentVersion: current.contentVersion,
                reporterId: message.senderId,
              },
              { chatId: message.chatId, commandMessageId: message.messageId },
            ],
          },
        });
        if (!duplicate && current.status === 'COLLECTING') {
          const recent = await tx.chatReportVote.groupBy({
            by: ['caseId'],
            where: {
              chatId: message.chatId,
              reporterId: message.senderId,
              createdAt: { gt: new Date(now.getTime() - 3_600_000) },
            },
          });
          if (!recent.some((v) => v.caseId === current!.id) && recent.length >= 10)
            throw new ReportRejectedError(
              'Лимит: десять жалоб на разные сообщения за час.',
              'rateLimit',
            );
          await tx.chatReportVote.create({
            data: {
              caseId: current.id,
              contentVersion: current.contentVersion,
              chatId: message.chatId,
              reporterId: message.senderId,
              commandMessageId: message.messageId,
            },
          });
          newVote = true;
          const count = await tx.chatReportVote.count({
            where: { caseId: current.id, contentVersion: current.contentVersion },
          });
          current = await tx.chatReportCase.update({
            where,
            data: {
              ...(count >= current.threshold ? { status: 'PENDING', decidedAt: acceptedAt } : {}),
              dueAt: acceptedAt,
            },
          });
          reachedThreshold = current.status === 'PENDING';
        }
        return current;
      });
      if (!report) throw new ReportRejectedError('Настройки изменены; прежний сбор жалоб отменён.');
      if (newVote) this.telemetry?.record('accepted');
      if (reachedThreshold) this.telemetry?.record('threshold');
      await this.deletes.ensureIntent({
        chatId: message.chatId,
        messageId: message.messageId,
        reasonKey: `report-command:${report.id}:${message.messageId}`,
        ruleCode: REPORT_COMMAND_RULE,
        subjectUserId: message.senderId,
        originBotId: botId,
        messageAuthorKind: 'user',
        entityType: 'CHAT',
        routingPolicy: 'delete_capable',
        retryUntilAt: report.expiresAt,
        event: {
          userId: message.senderId,
          metadata: { reportCaseId: report.id, commandCleanup: true, commandText: message.text },
        },
      });
      return true;
    } catch (error) {
      if (error instanceof ReportRejectedError) {
        this.telemetry?.record('rejected');
        const reason = {
          source: 'rejectedSource',
          membership: 'rejectedMembership',
          sanction: 'rejectedSanction',
          protected: 'rejectedProtected',
          policy: 'rejectedPolicy',
          closed: 'rejectedClosed',
          rateLimit: 'rejectedRateLimit',
        } as const;
        this.telemetry?.record(reason[error.reason]);
        await this.feedback(update, error.message);
        return true;
      }
      // A transient lookup/storage failure leaves the webhook retryable and never records a vote optimistically.
      throw error;
    }
  }

  async observeEdit(update: MaxUpdate): Promise<void> {
    if (!update.message || !update.botId) return;
    const node = extractRawMessageNode(record(update.raw));
    if (!node) return;
    const observed = await this.prisma.chatReportCase.findUnique({
      where: {
        chatId_messageId: { chatId: update.message.chatId, messageId: update.message.messageId },
      },
    });
    if (
      !observed ||
      !['COLLECTING', 'PENDING'].includes(observed.status) ||
      observed.contentHash === reportContentHash(node)
    )
      return;
    // FLAG: Edit webhooks can arrive out of order. Confirm the current message before resetting votes.
    const source = await this.state.source(
      update.message.chatId,
      update.message.messageId,
      update.botId,
    );
    if (!source || source.authorId !== observed.authorId) return;
    const hash = source.hash;
    await this.state.transaction(update.message.chatId, async (tx) => {
      const report = await tx.chatReportCase.findUnique({
        where: {
          chatId_messageId: {
            chatId: update.message!.chatId,
            messageId: update.message!.messageId,
          },
        },
      });
      if (
        !report ||
        report.contentHash === hash ||
        !['COLLECTING', 'PENDING'].includes(report.status)
      )
        return;
      if (report.updatedAt >= source.readStartedAt)
        throw new ReportStaleStateError('Версия сообщения изменилась во время проверки правки.');
      await tx.chatReportCase.update({
        where: { id: report.id },
        data: {
          contentHash: hash,
          contentVersion: { increment: 1 },
          status: 'COLLECTING',
          decidedAt: null,
          dueAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
    });
  }

  async ownsCounter(
    chatId: string,
    messageId: string,
    text: string,
    _botId: string,
    raw?: unknown,
  ): Promise<boolean> {
    const existing = await this.prisma.chatReportCase.findFirst({
      where: { chatId, counterMessageId: messageId },
      select: { id: true },
    });
    if (existing) return true;
    const node = extractRawMessageNode(record(raw));
    const targetId = node ? reportLinkedMessageId(node, chatId) : null;
    if (!targetId) return false;
    const sender = record(node?.sender);
    const originBotId = this.state.botIdFromSender(sender.user_id);
    if (sender.is_bot !== true || !originBotId) return false;
    const recovered = await this.prisma.chatReportCase.updateMany({
      where: {
        chatId,
        messageId: targetId,
        originBotId,
        counterMessageId: null,
        counterSendStartedAt: { not: null },
        counterText: text,
      },
      data: { counterMessageId: messageId, dueAt: new Date() },
    });
    return recovered.count === 1;
  }

  private async feedback(update: MaxUpdate, text: string): Promise<void> {
    const message = update.message;
    if (!message || !update.botId) return;
    const admitted = await this.redis.setStringIfAbsentWithTtl(
      `reports:feedback:${message.chatId}:${message.senderId}`,
      '1',
      60,
    );
    if (!admitted) return;
    await this.max.sendMessage(
      message.chatId,
      text,
      { messageLink: { type: 'reply', mid: message.messageId } },
      { botId: update.botId, trafficClass: 'interactive' },
    );
  }
}
