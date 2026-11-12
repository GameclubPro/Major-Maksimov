import {
  channelDialogMessageSchema,
  channelDialogResponseSchema,
  channelDialogTypeSchema,
  channelSuggestionRedirectResponseSchema,
  createChannelDialogMessageRequestSchema,
  createChannelDialogMessageResponseSchema,
  deleteChannelDialogMessageRequestSchema,
  deleteChannelDialogMessageResponseSchema,
  toggleChannelDialogReactionRequestSchema,
  toggleChannelDialogReactionResponseSchema,
  updateChannelDialogMessageRequestSchema,
  updateChannelDialogMessageResponseSchema,
  updateChannelDialogNotificationsRequestSchema,
  updateChannelDialogNotificationsResponseSchema,
  type ChannelDialogMessage,
  type ChannelDialogResponse,
  type ChannelDialogType,
} from '@maxim/contracts';
import { PREVIEW_CHANNEL_TITLE, PREVIEW_CHAT_TITLE } from '../design-preview';
import type { PreviewDialogBucket, PreviewState } from './preview-transport-state';
import {
  PREVIEW_NOT_HANDLED,
  readPreviewClock,
  resolvePreviewEntityRequest,
  type PreviewClock,
  type PreviewRequestHandler,
} from './preview-transport-runtime';
import { buildAuthorBadge, cloneJson, parseJsonBody } from './preview-transport-shared';
import {
  updateCommentRestrictionRequestSchema,
  type CommentRestriction,
} from '@maxim/contracts/channel-dialog';

const previewRestrictions = new WeakMap<PreviewState, Map<string, CommentRestriction>>();

export function resolveChatTitle(chatId: string, state: PreviewState): string {
  return state.chats.find((item) => item.id === chatId)?.title ?? PREVIEW_CHAT_TITLE;
}

export function resolveChatAvatarUrl(chatId: string, state: PreviewState): string | null {
  return state.chats.find((item) => item.id === chatId)?.avatarUrl ?? null;
}

export function resolveChannelTitle(channelId: string, state: PreviewState): string {
  return state.channels.find((item) => item.id === channelId)?.title ?? PREVIEW_CHANNEL_TITLE;
}

export function resolveChannelAvatarUrl(channelId: string, state: PreviewState): string | null {
  return state.channels.find((item) => item.id === channelId)?.avatarUrl ?? null;
}

export function buildPreviewDialogAttachments(
  attachments: Array<{
    type: 'image' | 'file';
    base64: string;
    mimeType: string;
    fileName: string;
  }> = [],
): ChannelDialogMessage['attachments'] {
  return attachments.map((attachment) => ({
    kind: attachment.type,
    url: `data:${attachment.mimeType};base64,${attachment.base64}`,
    previewUrl: `data:${attachment.mimeType};base64,${attachment.base64}`,
    fileName: attachment.fileName || null,
    mimeType: attachment.mimeType || null,
    size: Math.max(0, Math.floor((attachment.base64.length * 3) / 4)),
    ...(attachment.type === 'image'
      ? {
          width: 120,
          height: 120,
        }
      : {}),
  }));
}

