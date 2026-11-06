import { z } from 'zod';
import type { ChatSettings } from '../../prisma/prisma-client';
import { resolveDuplicateFlowConfig } from '../duplicate-flow-policy';
import { digestDuplicateContent } from './message-duplicate-content';
import { PHOTO_FINGERPRINT_ALGORITHM_VERSION } from '../photo-duplicate/photo-fingerprint-version';
import { PHOTO_RECOMPRESSION_VERSION } from '../photo-duplicate/photo-recompression-version';
import { duplicateScheduleDigestInput } from './message-duplicate-schedule';
import { MESSAGE_DUPLICATE_HISTORY_STORAGE_VERSION } from './message-duplicate-window.script';

export const MESSAGE_DUPLICATE_SOURCE = 'message_v1';
export const MESSAGE_DUPLICATE_MEDIA_VERSION = `sha256-v1:${PHOTO_FINGERPRINT_ALGORITHM_VERSION}`;
export const MESSAGE_DUPLICATE_CLAIM_PREFIX = 'message-duplicate-action:v1:';
export const messageDuplicateOriginalSchema = z
  .object({
    member: z.string().regex(/^[a-f0-9]{64}$/),
    author: z.string().regex(/^[a-f0-9]{64}$/),
    messageId: z.string().min(1).max(512),
    senderId: z.string().min(1).max(160),
    publishedAtMs: z.number().int().positive(),
    observedAtMs: z.number().int().positive(),
    expiresAtMs: z.number().int().positive(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    mediaHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10),
    epoch: z.number().int().nonnegative(),
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    originalId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type MessageDuplicateOriginal = z.infer<typeof messageDuplicateOriginalSchema>;

export const messageDuplicateBindingSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    enforcementScope: z.enum(['delete_only', 'full']).optional(),
    lifecycleRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    policyRevision: z.number().int().nonnegative().optional(),
    authorization: z
      .object({
        jobId: z
          .string()
          .regex(/^message-duplicate__[a-f0-9]{64}$/)
          .optional(),
        eventTimestampMs: z.number().int().positive(),
        deadlineAtMs: z.number().int().positive(),
      })
      .strict()
      .optional(),
    original: messageDuplicateOriginalSchema.optional(),
    sanction: z
      .object({
        action: z.enum(['WARN', 'MUTE', 'BAN']),
        repeatCount: z.number().int().min(1).max(20),
        threshold: z.number().int().min(1).max(20),
        settingsDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    senderId: z.string().min(1).max(160),
    messageId: z.string().min(1).max(512),
    eventTimestampMs: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER / 2 - 1),
    controlRevision: z.number().int().positive(),
    settingsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    compareMode: z.enum(['MESSAGE', 'TEXT', 'IMAGE']),
    imageScope: z.enum(['SAME_AUTHOR', 'CHAT']).optional(),
    mediaHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10),
    mediaVersion: z.literal(MESSAGE_DUPLICATE_MEDIA_VERSION),
    imageRecompression: z
      .object({
        version: z.literal(PHOTO_RECOMPRESSION_VERSION),
        originalHash: z.string().regex(/^[a-f0-9]{64}$/),
        currentHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    hasPhotos: z.boolean(),
    photoControlRevision: z.number().int().positive().nullable(),
    windowSeconds: z.number().int().positive().max(604800),
    requiredCount: z.number().int().min(2).max(21),
  })
  .strict()
  .refine(
    (value) =>
      value.version === 2 ||
      (value.version === 3 && value.enforcementScope === 'full') ||
      value.sanction === undefined,
  )
  .refine(
    (value) =>
      value.version !== 3 ||
      Boolean(
        value.original?.revision &&
        value.original.originalId &&
        value.lifecycleRevision &&
        value.enforcementScope &&
        value.policyRevision !== undefined,
      ),
  )
  .refine((value) =>
    value.compareMode === 'IMAGE'
      ? (value.version === 2 || (value.version === 3 && value.enforcementScope === 'full')) &&
        value.imageScope !== undefined &&
        value.hasPhotos &&
        value.mediaHashes.length > 0 &&
        value.photoControlRevision === null &&
        value.requiredCount >= 2
      : value.imageScope === undefined,
  )
  .refine(hasValidImageComparisonEvidence);
export type MessageDuplicateBinding = z.infer<typeof messageDuplicateBindingSchema>;

// FLAG: Candidate similarity never authorizes deletion. A tolerant single-image match
// retains both exact raster identities and the separately verified original anchor.
export function hasValidImageComparisonEvidence(value: {
  compareMode: string;
  mediaHashes: readonly string[];
  original?: { mediaHashes: readonly string[] };
  imageRecompression?: { version: string; originalHash: string; currentHash: string };
}): boolean {
  const proof = value.imageRecompression;
  if (value.compareMode !== 'IMAGE') return proof === undefined;
  const original = value.original?.mediaHashes;
  if (!original) return proof === undefined;
  const equal = [...original].sort().join(':') === [...value.mediaHashes].sort().join(':');
  if (equal) return proof === undefined;
  return Boolean(
    proof &&
    proof.version === PHOTO_RECOMPRESSION_VERSION &&
    original.length === 1 &&
    value.mediaHashes.length === 1 &&
    proof.originalHash === original[0] &&
    proof.currentHash === value.mediaHashes[0],
  );
}

export function messageDuplicateEnforcementScope(
  binding: MessageDuplicateBinding,
): 'full' | 'delete_only' {
  return binding.version === 3
    ? binding.enforcementScope!
    : binding.version === 2
      ? 'full'
      : 'delete_only';
}

export function parseMessageDuplicateBinding(value: unknown): MessageDuplicateBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  if (metadata.duplicateSource !== MESSAGE_DUPLICATE_SOURCE) return null;
  const result = messageDuplicateBindingSchema.safeParse(metadata.messageDuplicate);
  return result.success ? result.data : null;
}

export function isBoundMessageDuplicateDelete(input: {
  ruleCode?: string;
  reasonKey: string;
  event?: { metadata?: unknown };
}): boolean {
  const binding = parseMessageDuplicateBinding(input.event?.metadata);
  const metadata = input.event?.metadata as Record<string, unknown> | undefined;
  return (
    input.ruleCode === 'DUPLICATE_DELETE' &&
    input.reasonKey.startsWith('MESSAGE_DUPLICATE:') &&
    binding !== null &&
    metadata?.enforcementScope === messageDuplicateEnforcementScope(binding)
  );
}

export function messageDuplicateSettingsDigest(settings: ChatSettings): string {
  const flow = resolveDuplicateFlowConfig(settings);
  const nearEnabled =
    settings.duplicateDetectionPreset === 'STRICT' ||
    (settings.duplicateDetectionPreset === 'CUSTOM' && settings.duplicateNearMatchEnabled);
  const phoneValueMatchingEnabled =
    settings.duplicateDetectionPreset === 'CUSTOM' && settings.duplicateIgnorePhonesEnabled;
  const safeTextMatchingEnabled = nearEnabled || phoneValueMatchingEnabled;
  return digestDuplicateContent({
    // FLAG: Old text grants/jobs, including exact-only, must fail the fresh guard after
    // electrical quantity-unit and numeric/phone protection. IMAGE has independent settings/raster semantics.
    version: safeTextMatchingEnabled ? 'text-fixed-window-safe-text-v14' : 'text-fixed-window-v14',
    comparisonPolicy: 'text-or-image-v1',
    historyStorageVersion: MESSAGE_DUPLICATE_HISTORY_STORAGE_VERSION,
    historyRevision: settings.duplicateHistoryRevision ?? 0,
    schedule: duplicateScheduleDigestInput(settings),
    enabled: settings.antiDuplicateEnabled,
    fingerprint:
      settings.duplicateDetectionPreset === 'CUSTOM'
        ? [
            false,
            false,
            settings.duplicateIgnoreLinksEnabled,
            settings.duplicateIgnorePhonesEnabled,
            settings.duplicateNearMatchEnabled,
          ]
        : settings.duplicateDetectionPreset === 'STRICT'
          ? [true, true, false, false, true]
          : [false, false, false, false, false],
    window: flow.windowSec,
    allowed: flow.allowedCount,
  });
}

export function messageDuplicateSanctionSettingsDigest(
  settings: ChatSettings,
  imageOnly = false,
): string {
  return digestDuplicateContent({
    settings: imageOnly
      ? exactImageSettingsDigest(settings)
      : messageDuplicateSettingsDigest(settings),
    reactions: resolveDuplicateFlowConfig(settings).reactions,
    muteHours: settings.duplicateMuteEnabled ? settings.duplicateMuteDurationHours : null,
  });
}

export function exactImageSettingsDigest(settings: ChatSettings): string {
  return digestDuplicateContent({
    version: 'image-recompression-fixed-window-v2',
    recompressionVersion: PHOTO_RECOMPRESSION_VERSION,
    comparisonPolicy: 'text-or-image-v1',
    historyStorageVersion: MESSAGE_DUPLICATE_HISTORY_STORAGE_VERSION,
    historyRevision: settings.duplicateHistoryRevision ?? 0,
    schedule: duplicateScheduleDigestInput(settings),
    enabled: settings.antiDuplicateEnabled,
    scope: settings.duplicatePhotoScope,
    window: resolveDuplicateFlowConfig(settings).windowSec,
    allowed: resolveDuplicateFlowConfig(settings).allowedCount,
  });
}
