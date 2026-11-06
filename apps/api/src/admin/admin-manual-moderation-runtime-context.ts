import type { Logger } from '@nestjs/common';
import type { ChatSummary, ManualModerationActionResult } from '@maxim/contracts';
import type { Queue } from 'bullmq';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { ManualGroupCommandNoticeAuthorityInput } from './admin-manual-group-command-notice-authority';
import type {
  MaxActionDispatchOptions,
  MaxPublishedMessage,
  MaxSendMessageOptions,
} from '../max/max-client.service';
import type { ModerationSanctionStateLeaseGuard } from '../moderation/moderation-sanction-state-lock.service';
import type { ManualModerationFanoutLedgerStatus, Prisma } from '../prisma/prisma-client';
import type {
  AdminManualFanoutJob,
  AdminManualGroupModerationCommandJob,
} from './admin-manual-fanout.queue';
import type { AdminSuperBanJob } from './admin-super-ban.queue';
import type {
  AdminActionSource,
  ManualBanFollowUpSource,
  ManualModerationBotAction,
  ManualModerationExecutionOptions,
  ManualModerationFanoutSource,
  ResolveManualModerationActionBotAssignmentOptions,
} from './admin.service.support';

export type ManualModerationCleanupResult = {
  candidateMessageIds: string[];
  deletedMessageIds: string[];
  pendingMessageIds: string[];
  failedMessageIds: string[];
};

export type ManualModerationCleanupSummary = {
  mode?: 'queued';
  jobId?: string;
  candidateCount: number;
  deletedCount: number;
  pendingCount: number;
  failedCount: number;
};

export type ManualMuteFanoutResult = {
  mutedChatIds: string[];
  skippedChatIds: string[];
  failedChatIds: string[];
  retryableFailedChatIds?: string[];
};

export type ManualMuteFanoutSummary = {
  mode?: 'queued';
  jobId?: string;
  mutedChatsCount: number;
  mutedChatIds: string[];
  skippedChatsCount: number;
  skippedChatIds: string[];
  failedChatsCount: number;
  failedChatIds: string[];
};

export type ManualBanFanoutResult = {
  removedChatIds: string[];
  skippedChatIds: string[];
  failedChatIds: string[];
  retryableFailedChatIds?: string[];
  deletedMessageCount: number;
  failedMessageDeleteCount: number;
};

export type ManualBanFanoutSummary = {
  mode?: 'queued';
  jobId?: string;
  removedChatsCount: number;
  removedChatIds: string[];
  skippedChatsCount: number;
  skippedChatIds: string[];
  failedChatsCount: number;
  failedChatIds: string[];
  deletedMessageCount: number;
  failedMessageDeleteCount: number;
};

export type ManualMuteFollowUpInput = {
  sourceChatId: string;
  targetUserId: string;
  actor: AuthUser;
  rootIntentKey?: string | null;
  botId?: string | null;
  muteDurationHours: number | null;
  muteExpiresAt: Date | null;
  mutePermanent: boolean;
  source: ManualModerationFanoutSource;
  leaseGuard?: ModerationSanctionStateLeaseGuard;
};

export type ManualMuteFollowUpSummary = {
  sourceMessageCleanup: ManualModerationCleanupSummary;
  crossChatMuteFanout: ManualMuteFanoutSummary;
};

export type ManualBanFollowUpInput = {
  sourceChatId: string;
  targetUserId: string;
  actor: AuthUser;
  source: ManualBanFollowUpSource;
  rootIntentKey?: string | null;
  leaseGuard?: ModerationSanctionStateLeaseGuard;
};

export type ManualBanSourceCleanupInput = ManualBanFollowUpInput & {
  botId?: string | null;
};

export type ManualBanFollowUpSummary = {
  sourceMessageCleanup: ManualModerationCleanupSummary;
  crossChatFanout: ManualBanFanoutSummary;
};

