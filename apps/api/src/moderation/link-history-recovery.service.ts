import { createHash, randomUUID } from 'node:crypto';

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MaxClientService } from '../max/max-client.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { resolveRuntimeServiceProfile } from '../runtime/runtime-topology';
import { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import {
  LINK_HISTORY_RECOVERY_RULE_CODE,
  LINK_HISTORY_RECOVERY_SOURCE_TAG,
  createMessageContentFingerprint,
  deriveLinkPolicySemanticEffectiveAt,
  filterActionableNavigationTargets,
  hasActionableNavigationTargets,
  isLinkHistoryPolicyViolation,
  parseLinkHistoryListedMessage,
  type LinkHistoryListedMessageMetadata,
} from './link-history-recovery.util';
import {
  extractEnabledNavigationTargets,
  resolveEnabledNavigationTargetOptions,
  type EnabledNavigationTargetOptions,
} from './navigation/enabled-navigation-targets';
import { adaptMaxMessageNavigationView } from './navigation/max-navigation-view.adapter';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import { activeLinkPolicySql, linkPolicySemanticEffectiveAtSql } from './link-rules-history.sql';
import { fingerprintLinkRulesPolicy, isRuntimeLinkPolicyActive } from './link-rules-policy.runtime';

export {
  createMessageContentFingerprint,
  parseLinkHistoryListedMessage,
} from './link-history-recovery.util';

const LINK_HISTORY_RECOVERY_COMPONENT = 'moderation-link-history-recovery';
const DISCOVERY_PHASE = 'DISCOVERY';
const REPAIR_PHASE = 'REPAIR';
const MAX_TIMESTAMP_SKEW_MS = 1_000;

type ScanPhase = typeof DISCOVERY_PHASE | typeof REPAIR_PHASE;

type LinkHistoryScanLease = {
  chatId: string;
  policyRevision: number;
  policyEffectiveAt: Date;
  discoveryCursorAt: Date;
  repairCursorAt: Date;
  nextPhase: string;
  continuationPhase: string | null;
  windowLowerAt: Date | null;
  windowUpperAt: Date | null;
  continuationFromAt: Date | null;
  lastPageSignature: string | null;
  leaseToken: string;
  leaseExpiresAt: Date;
};

export type LinkHistoryScanWindow = {
  phase: ScanPhase;
  lowerAt: Date;
  upperAt: Date;
  fromAt: Date;
  continuation: boolean;
};

type LinkHistoryRecoveryConfig = {
  scanEnabled: boolean;
  deleteEnabled: boolean;
  intervalMs: number;
  startupDelayMs: number;
  leaseMs: number;
  pageSize: number;
  successDelayMs: number;
  errorBackoffMs: number;
  discoveryOverlapMs: number;
  repairWindowMs: number;
  repairSliceMs: number;
  navigationTargetOptions: EnabledNavigationTargetOptions;
};

type LinkHistoryPolicySnapshot = {
  linkPolicy: 'ALLOWLIST_ONLY' | 'BLOCKLIST_ONLY' | 'ALERT_ONLY';
  linkRulesPolicy?: unknown;
  linkPolicyRevision: number;
  linkPolicyEffectiveAt: Date | null;
  adminUserIds: Set<string>;
  allowlist: string[];
};

type PageCounters = {
  listed: number;
  structuredCandidates: number;
  exactLookups: number;
  exactLookupUnknown: number;
  policyViolations: number;
  runtimeBotImmune: number;
  adminImmune: number;
  authorAccessUnknown: number;
  actionableCandidates: number;
  intentsEnsured: number;
};

class LinkHistoryRecoveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LinkHistoryRecoveryError';
  }
}

