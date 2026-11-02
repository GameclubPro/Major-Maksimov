import {
  safetyDeskRetentionRuntimeResponseSchema,
  safetyDeskRetentionPreviewResponseSchema,
  safetyDeskRetryRetentionRequestSchema,
  type SafetyDeskRetentionRuntimeResponse,
  type SafetyDeskRetentionPreviewResponse,
} from '@maxim/contracts/safety-desk';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { MessageRetentionStore } from '../message-retention/message-retention-store.service';
import { retentionStatus } from '../message-retention/message-retention-status';
import {
  MESSAGE_RETENTION_CHAT_LIMIT,
  MESSAGE_RETENTION_SHARD_LIMIT,
  MESSAGE_RETENTION_RULE,
  retentionBlockerStatus,
} from '../message-retention/message-retention.policy';
import { AdminSettingsBotCapabilityService } from './admin-settings-bot-capability.service';
import { EraserControlService } from '../message-retention/eraser-control.service';
import {
  retentionRuntimePageQuery,
  retentionLegacyDiagnosticsQuery,
  retentionReviewPageQuery,
  type RetentionRuntimePageRow,
  type LegacyRuntimeBatch,
} from './safety-desk-retention-queries';

@Injectable()
export class SafetyDeskRetentionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: MessageRetentionStore,
    private readonly capabilities: AdminSettingsBotCapabilityService,
    @Optional() private readonly eraser?: EraserControlService,
  ) {}

  async runtime(input?: unknown): Promise<SafetyDeskRetentionRuntimeResponse> {
    const parsed = z
      .string()
      .regex(/^-[1-9]\d*$/)
      .optional()
      .safeParse(input);
    if (!parsed.success) throw new BadRequestException('Некорректный курсор чатов.');
    const rows = await this.prisma.$queryRaw<RetentionRuntimePageRow[]>(
      retentionRuntimePageQuery(parsed.data ?? null),
    );
    const page = rows.slice(0, 50);
    const legacyIds = page.filter((row) => row.source === 'legacy').map((row) => row.chatId);
    const ownedIds = page.filter((row) => row.source === 'eraser').map((row) => row.chatId);
    const [legacy] = await this.prisma.$queryRaw<LegacyRuntimeBatch[]>(
      retentionLegacyDiagnosticsQuery(legacyIds),
    );
    const diagnostics = new Map(legacy.diagnostics.map((row) => [row.chatId, row]));
    let remote: SafetyDeskRetentionRuntimeResponse | undefined;
    let unavailableReason: 'unavailable' | 'invalid_response' = 'unavailable';
    if (ownedIds.length && this.eraser) {
      try {
        const response = await this.eraser.request(
          `/runtime?chatIds=${encodeURIComponent(ownedIds.join(','))}`,
        );
        unavailableReason = 'invalid_response';
        const value = safetyDeskRetentionRuntimeResponseSchema.parse(response);
        const returnedIds = [
          ...value.items.map((row) => row.chatId),
          ...(value.unavailableSources ?? []).map((row) => row.chatId),
        ];
        if (
          value.nextAfter !== null ||
          returnedIds.length !== ownedIds.length ||
          new Set(returnedIds).size !== returnedIds.length ||
          returnedIds.some((id) => !ownedIds.includes(id)) ||
          value.items.some((row) => row.source !== undefined && row.source !== 'eraser') ||
          value.unavailableSources?.some((row) => row.source !== 'eraser')
        )
          throw new Error('Invalid selected source identities');
        remote = value;
      } catch {
        /* FLAG: A missing authoritative source never becomes a legacy snapshot. */
      }
    }
    const remoteItems = new Map(remote?.items.map((row) => [row.chatId, row]));
    const remoteUnavailable = new Map(
      remote?.unavailableSources?.map((row) => [row.chatId, row.reason]),
    );
    const unavailableSources: NonNullable<
      SafetyDeskRetentionRuntimeResponse['unavailableSources']
    > = [];
    const items: SafetyDeskRetentionRuntimeResponse['items'] = [];
    // FLAG: Missing completeness from an owned older runtime stays unknown. Complete legacy
    // diagnostics cannot establish completeness for that ledger; known incompleteness still wins.
    let incomplete: boolean | undefined = ownedIds.length > 0 ? remote?.incomplete : false;
    for (const policy of page) {
      if (policy.source === 'eraser') {
        const item = remoteItems.get(policy.chatId);
        if (item)
          items.push({
            ...item,
            chatTitle: policy.chatTitle,
            source: 'eraser',
            sourceStatus: 'available',
          });
        else
          unavailableSources.push({
            chatId: policy.chatId,
            chatTitle: policy.chatTitle,
            source: 'eraser',
            reason: remoteUnavailable.get(policy.chatId) ?? unavailableReason,
          });
        continue;
      }
      const diagnostic = diagnostics.get(policy.chatId);
      if (!diagnostic) {
        unavailableSources.push({
          chatId: policy.chatId,
          chatTitle: policy.chatTitle,
          source: 'legacy',
          reason: 'unavailable',
        });
        continue;
      }
      if (diagnostic.incomplete) incomplete = true;
      const dueMs =
        !policy.enabled || diagnostic.oldestSourceMs === null
          ? Infinity
          : diagnostic.oldestSourceMs + policy.hours * 3_600_000;
      const blocker =
        retentionBlockerStatus([
          ...(diagnostic.hasTerminalReview ? ['terminal_review'] : []),
          ...(diagnostic.hasWorkerError ? ['worker_error'] : []),
          ...(diagnostic.hasWaitingAccess ? ['waiting_access'] : []),
          ...(diagnostic.hasUnresolvedReceipt ? ['reconciliation'] : []),
          ...(diagnostic.hasDeferred ? ['deferred'] : []),
        ]) ??
        (diagnostic.hasLegacyRetry && ['error', 'no_access', 'delayed'].includes(policy.lastStatus)
          ? (policy.lastStatus as 'error' | 'no_access' | 'delayed')
          : null);
      items.push({
        chatId: policy.chatId,
        chatTitle: policy.chatTitle,
        source: 'legacy',
        sourceStatus: 'available',
        enabled: policy.enabled,
        hours: policy.hours === 24 ? 24 : policy.hours === 168 ? 168 : 48,
        revision: policy.revision,
        activationId: policy.activationId,
        pendingCount: policy.pendingCount,
        deletedCount: policy.deletedCount,
        skippedCount: policy.skippedCount,
        status: retentionStatus(
          policy,
          this.store.mode,
          this.store.allows(policy.chatId),
          dueMs,
          blocker,
        ),
        oldestDueAt: Number.isFinite(dueMs) ? new Date(dueMs).toISOString() : null,
        nextRunAt: policy.nextRunAt?.toISOString() ?? null,
        hasTerminalReview: diagnostic.hasTerminalReview,
        hasUnresolvedReceipt: diagnostic.hasUnresolvedReceipt,
        captureAfter: policy.captureAfter?.toISOString() ?? null,
        pausedAt: policy.pausedAt?.toISOString() ?? null,
        updatedAt: policy.updatedAt.toISOString(),
      });
    }
    if (unavailableSources.length > 0) incomplete = true;
    return safetyDeskRetentionRuntimeResponseSchema.parse({
      generatedAt: new Date().toISOString(),
      mode: remote?.mode ?? this.store.mode,
      ...(remote?.transportMetrics ? { transportMetrics: remote.transportMetrics } : {}),
      ...(remote?.cooldown ? { cooldown: remote.cooldown } : {}),
      ...(remote?.health ? { health: remote.health } : {}),
      nextAfter: rows.length > 50 ? page.at(-1)!.chatId : null,
      ...(incomplete === undefined ? {} : { incomplete }),
      unavailableSources,
      quotas: legacy.quotas.map((q) => ({ ...q, cap: MESSAGE_RETENTION_SHARD_LIMIT })),
      items,
    });
  }

  async preview(chatId: string, input?: unknown): Promise<SafetyDeskRetentionPreviewResponse> {
    this.assertChatId(chatId);
    const parsed = z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional()
      .safeParse(input);
    if (!parsed.success) throw new BadRequestException('Некорректный курсор сообщений.');
    const cursor = parsed.data;
    if (this.eraser && (await this.eraser.owns(chatId))) {
      const snapshot = safetyDeskRetentionPreviewResponseSchema.parse(
        await this.eraser.request(
          `/chats/${encodeURIComponent(chatId)}/review${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`,
        ),
      );
      const protection = await this.eraser
        .protectionReport(chatId)
        .catch(() => ({ status: 'unavailable' as const }));
      return safetyDeskRetentionPreviewResponseSchema.parse({ ...snapshot, protection });
    }
    const policy = await this.prisma.messageRetentionPolicy.findUnique({ where: { chatId } });
    if (!policy) throw new NotFoundException('Настройки очистки не найдены.');
    let after: string | null = null;
    if (cursor) {
      let value: {
        version: 1;
        source: string;
        chatId: string;
        revision: number;
        activationId: string;
        messageId: string;
      };
      try {
        value = z
          .object({
            version: z.literal(1),
            source: z.enum(['legacy', 'eraser']),
            chatId: z.string(),
            revision: z.number().int().nonnegative(),
            activationId: z.string(),
            messageId: z.string().min(1).max(256),
          })
          .strict()
          .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
      } catch {
        throw new BadRequestException('Некорректный курсор сообщений.');
      }
      if (
        value.source !== 'legacy' ||
        value.chatId !== chatId ||
        value.revision !== policy.revision ||
        value.activationId !== policy.activationId
      )
        throw new ConflictException('Настройки изменились. Обновите список.');
      after = value.messageId;
    }
    const [keys, quota] = await Promise.all([
      this.prisma.$queryRaw<Array<{ messageId: string }>>(retentionReviewPageQuery(chatId, after)),
      this.prisma.messageRetentionQuota.findUnique({ where: { shard: policy.quotaShard } }),
    ]);
    const ids = keys.slice(0, 20).map((row) => row.messageId);
    const selected = ids.length
      ? await this.prisma.messageRetentionCandidate.findMany({
          where: { chatId, messageId: { in: ids } },
          take: 20,
        })
      : [];
    const candidates = ids.flatMap((id) => selected.filter((row) => row.messageId === id));
    const intents = candidates.length
      ? await this.prisma.moderationDeleteIntent.findMany({
          where: { id: { in: candidates.flatMap((c) => (c.intentId ? [c.intentId] : [])) } },
          include: { reasons: { select: { ruleCode: true }, take: 2 } },
          take: 20,
        })
      : [];
    const byId = new Map(intents.map((intent) => [intent.id, intent]));
    return safetyDeskRetentionPreviewResponseSchema.parse({
      chatId,
      revision: policy.revision,
      activationId: policy.activationId,
      source: 'legacy',
      sourceStatus: 'available',
      incomplete: keys.length > 20,
      nextAfter:
        keys.length > 20
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                source: 'legacy',
                chatId,
                revision: policy.revision,
                activationId: policy.activationId,
                messageId: ids.at(-1),
              }),
            ).toString('base64url')
          : null,
      items: candidates.map((candidate) => {
        const intent = candidate.intentId ? byId.get(candidate.intentId) : undefined;
        const retryAllowed =
          this.store.allows(chatId, true) &&
          policy.enabled &&
          !policy.pausedAt &&
          quota !== null &&
          !quota.pausedAt &&
          policy.pendingCount < MESSAGE_RETENTION_CHAT_LIMIT * 0.8 &&
          quota.pendingCount < MESSAGE_RETENTION_SHARD_LIMIT * 0.8 &&
          candidate.activationId === policy.activationId &&
          !candidate.shadowOnly &&
          candidate.outcomeCode === 'terminal_review' &&
          ['skipped', 'cancelled'].includes(candidate.status) &&
          intent?.retentionOwned === true &&
          intent.chatId === chatId &&
          intent.messageId === candidate.messageId &&
          intent.subjectUserId === candidate.authorId &&
          ['FAILED_TERMINAL', 'EXPIRED'].includes(intent.status) &&
          intent.reasons.length === 1 &&
          intent.reasons[0]?.ruleCode === MESSAGE_RETENTION_RULE &&
          !intent.deleteDispatchStartedAt &&
          !intent.deleteDispatchStartedBotId &&
          !intent.remoteDeleteSucceededAt &&
          !intent.remoteDeleteSucceededBotId;
        return {
          messageId: candidate.messageId,
          authorId: candidate.authorId,
          sourceAt: candidate.sourceAt.toISOString(),
          dueAt: new Date(candidate.sourceAt.getTime() + policy.hours * 3_600_000).toISOString(),
          status: candidate.status,
          outcomeCode: candidate.outcomeCode,
          intentId: candidate.intentId,
          intentStatus: intent?.status ?? null,
          intentUpdatedAt: intent?.updatedAt.toISOString() ?? null,
          intentAttemptCount: intent?.attemptCount ?? null,
          reconcileAfter: candidate.reconcileAfter?.toISOString() ?? null,
          retryAllowed,
        };
      }),
    });
  }

  async retry(
    chatId: string,
    actorUserId: string | null,
    body: unknown,
  ): Promise<SafetyDeskRetentionPreviewResponse> {
    this.assertChatId(chatId);
    const parsed = safetyDeskRetryRetentionRequestSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Обновите сведения о сообщении перед повтором.');
    if (this.eraser && (await this.eraser.owns(chatId)))
      return safetyDeskRetentionPreviewResponseSchema.parse(
        await this.eraser.request(`/chats/${encodeURIComponent(chatId)}/retry`, 'POST', {
          ...parsed.data,
          actorUserId: actorUserId?.trim() || 'safety-desk-owner',
        }),
      );
    if (!this.store.allows(chatId, true))
      throw new BadRequestException('Обработка выключена для этого чата.');
    await this.capabilities.assertChatSettingsBotCapabilities(
      chatId,
      [{ permission: 'write', featureKeys: ['messageRetention'] }],
      { forceLive: true },
    );
    // FLAG: The store atomically checks versions, ownership, mutation evidence and credits.
    // An operator can only schedule the normal guarded worker, never dispatch DELETE here.
    const changed = await this.store.reopenTerminalCandidate({
      ...parsed.data,
      chatId,
      expectedIntentUpdatedAt: new Date(parsed.data.expectedIntentUpdatedAt),
      actorUserId: actorUserId?.trim() || 'safety-desk-owner',
    });
    if (!changed)
      throw new ConflictException('Состояние или условия обработки изменились. Обновите сведения.');
    return this.preview(chatId);
  }

  private assertChatId(chatId: string): void {
    if (!/^-[1-9]\d*$/.test(chatId))
      throw new BadRequestException('Некорректный идентификатор чата.');
  }
}