export function buildPreviewDialogMessage(payload: {
  id: string;
  type: ChannelDialogType;
  text: string;
  textFormat?: ChannelDialogMessage['textFormat'];
  authorUserId: string;
  authorDisplayName: string | null;
  isAdmin?: boolean;
  avatarUrl?: string | null;
  createdAt: string;
  replyToMessageId?: string | null;
  replyTo?: ChannelDialogMessage['replyTo'];
  attachments?: ChannelDialogMessage['attachments'];
  reactionGroups?: ChannelDialogMessage['reactionGroups'];
  delivered?: boolean;
  deliveredToUserId?: string | null;
  suggestionDelivery?: ChannelDialogMessage['suggestionDelivery'];
  reviewStatus?: ChannelDialogMessage['reviewStatus'];
  publishedUrl?: string | null;
  hasImage?: boolean;
  hasVideo?: boolean;
  videoFileName?: string | null;
  imageCount?: number;
  imageFileName?: string | null;
  imageFileNames?: string[];
}): ChannelDialogMessage {
  return channelDialogMessageSchema.parse({
    id: payload.id,
    type: payload.type,
    text: payload.text,
    ...(payload.textFormat !== undefined ? { textFormat: payload.textFormat } : {}),
    authorUserId: payload.authorUserId,
    authorDisplayName: payload.authorDisplayName,
    isAdmin: payload.isAdmin ?? payload.authorUserId.startsWith('preview-admin'),
    avatarUrl: payload.avatarUrl ?? null,
    createdAt: payload.createdAt,
    ...(payload.replyToMessageId !== undefined
      ? { replyToMessageId: payload.replyToMessageId }
      : {}),
    ...(payload.replyTo !== undefined ? { replyTo: payload.replyTo } : {}),
    ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
    ...(payload.reactionGroups !== undefined ? { reactionGroups: payload.reactionGroups } : {}),
    ...(payload.delivered !== undefined ? { delivered: payload.delivered } : {}),
    ...(payload.deliveredToUserId !== undefined
      ? { deliveredToUserId: payload.deliveredToUserId }
      : {}),
    ...(payload.suggestionDelivery !== undefined
      ? { suggestionDelivery: payload.suggestionDelivery }
      : {}),
    ...(payload.reviewStatus !== undefined ? { reviewStatus: payload.reviewStatus } : {}),
    ...(payload.publishedUrl !== undefined ? { publishedUrl: payload.publishedUrl } : {}),
    ...(payload.hasImage !== undefined ? { hasImage: payload.hasImage } : {}),
    ...(payload.hasVideo !== undefined ? { hasVideo: payload.hasVideo } : {}),
    ...(payload.videoFileName !== undefined ? { videoFileName: payload.videoFileName } : {}),
    ...(payload.imageCount !== undefined ? { imageCount: payload.imageCount } : {}),
    ...(payload.imageFileName !== undefined ? { imageFileName: payload.imageFileName } : {}),
    ...(payload.imageFileNames !== undefined ? { imageFileNames: payload.imageFileNames } : {}),
  });
}

export function decoratePreviewDialogMessageAccess(
  message: ChannelDialogMessage,
  viewerUserId: string,
): ChannelDialogMessage {
  const isOwnMessage = message.authorUserId === viewerUserId;
  const viewerIsAdmin = viewerUserId.startsWith('preview-admin');

  return channelDialogMessageSchema.parse({
    ...message,
    canEdit: message.type === 'comments' && isOwnMessage,
    canDelete: message.type === 'comments' && isOwnMessage,
    canDeleteAsAdmin: message.type === 'comments' && !isOwnMessage && viewerIsAdmin,
  });
}

export function findPreviewDialogMessage(
  bucket: PreviewDialogBucket,
  messageId: string | null | undefined,
): ChannelDialogMessage | null {
  const normalizedMessageId = messageId?.trim() ?? '';
  if (!normalizedMessageId) {
    return null;
  }

  return bucket.messages.find((message) => message.id === normalizedMessageId) ?? null;
}

export function getPreviewDialogBucket(
  state: PreviewState,
  entityType: 'chat' | 'channel',
  dialogType: ChannelDialogType,
  token: string | null | undefined,
): PreviewDialogBucket {
  const normalizedToken = token?.trim() ?? '';
  const baseBuckets = entityType === 'channel' ? state.channelDialogs : state.chatDialogs;

  if (!normalizedToken) {
    return baseBuckets[dialogType];
  }

  const threadBuckets =
    entityType === 'channel' ? state.channelDialogThreads : state.chatDialogThreads;
  const bucketsForType =
    threadBuckets[dialogType] ??
    ((threadBuckets[dialogType] = {}) as Record<string, PreviewDialogBucket>);
  const existingBucket = bucketsForType[normalizedToken];
  if (existingBucket) {
    return existingBucket;
  }

  const nextBucket = cloneJson(baseBuckets[dialogType]);
  bucketsForType[normalizedToken] = nextBucket;
  return nextBucket;
}

