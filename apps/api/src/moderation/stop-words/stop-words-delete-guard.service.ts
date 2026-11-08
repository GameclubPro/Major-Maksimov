import {
  prepareDeleteAuthority,
  finalizeDeleteAuthority,
  type DeleteAuthorityPreparation,
} from '../moderation-delete-authority-preparation';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MaxBotLinkService } from '../../max/max-bot-link.service';
import { AutomaticDeleteAuthorAccessService } from '../../max/automatic-delete-author-access.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../../max/max-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookParser } from '../../webhook/webhook.parser';
import { ParticipantModerationImmunityService } from '../participant-moderation-immunity.service';
import { MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES } from '../moderation.service.support';
import {
  extractEnabledWebhookNavigationTargets,
  resolveEnabledNavigationTargetOptions,
} from '../navigation/enabled-navigation-targets';
import { createAllowlistLinkMatcher } from '../rule-engine-link-detector';
import {
  detectLegacyStopWordsViolations,
  detectStopWordsViolations,
  extractStopWordsTextSegments,
  fingerprintStopWordsSource,
} from './stop-words.detection';
import { readStopWordsPolicy } from './stop-words.policy';
import { normalizeLegacyStopWordIdentity } from '../rule-engine-blocked-words.detector';

export const STOP_WORDS_DELETE_RULE_CODES = new Set([
  'MESSAGE_BLOCKED_WORD_DELETE',
  'MESSAGE_BLOCKED_DOMAIN_DELETE',
]);
type GuardReason = { ruleCode: string; metadata: unknown; reasonKey?: string };
type GuardInput = {
  chatId: string;
  messageId: string;
  subjectUserId: string | null;
  botId?: string;
};
export const STOP_WORDS_GUARD_REJECTION_REASONS = [
  'policy_disabled',
  'policy_changed',
  'source_changed',
  'rule_unmatched',
  'author_protected',
  'author_absent',
  'identity_changed',
  'participant_immune',
  'sanction_disabled',
  'delete_receipt_missing',
  'runtime_disabled',
  'binding_invalid',
  'binding_stale',
  'deadline_expired',
  'permission_changed',
] as const;
export type StopWordsGuardRejectionReason = (typeof STOP_WORDS_GUARD_REJECTION_REASONS)[number];

export class StopWordsDeleteGuardRejectedError extends Error {
  readonly code = 'stop_words_delete_no_longer_authorized';

  constructor(readonly rejectionReason: StopWordsGuardRejectionReason) {
    super('Stop-list deletion is no longer authorized');
  }
}

