import type { MaxUpdate } from '@maxim/contracts';
import { selectMaxMessageCandidate } from '../max/max-message-candidate.util';
export {
  measureVisibleMessageLength as calculateEffectiveMessageLength,
  collectForwardedVisibleText as collectForwardedTextSnippets,
} from './moderation-message-length';

const MAX_FORWARD_SCAN_DEPTH = 8;
const MAX_MEDIA_BATCH_ID_LENGTH = 512;
const MAX_MESSAGE_COUNT_PUBLICATION_ID_LENGTH = 256;
const MESSAGE_COUNT_PUBLICATION_ID_KEYS = [
  'media_group_id',
  'mediaGroupId',
  'album_id',
  'albumId',
] as const;
const MEDIA_BATCH_ID_KEYS = [
  'media_group_id',
  'mediaGroupId',
  'media_group',
  'mediaGroup',
  'album_id',
  'albumId',
  'album',
] as const;

export type ModerationMediaFlags = {
  hasPhotoAttachment: boolean;
  hasStickerAttachment: boolean;
  hasVideoAttachment: boolean;
  hasFileAttachment: boolean;
  hasVoiceAttachment: boolean;
  hasMediaBatch: boolean;
};

export function hasForwardedMessage(update: MaxUpdate): boolean {
  const rawRecord = asRecord(update.raw);
  if (!rawRecord) {
    return false;
  }

  const messageNode = selectMaxMessageCandidate(rawRecord, update.type)?.node ?? rawRecord;
  const body = asRecord(messageNode.body);
  const content = asRecord(messageNode.content);
  const payload = asRecord(messageNode.payload);
  return [messageNode, body, content, payload].some(hasDirectForwardMarker);
}

export function shouldSkipAntiSpamBurstForForward(update: MaxUpdate): boolean {
  const rawRecord = asRecord(update.raw);
  if (!rawRecord) {
    return false;
  }

  const messageNode = selectMaxMessageCandidate(rawRecord, update.type)?.node ?? rawRecord;
  return hasForwardedMessage(update) && !hasDirectCurrentMessageText(messageNode);
}

export function extractRawMessageNode(
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  const directMessage = asRecord(raw.message);
  if (directMessage) {
    return directMessage;
  }

  const envelopeKeys = ['message_created', 'data', 'event'];
  if (typeof raw.update_type === 'string') {
    envelopeKeys.push(raw.update_type);
  }
  if (typeof raw.type === 'string') {
    envelopeKeys.push(raw.type);
  }

  for (const key of envelopeKeys) {
    const envelope = asRecord(raw[key]);
    if (!envelope) {
      continue;
    }

    const nestedMessage = asRecord(envelope.message);
    if (nestedMessage) {
      return nestedMessage;
    }

    const nestedData = asRecord(envelope.data);
    const nestedDataMessage = nestedData ? asRecord(nestedData.message) : null;
    if (nestedDataMessage) {
      return nestedDataMessage;
    }
  }

  return null;
}

export function collectForwardedNodes(node: unknown, depth = 0, acc: unknown[] = []): unknown[] {
  if (depth > MAX_FORWARD_SCAN_DEPTH || node === null || node === undefined) {
    return acc;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectForwardedNodes(item, depth + 1, acc);
    }
    return acc;
  }

  if (typeof node !== 'object') {
    return acc;
  }

  const row = node as Record<string, unknown>;
  if (isForwardLinkedMessage(row)) {
    acc.push(readForwardLinkedMessagePayload(row) ?? row);
  }

  for (const [key, value] of Object.entries(row)) {
    if (/forward/i.test(key)) {
      acc.push(value);
    }

    if (value && (typeof value === 'object' || Array.isArray(value))) {
      collectForwardedNodes(value, depth + 1, acc);
    }
  }

  return acc;
}