export function togglePreviewDialogReaction(
  bucket: PreviewDialogBucket,
  messageId: string,
  emoji: string,
): ChannelDialogMessage {
  const nextMessages = bucket.messages.map((message) => {
    if (message.id !== messageId) {
      return message;
    }

    const existingGroups = message.reactionGroups ?? [];
    const reactedEmoji = existingGroups.find((group) => group.reactedByMe)?.emoji ?? null;
    const nextGroups = existingGroups
      .map((group) => {
        if (group.reactedByMe) {
          const nextCount = group.count - 1;
          return nextCount > 0 ? { ...group, count: nextCount, reactedByMe: false } : null;
        }

        if (reactedEmoji === emoji || group.emoji !== emoji) {
          return group;
        }

        return {
          ...group,
          count: group.count + 1,
          reactedByMe: true,
        };
      })
      .filter((group): group is NonNullable<typeof group> => group !== null);

    if (reactedEmoji !== emoji && !nextGroups.some((group) => group.emoji === emoji)) {
      nextGroups.push({
        emoji,
        count: 1,
        reactedByMe: true,
      });
    }

    const normalizedGroups = nextGroups.sort(
      (left, right) => right.count - left.count || left.emoji.localeCompare(right.emoji),
    );

    return channelDialogMessageSchema.parse({
      ...message,
      reactionGroups: normalizedGroups,
    });
  });

  bucket.messages = nextMessages;
  return bucket.messages.find((message) => message.id === messageId) ?? bucket.messages.at(-1)!;
}

export function updatePreviewDialogMessage(
  bucket: PreviewDialogBucket,
  messageId: string,
  text: string,
  clock: PreviewClock,
): ChannelDialogMessage {
  const editedAt = readPreviewClock(clock).toISOString();
  const nextMessages = bucket.messages.map((message) =>
    message.id === messageId
      ? channelDialogMessageSchema.parse({
          ...message,
          text,
          editedAt,
        })
      : message,
  );

  bucket.messages = nextMessages;
  return bucket.messages.find((message) => message.id === messageId) ?? bucket.messages.at(-1)!;
}

export function deletePreviewDialogMessage(
  bucket: PreviewDialogBucket,
  messageId: string,
): boolean {
  const previousLength = bucket.messages.length;
  bucket.messages = bucket.messages.filter((message) => message.id !== messageId);
  return bucket.messages.length < previousLength;
}

export function buildPreviewNotificationSettings(bucket: PreviewDialogBucket) {
  const threadMode = bucket.threadNotificationMode ?? bucket.notificationMode ?? 'off';
  const channelMode = bucket.channelNotificationMode ?? 'off';
  const allChannelsMode = bucket.allChannelsNotificationMode ?? 'off';
  const threadExplicit =
    bucket.threadNotificationExplicit ??
    (bucket.threadNotificationMode !== undefined || bucket.notificationMode !== undefined);
  const channelExplicit = bucket.channelNotificationExplicit ?? false;
  const allChannelsExplicit = bucket.allChannelsNotificationExplicit ?? false;
  const scope = threadExplicit
    ? 'thread'
    : channelExplicit
      ? 'channel'
      : allChannelsExplicit
        ? 'all_channels'
        : 'thread';
  const mode =
    scope === 'all_channels' ? allChannelsMode : scope === 'channel' ? channelMode : threadMode;

  return {
    mode,
    canUseAll: true,
    scope,
    thread: {
      mode: threadMode,
      explicit: threadExplicit,
    },
    channel: {
      mode: channelMode,
      explicit: channelExplicit,
    },
    allChannels: {
      mode: allChannelsMode,
      explicit: allChannelsExplicit,
    },
    availableChannelCount: 3,
  } as const;
}

