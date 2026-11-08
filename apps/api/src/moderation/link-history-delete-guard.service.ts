import {
  prepareDeleteAuthority,
  finalizeDeleteAuthority,
  type DeleteAuthorityPreparation,
} from './moderation-delete-authority-preparation';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MaxBotLinkService } from '../max/max-bot-link.service';
import { AutomaticDeleteAuthorAccessService } from '../max/automatic-delete-author-access.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  LINK_BLOCKED_DELETE_RULE_CODE,
  LINK_HISTORY_RECOVERY_RULE_CODE,
  LINK_HISTORY_RECOVERY_SOURCE_TAG,
  createMessageContentFingerprint,
  deriveLinkPolicySemanticEffectiveAt,
  filterActionableNavigationTargets,
  fingerprintLinkDeleteReasons,
  isLinkHistoryPolicyViolation,
  parseLinkHistoryListedMessage,
} from './link-history-recovery.util';
import {
  extractEnabledNavigationTargets,
  resolveEnabledNavigationTargetOptions,
  type EnabledNavigationTargetOptions,
} from './navigation/enabled-navigation-targets';
import { adaptMaxMessageNavigationView } from './navigation/max-navigation-view.adapter';
import { MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES } from './moderation.service.support';
import { fingerprintLinkRulesPolicy, isRuntimeLinkPolicyActive } from './link-rules-policy.runtime';

export type LinkHistoryDeleteGuardResult = 'absent' | 'allowed' | 'not_applicable';

type RecoveryReasonMetadata = {
  contentFingerprint: string;
  policyRevision: number;
  policyEffectiveAt: Date;
  linkRulesPolicySha256?: string;
};

type LiveReasonMetadata = {
  linkPolicyRevision: number;
  linkPolicyEffectiveAt: Date;
  linkRulesPolicySha256?: string;
};

export class LinkHistoryDeleteGuardRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly reasonFingerprint?: string,
  ) {
    super(message);
    this.name = 'LinkHistoryDeleteGuardRejectedError';
  }
}