export function detectMediaFlags(update: MaxUpdate): ModerationMediaFlags {
  const rawRecord = asRecord(update.raw);
  if (!rawRecord) {
    return createEmptyMediaFlags();
  }

  const messageNode = extractRawMessageNode(rawRecord) ?? rawRecord;
  const flags = createEmptyMediaFlags();
  collectMediaFlags(messageNode, flags);
  return flags;
}

export function extractDirectMediaBatchId(update: MaxUpdate): string | null {
  const rawRecord = asRecord(update.raw);
  if (!rawRecord) {
    return null;
  }

  const messageNode = extractRawMessageNode(rawRecord) ?? rawRecord;
  const containers = [
    messageNode,
    asRecord(messageNode.body),
    asRecord(messageNode.content),
    asRecord(messageNode.payload),
  ];

  for (const container of containers) {
    if (!container) {
      continue;
    }
    for (const key of MEDIA_BATCH_ID_KEYS) {
      const value = container[key];
      if (typeof value !== 'string' && typeof value !== 'number') {
        continue;
      }
      const normalized = String(value).trim();
      if (normalized && normalized.length <= MAX_MEDIA_BATCH_ID_LENGTH) {
        return normalized;
      }
    }
  }

  return null;
}

export function extractMessageCountPublicationId(update: MaxUpdate): string | null {
  const rawRecord = asRecord(update.raw);
  if (update.type !== 'message_created' || !rawRecord || !update.message?.messageId.trim()) {
    return null;
  }
  const candidate = selectMaxMessageCandidate(rawRecord, update.type);
  if (
    !candidate ||
    /(?:^|\.)(?:link|[^.]*forward[^.]*|[^.]*reply[^.]*)(?:\.|$)/i.test(candidate.path)
  ) {
    return null;
  }
  const node = candidate.node;
  const body = asRecord(node.body);
  const content = asRecord(node.content);
  const data = asRecord(node.data);
  const messageId = [
    node.messageId,
    node.message_id,
    node.mid,
    node.seq,
    node.id,
    body?.mid,
    body?.seq,
    body?.message_id,
    body?.messageId,
    body?.id,
    content?.mid,
    content?.seq,
    content?.message_id,
    content?.messageId,
    content?.id,
    data?.message_id,
    data?.messageId,
    data?.id,
  ]
    .map(readOpaqueIdentity)
    .find((value) => value !== null);
  if (messageId !== update.message.messageId.trim()) {
    return null;
  }
  const containers = [node, body, content, asRecord(node.payload)];
  const hasDirectPhoto = containers.some(
    (container) =>
      Array.isArray(container?.attachments) && container.attachments.some(isDirectPhotoAttachment),
  );
  if (!hasDirectPhoto) {
    return null;
  }

  // FLAG: MAX's documented album is one MID with attachments[]. Only an explicit direct
  // compatibility marker joins different sends; linked content and guessed groups never do.
  const identities = new Set<string>();
  for (const container of containers) {
    if (!container) continue;
    for (const key of MESSAGE_COUNT_PUBLICATION_ID_KEYS) {
      if (!(key in container)) continue;
      const identity = readOpaqueIdentity(container[key]);
      if (!identity || identity.length > MAX_MESSAGE_COUNT_PUBLICATION_ID_LENGTH) return null;
      identities.add(identity);
    }
  }
  return identities.size === 1 ? ([...identities][0] ?? null) : null;
}

function readOpaqueIdentity(value: unknown): string | null {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) {
    return null;
  }
  return String(value).trim() || null;
}

function isDirectPhotoAttachment(value: unknown): boolean {
  const attachment = asRecord(value);
  if (!attachment || !['image', 'photo'].includes(readLowerString(attachment.type) ?? '')) {
    return false;
  }
  const payload = asRecord(attachment.payload);
  return Boolean(
    payload && [payload.photo_id, payload.url, payload.token].some(readOpaqueIdentity),
  );
}