export function buildPreviewDialogResponse(
  chatId: string,
  dialogType: ChannelDialogType,
  bucket: PreviewDialogBucket,
  viewerUserId: string,
  profile: PreviewState['me']['profile'],
): ChannelDialogResponse {
  const previewThreadVariant =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('thread')?.trim().toLowerCase()
      : null;
  const normalizedBucket =
    dialogType === 'comments' && previewThreadVariant === 'empty'
      ? {
          ...bucket,
          messages: [],
        }
      : dialogType === 'comments' && previewThreadVariant === 'short'
        ? {
            ...bucket,
            messages: bucket.messages.slice(-2),
          }
        : bucket;

  return channelDialogResponseSchema.parse({
    chatId,
    entityTitle: dialogType === 'suggest' ? 'Новости Южного' : null,
    type: dialogType,
    introText:
      profile === 'publisher' && dialogType === 'suggest' ? null : normalizedBucket.introText,
    messages: normalizedBucket.messages.map((message) =>
      decoratePreviewDialogMessageAccess(message, viewerUserId),
    ),
    notificationSettings: buildPreviewNotificationSettings(normalizedBucket),
  });
}

export function buildPreviewAvatarDataUrl(
  label: string,
  startColor: string,
  endColor: string,
): string {
  const initials = buildAuthorBadge(label);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
      <defs>
        <linearGradient id="avatar-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${startColor}" />
          <stop offset="100%" stop-color="${endColor}" />
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="28" fill="url(#avatar-gradient)" />
      <text
        x="50%"
        y="52%"
        dominant-baseline="middle"
        text-anchor="middle"
        font-family="Manrope, Arial, sans-serif"
        font-size="34"
        font-weight="700"
        fill="#ffffff"
      >${initials}</text>
    </svg>
  `.trim();

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export function buildPreviewProfileUrl(handle: string): string {
  return `https://max.ru/${encodeURIComponent(handle)}`;
}

export function buildPreviewProfileHandoffUrl(seed: string): string {
  return `https://max.ru/id613002203036_bot?start=${encodeURIComponent(`preview-profile-${seed}`)}`;
}

