import {
  prepareDeleteAuthority,
  finalizeDeleteAuthority,
  type DeleteAuthorityPreparation,
} from '../moderation-delete-authority-preparation';
import { Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { MaxBotLinkService } from '../../max/max-bot-link.service';
import { AutomaticDeleteAuthorAccessService } from '../../max/automatic-delete-author-access.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../../max/max-client.service';
import type { ChatSettings } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { ParticipantModerationImmunityService } from '../participant-moderation-immunity.service';
import { MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES } from '../moderation.service.support';
import { MAX_PHOTO_ALBUM_IMAGES } from '../photo-duplicate/photo-attachment-extractor';
import { COMMERCIAL_OCR_DECISION_POLICY_VERSION } from './commercial-ocr-decision-policy';
import {
  COMMERCIAL_OCR_DEFAULT_VERSION,
  validateCommercialOcrVersion,
} from './commercial-ocr.queue';
import {
  CommercialOcrRuntimePolicyService,
  parseCommercialOcrEnforcementAuthority,
  sameCommercialOcrEnforcementAuthority,
  type CommercialOcrEnforcementAuthority,
} from './commercial-ocr-runtime-policy.service';
import { fingerprintCommercialOcrSettingsProfile } from './commercial-ocr-settings-profile';
import { extractCommercialOcrExactMessageSource } from './commercial-ocr-exact-source';
export {
  extractCommercialOcrDeleteSource,
  extractCommercialOcrExactMessageSource,
  type CommercialOcrDeleteSource,
  type CommercialOcrExactMessageSource,
} from './commercial-ocr-exact-source';

export const COMMERCIAL_OCR_DELETE_RULE_CODE = 'COMMERCIAL_OCR_DELETE';
export const COMMERCIAL_OCR_MESSAGE_ACTION_RULE_CODE = 'COMMERCIAL_OCR_MESSAGE_ACTION';
export const COMMERCIAL_OCR_PARTICIPANT_IMMUNITY_SCOPE = 'commercial_ocr_delete';
export const COMMERCIAL_OCR_DELETE_BINDING_VERSION = 5 as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type CommercialOcrDeleteBinding = {
  version: typeof COMMERCIAL_OCR_DELETE_BINDING_VERSION;
  policyVersion: typeof COMMERCIAL_OCR_DECISION_POLICY_VERSION;
  ocrVersion: string;
  commercialPolicyDigest: string;
  senderId: string;
  orderedPhotoIdDigest: string;
  captionDigest: string;
  sourceCreatedAt: string;
  expectedImageCount: number;
  authority: CommercialOcrEnforcementAuthority;
  ocrDeadlineAt: string;
};

export type CommercialOcrPolicySettings = Pick<
  ChatSettings,
  | 'commercialAdsFilterEnabled'
  | 'commercialAdsSensitivity'
  | 'commercialAdsWarnThreshold'
  | 'commercialAdsDeleteThreshold'
>;

export type CommercialOcrDeleteGuardResult = 'absent' | 'allowed' | 'not_applicable';

export class CommercialOcrDeleteGuardRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CommercialOcrDeleteGuardRejectedError';
  }
}