@Injectable()
export class StopWordsDeleteGuardService {
  private readonly parser = new WebhookParser();
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLink: MaxBotLinkService,
    private readonly immunity: ParticipantModerationImmunityService,
    private readonly config: ConfigService,
    @Optional() private readonly automaticDeleteAuthorAccess?: AutomaticDeleteAuthorAccessService,
  ) {}

  async assertIntentStillActionable(params: {
    intentId: string;
    chatId: string;
    messageId: string;
    subjectUserId: string | null;
    botId?: string;
    ownedReasonsOnly?: boolean;
  }): Promise<'allowed' | 'absent' | 'not_applicable'> {
    const allReasons = await this.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: params.intentId },
      select: { ruleCode: true, metadata: true },
    });
    const reasons = params.ownedReasonsOnly
      ? allReasons.filter((reason) => STOP_WORDS_DELETE_RULE_CODES.has(reason.ruleCode))
      : allReasons;
    // FLAG: This guard owns stop-list-only intents. Independently owned durable reasons keep
    // their existing dispatch guards and must not be cancelled by disabling the stop-list.
    if (
      !reasons.length ||
      reasons.some((reason) => !STOP_WORDS_DELETE_RULE_CODES.has(reason.ruleCode))
    )
      return 'not_applicable';
    const result = await this.assertMessageStillActionable(params, reasons);
    return result === 'absent' ? result : 'allowed';
  }

  async authorizeIntent(
    params: GuardInput & { intentId: string },
  ): Promise<'not_applicable' | 'absent' | { reasonKeys: string[] }> {
    return finalizeDeleteAuthority(await this.prepareForDispatch(params));
  }

  async prepareForDispatch(
    params: Parameters<StopWordsDeleteGuardService['authorizeIntent']>[0],
  ): Promise<
    DeleteAuthorityPreparation<Awaited<ReturnType<StopWordsDeleteGuardService['authorizeIntent']>>>
  > {
    const reasons = await this.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: params.intentId },
      select: { ruleCode: true, reasonKey: true, metadata: true },
    });
    const owned = reasons.filter((r) => STOP_WORDS_DELETE_RULE_CODES.has(r.ruleCode));
    if (!owned.length) return 'not_applicable' as const;
    return this.prepareMessageForDispatch(params, owned);
  }

  async assertSanctionStillActionable(
    params: GuardInput & {
      ruleCode: string;
      metadata: unknown;
      action: 'WARN' | 'MUTE' | 'BAN';
    },
  ): Promise<void> {
    // FLAG: The compatibility release leaves pre-policy sanctions on the existing execution
    // path until activation. A present but invalid policy must never take this legacy branch.
    const current = await this.prisma.chatSettings.findUnique({
      where: { chatId: params.chatId },
      select: { stopWordsPolicy: true },
    });
    if (current?.stopWordsPolicy === null) return;
    const result = await this.assertMessageStillActionable(
      params,
      [{ ruleCode: params.ruleCode + '_DELETE', metadata: params.metadata }],
      params.action,
    );
    if (result === 'absent') this.reject('delete_receipt_missing');
  }

  private async assertMessageStillActionable(
    params: GuardInput,
    reasons: readonly GuardReason[],
    action?: 'WARN' | 'MUTE' | 'BAN',
  ): Promise<{ reasonKeys: string[] } | 'absent'> {
    return finalizeDeleteAuthority(await this.prepareMessageForDispatch(params, reasons, action));
  }

  private async prepareMessageForDispatch(
    params: GuardInput,
    reasons: readonly GuardReason[],
    action?: 'WARN' | 'MUTE' | 'BAN',
  ): Promise<DeleteAuthorityPreparation<{ reasonKeys: string[] } | 'absent'>> {
    const senderId = params.subjectUserId;
    if (!senderId) this.reject('identity_changed');
    if (this.maxBotLink.isKnownBotUserId(senderId)) this.reject('author_protected');
    const settings = await this.load(params.chatId, senderId);
    if (action) this.assertSanctionPolicy(settings, reasons[0], action);
    const options = {
      botId: params.botId,
      bypassCache: true,
      trafficClass: 'critical' as const,
      actionHealthLane: 'critical' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
      timeoutMs: this.config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5_000,
    };
    // FLAG: A sanction keeps a fresh member proof even when DELETE uses a complete saved roster.
    const author = !action
      ? await this.automaticDeleteAuthorAccess?.resolve(params.chatId, senderId, options, {
          requireMembership: true,
          module: 'stopWords',
        })
      : undefined;
    const access = author
      ? author.member
      : await this.maxClient.getChatMemberAccess(params.chatId, senderId, options);
    if (author?.isAdmin) this.reject('author_protected');
    if (!access) this.reject('author_absent');
    if (author?.isAdmin ?? Boolean(access.isAdmin || access.isOwner))
      this.reject('author_protected');
    if (access.userId !== null && access.userId !== senderId)
      throw new Error('Stop-list author access unavailable');
    const row = await this.maxClient.getExactMessageRow(params.chatId, params.messageId, options);
    if (!row) {
      if (!action) return 'absent';
      // FLAG: A missing message alone cannot authorize a member sanction. Require our own
      // successful guarded deletion of exactly the same rule, revision and source fingerprint.
      const metadata = this.metadata(reasons[0]?.metadata);
      if (
        typeof metadata.stopWordsSourceSha256 !== 'string' ||
        metadata.stopWordsPolicyVersion !== 1
      )
        this.reject('delete_receipt_missing');
      const completed = await this.prisma.moderationDeleteIntent.findFirst({
        where: {
          chatId: params.chatId,
          messageId: params.messageId,
          subjectUserId: senderId,
          status: 'SUCCEEDED',
          reasons: {
            some: {
              ruleCode: reasons[0].ruleCode,
              AND: [
                { metadata: { path: ['moderationDeleteVerified'], equals: true } },
                {
                  metadata: {
                    path: ['stopWordsSourceSha256'],
                    equals: metadata.stopWordsSourceSha256,
                  },
                },
                {
                  metadata: { path: ['stopWordsRuleId'], equals: String(metadata.stopWordsRuleId) },
                },
                {
                  metadata: {
                    path: ['stopWordsRevision'],
                    equals: Number(metadata.stopWordsRevision),
                  },
                },
              ],
            },
          },
        },
        select: { id: true },
      });
      if (!completed) this.reject('delete_receipt_missing');
      const currentSettings = await this.load(params.chatId, senderId);
      this.assertSanctionPolicy(currentSettings, reasons[0], action);
      await this.assertNoImmunity(params, senderId, currentSettings.nightModeTimezone);
      this.assertSanctionPolicy(await this.load(params.chatId, senderId), reasons[0], action);
      return { reasonKeys: reasons.flatMap((r) => (r.reasonKey ? [r.reasonKey] : [])) };
    }
    const raw = { type: 'message_created', updateId: 'stop-words-delete-guard', message: row };
    const message = this.parser.parse(raw).message;
    if (
      !message ||
      message.chatId !== params.chatId ||
      message.messageId !== params.messageId ||
      message.senderId !== senderId ||
      message.entityType === 'channel'
    )
      this.reject('identity_changed');
    const targets = extractEnabledWebhookNavigationTargets(
      raw,
      resolveEnabledNavigationTargetOptions(this.config),
    );
    const textSegments = extractStopWordsTextSegments(raw, message.text);
    const sourceFingerprint = fingerprintStopWordsSource({
      text: message.text,
      textSegments,
      navigationTargets: targets,
    });
    const matchingReasons = (current: typeof settings) => {
      const detection = {
        text: message.text,
        textSegments,
        navigationTargets: targets,
        settings: current,
        isLinkAllowlisted: createAllowlistLinkMatcher(
          current.chat.domains.map((entry) => entry.domain),
        ),
      };
      // FLAG: Null is the legacy reader state, never an implicit EXACT-policy migration.
      const hits =
        current.stopWordsPolicy == null
          ? detectLegacyStopWordsViolations(detection)
          : detectStopWordsViolations(detection);
      return reasons.filter((reason) => {
        const metadata = this.metadata(reason.metadata);
        return hits.some(
          (hit) =>
            `${hit.ruleCode}_DELETE` === reason.ruleCode &&
            (typeof metadata.blockedWord !== 'string' ||
              (current.stopWordsPolicy == null
                ? normalizeLegacyStopWordIdentity(metadata.blockedWord) ===
                  normalizeLegacyStopWordIdentity(String(hit.metadata?.blockedWord ?? ''))
                : metadata.blockedWord === hit.metadata?.blockedWord)) &&
            (typeof metadata.blockedDomain !== 'string' ||
              metadata.blockedDomain === hit.metadata?.blockedDomain) &&
            (metadata.stopWordsSourceSha256 === undefined ||
              metadata.stopWordsSourceSha256 === sourceFingerprint) &&
            (metadata.stopWordsRuleId === undefined ||
              metadata.stopWordsRuleId === hit.metadata?.stopWordsRuleId) &&
            (metadata.stopWordsRevision === undefined ||
              metadata.stopWordsRevision === current.stopWordsRevision),
        );
      });
    };
    const assertReasonsMatch = (current: typeof settings) => {
      const matching = matchingReasons(current);
      if (matching.length) return matching;
      const metadata = reasons.map((reason) => this.metadata(reason.metadata));
      if (
        metadata.every(
          (entry) =>
            entry.stopWordsSourceSha256 !== undefined &&
            entry.stopWordsSourceSha256 !== sourceFingerprint,
        )
      )
        this.reject('source_changed');
      if (
        metadata.every(
          (entry) =>
            entry.stopWordsRevision !== undefined &&
            entry.stopWordsRevision !== current.stopWordsRevision,
        )
      )
        this.reject('policy_changed');
      this.reject('rule_unmatched');
    };
    // FLAG: Refresh policy after remote reads before spending participant protection.
    // A rule revoked while MAX was awaited cannot consume immunity or mislabel its refusal.
    const currentSettings = await this.load(params.chatId, senderId);
    assertReasonsMatch(currentSettings);
    await this.assertNoImmunity(params, senderId, currentSettings.nightModeTimezone);
    return prepareDeleteAuthority(async () => {
      const finalSettings = await this.load(params.chatId, senderId);
      const finalReasons = assertReasonsMatch(finalSettings);
      if (action) this.assertSanctionPolicy(finalSettings, reasons[0], action);
      return {
        reasonKeys: finalReasons.flatMap((r) => (r.reasonKey ? [r.reasonKey] : [])),
      };
    });
  }

  private async load(chatId: string, senderId: string) {
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      select: {
        chatId: true,
        stopWordsPolicy: true,
        stopWordsRevision: true,
        nightModeTimezone: true,
        messageLimitsBlockedWords: true,
        messageLimitsBlockedDomains: true,
        chat: {
          select: {
            entityType: true,
            admins: { select: { userId: true } },
            domains: {
              where: { OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: new Date() } }] },
              select: { domain: true },
            },
          },
        },
      },
    });
    if (!settings || settings.chat.entityType !== 'CHAT') this.reject('identity_changed');
    if (settings.chat.admins.some((admin) => admin.userId === senderId))
      this.reject('author_protected');
    const policy = readStopWordsPolicy(settings);
    if (policy && !policy.enabled) this.reject('policy_disabled');
    return settings;
  }

  private reject(reason: StopWordsGuardRejectionReason): never {
    throw new StopWordsDeleteGuardRejectedError(reason);
  }

  private async assertNoImmunity(
    params: GuardInput,
    senderId: string,
    nightModeTimezone: string,
  ): Promise<void> {
    const result = await this.immunity.consumeForMessage({
      chatId: params.chatId,
      userId: senderId,
      messageId: params.messageId,
      scope: 'stop-words-delete:v1',
      nightModeTimezone,
    });
    if (result === 'granted') this.reject('participant_immune');
  }

  private metadata(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private assertSanctionPolicy(
    settings: Awaited<ReturnType<StopWordsDeleteGuardService['load']>>,
    reason: GuardReason,
    action: 'WARN' | 'MUTE' | 'BAN',
  ): void {
    const policy = readStopWordsPolicy(settings);
    const metadata = this.metadata(reason.metadata);
    if (!policy || !policy.enabled) this.reject('policy_disabled');
    if (metadata.stopWordsRevision !== settings.stopWordsRevision) this.reject('policy_changed');
    const key =
      action === 'WARN' ? 'warnEnabled' : action === 'MUTE' ? 'muteEnabled' : 'banEnabled';
    if (!policy.sanctions[key]) this.reject('sanction_disabled');
  }
}
