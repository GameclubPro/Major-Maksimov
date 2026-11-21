import { createHash } from 'node:crypto';

import type { ChatSettings } from '../../prisma/prisma-client';
import {
  IMAGE_TEXT_STOP_LIST_LEGACY_POLICY_VERSION,
  IMAGE_TEXT_STOP_LIST_POLICY_VERSION,
} from './image-text-stop-list-decision';
import { validateCommercialOcrVersion } from './commercial-ocr.queue';

export const IMAGE_TEXT_STOP_LIST_BINDING_VERSION = 1 as const;
export const IMAGE_TEXT_STOP_LIST_SANDBOX_BOUNDARY = 'unix_socket_sandbox' as const;
export const IMAGE_TEXT_STOP_LIST_MESSAGE_ACTION_RULE_CODE =
  'IMAGE_TEXT_STOP_LIST_MESSAGE_ACTION' as const;
export const IMAGE_TEXT_STOP_LIST_ACTION_DEDUPE_PREFIX = 'image-text-stop-list-action:v1:';
export const IMAGE_TEXT_STOP_LIST_PARTICIPANT_IMMUNITY_SCOPE = 'image_text_stop_list_delete';

export type ImageTextStopListBinding = Readonly<{
  version: typeof IMAGE_TEXT_STOP_LIST_BINDING_VERSION;
  policyVersion:
    | typeof IMAGE_TEXT_STOP_LIST_LEGACY_POLICY_VERSION
    | typeof IMAGE_TEXT_STOP_LIST_POLICY_VERSION;
  ocrVersion: string;
  sandboxBoundary: typeof IMAGE_TEXT_STOP_LIST_SANDBOX_BOUNDARY;
  nativeBehaviorFingerprintSha256: string;
  policyFingerprint: string;
  ruleCode: 'MESSAGE_BLOCKED_WORD' | 'MESSAGE_BLOCKED_DOMAIN';
  value: string;
  ruleId?: string;
  imageIndex: number;
  primaryConfidencePermille: number;
  confirmationConfidencePermille: number;
  senderId: string;
  sourceCreatedAt: string;
  deleteDeadlineAt: string;
  expectedImageCount: number;
  orderedPhotoIdsSha256: string;
  captionSha256: string;
}>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function buildImageTextStopListBinding(params: {
  policyVersion?: ImageTextStopListBinding['policyVersion'];
  ocrVersion: string;
  nativeBehaviorFingerprintSha256: string;
  policyFingerprint: string;
  ruleCode: ImageTextStopListBinding['ruleCode'];
  value: string;
  ruleId?: string;
  imageIndex: number;
  primaryConfidencePermille: number;
  confirmationConfidencePermille: number;
  senderId: string;
  sourceCreatedAt: string;
  deleteDeadlineAt: string;
  orderedPhotoIds: readonly string[];
  caption: string;
}): ImageTextStopListBinding {
  const sourceCreatedAt = canonicalTimestamp(params.sourceCreatedAt);
  const deleteDeadlineAt = canonicalTimestamp(params.deleteDeadlineAt);
  if (Date.parse(deleteDeadlineAt) <= Date.parse(sourceCreatedAt)) {
    throw new Error('Image text stop-list delete deadline is invalid');
  }
  const senderId = boundedText(params.senderId, 512, 'senderId');
  const value = boundedText(params.value, 253, 'value');
  const ruleId =
    params.ruleId === undefined ? undefined : boundedText(params.ruleId, 260, 'ruleId');
  const ocrVersion = validateCommercialOcrVersion(params.ocrVersion);
  if (!SHA256_PATTERN.test(params.policyFingerprint)) {
    throw new Error('Image text stop-list policy fingerprint is invalid');
  }
  if (!SHA256_PATTERN.test(params.nativeBehaviorFingerprintSha256)) {
    throw new Error('Image text stop-list native behavior fingerprint is invalid');
  }
  if (params.ruleCode !== 'MESSAGE_BLOCKED_WORD' && params.ruleCode !== 'MESSAGE_BLOCKED_DOMAIN') {
    throw new Error('Image text stop-list rule code is invalid');
  }
  const expectedImageCount = params.orderedPhotoIds.length;
  if (
    expectedImageCount < 1 ||
    expectedImageCount > 10 ||
    !Number.isSafeInteger(params.imageIndex) ||
    params.imageIndex < 0 ||
    params.imageIndex >= expectedImageCount
  ) {
    throw new Error('Image text stop-list image identity is invalid');
  }
  const orderedPhotoIds = params.orderedPhotoIds.map((photoId) =>
    boundedText(photoId, 512, 'photoId'),
  );
  requireConfidence(params.primaryConfidencePermille);
  requireConfidence(params.confirmationConfidencePermille);

  return Object.freeze({
    version: IMAGE_TEXT_STOP_LIST_BINDING_VERSION,
    policyVersion: params.policyVersion ?? IMAGE_TEXT_STOP_LIST_LEGACY_POLICY_VERSION,
    ocrVersion,
    sandboxBoundary: IMAGE_TEXT_STOP_LIST_SANDBOX_BOUNDARY,
    nativeBehaviorFingerprintSha256: params.nativeBehaviorFingerprintSha256,
    policyFingerprint: params.policyFingerprint,
    ruleCode: params.ruleCode,
    value,
    ...(ruleId ? { ruleId } : {}),
    imageIndex: params.imageIndex,
    primaryConfidencePermille: params.primaryConfidencePermille,
    confirmationConfidencePermille: params.confirmationConfidencePermille,
    senderId,
    sourceCreatedAt,
    deleteDeadlineAt,
    expectedImageCount,
    orderedPhotoIdsSha256: digestJson(orderedPhotoIds),
    captionSha256: digestText(params.caption),
  });
}

