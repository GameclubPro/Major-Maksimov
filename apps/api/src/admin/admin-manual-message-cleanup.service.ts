import { Injectable, Logger, Optional } from '@nestjs/common';

import { MaxClientService, type MaxActionDispatchOptions } from '../max/max-client.service';
import { wasMaxPreDispatchGuardRejected } from '../max/max-action-pre-dispatch-guard';
import { wasMaxMemberMutationAttempted } from '../max/max-member-error.util';
import {
  isMaxMutationOutcomeAmbiguous,
  wasMaxMessageSendAttempted,
} from '../max/max-mutation-outcome.util';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { ModerationDeleteIntentService } from '../moderation/moderation-delete-intent.service';
import {
  ModerationSanctionStateLockError,
  type ModerationSanctionStateLeaseGuard,
} from '../moderation/moderation-sanction-state-lock.service';
import { extractMaxApiErrorMessage, isMaxMessageMissingError } from './admin-chat-rules';
import {
  MANUAL_BAN_RECENT_MESSAGE_DELETE_LIMIT,
  TWENTY_FOUR_HOURS_MS,
  sleepIfNeeded,
} from './admin.service.support';

export type AdminManualMessageCleanupResult = {
  candidateMessageIds: string[];
  deletedMessageIds: string[];
  pendingMessageIds: string[];
  failedMessageIds: string[];
};

type ManualDeleteOutcome = 'confirmed' | 'accepted' | 'waiting_capability' | 'failed';

@Injectable()
export class AdminManualMessageCleanupService {
  private readonly logger = new Logger(AdminManualMessageCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    @Optional() private readonly deleteIntents?: ModerationDeleteIntentService,
  ) {}

  async deleteGroupCommandMessage(
    chatId: string,
    messageId: string,
    options: {
      botId?: string;
      originBotId?: string | null;
      actorUserId?: string | null;
    } = {},
  ): Promise<void> {
    try {
      const outcome = await this.deleteWithDurableIntent({
        chatId,
        messageId,
        subjectUserId: options.actorUserId,
        originBotId: options.originBotId ?? options.botId,
        reasonKey: 'manual_group_command_message_cleanup',
        ruleCode: 'MANUAL_GROUP_COMMAND_MESSAGE_CLEANUP',
        metadata: {
          source: 'admin_manual_action',
          cleanupKind: 'group_command',
          messageRole: 'command',
        },
        directOptions: {
          immediate: true,
          trafficClass: 'interactive',
          ...(options.botId ? { botId: options.botId } : {}),
        },
      });
      if (outcome === 'failed') {
        this.logger.warn(
          { chatId, messageId },
          'Durable cleanup could not accept handled group admin command message deletion',
        );
      }
    } catch (error: unknown) {
      if (this.isExecutionEnabled(chatId, 'MANUAL_GROUP_COMMAND_MESSAGE_CLEANUP')) {
        this.logger.error(
          { chatId, messageId, err: this.formatError(error) },
          'Failed to persist or execute durable group admin command message deletion',
        );
        throw error;
      }
      this.logger.debug(
        { chatId, messageId, err: this.formatError(error) },
        'Failed to delete handled queued group admin command message',
      );
    }
  }

  async deleteGroupCommandTargetMessage(
    job: {
      sourceChatId: string;
      commandBotId?: string | null;
      targetUserId: string;
      targetMessageId?: string | null;
    },
    options: { botId?: string } = {},
  ): Promise<void> {
    if (!job.targetMessageId) {
      return;
    }

    try {
      const outcome = await this.deleteWithDurableIntent({
        chatId: job.sourceChatId,
        messageId: job.targetMessageId,
        subjectUserId: job.targetUserId,
        originBotId: job.commandBotId ?? options.botId,
        reasonKey: 'manual_group_command_target_message_cleanup',
        ruleCode: 'MANUAL_GROUP_COMMAND_TARGET_MESSAGE_CLEANUP',
        metadata: {
          source: 'admin_manual_action',
          cleanupKind: 'group_command',
          messageRole: 'target',
        },
        directOptions: {
          immediate: true,
          trafficClass: 'interactive',
          ...(options.botId ? { botId: options.botId } : {}),
        },
      });
      if (outcome === 'failed') {
        this.logger.warn(
          {
            chatId: job.sourceChatId,
            targetUserId: job.targetUserId,
            targetMessageId: job.targetMessageId,
          },
          'Durable cleanup could not accept handled group admin target message deletion',
        );
      }
    } catch (error: unknown) {
      if (
        this.isExecutionEnabled(job.sourceChatId, 'MANUAL_GROUP_COMMAND_TARGET_MESSAGE_CLEANUP')
      ) {
        this.logger.error(
          {
            chatId: job.sourceChatId,
            targetUserId: job.targetUserId,
            targetMessageId: job.targetMessageId,
            err: this.formatError(error),
          },
          'Failed to persist or execute durable group admin target message deletion',
        );
        throw error;
      }
      this.logger.debug(
        {
          chatId: job.sourceChatId,
          targetUserId: job.targetUserId,
          targetMessageId: job.targetMessageId,
          err: this.formatError(error),
        },
        'Failed to delete handled queued group admin command target message',
      );
    }
  }