export function buildCommercialOcrDeleteBinding(params: {
  ocrVersion: string;
  settings: CommercialOcrPolicySettings;
  senderId: string;
  orderedPhotoIds: readonly string[];
  caption: string;
  sourceCreatedAt: Date | string;
  expectedImageCount: number;
  authority: CommercialOcrEnforcementAuthority;
  ocrDeadlineAt: Date | string;
}): CommercialOcrDeleteBinding {
  const ocrVersion = validateCommercialOcrVersion(params.ocrVersion);
  const senderId = validateIdentifier(params.senderId, 'senderId');
  const orderedPhotoIds = validateOrderedPhotoIds(params.orderedPhotoIds);
  const expectedImageCount = validateExpectedImageCount(params.expectedImageCount);
  if (orderedPhotoIds.length !== expectedImageCount) {
    throw new Error('expectedImageCount does not match orderedPhotoIds');
  }
  if (typeof params.caption !== 'string') {
    throw new Error('caption is invalid');
  }
  const authority = parseCommercialOcrEnforcementAuthority(params.authority);
  if (!authority) throw new Error('commercial OCR authority is invalid');
  const sourceCreatedAt = canonicalIso(params.sourceCreatedAt, 'sourceCreatedAt');
  const ocrDeadlineAt = canonicalIso(params.ocrDeadlineAt, 'ocrDeadlineAt');
  if (
    Date.parse(ocrDeadlineAt) <= Date.parse(sourceCreatedAt) ||
    (authority.kind === 'CERTIFIED' &&
      (Date.parse(authority.controlExpiresAt) <= Date.parse(sourceCreatedAt) ||
        Date.parse(ocrDeadlineAt) > Date.parse(authority.controlExpiresAt)))
  ) {
    throw new Error('commercial OCR delete authorization has expired');
  }
  if (
    authority.kind === 'BASELINE' &&
    authority.settingsFingerprint !== fingerprintCommercialOcrSettingsProfile(params.settings)
  ) {
    throw new Error('commercial OCR baseline settings identity is invalid');
  }

  return {
    version: COMMERCIAL_OCR_DELETE_BINDING_VERSION,
    policyVersion: COMMERCIAL_OCR_DECISION_POLICY_VERSION,
    ocrVersion,
    commercialPolicyDigest: digestCommercialOcrPolicy(params.settings),
    senderId,
    orderedPhotoIdDigest: digestJson(orderedPhotoIds),
    captionDigest: digestText(params.caption),
    sourceCreatedAt,
    expectedImageCount,
    authority,
    ocrDeadlineAt,
  };
}

export function parseCommercialOcrDeleteBinding(value: unknown): CommercialOcrDeleteBinding | null {
  const outer = asRecord(value);
  const hasWrappedBinding = outer
    ? Object.prototype.hasOwnProperty.call(outer, 'commercialOcrBinding')
    : false;
  const wrappedBinding = hasWrappedBinding ? asRecord(outer?.commercialOcrBinding) : null;
  if (hasWrappedBinding && !wrappedBinding) {
    return null;
  }
  const row = wrappedBinding ?? outer;
  if (!row) {
    return null;
  }
  const allowedKeys = new Set([
    'version',
    'policyVersion',
    'ocrVersion',
    'commercialPolicyDigest',
    'senderId',
    'orderedPhotoIdDigest',
    'captionDigest',
    'sourceCreatedAt',
    'expectedImageCount',
    'authority',
    'ocrDeadlineAt',
  ]);
  if (Object.keys(row).some((key) => !allowedKeys.has(key))) return null;

  // FLAG: v4 and older pending bindings drain without deletion. Only v5 knows BASELINE versus
  // CERTIFIED authority, so rollback must retain the v5 guard or disable OCR before rollback.
  if (
    row.version !== COMMERCIAL_OCR_DELETE_BINDING_VERSION ||
    row.policyVersion !== COMMERCIAL_OCR_DECISION_POLICY_VERSION ||
    typeof row.ocrVersion !== 'string' ||
    typeof row.commercialPolicyDigest !== 'string' ||
    typeof row.senderId !== 'string' ||
    typeof row.orderedPhotoIdDigest !== 'string' ||
    typeof row.captionDigest !== 'string' ||
    typeof row.sourceCreatedAt !== 'string' ||
    typeof row.expectedImageCount !== 'number' ||
    typeof row.ocrDeadlineAt !== 'string'
  ) {
    return null;
  }

  try {
    const ocrVersion = validateCommercialOcrVersion(row.ocrVersion);
    const senderId = validateIdentifier(row.senderId, 'senderId');
    const expectedImageCount = validateExpectedImageCount(row.expectedImageCount);
    const sourceCreatedAt = canonicalIso(row.sourceCreatedAt, 'sourceCreatedAt');
    const authority = parseCommercialOcrEnforcementAuthority(row.authority);
    if (!authority) return null;
    const ocrDeadlineAt = canonicalIso(row.ocrDeadlineAt, 'ocrDeadlineAt');
    if (
      sourceCreatedAt !== row.sourceCreatedAt ||
      ocrDeadlineAt !== row.ocrDeadlineAt ||
      Date.parse(ocrDeadlineAt) <= Date.parse(sourceCreatedAt) ||
      (authority.kind === 'CERTIFIED' &&
        (Date.parse(authority.controlExpiresAt) <= Date.parse(sourceCreatedAt) ||
          Date.parse(ocrDeadlineAt) > Date.parse(authority.controlExpiresAt))) ||
      !SHA256_PATTERN.test(row.commercialPolicyDigest) ||
      !SHA256_PATTERN.test(row.orderedPhotoIdDigest) ||
      !SHA256_PATTERN.test(row.captionDigest)
    ) {
      return null;
    }
    return {
      version: COMMERCIAL_OCR_DELETE_BINDING_VERSION,
      policyVersion: COMMERCIAL_OCR_DECISION_POLICY_VERSION,
      ocrVersion,
      commercialPolicyDigest: row.commercialPolicyDigest,
      senderId,
      orderedPhotoIdDigest: row.orderedPhotoIdDigest,
      captionDigest: row.captionDigest,
      sourceCreatedAt,
      expectedImageCount,
      authority,
      ocrDeadlineAt,
    };
  } catch {
    return null;
  }
}