function handleChatDialogPreviewRequest(
  state: PreviewState,
  chatId: string,
  tail: string[],
  url: URL,
  method: string,
  init: RequestInit,
): unknown | typeof PREVIEW_NOT_HANDLED {
  if (tail[0] === 'dialog' && tail[1]) {
    const dialogType = channelDialogTypeSchema.parse(tail[1]);

    if (tail.length === 2 && method === 'GET') {
      const bucket = getPreviewDialogBucket(
        state,
        'chat',
        dialogType,
        url.searchParams.get('token'),
      );
      return cloneJson(
        buildPreviewDialogResponse(chatId, dialogType, bucket, state.me.userId, state.me.profile),
      );
    }

    if (tail.length === 3 && tail[2] === 'messages' && method === 'POST') {
      const payload = createChannelDialogMessageRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'chat', dialogType, payload.token);
      const replyTarget = findPreviewDialogMessage(bucket, payload.replyToMessageId);
      const message = buildPreviewDialogMessage({
        id: `chat-${dialogType}-${readPreviewClock(state.clock).getTime()}`,
        type: dialogType,
        text: payload.text,
        authorUserId: state.me.userId,
        authorDisplayName: state.me.displayName ?? state.me.username ?? null,
        avatarUrl: state.me.avatarUrl ?? null,
        createdAt: readPreviewClock(state.clock).toISOString(),
        replyToMessageId: replyTarget?.id ?? null,
        replyTo: replyTarget
          ? {
              messageId: replyTarget.id,
              authorDisplayName: replyTarget.authorDisplayName,
              text: replyTarget.text,
            }
          : null,
        attachments:
          dialogType === 'comments' ? buildPreviewDialogAttachments(payload.attachments) : [],
        reactionGroups: [],
        ...(dialogType === 'suggest'
          ? {
              delivered: true,
              deliveredToUserId: 'preview-admin-2',
              reviewStatus: 'pending',
              textFormat: payload.textFormat,
              hasVideo: Boolean(payload.video),
              videoFileName: payload.video?.fileName ?? null,
              hasImage: payload.images.length > 0 || Boolean(payload.imageBase64),
              imageCount: payload.images.length || (payload.imageBase64 ? 1 : 0),
              imageFileName: payload.images[0]?.fileName || payload.imageFileName || null,
              imageFileNames:
                payload.images.length > 0
                  ? payload.images.map((image) => image.fileName)
                  : payload.imageFileName
                    ? [payload.imageFileName]
                    : [],
            }
          : {}),
      });
      bucket.messages.push(message);
      return createChannelDialogMessageResponseSchema.parse({
        ok: true,
        message: decoratePreviewDialogMessageAccess(message, state.me.userId),
      });
    }

    if (tail[2] === 'notifications' && method === 'PUT') {
      const payload = updateChannelDialogNotificationsRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'chat', dialogType, payload.token);
      bucket.notificationScope = payload.scope;
      if (payload.scope === 'all_channels') {
        bucket.allChannelsNotificationMode = payload.mode;
        bucket.allChannelsNotificationExplicit = true;
      } else if (payload.scope === 'channel') {
        bucket.channelNotificationMode = payload.mode;
        bucket.channelNotificationExplicit = true;
      } else {
        bucket.threadNotificationMode = payload.mode;
        bucket.threadNotificationExplicit = true;
        bucket.notificationMode = payload.mode;
      }
      return updateChannelDialogNotificationsResponseSchema.parse({
        ok: true,
        notificationSettings: buildPreviewNotificationSettings(bucket),
      });
    }

    if (tail[2] === 'messages' && tail[3] && method === 'PATCH') {
      const payload = updateChannelDialogMessageRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'chat', dialogType, payload.token);
      const message = updatePreviewDialogMessage(bucket, tail[3], payload.text, state.clock);
      return updateChannelDialogMessageResponseSchema.parse({
        ok: true,
        message: decoratePreviewDialogMessageAccess(message, state.me.userId),
      });
    }

    if (tail[2] === 'messages' && tail[3] && method === 'DELETE') {
      const payload = deleteChannelDialogMessageRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'chat', dialogType, payload.token);
      deletePreviewDialogMessage(bucket, tail[3]);
      return deleteChannelDialogMessageResponseSchema.parse({
        ok: true,
        deletedMessageId: tail[3],
      });
    }

    if (tail[2] === 'messages' && tail[3] && tail[4] === 'reactions' && method === 'POST') {
      const payload = toggleChannelDialogReactionRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'chat', dialogType, payload.token);
      const message = togglePreviewDialogReaction(bucket, tail[3], payload.emoji);
      return toggleChannelDialogReactionResponseSchema.parse({
        ok: true,
        message: decoratePreviewDialogMessageAccess(message, state.me.userId),
      });
    }
  }

  return PREVIEW_NOT_HANDLED;
}