@Injectable()
export class LinkHistoryRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LinkHistoryRecoveryService.name);
  private readonly config: LinkHistoryRecoveryConfig;
  private readonly runsInBackgroundModerationService: boolean;
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private nextSeedAtMs = 0;
  private governorBackoffUntilMs = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly deleteIntents: ModerationDeleteIntentService,
    private readonly backgroundGovernor: BackgroundRuntimeGovernorService,
    configService: ConfigService,
  ) {
    this.runsInBackgroundModerationService =
      resolveRuntimeServiceProfile().service.serviceName === 'api-moderation-background';
    this.config = {
      scanEnabled: this.readBoolean(
        configService.get('MODERATION_LINK_HISTORY_SCAN_ENABLED'),
        false,
      ),
      deleteEnabled: this.readBoolean(
        configService.get('MODERATION_LINK_HISTORY_DELETE_ENABLED'),
        false,
      ),
      intervalMs: this.readPositiveInt(
        configService.get('MODERATION_LINK_HISTORY_SCAN_INTERVAL_MS'),
        1_000,
      ),
      startupDelayMs: this.readNonNegativeInt(
        configService.get('MODERATION_LINK_HISTORY_SCAN_STARTUP_DELAY_MS'),
        30_000,
      ),
      leaseMs: this.readPositiveInt(
        configService.get('MODERATION_LINK_HISTORY_SCAN_LEASE_MS'),
        60_000,
      ),
      pageSize: Math.min(
        99,
        this.readPositiveInt(configService.get('MODERATION_LINK_HISTORY_SCAN_PAGE_SIZE'), 50),
      ),
      successDelayMs: this.readPositiveInt(
        configService.get('MODERATION_LINK_HISTORY_SCAN_SUCCESS_DELAY_MS'),
        5 * 60_000,
      ),
      errorBackoffMs: this.readPositiveInt(
        configService.get('MODERATION_LINK_HISTORY_SCAN_ERROR_BACKOFF_MS'),
        5 * 60_000,
      ),
      discoveryOverlapMs: this.readPositiveInt(
        configService.get('MODERATION_LINK_HISTORY_DISCOVERY_OVERLAP_MS'),
        5 * 60_000,
      ),
      repairWindowMs: this.readPositiveInt(
        configService.get('MODERATION_LINK_HISTORY_REPAIR_WINDOW_MS'),
        24 * 60 * 60_000,
      ),
      repairSliceMs: this.readPositiveInt(
        configService.get('MODERATION_LINK_HISTORY_REPAIR_SLICE_MS'),
        60 * 60_000,
      ),
      navigationTargetOptions: resolveEnabledNavigationTargetOptions(configService),
    };
  }

  onModuleInit(): void {
    if (!this.runsInBackgroundModerationService || !this.config.scanEnabled) {
      return;
    }
    this.logger.log(
      {
        deleteEnabled: this.config.deleteEnabled,
        pageSize: this.config.pageSize,
        repairWindowMs: this.config.repairWindowMs,
      },
      'Enabled link history recovery worker',
    );
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.tick();
      this.timer = setInterval(() => void this.tick(), this.config.intervalMs);
      this.timer.unref();
    }, this.config.startupDelayMs);
    this.startupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<boolean> {
    if (!this.runsInBackgroundModerationService || !this.config.scanEnabled) {
      return false;
    }
    if (Date.now() < this.governorBackoffUntilMs) {
      return false;
    }

    const decision = await this.backgroundGovernor.decide({
      component: LINK_HISTORY_RECOVERY_COMPONENT,
      sourceTag: LINK_HISTORY_RECOVERY_SOURCE_TAG,
      allowMaxApiCapacitySlowPath: false,
    });
    if (decision.action !== 'run') {
      this.governorBackoffUntilMs = Date.now() + Math.max(1_000, decision.retryAfterMs);
      return false;
    }

    const now = new Date();
    if (now.getTime() >= this.nextSeedAtMs) {
      const seeded = await this.seedScanStates(now);
      if (seeded > 0) {
        this.logger.log(
          { affectedStates: seeded, deleteEnabled: this.config.deleteEnabled },
          'Synchronized link history scan baselines',
        );
      }
      this.nextSeedAtMs = now.getTime() + 60_000;
    }

    const lease = await this.claimNextState(now);
    if (!lease) {
      return false;
    }

    try {
      const counters = await this.processLease(lease, now);
      const logContext = {
        chatId: lease.chatId,
        phase: lease.continuationPhase ?? lease.nextPhase,
        deleteEnabled: this.config.deleteEnabled,
        ...counters,
      };
      if (counters.policyViolations > 0) {
        this.logger.log(logContext, 'Completed one link history recovery candidate page');
      } else {
        this.logger.debug(logContext, 'Completed one link history recovery page');
      }
    } catch (error: unknown) {
      const code =
        error instanceof LinkHistoryRecoveryError ? error.code : 'link_history_scan_failed';
      await this.failLease(lease, code);
      this.logger.warn(
        {
          chatId: lease.chatId,
          code,
          err: error instanceof Error ? error.message : String(error),
        },
        'Deferred link history recovery without advancing its cursor',
      );
    }
    return true;
  }

  private async tick(): Promise<void> {
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      await this.runOnce();
    } catch (error: unknown) {
      this.governorBackoffUntilMs = Date.now() + this.config.errorBackoffMs;
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Link history recovery tick failed before a chat lease was claimed',
      );
    } finally {
      this.inFlight = false;
    }
  }

  private async processLease(lease: LinkHistoryScanLease, now: Date): Promise<PageCounters> {
    await this.renewLease(lease);
    const policy = await this.loadPolicy(lease.chatId, now);
    this.assertMatchingPolicy(lease, policy);
    const window = resolveLinkHistoryScanWindow(lease, now, this.config);
    if (window.upperAt.getTime() <= window.lowerAt.getTime()) {
      await this.completeWindow(lease, window, now);
      return emptyPageCounters();
    }

    const scanBotId = await this.resolveScanBotId(lease.chatId);
    if (!scanBotId) {
      throw new LinkHistoryRecoveryError(
        'scan_bot_unavailable',
        'No active bot route is available for link history recovery',
      );
    }

    await this.renewLease(lease);
    const rows = await this.maxClient.listMessages(lease.chatId, {
      count: this.config.pageSize + 1,
      from: window.fromAt,
      to: window.lowerAt,
      trafficClass: 'background',
      sourceTag: LINK_HISTORY_RECOVERY_SOURCE_TAG,
      botId: scanBotId,
    });
    const parsedRows = rows.map((row) => ({ row, metadata: parseLinkHistoryListedMessage(row) }));
    if (parsedRows.some((item) => item.metadata === null)) {
      throw new LinkHistoryRecoveryError(
        'invalid_history_row',
        'MAX history returned a row without a millisecond timestamp, message id, or sender shape',
      );
    }
    const normalizedRows = parsedRows as Array<{
      row: Record<string, unknown>;
      metadata: LinkHistoryListedMessageMetadata;
    }>;
    this.assertRowsInsideWindow(normalizedRows, window);
    this.assertRowsReverseChronological(normalizedRows);

    const hasLookahead = normalizedRows.length > this.config.pageSize;
    let pageRows = normalizedRows.slice(0, this.config.pageSize);
    let continuationFromMs: number | null = null;
    if (hasLookahead) {
      const boundaryTimestampMs = pageRows.at(-1)!.metadata.timestampMs;
      const lookaheadTimestampMs = normalizedRows[this.config.pageSize]!.metadata.timestampMs;
      if (boundaryTimestampMs === lookaheadTimestampMs) {
        const boundaryStart = pageRows.findIndex(
          (item) => item.metadata.timestampMs === boundaryTimestampMs,
        );
        if (boundaryStart === 0) {
          throw new LinkHistoryRecoveryError(
            'history_page_timestamp_tie_saturated',
            'A MAX history timestamp group exceeds the safe page capacity',
          );
        }
        pageRows = pageRows.slice(0, boundaryStart);
        continuationFromMs = boundaryTimestampMs;
      } else {
        continuationFromMs = boundaryTimestampMs - 1;
      }
      if (
        continuationFromMs <= window.lowerAt.getTime() ||
        continuationFromMs >= window.fromAt.getTime()
      ) {
        throw new LinkHistoryRecoveryError(
          'history_page_saturated',
          'A MAX history page cannot be continued inside the requested window',
        );
      }
    }

    const signature = createPageSignature(normalizedRows.map((item) => item.metadata));
    if (hasLookahead && window.continuation && signature === lease.lastPageSignature) {
      throw new LinkHistoryRecoveryError(
        'history_page_saturated',
        'MAX repeated a full timestamp page; cursor advancement would skip messages',
      );
    }

    const counters: PageCounters = {
      ...emptyPageCounters(),
      listed: rows.length,
    };
    for (const item of pageRows) {
      const listedTargets = this.extractEnabledTargets(adaptMaxMessageNavigationView(item.row));
      if (!hasActionableNavigationTargets(listedTargets)) {
        continue;
      }
      counters.structuredCandidates += 1;
      await this.renewLease(lease);
      let exactRow: Record<string, unknown> | null;
      try {
        exactRow = await this.maxClient.getExactMessageRow(lease.chatId, item.metadata.messageId, {
          trafficClass: 'background',
          sourceTag: LINK_HISTORY_RECOVERY_SOURCE_TAG,
          botId: scanBotId,
          bypassCache: true,
        });
      } catch (error: unknown) {
        counters.exactLookups += 1;
        if (readHttpStatus(error) !== 404) {
          throw error;
        }
        // MAX uses the same 404 for a missing message and lost bot access. Skip this candidate
        // without deleting it, but advance the bounded history cursor so one row cannot starve it.
        counters.exactLookupUnknown += 1;
        continue;
      }
      counters.exactLookups += 1;
      if (!exactRow) {
        continue;
      }

      const exactMetadata = parseLinkHistoryListedMessage(exactRow);
      if (!exactMetadata || exactMetadata.messageId !== item.metadata.messageId) {
        throw new LinkHistoryRecoveryError(
          'exact_message_mismatch',
          'MAX exact lookup returned an invalid or different message row',
        );
      }
      if (exactMetadata.timestampMs < policy.linkPolicyEffectiveAt!.getTime()) {
        continue;
      }

      const exactView = adaptMaxMessageNavigationView(exactRow);
      const actionableTargets = filterActionableNavigationTargets(
        this.extractEnabledTargets(exactView),
      );
      if (
        !isLinkHistoryPolicyViolation(
          policy.linkPolicy,
          policy.allowlist,
          actionableTargets,
          policy.linkRulesPolicy,
        )
      ) {
        continue;
      }
      counters.policyViolations += 1;
      if (!exactMetadata.senderId) {
        throw new LinkHistoryRecoveryError(
          'message_author_unknown',
          'Recovery cannot prove the exact message author',
        );
      }
      if (this.maxBotLinkService.isKnownBotUserId(exactMetadata.senderId)) {
        counters.runtimeBotImmune += 1;
        continue;
      }
      if (policy.adminUserIds.has(exactMetadata.senderId)) {
        counters.adminImmune += 1;
        continue;
      }

      await this.renewLease(lease);
      const remoteAccess = await this.maxClient.getChatMemberAccess(
        lease.chatId,
        exactMetadata.senderId,
        {
          trafficClass: 'background',
          sourceTag: LINK_HISTORY_RECOVERY_SOURCE_TAG,
          botId: scanBotId,
          bypassCache: true,
        },
      );
      if (!remoteAccess) {
        counters.authorAccessUnknown += 1;
        continue;
      }
      if (remoteAccess?.isAdmin || remoteAccess?.isOwner) {
        counters.adminImmune += 1;
        continue;
      }

      counters.actionableCandidates += 1;
      if (!this.config.deleteEnabled) {
        continue;
      }
      const fingerprint = createMessageContentFingerprint(exactView);
      const ensured = await this.deleteIntents.ensureIntent({
        chatId: lease.chatId,
        messageId: exactMetadata.messageId,
        reasonKey: `link-history-recovery:${fingerprint}`,
        ruleCode: LINK_HISTORY_RECOVERY_RULE_CODE,
        subjectUserId: exactMetadata.senderId,
        sourceMessageAt: new Date(exactMetadata.timestampMs),
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: scanBotId,
        routingPolicy: 'delete_capable',
        event: {
          userId: exactMetadata.senderId,
          eventType: 'MESSAGE',
          score: 1,
          metadata: {
            source: 'history_recovery',
            contentFingerprint: fingerprint,
            policyRevision: policy.linkPolicyRevision,
            policyEffectiveAt: policy.linkPolicyEffectiveAt!.toISOString(),
            ...(policy.linkRulesPolicy != null
              ? { linkRulesPolicySha256: fingerprintLinkRulesPolicy(policy.linkRulesPolicy) }
              : {}),
            evidence: actionableTargets.map((target) => ({
              kind: target.kind,
              targetHash: hashSensitiveValue(target.normalizedTarget),
              carriers: Array.from(new Set(target.origins.map((origin) => origin.carrier))).sort(),
              provenance: Array.from(
                new Set(target.origins.map((origin) => origin.provenance)),
              ).sort(),
            })),
          },
        },
      });
      if (ensured.intentId) {
        counters.intentsEnsured += 1;
      }
    }

    if (hasLookahead && continuationFromMs !== null) {
      await this.persistContinuation(lease, window, new Date(continuationFromMs), signature, now);
    } else {
      await this.completeWindow(lease, window, now);
    }
    return counters;
  }

  private async seedScanStates(now: Date): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "moderation_link_history_scan_states" (
        "chat_id", "policy_revision", "policy_effective_at", "discovery_cursor_at",
        "repair_cursor_at", "next_phase", "delete_mode_prepared", "next_scan_at",
        "created_at", "updated_at"
      )
      SELECT
        settings."chat_id",
        settings."link_policy_revision",
        semantic_baseline."effective_at",
        semantic_baseline."effective_at",
        semantic_baseline."effective_at",
        ${DISCOVERY_PHASE},
        ${this.config.deleteEnabled},
        ${now},
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM "chat_settings" settings
      INNER JOIN "chats" chat ON chat."id" = settings."chat_id"
      CROSS JOIN LATERAL (
        SELECT ${linkPolicySemanticEffectiveAtSql(now)} AS "effective_at"
      ) semantic_baseline
      WHERE ${activeLinkPolicySql()}
        AND settings."link_policy_revision" >= 1
        AND settings."link_policy_effective_at" IS NOT NULL
        AND semantic_baseline."effective_at" IS NOT NULL
        AND chat."entity_type" = CAST('CHAT' AS "ChatEntityType")
      ON CONFLICT ("chat_id") DO UPDATE SET
        "policy_revision" = EXCLUDED."policy_revision",
        "policy_effective_at" = EXCLUDED."policy_effective_at",
        "discovery_cursor_at" = CASE
          WHEN "moderation_link_history_scan_states"."policy_revision"
              <> EXCLUDED."policy_revision"
            OR "moderation_link_history_scan_states"."policy_effective_at"
              <> EXCLUDED."policy_effective_at"
            OR (EXCLUDED."delete_mode_prepared"
              AND NOT "moderation_link_history_scan_states"."delete_mode_prepared")
          THEN EXCLUDED."policy_effective_at"
          ELSE "moderation_link_history_scan_states"."discovery_cursor_at"
        END,
        "repair_cursor_at" = CASE
          WHEN "moderation_link_history_scan_states"."policy_revision"
              <> EXCLUDED."policy_revision"
            OR "moderation_link_history_scan_states"."policy_effective_at"
              <> EXCLUDED."policy_effective_at"
            OR (EXCLUDED."delete_mode_prepared"
              AND NOT "moderation_link_history_scan_states"."delete_mode_prepared")
          THEN EXCLUDED."policy_effective_at"
          ELSE "moderation_link_history_scan_states"."repair_cursor_at"
        END,
        "next_phase" = CASE
          WHEN "moderation_link_history_scan_states"."policy_revision"
              <> EXCLUDED."policy_revision"
            OR "moderation_link_history_scan_states"."policy_effective_at"
              <> EXCLUDED."policy_effective_at"
            OR (EXCLUDED."delete_mode_prepared"
              AND NOT "moderation_link_history_scan_states"."delete_mode_prepared")
          THEN ${DISCOVERY_PHASE}
          ELSE "moderation_link_history_scan_states"."next_phase"
        END,
        "continuation_phase" = CASE
          WHEN "moderation_link_history_scan_states"."policy_revision"
              <> EXCLUDED."policy_revision"
            OR "moderation_link_history_scan_states"."policy_effective_at"
              <> EXCLUDED."policy_effective_at"
            OR (EXCLUDED."delete_mode_prepared"
              AND NOT "moderation_link_history_scan_states"."delete_mode_prepared")
          THEN NULL
          ELSE "moderation_link_history_scan_states"."continuation_phase"
        END,
        "window_lower_at" = CASE
          WHEN "moderation_link_history_scan_states"."policy_revision"
              <> EXCLUDED."policy_revision"
            OR "moderation_link_history_scan_states"."policy_effective_at"
              <> EXCLUDED."policy_effective_at"
            OR (EXCLUDED."delete_mode_prepared"
              AND NOT "moderation_link_history_scan_states"."delete_mode_prepared")
          THEN NULL
          ELSE "moderation_link_history_scan_states"."window_lower_at"
        END,
        "window_upper_at" = CASE
          WHEN "moderation_link_history_scan_states"."policy_revision"
              <> EXCLUDED."policy_revision"
            OR "moderation_link_history_scan_states"."policy_effective_at"
              <> EXCLUDED."policy_effective_at"
            OR (EXCLUDED."delete_mode_prepared"
              AND NOT "moderation_link_history_scan_states"."delete_mode_prepared")
          THEN NULL
          ELSE "moderation_link_history_scan_states"."window_upper_at"
        END,
        "continuation_from_at" = CASE
          WHEN "moderation_link_history_scan_states"."policy_revision"
              <> EXCLUDED."policy_revision"
            OR "moderation_link_history_scan_states"."policy_effective_at"
              <> EXCLUDED."policy_effective_at"
            OR (EXCLUDED."delete_mode_prepared"
              AND NOT "moderation_link_history_scan_states"."delete_mode_prepared")
          THEN NULL
          ELSE "moderation_link_history_scan_states"."continuation_from_at"
        END,
        "last_page_signature" = CASE
          WHEN "moderation_link_history_scan_states"."policy_revision"
              <> EXCLUDED."policy_revision"
            OR "moderation_link_history_scan_states"."policy_effective_at"
              <> EXCLUDED."policy_effective_at"
            OR (EXCLUDED."delete_mode_prepared"
              AND NOT "moderation_link_history_scan_states"."delete_mode_prepared")
          THEN NULL
          ELSE "moderation_link_history_scan_states"."last_page_signature"
        END,
        "delete_mode_prepared" = EXCLUDED."delete_mode_prepared",
        "next_scan_at" = CASE
          WHEN "moderation_link_history_scan_states"."policy_revision"
              <> EXCLUDED."policy_revision"
            OR "moderation_link_history_scan_states"."policy_effective_at"
              <> EXCLUDED."policy_effective_at"
            OR (EXCLUDED."delete_mode_prepared"
              AND NOT "moderation_link_history_scan_states"."delete_mode_prepared")
          THEN ${now}
          ELSE "moderation_link_history_scan_states"."next_scan_at"
        END,
        "last_error_code" = CASE
          WHEN "moderation_link_history_scan_states"."policy_revision"
              <> EXCLUDED."policy_revision"
            OR "moderation_link_history_scan_states"."policy_effective_at"
              <> EXCLUDED."policy_effective_at"
            OR (EXCLUDED."delete_mode_prepared"
              AND NOT "moderation_link_history_scan_states"."delete_mode_prepared")
          THEN NULL
          ELSE "moderation_link_history_scan_states"."last_error_code"
        END,
        "last_error_at" = CASE
          WHEN "moderation_link_history_scan_states"."policy_revision"
              <> EXCLUDED."policy_revision"
            OR "moderation_link_history_scan_states"."policy_effective_at"
              <> EXCLUDED."policy_effective_at"
            OR (EXCLUDED."delete_mode_prepared"
              AND NOT "moderation_link_history_scan_states"."delete_mode_prepared")
          THEN NULL
          ELSE "moderation_link_history_scan_states"."last_error_at"
        END,
        "lease_token" = CASE
          WHEN "moderation_link_history_scan_states"."policy_revision"
              <> EXCLUDED."policy_revision"
            OR "moderation_link_history_scan_states"."policy_effective_at"
              <> EXCLUDED."policy_effective_at"
            OR (EXCLUDED."delete_mode_prepared"
              AND NOT "moderation_link_history_scan_states"."delete_mode_prepared")
          THEN NULL
          ELSE "moderation_link_history_scan_states"."lease_token"
        END,
        "lease_expires_at" = CASE
          WHEN "moderation_link_history_scan_states"."policy_revision"
              <> EXCLUDED."policy_revision"
            OR "moderation_link_history_scan_states"."policy_effective_at"
              <> EXCLUDED."policy_effective_at"
            OR (EXCLUDED."delete_mode_prepared"
              AND NOT "moderation_link_history_scan_states"."delete_mode_prepared")
          THEN NULL
          ELSE "moderation_link_history_scan_states"."lease_expires_at"
        END,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "moderation_link_history_scan_states"."policy_revision"
          <> EXCLUDED."policy_revision"
        OR "moderation_link_history_scan_states"."policy_effective_at"
          <> EXCLUDED."policy_effective_at"
        OR "moderation_link_history_scan_states"."delete_mode_prepared"
          <> EXCLUDED."delete_mode_prepared"
    `);
  }

  private async claimNextState(now: Date): Promise<LinkHistoryScanLease | null> {
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + this.config.leaseMs);
    const rows = await this.prisma.$queryRaw<LinkHistoryScanLease[]>(Prisma.sql`
      WITH candidate AS (
        SELECT state."chat_id"
        FROM "moderation_link_history_scan_states" state
        INNER JOIN "chat_settings" settings ON settings."chat_id" = state."chat_id"
        INNER JOIN "chats" chat ON chat."id" = state."chat_id"
        CROSS JOIN LATERAL (
          SELECT ${linkPolicySemanticEffectiveAtSql(now)} AS "effective_at"
        ) semantic_baseline
        WHERE state."next_scan_at" <= ${now}
          AND (state."lease_expires_at" IS NULL OR state."lease_expires_at" < ${now})
          AND ${activeLinkPolicySql()}
          AND settings."link_policy_revision" = state."policy_revision"
          AND settings."link_policy_effective_at" IS NOT NULL
          AND semantic_baseline."effective_at" = state."policy_effective_at"
          AND chat."entity_type" = CAST('CHAT' AS "ChatEntityType")
        ORDER BY state."next_scan_at" ASC, state."last_successful_scan_at" ASC NULLS FIRST,
          state."chat_id" ASC
        LIMIT 1
        FOR UPDATE OF state SKIP LOCKED
      )
      UPDATE "moderation_link_history_scan_states" state
      SET
        "lease_token" = ${leaseToken},
        "lease_expires_at" = ${leaseExpiresAt},
        "updated_at" = CURRENT_TIMESTAMP
      FROM candidate
      WHERE state."chat_id" = candidate."chat_id"
      RETURNING
        state."chat_id" AS "chatId",
        state."policy_revision" AS "policyRevision",
        state."policy_effective_at" AS "policyEffectiveAt",
        state."discovery_cursor_at" AS "discoveryCursorAt",
        state."repair_cursor_at" AS "repairCursorAt",
        state."next_phase" AS "nextPhase",
        state."continuation_phase" AS "continuationPhase",
        state."window_lower_at" AS "windowLowerAt",
        state."window_upper_at" AS "windowUpperAt",
        state."continuation_from_at" AS "continuationFromAt",
        state."last_page_signature" AS "lastPageSignature",
        state."lease_token" AS "leaseToken",
        state."lease_expires_at" AS "leaseExpiresAt"
    `);
    return rows[0] ?? null;
  }

  private async loadPolicy(chatId: string, now: Date): Promise<LinkHistoryPolicySnapshot> {
    const [settings, allowlistRows, expiredAllowlist] = await this.prisma.$transaction(
      [
        this.prisma.chatSettings.findUnique({
          where: { chatId },
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
            chatId,
            OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: now } }],
          },
          select: { domain: true },
        }),
        this.prisma.domainAllowlist.aggregate({
          where: {
            chatId,
            removeAfterAt: { lte: now },
          },
          _max: { removeAfterAt: true },
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    if (!settings) {
      throw new LinkHistoryRecoveryError('policy_missing', 'Chat link policy no longer exists');
    }
    return {
      linkPolicy: settings.linkPolicy,
      linkRulesPolicy: settings.linkRulesPolicy,
      linkPolicyRevision: settings.linkPolicyRevision,
      linkPolicyEffectiveAt: deriveLinkPolicySemanticEffectiveAt(
        settings.linkPolicy,
        settings.linkPolicyEffectiveAt,
        expiredAllowlist._max.removeAfterAt,
        settings.linkRulesPolicy,
        now.getTime(),
      ),
      adminUserIds: new Set(settings.chat.admins.map((admin) => admin.userId)),
      allowlist: allowlistRows.map((row) => row.domain),
    };
  }

  private extractEnabledTargets(
    view: Parameters<typeof extractEnabledNavigationTargets>[0],
  ): ReturnType<typeof extractEnabledNavigationTargets> {
    return extractEnabledNavigationTargets(view, {
      ...this.config.navigationTargetOptions,
    });
  }

  private assertMatchingPolicy(
    lease: LinkHistoryScanLease,
    policy: LinkHistoryPolicySnapshot,
  ): asserts policy is LinkHistoryPolicySnapshot & { linkPolicyEffectiveAt: Date } {
    if (
      !isRuntimeLinkPolicyActive(policy.linkPolicy, policy.linkRulesPolicy) ||
      !policy.linkPolicyEffectiveAt ||
      policy.linkPolicyRevision !== lease.policyRevision ||
      policy.linkPolicyEffectiveAt.getTime() !== lease.policyEffectiveAt.getTime()
    ) {
      throw new LinkHistoryRecoveryError(
        'policy_revision_changed',
        'Link policy changed after the recovery lease was claimed',
      );
    }
  }

  private async resolveScanBotId(chatId: string): Promise<string | null> {
    const route = await this.maxBotLinkService.resolveBotRoute({
      purpose: 'capability',
      chatId,
      capability: 'background_scans',
      fallbackToPrimary: true,
    });
    return route.botId?.trim() || null;
  }

  private assertRowsInsideWindow(
    rows: readonly { metadata: LinkHistoryListedMessageMetadata }[],
    window: LinkHistoryScanWindow,
  ): void {
    const lowerMs = window.lowerAt.getTime() - MAX_TIMESTAMP_SKEW_MS;
    const upperMs = window.upperAt.getTime() + MAX_TIMESTAMP_SKEW_MS;
    if (
      rows.some(({ metadata }) => metadata.timestampMs < lowerMs || metadata.timestampMs > upperMs)
    ) {
      throw new LinkHistoryRecoveryError(
        'history_boundary_violation',
        'MAX history returned a message outside the requested millisecond window',
      );
    }
  }

  private assertRowsReverseChronological(
    rows: readonly { metadata: LinkHistoryListedMessageMetadata }[],
  ): void {
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index]!.metadata.timestampMs > rows[index - 1]!.metadata.timestampMs) {
        throw new LinkHistoryRecoveryError(
          'history_order_violation',
          'MAX history rows are not ordered from newest to oldest',
        );
      }
    }
  }

  private async renewLease(lease: LinkHistoryScanLease): Promise<void> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + this.config.leaseMs);
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_link_history_scan_states"
      SET "lease_expires_at" = ${leaseExpiresAt}, "updated_at" = CURRENT_TIMESTAMP
      WHERE "chat_id" = ${lease.chatId}
        AND "lease_token" = ${lease.leaseToken}
        AND "lease_expires_at" > ${now}
    `);
    if (changed === 0) {
      throw new LinkHistoryRecoveryError('scan_lease_lost', 'Link history scan lease was lost');
    }
    lease.leaseExpiresAt = leaseExpiresAt;
  }

  private async persistContinuation(
    lease: LinkHistoryScanLease,
    window: LinkHistoryScanWindow,
    continuationFromAt: Date,
    signature: string,
    now: Date,
  ): Promise<void> {
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_link_history_scan_states"
      SET
        "continuation_phase" = ${window.phase},
        "window_lower_at" = ${window.lowerAt},
        "window_upper_at" = ${window.upperAt},
        "continuation_from_at" = ${continuationFromAt},
        "last_page_signature" = ${signature},
        "next_scan_at" = ${new Date(now.getTime() + this.config.intervalMs)},
        "last_error_code" = NULL,
        "last_error_at" = NULL,
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "chat_id" = ${lease.chatId} AND "lease_token" = ${lease.leaseToken}
    `);
    if (changed === 0) {
      throw new LinkHistoryRecoveryError(
        'scan_lease_lost',
        'Link history continuation lease was lost',
      );
    }
  }

  private async completeWindow(
    lease: LinkHistoryScanLease,
    window: LinkHistoryScanWindow,
    now: Date,
  ): Promise<void> {
    const repairFloorAt = new Date(
      Math.max(lease.policyEffectiveAt.getTime(), now.getTime() - this.config.repairWindowMs),
    );
    const nextDiscoveryCursorAt =
      window.phase === DISCOVERY_PHASE ? window.upperAt : lease.discoveryCursorAt;
    const repairReachedDiscovery = window.upperAt.getTime() >= lease.discoveryCursorAt.getTime();
    const nextRepairCursorAt =
      window.phase === REPAIR_PHASE
        ? repairReachedDiscovery
          ? repairFloorAt
          : window.upperAt
        : lease.repairCursorAt;
    const nextPhase = window.phase === DISCOVERY_PHASE ? REPAIR_PHASE : DISCOVERY_PHASE;
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_link_history_scan_states"
      SET
        "discovery_cursor_at" = ${nextDiscoveryCursorAt},
        "repair_cursor_at" = ${nextRepairCursorAt},
        "next_phase" = ${nextPhase},
        "continuation_phase" = NULL,
        "window_lower_at" = NULL,
        "window_upper_at" = NULL,
        "continuation_from_at" = NULL,
        "last_page_signature" = NULL,
        "next_scan_at" = ${new Date(now.getTime() + this.config.successDelayMs)},
        "last_successful_scan_at" = CURRENT_TIMESTAMP,
        "last_error_code" = NULL,
        "last_error_at" = NULL,
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "chat_id" = ${lease.chatId} AND "lease_token" = ${lease.leaseToken}
    `);
    if (changed === 0) {
      throw new LinkHistoryRecoveryError(
        'scan_lease_lost',
        'Link history completion lease was lost',
      );
    }
  }

  private async failLease(lease: LinkHistoryScanLease, errorCode: string): Promise<void> {
    const now = new Date();
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_link_history_scan_states"
      SET
        "next_scan_at" = ${new Date(now.getTime() + this.config.errorBackoffMs)},
        "last_error_code" = ${errorCode.slice(0, 128)},
        "last_error_at" = ${now},
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "chat_id" = ${lease.chatId} AND "lease_token" = ${lease.leaseToken}
    `);
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

  private readPositiveInt(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private readNonNegativeInt(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
  }
}

export function resolveLinkHistoryScanWindow(
  lease: Pick<
    LinkHistoryScanLease,
    | 'policyEffectiveAt'
    | 'discoveryCursorAt'
    | 'repairCursorAt'
    | 'nextPhase'
    | 'continuationPhase'
    | 'windowLowerAt'
    | 'windowUpperAt'
    | 'continuationFromAt'
  >,
  now: Date,
  config: Pick<
    LinkHistoryRecoveryConfig,
    'discoveryOverlapMs' | 'repairWindowMs' | 'repairSliceMs'
  >,
): LinkHistoryScanWindow {
  if (lease.continuationPhase !== null) {
    const phase = normalizePhase(lease.continuationPhase);
    if (!phase || !lease.windowLowerAt || !lease.windowUpperAt || !lease.continuationFromAt) {
      throw new LinkHistoryRecoveryError(
        'invalid_scan_continuation',
        'Persisted link history continuation is incomplete',
      );
    }
    if (
      lease.windowLowerAt.getTime() < lease.policyEffectiveAt.getTime() ||
      lease.windowUpperAt.getTime() > now.getTime() + MAX_TIMESTAMP_SKEW_MS ||
      lease.continuationFromAt.getTime() > lease.windowUpperAt.getTime() ||
      lease.continuationFromAt.getTime() <= lease.windowLowerAt.getTime()
    ) {
      throw new LinkHistoryRecoveryError(
        'invalid_scan_continuation',
        'Persisted link history continuation has unsafe boundaries',
      );
    }
    return {
      phase,
      lowerAt: lease.windowLowerAt,
      upperAt: lease.windowUpperAt,
      fromAt: lease.continuationFromAt,
      continuation: true,
    };
  }

  const phase = normalizePhase(lease.nextPhase);
  if (!phase) {
    throw new LinkHistoryRecoveryError('invalid_scan_phase', 'Persisted scan phase is invalid');
  }
  if (phase === DISCOVERY_PHASE) {
    const lowerAt = new Date(
      Math.max(
        lease.policyEffectiveAt.getTime(),
        lease.discoveryCursorAt.getTime() - config.discoveryOverlapMs,
      ),
    );
    return { phase, lowerAt, upperAt: now, fromAt: now, continuation: false };
  }

  const repairFloorMs = Math.max(
    lease.policyEffectiveAt.getTime(),
    now.getTime() - config.repairWindowMs,
  );
  const discoveryUpperMs = Math.min(lease.discoveryCursorAt.getTime(), now.getTime());
  const repairCursorMs =
    lease.repairCursorAt.getTime() < repairFloorMs ||
    lease.repairCursorAt.getTime() >= discoveryUpperMs
      ? repairFloorMs
      : lease.repairCursorAt.getTime();
  const upperMs = Math.min(repairCursorMs + config.repairSliceMs, discoveryUpperMs);
  return {
    phase,
    lowerAt: new Date(repairCursorMs),
    upperAt: new Date(upperMs),
    fromAt: new Date(upperMs),
    continuation: false,
  };
}

function createPageSignature(rows: readonly LinkHistoryListedMessageMetadata[]): string {
  const hash = createHash('sha256').update('max-link-history-page:v1\0');
  for (const row of rows) {
    hash.update(row.messageId).update('\0').update(String(row.timestampMs)).update('\0');
  }
  return hash.digest('hex');
}

function hashSensitiveValue(value: string): string {
  return createHash('sha256').update('max-navigation-target:v1\0').update(value).digest('hex');
}

function normalizePhase(value: string): ScanPhase | null {
  return value === DISCOVERY_PHASE || value === REPAIR_PHASE ? value : null;
}

function emptyPageCounters(): PageCounters {
  return {
    listed: 0,
    structuredCandidates: 0,
    exactLookups: 0,
    exactLookupUnknown: 0,
    policyViolations: 0,
    runtimeBotImmune: 0,
    adminImmune: 0,
    authorAccessUnknown: 0,
    actionableCandidates: 0,
    intentsEnsured: 0,
  };
}

function readHttpStatus(error: unknown): number | null {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === 'number' ? status : null;
}