  async deleteRecentTrackedMessages(
    chatId: string,
    targetUserId: string,
    options: {
      spacingMs?: number;
      botId?: string;
      leaseGuard?: ModerationSanctionStateLeaseGuard;
    } = {},
  ): Promise<AdminManualMessageCleanupResult> {
    const { leaseGuard } = options;
    const candidateMessageIds = await this.findRecentTrackedMessageIds(chatId, targetUserId);
    const deletedMessageIds: string[] = [];
    const pendingMessageIds: string[] = [];
    const failedMessageIds: string[] = [];

    for (const [index, messageId] of candidateMessageIds.entries()) {
      if (index > 0) {
        await sleepIfNeeded(options.spacingMs ?? 0);
      }

      await leaseGuard?.assertOwned();
      try {
        const outcome = await this.deleteWithDurableIntent({
          chatId,
          messageId,
          subjectUserId: targetUserId,
          originBotId: options.botId,
          reasonKey: 'manual_action_recent_message_cleanup',
          ruleCode: 'MANUAL_ACTION_RECENT_MESSAGE_CLEANUP',
          metadata: {
            source: 'admin_manual_action',
            cleanupKind: 'recent_tracked_message',
          },
          directOptions: {
            immediate: true,
            ...(options.botId ? { botId: options.botId } : {}),
            ...(leaseGuard
              ? { beforeImmediateDeleteMutation: () => leaseGuard.assertOwned() }
              : {}),
          },
          beforeDirectExecutorProofRetry: async () => leaseGuard?.assertOwned(),
        });
        if (outcome === 'confirmed') {
          deletedMessageIds.push(messageId);
        } else if (outcome === 'accepted') {
          pendingMessageIds.push(messageId);
        } else {
          failedMessageIds.push(messageId);
        }
      } catch (error: unknown) {
        // FLAG: A final lease check can fail on the last message too; preserve the
        // caller's ordering failure instead of returning a partial cleanup result.
        if (error instanceof ModerationSanctionStateLockError) throw error;
        if (this.isExecutionEnabled(chatId, 'MANUAL_ACTION_RECENT_MESSAGE_CLEANUP')) {
          this.logger.error(
            { chatId, targetUserId, messageId, err: this.formatError(error) },
            'Failed to persist or execute durable recent-message cleanup',
          );
          throw error;
        }
        if (isMaxMessageMissingError(error)) {
          deletedMessageIds.push(messageId);
          continue;
        }

        failedMessageIds.push(messageId);
        this.logger.warn(
          { chatId, targetUserId, messageId, err: this.formatError(error) },
          'Failed to delete tracked recent message during manual moderation cleanup',
        );
      }
    }

    return { candidateMessageIds, deletedMessageIds, pendingMessageIds, failedMessageIds };
  }

  async deleteBotAuthoredMessage(params: {
    chatId: string;
    messageId: string;
    originBotId?: string | null;
    reasonKey: string;
    ruleCode: string;
    metadata: Prisma.InputJsonObject;
    directOptions: MaxActionDispatchOptions;
  }): Promise<ManualDeleteOutcome> {
    return this.deleteWithDurableIntent(
      {
        ...params,
        entityType: 'CHAT',
        messageAuthorKind: 'bot',
        routingPolicy: 'origin_only',
      },
      true,
    );
  }

  async deleteChatRulesMessage(params: {
    chatId: string;
    messageId: string;
    botId?: string;
    cleanupKind: 'republish_previous' | 'reset_current';
    source: string;
    actorUserId: string;
    directOptions: MaxActionDispatchOptions;
  }): Promise<ManualDeleteOutcome> {
    const republish = params.cleanupKind === 'republish_previous';
    return this.deleteBotAuthoredMessage({
      chatId: params.chatId,
      messageId: params.messageId,
      originBotId: params.botId,
      reasonKey: republish
        ? 'chat_rules_republish_previous_message_cleanup'
        : 'chat_rules_reset_published_message_cleanup',
      ruleCode: republish
        ? 'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP'
        : 'CHAT_RULES_RESET_PUBLISHED_MESSAGE_CLEANUP',
      metadata: {
        source: params.source,
        actorUserId: params.actorUserId,
        cleanupKind: republish ? 'chat_rules_republish' : 'chat_rules_reset',
      },
      directOptions: params.directOptions,
    });
  }