export type ManualModerationFanoutLedgerOperation =
  | 'SOURCE_CLEANUP'
  | 'FANOUT_BAN_MEMBER'
  | 'FANOUT_MUTE_RECORD'
  | 'COMMAND_SOURCE_BAN'
  | 'COMMAND_SOURCE_MUTE'
  | 'COMMAND_NOTICE_OUTCOME'
  | 'COMMAND_NOTICE_SUCCESS'
  | 'COMMAND_NOTICE_FAILURE';

export type ManualModerationFanoutLedgerRowView = {
  metadata?: Prisma.JsonValue | null;
  status: ManualModerationFanoutLedgerStatus;
  moderationEventId: string | null;
};

export type ManualModerationFanoutLedgerClaimView =
  | { claimed: true; lockToken: string; row?: ManualModerationFanoutLedgerRowView | null }
  | { claimed: false; row?: ManualModerationFanoutLedgerRowView | null };

export type ManualModerationFanoutOperationKeyInput = {
  operation: ManualModerationFanoutLedgerOperation;
  sourceChatId: string;
  targetChatId: string;
  targetUserId: string;
  jobId?: string | null;
  rootIntentKey?: string | null;
  extra?: Array<string | number | boolean | null | undefined>;
};

export type ManualModerationFanoutLedgerClaimInput = {
  operationKey: string;
  jobId?: string | null;
  rootIntentKey?: string | null;
  sourceKind: string;
  operation: ManualModerationFanoutLedgerOperation;
  sourceChatId: string;
  targetChatId: string;
  targetUserId: string;
  actorUserId: string;
  logicalAction: string;
  botId?: string | null;
  executionMode?: string | null;
  metadata?: Prisma.InputJsonValue | null;
};

export type ManualModerationFanoutLedgerCompleteInput = {
  operationKey: string;
  lockToken: string;
  status?: ManualModerationFanoutLedgerStatus;
  botId?: string | null;
  executionMode?: string | null;
  moderationEventId?: string | null;
  auditLogId?: string | null;
  remoteMessageId?: string | null;
  metadata?: Prisma.InputJsonValue | null;
};

export type ManualModerationFanoutLedgerFailureInput = {
  operationKey: string;
  lockToken: string;
  status: ManualModerationFanoutLedgerStatus;
  error: unknown;
  terminal?: boolean;
  retainClaim?: boolean;
  requireClaim?: boolean;
  botId?: string | null;
  executionMode?: string | null;
  metadata?: Prisma.InputJsonValue | null;
};

export type ManualModerationActionBotAssignmentInput = {
  chatId: string;
  action: ManualModerationBotAction;
  options?: ResolveManualModerationActionBotAssignmentOptions;
};