function handleChannelDialogPreviewRequest(
  state: PreviewState,
  channelId: string,
  tail: string[],
  url: URL,
  method: string,
  init: RequestInit,
): unknown | typeof PREVIEW_NOT_HANDLED {
  if (tail[0] === 'dialog' && tail[1]) {
    if (tail[1] === 'suggest' && tail[2] === 'redirect' && method === 'GET') {
      const token = url.searchParams.get('token')?.trim() ?? '';
      return channelSuggestionRedirectResponseSchema.parse({
        url: `https://max.ru/id613002203036_bot?start=${encodeURIComponent(
          token ? `preview-suggest-${channelId}-${token}` : `preview-suggest-${channelId}`,
        )}`,
        title: resolveChannelTitle(channelId, state),
      });
    }

    const dialogType = channelDialogTypeSchema.parse(tail[1]);

    if (tail.length === 2 && method === 'GET') {
      const bucket = getPreviewDialogBucket(
        state,
        'channel',
        dialogType,
        url.searchParams.get('token'),
      );
      return cloneJson(
        buildPreviewDialogResponse(
          channelId,
          dialogType,
          bucket,
          state.me.userId,
          state.me.profile,
        ),
      );
    }

    if (
      tail.length === 3 &&
      (tail[2] === 'messages' || (tail[1] === 'suggest' && tail[2] === 'video')) &&
      method === 'POST'
    ) {
      const payload = createChannelDialogMessageRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'channel', dialogType, payload.token);
      const replyTarget = findPreviewDialogMessage(bucket, payload.replyToMessageId);
      const message = buildPreviewDialogMessage({
        id: `channel-${dialogType}-${readPreviewClock(state.clock).getTime()}`,
        type: dialogType,
        text: payload.text,
        authorUserId: state.me.userId,
        authorDisplayName: state.me.displayName ?? state.me.username ?? null,
        avatarUrl: state.me.avatarUrl ?? null,
        createdAt: readPreviewClock(state.clock).toISOString(),
        replyToMessageId: replyTarget?.id ?? null,
        replyTo: replyTarget
          ? {
              messageId: replyTarget.id,
              authorDisplayName: replyTarget.authorDisplayName,
              text: replyTarget.text,
            }
          : null,
        attachments:
          dialogType === 'comments' ? buildPreviewDialogAttachments(payload.attachments) : [],
        reactionGroups: [],
        ...(dialogType === 'suggest'
          ? {
              delivered: true,
              deliveredToUserId: 'preview-admin-2',
              reviewStatus: 'pending',
              textFormat: payload.textFormat,
              hasVideo: Boolean(payload.video),
              videoFileName: payload.video?.fileName ?? null,
              hasImage: payload.images.length > 0 || Boolean(payload.imageBase64),
              imageCount: payload.images.length || (payload.imageBase64 ? 1 : 0),
              imageFileName: payload.images[0]?.fileName || payload.imageFileName || null,
              imageFileNames:
                payload.images.length > 0
                  ? payload.images.map((image) => image.fileName)
                  : payload.imageFileName
                    ? [payload.imageFileName]
                    : [],
            }
          : {}),
      });
      bucket.messages.push(message);
      return createChannelDialogMessageResponseSchema.parse({
        ok: true,
        message: decoratePreviewDialogMessageAccess(message, state.me.userId),
      });
    }

    if (tail[2] === 'notifications' && method === 'PUT') {
      const payload = updateChannelDialogNotificationsRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'channel', dialogType, payload.token);
      bucket.notificationScope = payload.scope;
      if (payload.scope === 'all_channels') {
        bucket.allChannelsNotificationMode = payload.mode;
        bucket.allChannelsNotificationExplicit = true;
      } else if (payload.scope === 'channel') {
        bucket.channelNotificationMode = payload.mode;
        bucket.channelNotificationExplicit = true;
      } else {
        bucket.threadNotificationMode = payload.mode;
        bucket.threadNotificationExplicit = true;
        bucket.notificationMode = payload.mode;
      }
      return updateChannelDialogNotificationsResponseSchema.parse({
        ok: true,
        notificationSettings: buildPreviewNotificationSettings(bucket),
      });
    }

    if (tail[2] === 'messages' && tail[3] && method === 'PATCH') {
      const payload = updateChannelDialogMessageRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'channel', dialogType, payload.token);
      const message = updatePreviewDialogMessage(bucket, tail[3], payload.text, state.clock);
      return updateChannelDialogMessageResponseSchema.parse({
        ok: true,
        message: decoratePreviewDialogMessageAccess(message, state.me.userId),
      });
    }

    if (tail[2] === 'messages' && tail[3] && method === 'DELETE') {
      const payload = deleteChannelDialogMessageRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'channel', dialogType, payload.token);
      deletePreviewDialogMessage(bucket, tail[3]);
      return deleteChannelDialogMessageResponseSchema.parse({
        ok: true,
        deletedMessageId: tail[3],
      });
    }

    if (tail[2] === 'messages' && tail[3] && tail[4] === 'reactions' && method === 'POST') {
      const payload = toggleChannelDialogReactionRequestSchema.parse(parseJsonBody(init));
      const bucket = getPreviewDialogBucket(state, 'channel', dialogType, payload.token);
      const message = togglePreviewDialogReaction(bucket, tail[3], payload.emoji);
      return toggleChannelDialogReactionResponseSchema.parse({
        ok: true,
        message: decoratePreviewDialogMessageAccess(message, state.me.userId),
      });
    }
  }

  return PREVIEW_NOT_HANDLED;
}

