import type { ChatSettings, ModerationRuleFollowup, SanctionAction } from '../prisma/prisma-client';
import type { RuleViolation } from './rule-engine.contract';
import type {
  createRuleSanctionGuards,
  createCommercialNoticeDispatchOptions,
} from './moderation-execution-guard-callbacks';

export const MODERATION_RULE_FOLLOWUP_EXECUTOR = Symbol('MODERATION_RULE_FOLLOWUP_EXECUTOR');
export type ModerationRuleFollowupEnvelope = {
  version: 1;
  updateType: string;
  originBotId: string | null;
  userLabel: string;
  effectiveMessageLength: number;
  rulesPublishedUrl: string | null;
  rulesPublishedMessageId: string | null;
};
export type ModerationRuleFollowupPlan = {
  version: 1;
  action: Extract<SanctionAction, 'NONE' | 'WARN' | 'MUTE' | 'BAN'>;
  violationCount: number;
  issuedAtMs: number;
  muteExpiresAtMs: number | null;
  muteDurationHours: number;
  eventId: string;
  noticeKey: string;
};
export type ModerationRuleFollowupExecutor = {
  executeSpammerKickFollowup(
    row: ModerationRuleFollowup,
    leaseToken: string,
    receiptOnly: boolean,
  ): ReturnType<typeof import('./spammer-kick-followup').executeSpammerKickFollowup>;
  executeRuleFollowup(
    row: ModerationRuleFollowup,
    plan: ModerationRuleFollowupPlan,
    journal: ModerationRuleFollowupJournal,
  ): Promise<void>;
};
export type ModerationRuleFollowupJournal =
  import('./moderation-rule-followup-sanction').RuleFollowupSanctionJournal;
export type RuleFollowupExecutionContext = {
  chatId: string;
  senderId: string;
  messageId: string;
  userLabel: string;
  topViolation: RuleViolation;
  settings: ChatSettings;
  updateType: string | null;
  maskedExcerpt: string;
  effectiveMessageLength: number;
  rulesPublishedUrl: string | null;
  rulesPublishedMessageId: string | null;
  messageDeleted: boolean;
  isCommercialReviewOnly: boolean;
  ownRuleGuards?: ReturnType<typeof createRuleSanctionGuards>;
  authorizeCommercialSanction?: () => Promise<boolean>;
  authorizeCommercialFinal?: Parameters<typeof createCommercialNoticeDispatchOptions>[0];
  beforeNoticeSend?: () => Promise<void>;
  recoveringOwnEffect?: boolean;
  durable?: {
    row: ModerationRuleFollowup;
    plan: ModerationRuleFollowupPlan;
    journal: ModerationRuleFollowupJournal;
  };
};

export type { ModerationRuleFollowup } from '../prisma/prisma-client';