@Injectable()
export class CommercialOcrDeleteGuardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly participantImmunity: ParticipantModerationImmunityService,
    private readonly runtimePolicy: CommercialOcrRuntimePolicyService,
    @Optional() private readonly automaticDeleteAuthorAccess?: AutomaticDeleteAuthorAccessService,
  ) {}

  async assertIntentStillActionable(params: {
    intentId: string;
    chatId: string;
    messageId: string;
    subjectUserId: string | null;
    sourceMessageAt: Date | null;
    botId: string;
  }): Promise<CommercialOcrDeleteGuardResult> {
    return finalizeDeleteAuthority(await this.prepareForDispatch(params));
  }

  async prepareForDispatch(
    params: Parameters<CommercialOcrDeleteGuardService['assertIntentStillActionable']>[0],
  ): Promise<DeleteAuthorityPreparation<CommercialOcrDeleteGuardResult>> {
    const reasons = await this.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: params.intentId },
      select: { ruleCode: true, metadata: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const ocrReasons = reasons.filter(
      (reason) => reason.ruleCode === COMMERCIAL_OCR_DELETE_RULE_CODE,
    );
    if (ocrReasons.length === 0) {
      throw rejected('commercial_ocr_reason_missing', 'OCR delete intent has no reason metadata');
    }

    const bindings = ocrReasons.map((reason) => parseCommercialOcrDeleteBinding(reason.metadata));
    if (bindings.some((binding) => binding === null)) {
      throw rejected(
        'commercial_ocr_binding_invalid',
        'OCR delete intent has no valid content binding',
      );
    }
    const binding = bindings[0]!;
    if (bindings.some((candidate) => !sameBinding(candidate!, binding))) {
      throw rejected(
        'commercial_ocr_binding_ambiguous',
        'OCR delete intent contains conflicting content bindings',
      );
    }

    if (Date.parse(binding.ocrDeadlineAt) <= Date.now()) {
      throw rejected(
        'commercial_ocr_deadline_expired',
        'Commercial OCR deletion deadline has expired',
      );
    }
    if (
      binding.authority.kind === 'CERTIFIED' &&
      Date.parse(binding.authority.controlExpiresAt) <= Date.now()
    ) {
      throw rejected(
        'commercial_ocr_runtime_control_expired',
        'The runtime control that authorized this OCR decision has expired',
      );
    }

    // FLAG: Baseline and certification both bind settings. Re-read the current profile inside
    // the dispatch guard; settings captured by analysis never authorize retries on their own.
    const authorization = await this.loadCurrentAuthorization(params.chatId, binding);
    const settings = authorization.settings;
    await this.assertRuntimeAuthorization(
      params.chatId,
      authorization.settingsFingerprint,
      binding,
    );
    if (
      binding.policyVersion !== COMMERCIAL_OCR_DECISION_POLICY_VERSION ||
      binding.ocrVersion !== COMMERCIAL_OCR_DEFAULT_VERSION
    ) {
      throw rejected(
        'commercial_ocr_version_changed',
        'Commercial OCR behavior changed after the deletion candidate was recorded',
      );
    }

    if (
      !params.subjectUserId ||
      params.subjectUserId !== binding.senderId ||
      this.maxBotLinkService.isKnownBotUserId(binding.senderId)
    ) {
      throw rejected(
        'commercial_ocr_author_immune',
        'OCR delete intent no longer identifies an eligible human author',
      );
    }
    if (
      !params.sourceMessageAt ||
      params.sourceMessageAt.toISOString() !== binding.sourceCreatedAt
    ) {
      throw rejected(
        'commercial_ocr_source_timestamp_changed',
        'OCR delete intent source timestamp no longer matches its content binding',
      );
    }

    if (settings.chat.admins.some((admin) => admin.userId === binding.senderId)) {
      throw rejected(
        'commercial_ocr_admin_immune',
        'Current local chat administrators are immune from OCR deletion',
      );
    }

    const authorOptions = {
      trafficClass: 'critical' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
      botId: params.botId,
      bypassCache: true,
    };
    const author = await this.automaticDeleteAuthorAccess?.resolve(
      params.chatId,
      binding.senderId,
      authorOptions,
      { requireMembership: true, module: 'commercialOcr' },
    );
    if (author?.isAdmin) {
      throw rejected(
        'commercial_ocr_admin_immune',
        'Saved chat administrators are immune from OCR deletion',
      );
    }
    const remoteAccess = author
      ? author.member
      : await this.maxClient.getChatMemberAccess(params.chatId, binding.senderId, authorOptions);
    if (
      !remoteAccess ||
      (remoteAccess.userId !== null && remoteAccess.userId !== binding.senderId)
    ) {
      throw rejected(
        'commercial_ocr_author_access_unknown',
        'MAX did not confirm the current identity of the OCR message author',
      );
    }
    if (author?.isAdmin ?? Boolean(remoteAccess.isAdmin || remoteAccess.isOwner)) {
      throw rejected(
        'commercial_ocr_admin_immune',
        'MAX reports current administrator or owner access for the OCR message author',
      );
    }

    const exactRow = await this.maxClient.getExactMessageRow(params.chatId, params.messageId, {
      trafficClass: 'critical',
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
      botId: params.botId,
      bypassCache: true,
    });
    if (!exactRow) {
      return 'absent';
    }
    const exactSource = extractCommercialOcrExactMessageSource(exactRow);
    if (
      !exactSource ||
      exactSource.source.messageId !== params.messageId ||
      exactSource.source.chatId !== params.chatId
    ) {
      throw rejected(
        'commercial_ocr_message_ambiguous',
        'MAX did not return a complete stable identity for the exact OCR message',
      );
    }
    if (exactSource.authorKind === 'bot_or_service') {
      throw rejected(
        'commercial_ocr_author_immune',
        'The exact OCR message is authored by a bot or service account',
      );
    }
    if (exactSource.authorKind !== 'user') {
      throw rejected(
        'commercial_ocr_message_ambiguous',
        'MAX did not confirm that the exact OCR message has a human author',
      );
    }
    const source = exactSource.source;

    const currentBinding = buildCommercialOcrDeleteBinding({
      ocrVersion: COMMERCIAL_OCR_DEFAULT_VERSION,
      settings,
      senderId: source.senderId,
      orderedPhotoIds: source.orderedPhotoIds,
      caption: source.caption,
      sourceCreatedAt: source.sourceCreatedAt,
      expectedImageCount: source.orderedPhotoIds.length,
      authority: binding.authority,
      ocrDeadlineAt: binding.ocrDeadlineAt,
    });
    if (!sameBinding(currentBinding, binding)) {
      throw rejected(
        'commercial_ocr_message_changed',
        'The exact OCR message content or identity changed before deletion',
      );
    }
    let immunity: Awaited<ReturnType<ParticipantModerationImmunityService['consumeForMessage']>>;
    try {
      immunity = await this.participantImmunity.consumeForMessage({
        chatId: params.chatId,
        userId: binding.senderId,
        messageId: params.messageId,
        scope: COMMERCIAL_OCR_PARTICIPANT_IMMUNITY_SCOPE,
        nightModeTimezone: settings.nightModeTimezone,
      });
    } catch {
      throw rejected(
        'commercial_ocr_participant_immunity_unknown',
        'Participant moderation immunity could not be checked before OCR deletion',
      );
    }
    if (immunity === 'granted') {
      throw rejected(
        'commercial_ocr_participant_immune',
        'Current participant moderation immunity prevents OCR deletion',
      );
    }

    return prepareDeleteAuthority(async () => {
      // MAX lookups and immunity checks are asynchronous. Re-read both mutable authorization sources
      // after them so a mid-guard settings or rollout change cannot authorize the remote mutation.
      const finalAuthorization = await this.loadCurrentAuthorization(params.chatId, binding);
      if (finalAuthorization.settings.nightModeTimezone !== settings.nightModeTimezone) {
        throw rejected(
          'commercial_ocr_participant_immunity_unknown',
          'Participant moderation immunity was checked with a stale chat timezone',
        );
      }
      this.assertLocalAdminEligible(finalAuthorization.settings, binding.senderId);
      await this.assertRuntimeAuthorization(
        params.chatId,
        finalAuthorization.settingsFingerprint,
        binding,
      );
      return 'allowed' as const;
    });
  }

  private async loadCurrentAuthorization(chatId: string, binding: CommercialOcrDeleteBinding) {
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      select: {
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: true,
        commercialAdsWarnThreshold: true,
        commercialAdsDeleteThreshold: true,
        nightModeTimezone: true,
        chat: { select: { admins: { select: { userId: true } } } },
      },
    });
    if (!settings?.commercialAdsFilterEnabled) {
      throw rejected(
        'commercial_ocr_filter_disabled',
        'Commercial advertisement filtering is no longer enabled for this chat',
      );
    }
    if (digestCommercialOcrPolicy(settings) !== binding.commercialPolicyDigest) {
      throw rejected(
        'commercial_ocr_policy_changed',
        'Commercial advertisement policy changed after the deletion candidate was recorded',
      );
    }

    let settingsFingerprint: string;
    try {
      settingsFingerprint = fingerprintCommercialOcrSettingsProfile(settings);
    } catch {
      throw rejected(
        'commercial_ocr_policy_changed',
        'Commercial advertisement policy is no longer a valid certified profile',
      );
    }
    return { settings, settingsFingerprint };
  }

  private assertLocalAdminEligible(
    settings: { chat: { admins: Array<{ userId: string }> } },
    senderId: string,
  ): void {
    if (settings.chat.admins.some((admin) => admin.userId === senderId)) {
      throw rejected(
        'commercial_ocr_admin_immune',
        'Current local chat administrators are immune from OCR deletion',
      );
    }
  }

  private async assertRuntimeAuthorization(
    chatId: string,
    settingsFingerprint: string,
    binding: CommercialOcrDeleteBinding,
  ): Promise<void> {
    if (Date.parse(binding.ocrDeadlineAt) <= Date.now()) {
      throw rejected(
        'commercial_ocr_deadline_expired',
        'Commercial OCR deletion deadline has expired',
      );
    }
    const runtime = await this.runtimePolicy.resolveEffectivePolicy({
      chatId,
      settingsFingerprint,
    });
    if (Date.parse(binding.ocrDeadlineAt) <= Date.now()) {
      throw rejected(
        'commercial_ocr_deadline_expired',
        'Commercial OCR deletion deadline has expired',
      );
    }
    if (!runtime.enforce) {
      if (runtime.enforcementAuthority === 'unavailable') {
        throw rejected(
          'commercial_ocr_runtime_control_unavailable',
          'Commercial OCR runtime control could not be read before deletion',
        );
      }
      throw rejected(
        'commercial_ocr_runtime_revoked',
        'Commercial OCR enforcement authorization is no longer active',
      );
    }
    if (!sameCommercialOcrEnforcementAuthority(runtime.authority, binding.authority)) {
      throw rejected(
        'commercial_ocr_runtime_control_changed',
        'Commercial OCR runtime authorization changed after the deletion candidate was recorded',
      );
    }
  }
}