export const handleDialogPreviewRequest: PreviewRequestHandler = (context) => {
  const entity = resolvePreviewEntityRequest(context);
  if (!entity || entity.tail[0] !== 'dialog') {
    return PREVIEW_NOT_HANDLED;
  }
  if (entity.tail[1] === 'comments') {
    const { state, method, init, url } = context;
    const prefix = `${state.me.profile}:${entity.entityType}:${entity.entityId}:`;
    const restrictions = previewRestrictions.get(state) ?? new Map<string, CommentRestriction>();
    previewRestrictions.set(state, restrictions);
    const read = (userId: string): CommentRestriction => {
      const row = restrictions.get(prefix + userId) ?? {
        userId,
        displayName: null,
        kind: null,
        expiresAt: null,
        reason: '',
        revision: 0,
      };
      return row.kind === 'MUTE' &&
        row.expiresAt &&
        Date.parse(row.expiresAt) <= readPreviewClock(state.clock).getTime()
        ? { ...row, kind: null, expiresAt: null, reason: '' }
        : row;
    };
    if (entity.tail[2] === 'moderation') {
      const targetUserId = entity.tail[4] ? decodeURIComponent(entity.tail[4]) : null;
      const canManage = state.me.userId.startsWith('preview-admin');
      if (method === 'GET' && entity.tail.length === 3)
        return { canManage, restriction: cloneJson(read(state.me.userId)) };
      if (!canManage) throw new Error('Недостаточно прав администратора.');
      if (method === 'GET' && entity.tail[3] === 'restrictions') {
        const cursor = url.searchParams.get('cursor');
        const items = [...restrictions.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => read(key.slice(prefix.length)))
          .filter((row) => row.kind && (!cursor || row.userId > cursor))
          .sort((a, b) => a.userId.localeCompare(b.userId));
        return cloneJson({
          items: items.slice(0, 50),
          nextCursor: items.length > 50 ? items[49]!.userId : null,
        });
      }
      if (targetUserId && method === 'GET') return cloneJson(read(targetUserId));
      if (targetUserId && method === 'PUT') {
        const request = updateCommentRestrictionRequestSchema.parse(parseJsonBody(init));
        const current = read(targetUserId);
        if (current.revision !== request.expectedRevision)
          throw new Error('Ограничение уже изменилось. Обновите данные.');
        const source = getPreviewDialogBucket(
          state,
          entity.entityType,
          'comments',
          request.token,
        ).messages.find(
          (message) =>
            message.id === request.sourceMessageId && message.authorUserId === targetUserId,
        );
        if (!current.revision && !source) throw new Error('Комментарий автора не найден.');
        if (targetUserId === state.me.userId || source?.isAdmin)
          throw new Error('Администратора нельзя ограничивать.');
        const updated: CommentRestriction = {
          userId: targetUserId,
          displayName: source?.authorDisplayName ?? current.displayName,
          kind: request.action === 'RELEASE' ? null : request.action,
          expiresAt:
            request.action === 'MUTE'
              ? new Date(
                  readPreviewClock(state.clock).getTime() + request.durationSeconds! * 1000,
                ).toISOString()
              : null,
          reason: request.action === 'RELEASE' ? '' : request.reason,
          revision: current.revision + 1,
        };
        restrictions.set(prefix + targetUserId, updated);
        return cloneJson(updated);
      }
    }
    if (
      entity.tail[2] === 'messages' &&
      (method === 'POST' || method === 'PATCH') &&
      read(state.me.userId).kind
    )
      throw new Error('Участие в комментариях этого сообщества ограничено.');
  }
  return entity.entityType === 'chat'
    ? handleChatDialogPreviewRequest(
        context.state,
        entity.entityId,
        entity.tail,
        context.url,
        context.method,
        context.init,
      )
    : handleChannelDialogPreviewRequest(
        context.state,
        entity.entityId,
        entity.tail,
        context.url,
        context.method,
        context.init,
      );
};