export function parseImageTextStopListBinding(metadata: unknown): ImageTextStopListBinding | null {
  const root = asRecord(metadata);
  const value = asRecord(root?.imageTextStopListBinding);
  if (
    !value ||
    value.version !== IMAGE_TEXT_STOP_LIST_BINDING_VERSION ||
    (value.policyVersion !== IMAGE_TEXT_STOP_LIST_POLICY_VERSION &&
      value.policyVersion !== IMAGE_TEXT_STOP_LIST_LEGACY_POLICY_VERSION) ||
    value.sandboxBoundary !== IMAGE_TEXT_STOP_LIST_SANDBOX_BOUNDARY ||
    !SHA256_PATTERN.test(readString(value.nativeBehaviorFingerprintSha256)) ||
    !SHA256_PATTERN.test(readString(value.policyFingerprint)) ||
    (value.ruleCode !== 'MESSAGE_BLOCKED_WORD' && value.ruleCode !== 'MESSAGE_BLOCKED_DOMAIN') ||
    !isBoundedString(value.value, 253) ||
    (value.ruleId !== undefined && !isBoundedString(value.ruleId, 260)) ||
    !isBoundedString(value.senderId, 512) ||
    !isCanonicalTimestamp(value.sourceCreatedAt) ||
    !isCanonicalTimestamp(value.deleteDeadlineAt) ||
    Date.parse(value.deleteDeadlineAt as string) <= Date.parse(value.sourceCreatedAt as string) ||
    !Number.isSafeInteger(value.expectedImageCount) ||
    (value.expectedImageCount as number) < 1 ||
    (value.expectedImageCount as number) > 10 ||
    !Number.isSafeInteger(value.imageIndex) ||
    (value.imageIndex as number) < 0 ||
    (value.imageIndex as number) >= (value.expectedImageCount as number) ||
    !isConfidence(value.primaryConfidencePermille) ||
    !isConfidence(value.confirmationConfidencePermille) ||
    !SHA256_PATTERN.test(readString(value.orderedPhotoIdsSha256)) ||
    !SHA256_PATTERN.test(readString(value.captionSha256))
  ) {
    return null;
  }
  let ocrVersion: string;
  try {
    ocrVersion = validateCommercialOcrVersion(readString(value.ocrVersion));
  } catch {
    return null;
  }
  return Object.freeze({
    version: IMAGE_TEXT_STOP_LIST_BINDING_VERSION,
    policyVersion: value.policyVersion,
    ocrVersion,
    sandboxBoundary: IMAGE_TEXT_STOP_LIST_SANDBOX_BOUNDARY,
    nativeBehaviorFingerprintSha256: readString(value.nativeBehaviorFingerprintSha256),
    policyFingerprint: readString(value.policyFingerprint),
    ruleCode: value.ruleCode,
    value: value.value,
    ...(typeof value.ruleId === 'string' ? { ruleId: value.ruleId } : {}),
    imageIndex: value.imageIndex as number,
    primaryConfidencePermille: value.primaryConfidencePermille as number,
    confirmationConfidencePermille: value.confirmationConfidencePermille as number,
    senderId: value.senderId,
    sourceCreatedAt: value.sourceCreatedAt,
    deleteDeadlineAt: value.deleteDeadlineAt,
    expectedImageCount: value.expectedImageCount as number,
    orderedPhotoIdsSha256: readString(value.orderedPhotoIdsSha256),
    captionSha256: readString(value.captionSha256),
  });
}