function hasDirectCurrentMessageText(messageNode: Record<string, unknown>): boolean {
  const body = asRecord(messageNode.body);
  const content = asRecord(messageNode.content);
  const payload = asRecord(messageNode.payload);
  const nestedMessage = asRecord(messageNode.message);
  const candidates = [
    messageNode.text,
    messageNode.caption,
    messageNode.plain,
    messageNode.message_text,
    messageNode.messageText,
    body?.text,
    body?.caption,
    body?.plain,
    content?.text,
    content?.caption,
    content?.plain,
    payload?.text,
    payload?.caption,
    payload?.plain,
    nestedMessage?.text,
    nestedMessage?.caption,
    nestedMessage?.plain,
  ];

  return candidates.some((candidate) => typeof candidate === 'string' && candidate.trim());
}

function collectMediaFlags(
  node: unknown,
  flags: ModerationMediaFlags,
  depth = 0,
  inStickerContext = false,
  inFileContext = false,
): void {
  if (
    depth > MAX_FORWARD_SCAN_DEPTH ||
    node === null ||
    node === undefined ||
    (flags.hasPhotoAttachment &&
      flags.hasStickerAttachment &&
      flags.hasVideoAttachment &&
      flags.hasFileAttachment &&
      flags.hasVoiceAttachment &&
      flags.hasMediaBatch)
  ) {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectMediaFlags(item, flags, depth + 1, inStickerContext, inFileContext);
    }
    return;
  }

  if (typeof node !== 'object') {
    return;
  }

  const row = node as Record<string, unknown>;
  const relationType = readLowerString(row.type ?? row.kind ?? row.entity_type ?? row.entityType);
  if (isReplyReferenceType(relationType)) {
    return;
  }

  const payload =
    row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : null;
  const type = readLowerString(row.type ?? payload?.type);
  const mimeType = readLowerString(
    row.mime_type ?? row.mimeType ?? payload?.mime_type ?? payload?.mimeType,
  );
  const fileName = readLowerString(
    row.file_name ??
      row.fileName ??
      row.filename ??
      payload?.file_name ??
      payload?.fileName ??
      payload?.filename ??
      payload?.url,
  );
  const mediaType = readLowerString(
    row.media_type ?? row.mediaType ?? payload?.media_type ?? payload?.mediaType,
  );
  const stickerContext = inStickerContext || type === 'sticker' || mediaType === 'sticker';
  const imageLike =
    !stickerContext &&
    (type === 'photo' ||
      type === 'image' ||
      type === 'picture' ||
      mimeType?.startsWith('image/') ||
      mediaType === 'photo' ||
      mediaType === 'image' ||
      isLikelyImageFileName(fileName));
  const fileContext =
    !imageLike &&
    (inFileContext ||
      type === 'file' ||
      type === 'document' ||
      type === 'doc' ||
      mediaType === 'file' ||
      mediaType === 'document');

  if (imageLike) {
    flags.hasPhotoAttachment = true;
  }

  if (stickerContext) {
    flags.hasStickerAttachment = true;
  }

  if (
    type === 'video' ||
    mimeType?.startsWith('video/') ||
    mediaType === 'video' ||
    isLikelyVideoFileName(fileName)
  ) {
    flags.hasVideoAttachment = true;
  }

  if (
    type === 'voice' ||
    type === 'audio' ||
    type === 'audio_message' ||
    type === 'ptt' ||
    mimeType?.startsWith('audio/') ||
    mediaType === 'voice' ||
    mediaType === 'audio' ||
    isLikelyVoiceFileName(fileName)
  ) {
    flags.hasVoiceAttachment = true;
  }

  if (fileContext) {
    flags.hasFileAttachment = true;
  }

  for (const [key, value] of Object.entries(row)) {
    const keyLower = key.toLowerCase();
    if (isMediaBatchKey(keyLower)) {
      flags.hasMediaBatch = true;
    }

    if (
      !stickerContext &&
      !fileContext &&
      (keyLower === 'photo' ||
        keyLower === 'photos' ||
        keyLower === 'image' ||
        keyLower === 'picture' ||
        keyLower === 'images')
    ) {
      flags.hasPhotoAttachment = true;
    }

    if (keyLower === 'sticker' || keyLower === 'stickers') {
      flags.hasStickerAttachment = true;
    }

    if (keyLower === 'video' || keyLower === 'videos') {
      flags.hasVideoAttachment = true;
    }

    if (
      keyLower === 'voice' ||
      keyLower === 'voices' ||
      keyLower === 'audio' ||
      keyLower === 'audio_message'
    ) {
      flags.hasVoiceAttachment = true;
    }

    if (value && (typeof value === 'object' || Array.isArray(value))) {
      if (isReplyReferenceKey(keyLower)) {
        continue;
      }

      const childStickerContext =
        stickerContext || keyLower === 'sticker' || keyLower === 'stickers';
      const childFileContext =
        fileContext ||
        keyLower === 'file' ||
        keyLower === 'files' ||
        keyLower === 'document' ||
        keyLower === 'documents';
      collectMediaFlags(value, flags, depth + 1, childStickerContext, childFileContext);
    }
  }
}