function sameBinding(left: CommercialOcrDeleteBinding, right: CommercialOcrDeleteBinding): boolean {
  return (
    left.version === right.version &&
    left.policyVersion === right.policyVersion &&
    left.ocrVersion === right.ocrVersion &&
    left.commercialPolicyDigest === right.commercialPolicyDigest &&
    left.senderId === right.senderId &&
    left.orderedPhotoIdDigest === right.orderedPhotoIdDigest &&
    left.captionDigest === right.captionDigest &&
    left.sourceCreatedAt === right.sourceCreatedAt &&
    left.expectedImageCount === right.expectedImageCount &&
    sameCommercialOcrEnforcementAuthority(left.authority, right.authority) &&
    left.ocrDeadlineAt === right.ocrDeadlineAt
  );
}

function digestCommercialOcrPolicy(settings: CommercialOcrPolicySettings): string {
  if (typeof settings?.commercialAdsFilterEnabled !== 'boolean') {
    throw new Error('commercialAdsFilterEnabled is invalid');
  }
  if (
    settings.commercialAdsSensitivity !== 'BALANCED' &&
    settings.commercialAdsSensitivity !== 'STRICT'
  ) {
    throw new Error('commercialAdsSensitivity is invalid');
  }
  if (!Number.isSafeInteger(settings.commercialAdsWarnThreshold)) {
    throw new Error('commercialAdsWarnThreshold is invalid');
  }
  if (!Number.isSafeInteger(settings.commercialAdsDeleteThreshold)) {
    throw new Error('commercialAdsDeleteThreshold is invalid');
  }

  return digestJson({
    commercialAdsFilterEnabled: settings.commercialAdsFilterEnabled,
    commercialAdsSensitivity: settings.commercialAdsSensitivity,
    commercialAdsWarnThreshold: settings.commercialAdsWarnThreshold,
    commercialAdsDeleteThreshold: settings.commercialAdsDeleteThreshold,
  });
}

function validateOrderedPhotoIds(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_PHOTO_ALBUM_IMAGES) {
    throw new Error('orderedPhotoIds is invalid');
  }
  return values.map((value) => validateIdentifier(value, 'photoId'));
}

function validateExpectedImageCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PHOTO_ALBUM_IMAGES) {
    throw new Error('expectedImageCount is invalid');
  }
  return value;
}

function validateIdentifier(value: string, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} is invalid`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function canonicalIso(value: Date | string, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${field} is invalid`);
  }
  return date.toISOString();
}

function digestJson(value: unknown): string {
  return digestText(JSON.stringify(value));
}

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rejected(code: string, message: string): CommercialOcrDeleteGuardRejectedError {
  return new CommercialOcrDeleteGuardRejectedError(code, message);
}