  private async deleteWithDurableIntent(
    params: {
      chatId: string;
      messageId: string;
      reasonKey: string;
      ruleCode: string;
      subjectUserId?: string | null;
      originBotId?: string | null;
      entityType?: 'CHAT' | 'CHANNEL';
      messageAuthorKind?: 'user' | 'bot';
      routingPolicy?: 'delete_capable' | 'origin_first' | 'origin_only';
      metadata: Prisma.InputJsonObject;
      directOptions: MaxActionDispatchOptions;
      beforeDirectExecutorProofRetry?: () => Promise<void>;
    },
    persistBeforeAttempt = false,
  ): Promise<ManualDeleteOutcome> {
    const rollout = this.deleteIntents?.getRolloutForRule(params.chatId, params.ruleCode) ?? 'off';
    if (this.deleteIntents && rollout !== 'off') {
      try {
        const intentInput = {
          chatId: params.chatId,
          messageId: params.messageId,
          reasonKey: params.reasonKey,
          ruleCode: params.ruleCode,
          subjectUserId: params.subjectUserId,
          entityType: params.entityType ?? 'CHAT',
          messageAuthorKind: params.messageAuthorKind ?? 'user',
          originBotId: params.originBotId,
          routingPolicy: params.routingPolicy ?? 'origin_first',
          event: {
            userId: params.subjectUserId,
            eventType: null,
            metadata: params.metadata,
          },
        } as const;
        if (persistBeforeAttempt) {
          await this.deleteIntents.ensureIntent(intentInput);
        }
        const result = await this.deleteIntents.ensureAndAttempt(intentInput);

        switch (result.kind) {
          case 'confirmed':
          case 'already_absent':
            return 'confirmed';
          case 'pending':
          case 'ambiguous':
          case 'inline_declined':
            return 'accepted';
          case 'waiting_capability':
            return persistBeforeAttempt ? 'waiting_capability' : 'accepted';
          case 'expired':
          case 'terminal':
            return 'failed';
          case 'off':
          case 'observed':
            break;
        }
      } catch (error: unknown) {
        if (rollout === 'execute') {
          throw error;
        }
        this.logger.warn(
          { chatId: params.chatId, messageId: params.messageId, err: this.formatError(error) },
          'Failed to record shadow manual delete intent; falling back to direct deletion',
        );
      }
    }

    try {
      await this.maxClient.deleteMessage(params.chatId, params.messageId, params.directOptions);
    } catch (error: unknown) {
      // FLAG: Only a certified no-effect executor rejection may requalify the same
      // explicitly selected bot once. Never repeat durable persistence or an unknown
      // DELETE, choose a peer, or relax the fresh proof, quota and final lease guards.
      if (
        !params.beforeDirectExecutorProofRetry ||
        !params.directOptions.botId?.trim() ||
        !wasMaxPreDispatchGuardRejected(error) ||
        (error as { code?: unknown }).code !== 'max_action_executor_proof_rejected' ||
        wasMaxMessageSendAttempted(error) ||
        wasMaxMemberMutationAttempted(error) ||
        isMaxMutationOutcomeAmbiguous(error)
      ) {
        throw error;
      }
      await params.beforeDirectExecutorProofRetry();
      await this.maxClient.deleteMessage(params.chatId, params.messageId, params.directOptions);
    }
    return 'confirmed';
  }

  private async findRecentTrackedMessageIds(
    chatId: string,
    targetUserId: string,
  ): Promise<string[]> {
    const normalizedChatId = chatId.trim();
    const normalizedTargetUserId = targetUserId.trim();
    if (!normalizedChatId || !normalizedTargetUserId) {
      return [];
    }

    const since = new Date(Date.now() - TWENTY_FOUR_HOURS_MS);
    const rows = await this.prisma.$queryRaw<Array<{ message_id: string | null }>>`
      SELECT message_id
      FROM (
        SELECT DISTINCT ON (message_id)
          message_id,
          message_created_at
        FROM (
          SELECT
            NULLIF(BTRIM(normalized_payload->'message'->>'messageId'), '') AS message_id,
            COALESCE(
              NULLIF(BTRIM(normalized_payload->'message'->>'createdAt'), '')::timestamptz,
              created_at
            ) AS message_created_at
          FROM webhook_events
          WHERE normalized_payload->>'type' = 'message_created'
            AND normalized_payload->'message'->>'senderId' = ${normalizedTargetUserId}
            AND normalized_payload->'message'->>'chatId' = ${normalizedChatId}
            AND NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), '') IS NOT NULL
            AND created_at >= ${since}
        ) AS source_rows
        WHERE message_id IS NOT NULL
          AND message_created_at >= ${since}
        ORDER BY message_id, message_created_at DESC
      ) AS deduped_rows
      ORDER BY message_created_at DESC
      LIMIT ${MANUAL_BAN_RECENT_MESSAGE_DELETE_LIMIT}
    `;

    return Array.from(
      new Set(
        (Array.isArray(rows) ? rows : [])
          .map((row) => (typeof row.message_id === 'string' ? row.message_id.trim() : ''))
          .filter(Boolean),
      ),
    );
  }

  private isExecutionEnabled(chatId: string, ruleCode: string): boolean {
    return this.deleteIntents?.getRolloutForRule(chatId, ruleCode) === 'execute';
  }

  private formatError(error: unknown): string {
    return (
      extractMaxApiErrorMessage(error) || (error instanceof Error ? error.message : String(error))
    );
  }
}