function createEmptyMediaFlags(): ModerationMediaFlags {
  return {
    hasPhotoAttachment: false,
    hasStickerAttachment: false,
    hasVideoAttachment: false,
    hasFileAttachment: false,
    hasVoiceAttachment: false,
    hasMediaBatch: false,
  };
}

function isMediaBatchKey(value: string): boolean {
  return (
    value === 'album' ||
    value === 'albumid' ||
    value === 'album_id' ||
    value === 'mediagroup' ||
    value === 'mediagroupid' ||
    value === 'media_group' ||
    value === 'media_group_id'
  );
}

function isForwardLinkedMessage(row: Record<string, unknown>): boolean {
  return readLowerString(row.type ?? row.link_type ?? row.linkType) === 'forward';
}

function hasDirectForwardMarker(container: Record<string, unknown> | null): boolean {
  if (!container) {
    return false;
  }

  const link = asRecord(container.link);
  if (readLowerString(link?.type ?? link?.link_type ?? link?.linkType) === 'forward') {
    return true;
  }

  return [
    container.forward,
    container.forwarded,
    container.forwarded_message,
    container.forwardedMessage,
    container.forwarded_messages,
    container.forwardedMessages,
  ].some(isPresentForwardPayload);
}

function isPresentForwardPayload(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => item !== null && item !== undefined && item !== false);
  }
  if (value && typeof value === 'object') {
    return true;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value !== 0;
  }
  return value === true;
}

function readForwardLinkedMessagePayload(row: Record<string, unknown>): unknown {
  return row.message ?? row.body ?? row.content ?? row.payload ?? null;
}

function isReplyReferenceType(value: string | null): boolean {
  return (
    value === 'reply' ||
    value === 'reply_message' ||
    value === 'replymessage' ||
    value === 'quoted' ||
    value === 'quoted_message' ||
    value === 'quotedmessage'
  );
}

function isReplyReferenceKey(value: string): boolean {
  return (
    value === 'reply' ||
    value === 'replyto' ||
    value === 'reply_to' ||
    value === 'replymessage' ||
    value === 'reply_message' ||
    value === 'replytomessage' ||
    value === 'reply_to_message' ||
    value === 'repliedmessage' ||
    value === 'replied_message' ||
    value === 'quoted' ||
    value === 'quotedmessage' ||
    value === 'quoted_message'
  );
}

function isLikelyVideoFileName(value: string | null): boolean {
  if (!value) {
    return false;
  }

  return /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(value);
}

function isLikelyImageFileName(value: string | null): boolean {
  if (!value) {
    return false;
  }

  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(value);
}

function isLikelyVoiceFileName(value: string | null): boolean {
  if (!value) {
    return false;
  }

  return /\.(ogg|opus|mp3|m4a|wav|flac)$/i.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readLowerString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}