export type AdminManualModerationRuntimeContext = {
  readonly logger: Logger;
  readonly adminSuperBanQueue?: Queue<AdminSuperBanJob>;
  readonly adminManualFanoutQueue?: Queue<AdminManualFanoutJob>;
  readonly adminManualCommandQueue?: Queue<AdminManualFanoutJob>;
  enqueueManualModerationFanout(job: AdminManualFanoutJob): Promise<boolean>;
  isKnownRuntimeBotUserId(userId: string | null | undefined): boolean;
  isSuperBanDeveloperUserId(userId: string | null | undefined): boolean;
  processDeveloperSuperBanJob(job: AdminSuperBanJob): Promise<void>;
  processManualSystemBan(
    chatId: string,
    targetUserId: string,
    actor: AuthUser,
    source: Extract<AdminActionSource, 'group_command' | 'private_command'>,
    options: ManualModerationExecutionOptions,
  ): Promise<ManualModerationActionResult>;
  processManualModerationAction(
    chatId: string,
    targetUserId: string,
    actor: AuthUser,
    body: unknown,
    source: AdminActionSource,
    options: ManualModerationExecutionOptions,
  ): Promise<ManualModerationActionResult>;
  resolveManualCommandFanoutChats(actor: AuthUser, sourceChatId: string): Promise<ChatSummary[]>;
  runManualSourceCleanupWithLedger(params: {
    jobId?: string | null;
    rootIntentKey?: string | null;
    sourceKind: string;
    sourceChatId: string;
    targetUserId: string;
    actorUserId: string;
    botId?: string | null;
    logMessage: string;
  }): Promise<ManualModerationCleanupResult>;
  applyManualMuteFanout(params: {
    jobId?: string | null;
    rootIntentKey?: string | null;
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    muteDurationHours: number | null;
    muteExpiresAt: Date | null;
    mutePermanent: boolean;
    source: ManualModerationFanoutSource;
    targetChats?: ChatSummary[];
  }): Promise<ManualMuteFanoutResult>;
  applyManualSystemBanFanout(params: {
    jobId?: string | null;
    rootIntentKey?: string | null;
    source?: ManualBanFollowUpSource;
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    targetChats?: ChatSummary[];
  }): Promise<ManualBanFanoutResult>;
  resolveManualGroupCommandCleanupBotId(
    chatId: string,
    preferredBotId?: string | null,
  ): Promise<string | undefined>;
  resolveManualModerationTargetDisplayName(
    chatId: string,
    targetUserId: string,
    options: { botId?: string; allowRemoteLookup?: boolean },
  ): Promise<string | null>;
  deleteManualGroupCommandTargetMessage(
    job: Pick<
      AdminManualGroupModerationCommandJob,
      'sourceChatId' | 'commandBotId' | 'targetUserId' | 'targetMessageId'
    >,
    options: { botId?: string },
  ): Promise<void>;
  deleteManualGroupCommandMessage(
    chatId: string,
    messageId: string,
    options: { botId?: string; originBotId?: string | null; actorUserId?: string | null },
  ): Promise<void>;
  readManualModerationFanoutIntentRow(params: {
    rootIntentKey: string;
    operation: 'COMMAND_SOURCE_BAN' | 'COMMAND_SOURCE_MUTE';
    sourceChatId: string;
    targetChatId: string;
    targetUserId: string;
  }): Promise<ManualModerationFanoutLedgerRowView | null>;

  resolveManualModerationActionBotAssignment(
    input: ManualModerationActionBotAssignmentInput,
  ): Promise<string | undefined>;
  assertBotCanDeleteMessages(chatId: string, botId?: string): Promise<void>;
  deleteRecentTrackedMessagesForManualAction(
    chatId: string,
    targetUserId: string,
    options: { botId?: string; leaseGuard?: ModerationSanctionStateLeaseGuard },
  ): Promise<ManualModerationCleanupResult>;
  runManualBanSourceCleanup(
    chatId: string,
    targetUserId: string,
    actorUserId: string,
    options: { botId?: string; leaseGuard?: ModerationSanctionStateLeaseGuard },
  ): Promise<ManualModerationCleanupResult>;
  runManualBanFanoutInlineSummary(params: ManualBanFollowUpInput): Promise<ManualBanFanoutSummary>;

  normalizeManualModerationBotId(value: unknown): string | null;
  canResolveCurrentChatMemberAccess(): boolean;
  resolveDeliveryBotAssignment(chatId: string): Promise<string | null | undefined>;

  claimManualModerationFanoutLedgerEntry(
    params: ManualModerationFanoutLedgerClaimInput,
  ): Promise<ManualModerationFanoutLedgerClaimView>;
  completeManualModerationFanoutLedgerEntry(
    params: ManualModerationFanoutLedgerCompleteInput,
  ): Promise<void>;
  markManualModerationFanoutLedgerFailed(
    params: ManualModerationFanoutLedgerFailureInput,
  ): Promise<boolean>;
  findSettledManualGroupCommandOutcomeRows(params: {
    jobId: string;
    chatId: string;
    targetUserId: string;
  }): Promise<Array<{ operation: string }>>;
  assertManualGroupCommandSuccessNoticeAuthority(
    input: ManualGroupCommandNoticeAuthorityInput,
  ): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    options: MaxSendMessageOptions,
    dispatchOptions: MaxActionDispatchOptions,
  ): Promise<MaxPublishedMessage | void>;
};

export function createAdminManualModerationRuntimeContext(
  target: AdminManualModerationRuntimeContext,
): AdminManualModerationRuntimeContext {
  return target;
}