@Injectable()
export class LinkHistoryDeleteGuardService {
  private readonly deleteEnabled: boolean;
  private readonly extractionOptions: EnabledNavigationTargetOptions;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
    configService: ConfigService,
    @Optional() private readonly automaticDeleteAuthorAccess?: AutomaticDeleteAuthorAccessService,
  ) {
    this.deleteEnabled = this.readBoolean(
      configService.get('MODERATION_LINK_HISTORY_DELETE_ENABLED'),
      false,
    );
    this.extractionOptions = resolveEnabledNavigationTargetOptions(configService);
  }

  async assertIntentStillActionable(params: {
    intentId: string;
    chatId: string;
    messageId: string;
    subjectUserId: string | null;
    botId: string;
  }): Promise<LinkHistoryDeleteGuardResult> {
    return finalizeDeleteAuthority(await this.prepareForDispatch(params));
  }

  async prepareForDispatch(
    params: Parameters<LinkHistoryDeleteGuardService['assertIntentStillActionable']>[0],
  ): Promise<DeleteAuthorityPreparation<LinkHistoryDeleteGuardResult>> {
    const allReasons = await this.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: params.intentId },
      select: { ruleCode: true, reasonKey: true, score: true, metadata: true },
      orderBy: { reasonKey: 'asc' },
      take: 65,
    });
    if (allReasons.length > 64) throw new Error('Link guard reason set exceeds safety limit');
    const reasonRows = allReasons.filter((reason) =>
      [LINK_BLOCKED_DELETE_RULE_CODE, LINK_HISTORY_RECOVERY_RULE_CODE].includes(reason.ruleCode),
    );
    if (reasonRows.length === 0) {
      return 'not_applicable';
    }
    const reasonFingerprint = fingerprintLinkDeleteReasons(allReasons);
    const reject = (code: string, message: string) =>
      new LinkHistoryDeleteGuardRejectedError(code, message, reasonFingerprint);
    const liveReasonRows = reasonRows.filter(
      (row) => row.ruleCode === LINK_BLOCKED_DELETE_RULE_CODE,
    );
    const usesLiveSemantics = liveReasonRows.length > 0;
    if (!usesLiveSemantics && !this.deleteEnabled) {
      throw reject('history_delete_disabled', 'Link history recovery deletion is disabled');
    }

    const recoveryReasons = reasonRows
      .filter((row) => row.ruleCode === LINK_HISTORY_RECOVERY_RULE_CODE)
      .map((row) => this.parseReasonMetadata(row.metadata))
      .filter((reason): reason is RecoveryReasonMetadata => reason !== null);
    const liveReasons = liveReasonRows
      .map((row) => this.parseLiveReasonMetadata(row.metadata))
      .filter((reason): reason is LiveReasonMetadata => reason !== null);
    if (usesLiveSemantics ? liveReasons.length === 0 : recoveryReasons.length === 0) {
      throw reject(
        usesLiveSemantics ? 'live_reason_invalid' : 'history_reason_invalid',
        'Link deletion intent has no valid policy fence',
      );
    }

    if (!params.subjectUserId) {
      throw reject(
        usesLiveSemantics ? 'live_message_identity_changed' : 'history_message_identity_changed',
        'Link deletion intent no longer identifies the message author',
      );
    }
    if (this.maxBotLinkService.isKnownBotUserId(params.subjectUserId)) {
      throw reject(
        usesLiveSemantics ? 'live_runtime_bot_immune' : 'history_runtime_bot_immune',
        'Runtime bot messages are immune from link deletion',
      );
    }

    const loadAuthority = async () => {
      const now = new Date();
      const [settings, allowlistRows, expiredAllowlist] = await this.prisma.$transaction(
        [
          this.prisma.chatSettings.findUnique({
            where: { chatId: params.chatId },
            select: {
              linkPolicy: true,
              linkRulesPolicy: true,
              linkPolicyRevision: true,
              linkPolicyEffectiveAt: true,
              chat: {
                select: {
                  admins: { select: { userId: true } },
                },
              },
            },
          }),
          this.prisma.domainAllowlist.findMany({
            where: {
              chatId: params.chatId,
              OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: now } }],
            },
            select: { domain: true },
          }),
          this.prisma.domainAllowlist.aggregate({
            where: {
              chatId: params.chatId,
              removeAfterAt: { lte: now },
            },
            _max: { removeAfterAt: true },
          }),
        ],
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
      const policyEffectiveAt = settings
        ? deriveLinkPolicySemanticEffectiveAt(
            settings.linkPolicy,
            settings.linkPolicyEffectiveAt,
            expiredAllowlist._max.removeAfterAt,
            settings.linkRulesPolicy,
            now.getTime(),
          )
        : null;
      if (
        !settings ||
        !isRuntimeLinkPolicyActive(settings.linkPolicy, settings.linkRulesPolicy) ||
        (usesLiveSemantics ? !settings.linkPolicyEffectiveAt : !policyEffectiveAt)
      ) {
        throw reject(
          usesLiveSemantics ? 'live_policy_inactive' : 'history_policy_inactive',
          'Strict link policy is no longer active',
        );
      }
      const matchingRecoveryReasons = recoveryReasons.filter(
        (reason) =>
          reason.policyRevision === settings.linkPolicyRevision &&
          (settings.linkRulesPolicy == null ||
            reason.linkRulesPolicySha256 ===
              fingerprintLinkRulesPolicy(settings.linkRulesPolicy)) &&
          reason.policyEffectiveAt.getTime() === policyEffectiveAt?.getTime(),
      );
      const matchingLiveReasons = liveReasons.filter(
        (reason) =>
          reason.linkPolicyRevision === settings.linkPolicyRevision &&
          (settings.linkRulesPolicy == null ||
            reason.linkRulesPolicySha256 ===
              fingerprintLinkRulesPolicy(settings.linkRulesPolicy)) &&
          settings.linkPolicyEffectiveAt !== null &&
          reason.linkPolicyEffectiveAt.getTime() === settings.linkPolicyEffectiveAt.getTime(),
      );
      if (
        usesLiveSemantics ? matchingLiveReasons.length === 0 : matchingRecoveryReasons.length === 0
      ) {
        throw reject(
          usesLiveSemantics ? 'live_policy_revision_changed' : 'history_policy_revision_changed',
          'Link policy changed after the deletion candidate was recorded',
        );
      }

      if (settings.chat.admins.some((admin) => admin.userId === params.subjectUserId)) {
        throw reject(
          usesLiveSemantics ? 'live_admin_immune' : 'history_admin_immune',
          'Current chat administrators are immune from link deletion',
        );
      }
      return { settings, allowlistRows, policyEffectiveAt, matchingRecoveryReasons };
    };
    const { settings, allowlistRows, policyEffectiveAt, matchingRecoveryReasons } =
      await loadAuthority();
    const authorOptions = {
      trafficClass: 'critical' as const,
      sourceTag: usesLiveSemantics
        ? MAX_API_SOURCE_TAGS.MODERATION_DELETE
        : LINK_HISTORY_RECOVERY_SOURCE_TAG,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
      botId: params.botId,
      bypassCache: true,
    };
    const author = await this.automaticDeleteAuthorAccess?.resolve(
      params.chatId,
      params.subjectUserId,
      authorOptions,
      { requireMembership: false },
    );
    const remoteAccess = author
      ? author.member
      : await this.maxClient.getChatMemberAccess(
          params.chatId,
          params.subjectUserId,
          authorOptions,
        );
    let authorInAdminRoster = author?.isAdmin ?? false;
    if (!authorInAdminRoster && !author?.initialized && !remoteAccess) {
      // FLAG: Before the saved roster is initialized, an omitted member retains the legacy
      // full-roster proof. Initialized DELETE never fetches an author or roster here;
      // exact source and current local policy checks remain mandatory.
      const admins = await this.maxClient.getChatAdminAccesses(params.chatId, {
        trafficClass: 'critical',
        sourceTag: usesLiveSemantics
          ? MAX_API_SOURCE_TAGS.MODERATION_DELETE
          : LINK_HISTORY_RECOVERY_SOURCE_TAG,
        ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
        botId: params.botId,
        bypassCache: true,
      });
      authorInAdminRoster = admins.some((admin) => String(admin.userId) === params.subjectUserId);
    }
    if (
      authorInAdminRoster ||
      (remoteAccess &&
        ((remoteAccess.userId && String(remoteAccess.userId) !== params.subjectUserId) ||
          (author?.isAdmin ?? Boolean(remoteAccess.isAdmin || remoteAccess.isOwner))))
    ) {
      throw reject(
        usesLiveSemantics ? 'live_admin_immune' : 'history_admin_immune',
        'MAX reports a different author identity or current administrator access',
      );
    }

    const exactRow = await this.maxClient.getExactMessageRow(params.chatId, params.messageId, {
      trafficClass: 'critical',
      sourceTag: usesLiveSemantics
        ? MAX_API_SOURCE_TAGS.MODERATION_DELETE
        : LINK_HISTORY_RECOVERY_SOURCE_TAG,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
      botId: params.botId,
      bypassCache: true,
    });
    if (!exactRow) {
      return 'absent';
    }

    const metadata = parseLinkHistoryListedMessage(exactRow);
    if (
      !metadata ||
      metadata.messageId !== params.messageId ||
      !metadata.senderId ||
      metadata.senderId !== params.subjectUserId
    ) {
      throw reject(
        usesLiveSemantics ? 'live_message_identity_changed' : 'history_message_identity_changed',
        'Exact message identity or author no longer matches the link deletion intent',
      );
    }
    if (
      !usesLiveSemantics &&
      policyEffectiveAt &&
      metadata.timestampMs < policyEffectiveAt.getTime()
    ) {
      throw reject(
        'history_policy_revision_changed',
        'Message predates the current link policy baseline',
      );
    }

    const view = adaptMaxMessageNavigationView(exactRow);
    const fingerprint = createMessageContentFingerprint(view);
    if (
      !usesLiveSemantics &&
      !matchingRecoveryReasons.some((reason) => reason.contentFingerprint === fingerprint)
    ) {
      throw reject(
        'history_content_changed',
        'Message content changed after the recovery candidate was recorded',
      );
    }

    const targets = filterActionableNavigationTargets(
      extractEnabledNavigationTargets(view, this.extractionOptions),
    );
    if (
      !isLinkHistoryPolicyViolation(
        settings.linkPolicy,
        allowlistRows.map((row) => row.domain),
        targets,
        settings.linkRulesPolicy,
      )
    ) {
      throw reject(
        usesLiveSemantics
          ? 'live_violation_no_longer_present'
          : 'history_violation_no_longer_present',
        'Exact message content no longer violates the current link policy',
      );
    }
    return prepareDeleteAuthority(async () => {
      const current = await loadAuthority();
      if (
        (!usesLiveSemantics &&
          current.policyEffectiveAt &&
          metadata.timestampMs < current.policyEffectiveAt.getTime()) ||
        !isLinkHistoryPolicyViolation(
          current.settings.linkPolicy,
          current.allowlistRows.map((row) => row.domain),
          targets,
          current.settings.linkRulesPolicy,
        )
      )
        throw reject(
          usesLiveSemantics
            ? 'live_violation_no_longer_present'
            : 'history_violation_no_longer_present',
          'Current link policy no longer authorizes this deletion',
        );
      return 'allowed' as const;
    });
  }

  private parseReasonMetadata(value: unknown): RecoveryReasonMetadata | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const row = value as Record<string, unknown>;
    const fingerprint =
      typeof row.contentFingerprint === 'string' ? row.contentFingerprint.trim().toLowerCase() : '';
    const revision = Number(row.policyRevision);
    const effectiveAt =
      typeof row.policyEffectiveAt === 'string' || row.policyEffectiveAt instanceof Date
        ? new Date(row.policyEffectiveAt)
        : null;
    if (
      !/^[a-f0-9]{64}$/u.test(fingerprint) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !effectiveAt ||
      !Number.isFinite(effectiveAt.getTime())
    ) {
      return null;
    }
    return {
      contentFingerprint: fingerprint,
      policyRevision: revision,
      policyEffectiveAt: effectiveAt,
      ...(typeof row.linkRulesPolicySha256 === 'string'
        ? { linkRulesPolicySha256: row.linkRulesPolicySha256 }
        : {}),
    };
  }

  private parseLiveReasonMetadata(value: unknown): LiveReasonMetadata | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const row = value as Record<string, unknown>;
    const revision = row.linkPolicyRevision;
    const effectiveAt =
      typeof row.linkPolicyEffectiveAt === 'string' || row.linkPolicyEffectiveAt instanceof Date
        ? new Date(row.linkPolicyEffectiveAt)
        : null;
    if (
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !effectiveAt ||
      !Number.isFinite(effectiveAt.getTime())
    ) {
      return null;
    }
    return {
      linkPolicyRevision: revision,
      linkPolicyEffectiveAt: effectiveAt,
      ...(typeof row.linkRulesPolicySha256 === 'string'
        ? { linkRulesPolicySha256: row.linkRulesPolicySha256 }
        : {}),
    };
  }

  private readBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
      }
      if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
      }
    }
    return fallback;
  }
}