export function fingerprintImageTextStopListPolicy(params: {
  settings: Pick<
    ChatSettings,
    | 'messageLimitsImageTextScanEnabled'
    | 'messageLimitsBlockedWords'
    | 'messageLimitsBlockedDomains'
    | 'nightModeTimezone'
  > & { stopWordsPolicy?: unknown; stopWordsRevision?: number };
  domainAllowlist: readonly string[];
}): string {
  return digestJson({
    // The fingerprint identifies settings, independently of how the OCR readings were scored.
    version: IMAGE_TEXT_STOP_LIST_LEGACY_POLICY_VERSION,
    enabled: params.settings.messageLimitsImageTextScanEnabled,
    blockedWords: params.settings.messageLimitsBlockedWords,
    blockedDomains: params.settings.messageLimitsBlockedDomains,
    nightModeTimezone: params.settings.nightModeTimezone,
    domainAllowlist: [...new Set(params.domainAllowlist)].sort((left, right) =>
      left.localeCompare(right),
    ),
    ...(params.settings.stopWordsPolicy != null
      ? {
          stopWordsPolicy: params.settings.stopWordsPolicy,
          stopWordsRevision: params.settings.stopWordsRevision ?? 0,
        }
      : {}),
  });
}

export function imageTextStopListSourceMatchesBinding(
  binding: ImageTextStopListBinding,
  source: {
    senderId: string;
    sourceCreatedAt: string;
    caption: string;
    orderedPhotoIds: readonly string[];
  },
): boolean {
  return (
    source.senderId === binding.senderId &&
    source.sourceCreatedAt === binding.sourceCreatedAt &&
    source.orderedPhotoIds.length === binding.expectedImageCount &&
    digestJson(source.orderedPhotoIds) === binding.orderedPhotoIdsSha256 &&
    digestText(source.caption) === binding.captionSha256
  );
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function digestText(value: string): string {
  if (typeof value !== 'string') {
    throw new Error('Image text stop-list caption is invalid');
  }
  return createHash('sha256').update(value).digest('hex');
}

function boundedText(value: string, maximum: number, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximum) {
    throw new Error(`Image text stop-list ${label} is invalid`);
  }
  return normalized;
}

function canonicalTimestamp(value: string): string {
  if (!isCanonicalTimestamp(value)) {
    throw new Error('Image text stop-list source timestamp is invalid');
  }
  return value;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function requireConfidence(value: number): void {
  if (!isConfidence(value)) {
    throw new Error('Image text stop-list confidence is invalid');
  }
}

function isConfidence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 900 && (value as number) <= 1_000;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= maximum
  );
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
