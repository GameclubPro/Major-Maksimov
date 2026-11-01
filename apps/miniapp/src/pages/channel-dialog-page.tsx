import { AppIcon as IconoirSprite } from '../components/ui/app-icon';
import type {
  ChannelDialogAttachment,
  ChannelDialogMessage,
  ChannelDialogNotificationMode,
  ChannelDialogNotificationScope,
  ChannelDialogNotificationSettings,
  ChannelDialogResponse,
  ChannelDialogType,
} from '@maxim/contracts/channel-dialog';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import {
  MAX_CHANNEL_DIALOG_ATTACHMENTS,
  MAX_CHANNEL_DIALOG_ATTACHMENTS_TOTAL_BASE64,
  MAX_CHANNEL_DIALOG_COMMENT_FILES,
  MAX_CHANNEL_DIALOG_IMAGE_BASE64_LENGTH,
  MAX_CHANNEL_DIALOG_SUGGEST_IMAGES,
} from '@maxim/contracts/channel-dialog';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Fragment,
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent as ReactChangeEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useParams, useSearchParams } from 'react-router';
import { MAX_MARKDOWN_TOOL_DEFINITIONS, type MaxMarkdownTool } from '../lib/max-markdown-tools';
import { PublicDialogUnavailableState } from '../components/public-dialog-unavailable-state';
import type { MaxRichTextEditorHandle } from '../components/max-rich-text-editor';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { isSessionExpiredApiMessage, isTerminalDialogApiMessage } from '../lib/dialog-api-error';
import {
  createChatDialogMessage,
  createChannelDialogMessage,
  deleteChatDialogMessage,
  deleteChannelDialogMessage,
  getChatDialog,
  getChannelDialog,
  updateChatDialogNotifications,
  updateChatDialogMessage,
  updateChannelDialogNotifications,
  updateChannelDialogMessage,
  toggleChannelDialogReaction,
  toggleChatDialogReaction,
} from '../lib/api/channel-dialog-client';
import type { ApiTransport } from '../lib/api/transport';
import {
  resolveSuggestionKeyboardLayout,
  type SuggestionKeyboardViewportBaseline,
} from '../lib/channel-suggestion-keyboard-layout';
import { resolveSuggestionStatus } from '../lib/channel-suggestion-status';
import { cn } from '../lib/cn';
import { resolveChannelDialogProfileCapabilities } from '../lib/channel-dialog-profile-capabilities';
import {
  commentModerationKey,
  getCommentModerationState,
} from '../lib/api/comment-moderation-client';
import { commentRestrictionLabel } from '../lib/comment-restriction';
import type { CommentModerationTarget } from '../components/comment-moderation-sheet';
import { formatDialogAttachmentSize } from '../lib/dialog-attachment-size';
import type { PreparedCommentDialogAttachment } from '../lib/dialog-attachments';
import { openFileInputPicker, resolveFileInputActivationMode } from '../lib/file-input-picker';
import type { LastEntityType } from '../lib/last-chat';
import {
  downloadMaxFile,
  maxImpact,
  maxNotify,
  maxSelectionChanged,
  openMaxBotLink,
  openMaxBotLinkAndClose,
} from '../lib/max-bridge';
import { useDialogFocusTrap } from '../lib/dialog-focus';
import { useNativeBackHandler } from '../lib/native-back';
import { useCommentTheme } from '../lib/use-comment-theme';
import { useCommentScroll } from '../lib/use-comment-scroll';
import { formatCommentDay, isSameCommentDay } from '../lib/comment-timeline';
import { toggleDialogReactionLocally } from '../lib/comment-dialog-reactions';
import { queryKeys } from '../lib/query-keys';
import { tokenizeTextLinks } from '../lib/text-links';
import { describeUserFacingError } from '../lib/user-facing-error';
import '../styles/channel-dialog-comments.css';
import '../styles/channel-dialog-image-viewer.css';
import '../styles/channel-dialog-native-comments.css';
import '../styles/channel-dialog-themes.css';

const LazyChannelDialogNotificationSheet = lazy(
  () => import('../components/channel-dialog-notification-sheet'),
);
const CommentThemeSheet = lazy(() => import('../components/comment-theme-sheet'));
const CommentCopyAction = lazy(() => import('../components/comment-copy-action'));
const CommentComposeEmojiPicker = lazy(() => import('../components/comment-compose-emoji-picker'));
const MaxRichTextEditor = lazy(async () => {
  const module = await import('../components/max-rich-text-editor');
  return { default: module.MaxRichTextEditor };
});
const MaxMarkdownPreview = lazy(async () => {
  const module = await import('../components/max-markdown-preview');
  return { default: module.MaxMarkdownPreview };
});
const LazyCommentModerationSheet = lazy(() => import('../components/comment-moderation-sheet'));

const COMMENT_REACTION_OPTIONS = [
  '👍',
  '❤️',
  '😂',
  '😮',
  '😢',
  '😡',
  '🔥',
  '👏',
  '😍',
  '🎉',
  '💯',
  '👀',
  '🤝',
  '🤔',
  '👌',
  '✅',
] as const;

const COMMENT_REACTION_PRIMARY_OPTIONS = COMMENT_REACTION_OPTIONS.slice(0, 6);
const COMMENT_REACTION_EXPANDED_OPTIONS = COMMENT_REACTION_OPTIONS.slice(6);
const COMMENT_NOTIFICATION_TOP_MARGIN_PX = 6;
const COMMENT_NOTIFICATION_MAX_NUDGE_PX = 88;
const COMMENT_DRAFT_MAX_LENGTH = 2_000;
const SOURCE_HIGHLIGHT_DURATION_MS = 1_500;
const ATTACHMENT_SELECTION_DEDUPE_MS = 2_500;
const SWIPE_REPLY_ACTIVATION_DISTANCE = 14;
const SWIPE_REPLY_TRIGGER_DISTANCE = 54;
const SWIPE_REPLY_MAX_OFFSET = 78;

type AttachmentInputKind = 'image' | 'file';
type CommentImageAlbumVariant = 'grid' | 'lead' | 'tail';

function normalizeApiError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Не удалось отправить сообщение.';
  }

  const normalized = error.message.trim();
  if (!normalized) {
    return 'Не удалось отправить сообщение.';
  }

  if (normalized.startsWith('API request failed:')) {
    const details = normalized.replace(/^API request failed:\s*\d+\s*/u, '').trim();
    return details || 'Не удалось отправить сообщение.';
  }

  return normalized;
}

function resolveDialogType(pathname: string): ChannelDialogType {
  return pathname.includes('/dialog/suggest') ? 'suggest' : 'comments';
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function buildAuthorBadge(value: string | null | undefined): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    return 'MX';
  }

  const words = normalized
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);

  if (words.length >= 2) {
    return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase();
  }

  return normalized.slice(0, 2).toUpperCase();
}

function getAuthorLabel(message: ChannelDialogMessage): string {
  return message.authorDisplayName || `Участник ${message.authorUserId}`;
}

function summarizeReplyText(value: string, maxLength = 96): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function getNotificationSettingsForScope(
  settings: ChannelDialogNotificationSettings,
  scope: ChannelDialogNotificationScope,
): { mode: ChannelDialogNotificationMode; explicit: boolean } {
  if (scope === 'all_channels') {
    return settings.allChannels;
  }
  if (scope === 'channel') {
    return settings.channel;
  }
  return settings.thread;
}

const COMMENT_IMAGE_FILE_NAME_RE = /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/iu;

function isCommentAttachmentImageLike(
  attachment:
    | Pick<ChannelDialogAttachment, 'kind' | 'mimeType' | 'fileName'>
    | Pick<PreparedCommentDialogAttachment, 'type' | 'mimeType' | 'fileName'>
    | null
    | undefined,
): boolean {
  if (!attachment) {
    return false;
  }

  const explicitKind =
    'kind' in attachment ? attachment.kind : 'type' in attachment ? attachment.type : null;
  if (explicitKind === 'image') {
    return true;
  }

  const mimeType = attachment.mimeType?.trim().toLowerCase() ?? '';
  if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml') {
    return true;
  }

  const fileName = attachment.fileName?.trim() ?? '';
  return COMMENT_IMAGE_FILE_NAME_RE.test(fileName);
}

function resolveCommentAttachmentKind(
  attachment:
    | Pick<ChannelDialogAttachment, 'kind' | 'mimeType' | 'fileName'>
    | Pick<PreparedCommentDialogAttachment, 'type' | 'mimeType' | 'fileName'>,
): 'image' | 'file' {
  return isCommentAttachmentImageLike(attachment) ? 'image' : 'file';
}

function resolveCommentAttachmentBadge(
  attachment:
    | Pick<ChannelDialogAttachment, 'mimeType' | 'fileName'>
    | Pick<PreparedCommentDialogAttachment, 'mimeType' | 'fileName'>,
): string {
  const fileName = attachment.fileName?.trim().toLowerCase() ?? '';
  const extensionMatch = fileName.match(/\.([a-z0-9]{1,8})$/iu);
  if (extensionMatch?.[1]) {
    return extensionMatch[1].slice(0, 5).toUpperCase();
  }

  const mimeType = attachment.mimeType?.trim().toLowerCase() ?? '';
  if (mimeType.startsWith('application/')) {
    return (
      mimeType.slice('application/'.length).split(/[.+-]/u)[0]?.slice(0, 5).toUpperCase() || 'FILE'
    );
  }
  if (mimeType.startsWith('text/')) {
    return 'TEXT';
  }
  if (mimeType.startsWith('audio/')) {
    return 'AUDIO';
  }

  return 'FILE';
}

function resolveCommentImageAlbumVariant(
  attachments: Pick<ChannelDialogAttachment, 'width' | 'height'>[],
): CommentImageAlbumVariant {
  if (attachments.length !== 3 && attachments.length !== 5) {
    return 'grid';
  }

  const lead = attachments[0];
  if (lead?.width && lead.height && lead.width >= lead.height) {
    return 'lead';
  }

  const tail = attachments[attachments.length - 1];
  if (tail?.width && tail.height && tail.width >= tail.height) {
    return 'tail';
  }

  return 'grid';
}

function resolveCommentAttachmentSummary(
  attachments:
    | Pick<ChannelDialogAttachment, 'kind' | 'mimeType' | 'fileName'>[]
    | Pick<PreparedCommentDialogAttachment, 'type' | 'mimeType' | 'fileName'>[]
    | null
    | undefined,
): string {
  if (!attachments?.length) {
    return '';
  }

  const imageAttachments = attachments.filter(
    (attachment) => resolveCommentAttachmentKind(attachment) === 'image',
  );
  const fileAttachments = attachments.filter(
    (attachment) => resolveCommentAttachmentKind(attachment) === 'file',
  );
  const imageCount = imageAttachments.length;

  if (imageCount > 0 && fileAttachments.length === 0) {
    if (imageCount > 1) {
      return `Фото · ${imageCount}`;
    }
    const fileName = imageAttachments[0]?.fileName?.trim();
    return fileName ? `Фото · ${fileName}` : 'Фото';
  }

  if (fileAttachments.length > 0 && imageCount === 0) {
    if (fileAttachments.length > 1) {
      return `Файлы · ${fileAttachments.length}`;
    }
    const fileName = fileAttachments[0]?.fileName?.trim();
    return fileName ? `Файл · ${fileName}` : 'Файл';
  }

  return `Вложения · ${attachments.length}`;
}

function getCommentAttachmentOpenUrl(attachment: ChannelDialogAttachment): string {
  const remoteUrl = attachment.url?.trim() ?? '';
  if (remoteUrl) {
    return remoteUrl;
  }

  return isCommentAttachmentImageLike(attachment) ? (attachment.previewUrl?.trim() ?? '') : '';
}

function getCommentAttachmentViewerUrl(attachment: ChannelDialogAttachment): string {
  return attachment.url?.trim() || attachment.previewUrl?.trim() || '';
}

function getCommentAttachmentPreviewUrl(attachment: ChannelDialogAttachment): string {
  return attachment.previewUrl?.trim() || attachment.url?.trim() || '';
}

type CommentComposeAttachment =
  | Pick<ChannelDialogAttachment, 'kind' | 'previewUrl' | 'url' | 'fileName' | 'mimeType' | 'size'>
  | Pick<PreparedCommentDialogAttachment, 'type' | 'previewUrl' | 'fileName' | 'mimeType' | 'size'>;

function getCommentComposeAttachmentPreviewUrl(attachment: CommentComposeAttachment): string {
  if ('kind' in attachment) {
    return attachment.previewUrl?.trim() || attachment.url?.trim() || '';
  }

  return attachment.previewUrl?.trim() || '';
}

function getCommentAttachmentImageStyle(
  attachment: Pick<ChannelDialogAttachment, 'width' | 'height'>,
): CSSProperties | undefined {
  if (!attachment.width || !attachment.height) {
    return undefined;
  }

  return {
    aspectRatio: `${attachment.width} / ${attachment.height}`,
  };
}

function calculateDraftAttachmentsBase64Length(
  attachments: PreparedCommentDialogAttachment[],
): number {
  return attachments.reduce((total, attachment) => total + attachment.base64.length, 0);
}

function resolveMessageWidthTone(
  message: ChannelDialogMessage,
): 'is-wide' | 'is-medium' | 'is-compact' {
  if (message.attachments.length > 0) {
    return 'is-wide';
  }

  if (message.replyTo) {
    return 'is-wide';
  }

  const normalizedText = message.text.replace(/\s+/gu, ' ').trim();
  if (normalizedText.length >= 108) {
    return 'is-wide';
  }

  if (normalizedText.length <= 56) {
    return 'is-compact';
  }

  return 'is-medium';
}

function resolveSuggestionAttachmentLabel(message: ChannelDialogMessage): string {
  if (message.hasVideo) {
    const fileName = message.videoFileName?.trim();
    return fileName ? `Видео · ${fileName}` : 'Видео приложено';
  }

  const imageCount = Math.max(
    message.imageCount ?? 0,
    message.imageFileNames?.length ?? 0,
    message.imageFileName ? 1 : 0,
  );
  if (imageCount > 1) {
    return `Фото · ${imageCount} шт.`;
  }

  const fileName = message.imageFileName?.trim();
  return fileName ? `Фото · ${fileName}` : 'Фото приложено';
}

function renderPlainTextParagraphs(text: string) {
  const normalized = text.replace(/\r\n?/gu, '\n').trim();
  if (!normalized) {
    return null;
  }

  return normalized.split(/\n{2,}/u).map((paragraph, paragraphIndex) => (
    <p key={`paragraph-${paragraphIndex}`}>
      {paragraph.split('\n').map((line, lineIndex) => (
        <Fragment key={lineIndex}>
          {lineIndex > 0 ? <br /> : null}
          {renderCommentTextLine(line, `paragraph-${paragraphIndex}-line-${lineIndex}`)}
        </Fragment>
      ))}
    </p>
  ));
}

function renderCommentTextLine(line: string, keyPrefix: string) {
  return tokenizeTextLinks(line).map((segment, index) => {
    if (segment.type === 'text') {
      return <Fragment key={`${keyPrefix}-text-${index}`}>{segment.text}</Fragment>;
    }

    return (
      <a
        key={`${keyPrefix}-link-${index}`}
        className="channel-dialog-message__link"
        href={segment.href}
        onClick={handleCommentLinkClick(segment.href)}
        onContextMenu={stopCommentLinkMouseEvent}
        onKeyDown={stopCommentLinkKeyboardEvent}
        onPointerCancel={stopCommentLinkPointerEvent}
        onPointerDown={stopCommentLinkPointerEvent}
        onPointerMove={stopCommentLinkPointerEvent}
        onPointerUp={stopCommentLinkPointerEvent}
        rel="noreferrer"
        target="_blank"
      >
        {segment.text}
      </a>
    );
  });
}

function handleCommentLinkClick(url: string) {
  return (event: ReactMouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    event.stopPropagation();
    openMaxBotLink(url);
  };
}

function stopCommentLinkMouseEvent(event: ReactMouseEvent<HTMLAnchorElement>) {
  event.stopPropagation();
}

function stopCommentLinkKeyboardEvent(event: ReactKeyboardEvent<HTMLAnchorElement>) {
  event.stopPropagation();
}

function stopCommentLinkPointerEvent(event: ReactPointerEvent<HTMLAnchorElement>) {
  event.stopPropagation();
}

function buildSwipeReplyStyle(
  preview: SwipeReplyPreview | null,
  messageId: string,
): CSSProperties | undefined {
  if (!preview || preview.messageId !== messageId) {
    return undefined;
  }

  return {
    '--channel-dialog-swipe-offset': `${preview.offset}px`,
    '--channel-dialog-swipe-progress': `${preview.progress}`,
  } as CSSProperties;
}

function buildAdminBubbleStyle(isAdmin: boolean, isOwnMessage: boolean): CSSProperties | undefined {
  if (!isAdmin) {
    return undefined;
  }

  return {
    '--channel-dialog-message-role-accent': isOwnMessage
      ? 'var(--comment-own-ink, #b8ff7a)'
      : 'var(--comment-admin, #00b7c7)',
  } as CSSProperties;
}

function buildAdminAuthorStyle(isAdmin: boolean, isOwnMessage: boolean): CSSProperties | undefined {
  if (!isAdmin) {
    return undefined;
  }

  return {
    color: isOwnMessage ? 'var(--comment-own-ink, #d9ffc2)' : 'var(--comment-admin, #007782)',
  };
}

function isGroupedWithPrevious(messages: ChannelDialogMessage[], index: number): boolean {
  const current = messages[index];
  const previous = messages[index - 1];
  if (!current || !previous) {
    return false;
  }

  if (
    current.authorUserId !== previous.authorUserId ||
    !isSameCommentDay(current.createdAt, previous.createdAt)
  ) {
    return false;
  }

  const currentTime = new Date(current.createdAt).getTime();
  const previousTime = new Date(previous.createdAt).getTime();
  if (!Number.isFinite(currentTime) || !Number.isFinite(previousTime)) {
    return true;
  }

  return currentTime - previousTime < 12 * 60 * 1_000;
}

function mergeDialogMessage(
  current: ChannelDialogMessage,
  next: ChannelDialogMessage,
): ChannelDialogMessage {
  return {
    ...current,
    ...next,
    avatarUrl: next.avatarUrl ?? current.avatarUrl ?? null,
  };
}

function updateDialogMessage(
  dialog: ChannelDialogResponse | undefined,
  message: ChannelDialogMessage,
): ChannelDialogResponse | undefined {
  if (!dialog) {
    return dialog;
  }

  const existingIndex = dialog.messages.findIndex((item) => item.id === message.id);
  if (existingIndex < 0) {
    return {
      ...dialog,
      messages: [...dialog.messages, message],
    };
  }

  return {
    ...dialog,
    messages: dialog.messages.map((item) =>
      item.id === message.id ? mergeDialogMessage(item, message) : item,
    ),
  };
}

function removeDialogMessage(
  dialog: ChannelDialogResponse | undefined,
  messageId: string,
): ChannelDialogResponse | undefined {
  if (!dialog) {
    return dialog;
  }

  return {
    ...dialog,
    messages: dialog.messages.filter((item) => item.id !== messageId),
  };
}

function DialogAvatar({
  avatarUrl,
  label,
  onClick,
  disabled = false,
}: {
  avatarUrl: string | null | undefined;
  label: string | null | undefined;
  onClick?: (() => void) | null;
  disabled?: boolean;
}) {
  const [imageBroken, setImageBroken] = useState(false);
  const resolvedAvatarUrl = avatarUrl?.trim() ?? '';
  const showImage = resolvedAvatarUrl.length > 0 && !imageBroken;
  const normalizedLabel = label?.trim() || 'пользователя';
  const avatarContent = showImage ? (
    <img src={resolvedAvatarUrl} alt="" loading="lazy" onError={() => setImageBroken(true)} />
  ) : (
    buildAuthorBadge(label)
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={cn('channel-dialog-message__avatar', 'is-clickable', showImage && 'has-image')}
        aria-label={`Открыть профиль ${normalizedLabel}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onClick();
        }}
        disabled={disabled}
      >
        {avatarContent}
      </button>
    );
  }

  return (
    <div className={cn('channel-dialog-message__avatar', showImage && 'has-image')}>
      {avatarContent}
    </div>
  );
}

function CommentAttachmentGlyph({ kind }: { kind: 'image' | 'file' }) {
  return kind === 'image' ? (
    <IconoirSprite variant="iconoir" icon="Camera" aria-hidden focusable="false" />
  ) : (
    <IconoirSprite variant="iconoir" icon="Attachment" aria-hidden focusable="false" />
  );
}

function CommentMessageAttachments({
  attachments,
  onOpenImageAlbum,
}: {
  attachments: ChannelDialogAttachment[];
  onOpenImageAlbum?: (attachments: ChannelDialogAttachment[], index: number) => void;
}) {
  if (!attachments.length) {
    return null;
  }

  const imageAttachments = attachments.filter(
    (attachment) => resolveCommentAttachmentKind(attachment) === 'image',
  );
  const fileAttachments = attachments.filter(
    (attachment) => resolveCommentAttachmentKind(attachment) === 'file',
  );
  const albumVariant = resolveCommentImageAlbumVariant(imageAttachments);

  return (
    <div className="channel-dialog-message__attachments">
      {imageAttachments.length > 0 ? (
        <div
          className={cn(
            'channel-dialog-message__image-grid',
            imageAttachments.length === 1 && 'is-single',
            `is-count-${Math.min(imageAttachments.length, MAX_CHANNEL_DIALOG_ATTACHMENTS)}`,
            albumVariant === 'lead' && 'has-lead-image',
            albumVariant === 'tail' && 'has-tail-image',
          )}
        >
          {imageAttachments.map((attachment, attachmentIndex) => {
            const viewerUrl = getCommentAttachmentViewerUrl(attachment);
            const previewUrl = getCommentAttachmentPreviewUrl(attachment);
            const fileName = attachment.fileName?.trim() || `Фото ${attachmentIndex + 1}`;

            return (
              <button
                key={`${fileName}-${attachmentIndex}`}
                type="button"
                className="channel-dialog-message__image-tile"
                style={getCommentAttachmentImageStyle(attachment)}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  if (viewerUrl) {
                    onOpenImageAlbum?.(imageAttachments, attachmentIndex);
                  }
                }}
                disabled={!viewerUrl}
                aria-label={fileName}
              >
                {previewUrl ? (
                  <img src={previewUrl} alt="" loading="lazy" />
                ) : (
                  <CommentAttachmentGlyph kind="image" />
                )}
                <span className="channel-dialog-message__image-tile-glow" aria-hidden />
              </button>
            );
          })}
        </div>
      ) : null}

      {fileAttachments.length > 0 ? (
        <div className="channel-dialog-message__file-list">
          {fileAttachments.map((attachment, attachmentIndex) => {
            const url = getCommentAttachmentOpenUrl(attachment);
            const fileName = attachment.fileName?.trim() || `Файл ${attachmentIndex + 1}`;
            const badge = resolveCommentAttachmentBadge(attachment);
            const meta = [
              attachment.size ? formatDialogAttachmentSize(attachment.size) : null,
              url ? 'Открыть' : null,
            ]
              .filter(Boolean)
              .join(' · ');

            return (
              <button
                key={`${fileName}-${attachmentIndex}`}
                type="button"
                className="channel-dialog-message__file-pill"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  if (url) {
                    void downloadMaxFile(url, fileName);
                  }
                }}
                disabled={!url}
                aria-label={fileName}
              >
                <span className="channel-dialog-message__file-pill-icon" aria-hidden>
                  <CommentAttachmentGlyph kind="file" />
                </span>
                <span className="channel-dialog-message__file-pill-copy">
                  <strong>{fileName}</strong>
                  <span className="channel-dialog-message__file-pill-meta">
                    <b>{badge}</b>
                    <span>{meta || 'Файл'}</span>
                  </span>
                </span>
                <span className="channel-dialog-message__file-pill-arrow" aria-hidden>
                  <SendArrowIcon />
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function CommentComposeImageStrip({
  attachments,
  removable = false,
  onRemove,
}: {
  attachments: CommentComposeAttachment[];
  removable?: boolean;
  onRemove?: (index: number) => void;
}) {
  if (!attachments.length) {
    return null;
  }

  return (
    <div
      className="channel-dialog-compose__image-strip"
      role="list"
      aria-label={`Фото: ${attachments.length}`}
    >
      {attachments.map((attachment, attachmentIndex) => {
        const previewUrl = getCommentComposeAttachmentPreviewUrl(attachment);
        const fileName = attachment.fileName?.trim() || `Фото ${attachmentIndex + 1}`;

        return (
          <div
            key={`${fileName}-${attachmentIndex}`}
            className="channel-dialog-compose__image-chip"
            role="listitem"
            aria-label={fileName}
          >
            {previewUrl ? (
              <img src={previewUrl} alt={fileName} loading="lazy" />
            ) : (
              <CommentAttachmentGlyph kind="image" />
            )}

            {removable && onRemove ? (
              <button
                type="button"
                className="channel-dialog-compose__image-chip-dismiss"
                onClick={() => onRemove(attachmentIndex)}
                aria-label={`Убрать ${fileName}`}
              >
                <CloseIcon />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function CommentComposeFileList({
  attachments,
  removable = false,
  onRemove,
}: {
  attachments: CommentComposeAttachment[];
  removable?: boolean;
  onRemove?: (index: number) => void;
}) {
  if (!attachments.length) {
    return null;
  }

  return attachments.map((attachment, attachmentIndex) => {
    const fileName = attachment.fileName?.trim() || `Файл ${attachmentIndex + 1}`;

    return (
      <div
        key={`${fileName}-${attachmentIndex}`}
        className="channel-dialog-compose__attachment is-file"
      >
        <div className="channel-dialog-compose__attachment-preview" aria-hidden>
          <CommentAttachmentGlyph kind="file" />
        </div>
        <div className="channel-dialog-compose__attachment-copy">
          <span>
            {[fileName, attachment.size ? formatDialogAttachmentSize(attachment.size) : null]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        {removable && onRemove ? (
          <button
            type="button"
            className="channel-dialog-compose__attachment-dismiss"
            onClick={() => onRemove(attachmentIndex)}
            aria-label={`Убрать ${fileName}`}
          >
            <CloseIcon />
          </button>
        ) : null}
      </div>
    );
  });
}

function SuggestComposeImageGrid({
  attachments,
  preparingCount = 0,
  busy = false,
  onRemove,
}: {
  attachments: CommentComposeAttachment[];
  preparingCount?: number;
  busy?: boolean;
  onRemove: (index: number) => void;
}) {
  const cappedPreparingCount = Math.max(
    0,
    Math.min(preparingCount, MAX_CHANNEL_DIALOG_SUGGEST_IMAGES - attachments.length),
  );

  if (!attachments.length && cappedPreparingCount <= 0) {
    return null;
  }
  const visibleCount = Math.min(
    attachments.length + cappedPreparingCount,
    MAX_CHANNEL_DIALOG_SUGGEST_IMAGES,
  );

  return (
    <div
      className={cn(
        'channel-suggest-composer__image-grid',
        `is-count-${visibleCount}`,
        busy && 'is-busy',
      )}
      role="list"
      aria-label={`Фото: ${visibleCount}`}
    >
      {attachments.map((attachment, attachmentIndex) => {
        const previewUrl = getCommentComposeAttachmentPreviewUrl(attachment);
        const fileName = attachment.fileName?.trim() || `Фото ${attachmentIndex + 1}`;

        return (
          <div
            key={`${fileName}-${attachmentIndex}`}
            className={cn('channel-suggest-composer__image-tile', busy && 'is-uploading')}
            role="listitem"
            aria-label={fileName}
          >
            {previewUrl ? (
              <img src={previewUrl} alt={fileName} loading="lazy" />
            ) : (
              <CommentAttachmentGlyph kind="image" />
            )}

            <button
              type="button"
              className="channel-suggest-composer__image-remove"
              onClick={() => onRemove(attachmentIndex)}
              aria-label={`Убрать ${fileName}`}
            >
              <CloseIcon />
            </button>
          </div>
        );
      })}
      {Array.from({ length: cappedPreparingCount }, (_, index) => (
        <div
          key={`preparing-${index}`}
          className="channel-suggest-composer__image-tile is-loading"
          role="listitem"
          aria-label="Готовим фото"
        >
          <span className="channel-suggest-composer__image-loader" aria-hidden>
            <IconoirSprite variant="iconoir" icon="Camera" aria-hidden focusable="false" />
          </span>
        </div>
      ))}
    </div>
  );
}

function SuggestionRequirements({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n{2,}/u)
    .map((line) => line.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return null;
  }

  return (
    <section className="channel-suggest-requirements" aria-label="Требования">
      <span className="channel-suggest-requirements__label">Требования</span>
      <div className="channel-suggest-requirements__text">
        {paragraphs.map((paragraph, index) => (
          <p key={`${paragraph}-${index}`}>{paragraph}</p>
        ))}
      </div>
    </section>
  );
}

function SuggestMarkdownToolIcon({ tool }: { tool: MaxMarkdownTool }) {
  switch (tool) {
    case 'heading':
      return <IconoirSprite variant="iconoir" icon="Type" aria-hidden focusable="false" />;
    case 'bold':
      return <IconoirSprite variant="iconoir" icon="Bold" aria-hidden focusable="false" />;
    case 'italic':
      return <IconoirSprite variant="iconoir" icon="Italic" aria-hidden focusable="false" />;
    case 'underline':
      return <IconoirSprite variant="iconoir" icon="Underline" aria-hidden focusable="false" />;
    case 'strike':
      return <IconoirSprite variant="iconoir" icon="Strikethrough" aria-hidden focusable="false" />;
    case 'code':
      return <IconoirSprite variant="iconoir" icon="Code" aria-hidden focusable="false" />;
    case 'link':
      return <IconoirSprite variant="iconoir" icon="Link" aria-hidden focusable="false" />;
  }
}

function SendArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M4.5 10H15.5"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10.8 5.3L15.5 10L10.8 14.7"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path d="M5.5 5.5L14.5 14.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M14.5 5.5L5.5 14.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M11.8 4.4L6.2 10L11.8 15.6"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ReplyArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M7.6 6.1L4.3 9.4L7.6 12.7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 9.4H11.2C13.6 9.4 15.5 11.3 15.5 13.7V14.3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M4.7 15.3L7.2 14.7L14.6 7.3C15 6.9 15 6.2 14.6 5.8L13.9 5.1C13.5 4.7 12.8 4.7 12.4 5.1L5 12.5L4.7 15.3Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11.6 5.9L13.8 8.1"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M5.8 6.4L6.4 14.2C6.5 15.1 7.2 15.8 8.1 15.8H11.9C12.8 15.8 13.5 15.1 13.6 14.2L14.2 6.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M4.8 5.2H15.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path
        d="M8.1 5.2V4.6C8.1 4.2 8.4 3.9 8.8 3.9H11.2C11.6 3.9 11.9 4.2 11.9 4.6V5.2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8.7 8.3V13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M11.3 8.3V13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

type DialogViewModel = {
  title: string;
  placeholder: string;
};

type ReactionPopoverLayout = {
  left: number;
  top: number;
  width: number;
  placement: 'above' | 'below';
};

type CommentImageViewerState = {
  attachments: ChannelDialogAttachment[];
  activeIndex: number;
};

type SwipeReplyPreview = {
  messageId: string;
  offset: number;
  progress: number;
  armed: boolean;
};

type EditRestoreState = {
  draft: string;
  replyToMessageId: string | null;
  draftAttachments: PreparedCommentDialogAttachment[];
};

type SwipeReplyGesture = {
  messageId: string;
  startX: number;
  startY: number;
  isOwn: boolean;
  engaged: boolean;
  armed: boolean;
};

type CommentDraftAttachment = PreparedCommentDialogAttachment;

type PreparingAttachmentState = {
  kind: AttachmentInputKind;
  total: number;
  done: number;
};

type TerminalDialogErrorState = {
  entityType: LastEntityType;
  chatId: string;
  dialogType: ChannelDialogType;
  token: string;
  message: string;
};

function buildViewModel(dialogType: ChannelDialogType): DialogViewModel {
  if (dialogType === 'suggest') {
    return {
      title: 'Предложить пост',
      placeholder: 'Текст идеи или подпись к фото',
    };
  }

  return {
    title: 'Комментарии',
    placeholder: 'Комментарий',
  };
}

function resolveDialogEntityType(pathname: string): LastEntityType {
  return pathname.includes('/channel/') ? 'channel' : 'chat';
}

export function ChannelDialogPage({
  api,
  profile,
  userId: currentUserId,
}: {
  api: ApiTransport;
  profile: MiniappProfile;
  userId: string;
}) {
  const { chatId = '' } = useParams();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token')?.trim() ?? '';
  const dialogType = resolveDialogType(location.pathname);
  const { theme: commentTheme, selectTheme: selectCommentTheme } = useCommentTheme(
    dialogType === 'comments',
  );
  const entityType = resolveDialogEntityType(location.pathname);
  const { canManageCommentNotifications, canUploadCommentAttachments } =
    resolveChannelDialogProfileCapabilities(profile);
  const viewModel = useMemo(() => buildViewModel(dialogType), [dialogType]);
  const [draft, setDraft] = useState('');
  const [draftAttachments, setDraftAttachments] = useState<CommentDraftAttachment[]>([]);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editRestoreState, setEditRestoreState] = useState<EditRestoreState | null>(null);
  const [replyToMessageId, setReplyToMessageId] = useState<string | null>(null);
  const [isReactionPickerExpanded, setIsReactionPickerExpanded] = useState(false);
  const [isComposeEmojiOpen, setIsComposeEmojiOpen] = useState(false);
  const [isComposeToolsOpen, setIsComposeToolsOpen] = useState(false);
  const [isNotificationSettingsOpen, setIsNotificationSettingsOpen] = useState(false);
  const [isThemeSettingsOpen, setIsThemeSettingsOpen] = useState(false);
  const [isCommentToolsOpen, setIsCommentToolsOpen] = useState(false);
  const [moderationSheet, setModerationSheet] = useState<{
    target: CommentModerationTarget | null;
  } | null>(null);
  const [notificationDraftMode, setNotificationDraftMode] =
    useState<ChannelDialogNotificationMode>('off');
  const [notificationDraftScope, setNotificationDraftScope] =
    useState<ChannelDialogNotificationScope>('thread');
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [terminalDialogErrorState, setTerminalDialogErrorState] =
    useState<TerminalDialogErrorState | null>(null);
  const [swipeReplyPreview, setSwipeReplyPreview] = useState<SwipeReplyPreview | null>(null);
  const [preparingAttachmentState, setPreparingAttachmentState] =
    useState<PreparingAttachmentState | null>(null);
  const [imageViewer, setImageViewer] = useState<CommentImageViewerState | null>(null);
  const [reactionPopoverLayout, setReactionPopoverLayout] = useState<ReactionPopoverLayout | null>(
    null,
  );
  const [commentsNotificationTopNudge, setCommentsNotificationTopNudge] = useState(0);
  const composeFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const composeToolsToggleRef = useRef<HTMLButtonElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const suggestComposerRef = useRef<HTMLElement | null>(null);
  const suggestBarRef = useRef<HTMLDivElement | null>(null);
  const suggestionKeyboardBaselineRef = useRef<SuggestionKeyboardViewportBaseline | null>(null);
  const themeToggleRef = useRef<HTMLButtonElement | null>(null);
  const commentToolsPanelRef = useRef<HTMLElement | null>(null);
  const commentToolsCloseRef = useRef<HTMLButtonElement | null>(null);
  const imageViewerPanelRef = useRef<HTMLElement | null>(null);
  const imageViewerCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const commentsNotificationTopNudgeRef = useRef(0);
  const reactionPopoverRef = useRef<HTMLDivElement | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const pressTimerRef = useRef<number | null>(null);
  const pressPointRef = useRef<{ x: number; y: number } | null>(null);
  const swipeReplyGestureRef = useRef<SwipeReplyGesture | null>(null);
  const attachmentPreparationGenerationRef = useRef(0);
  const attachmentInputWatchCleanupRef = useRef<Record<AttachmentInputKind, (() => void) | null>>({
    image: null,
    file: null,
  });
  const lastHandledAttachmentSelectionRef = useRef<Record<AttachmentInputKind, string | null>>({
    image: null,
    file: null,
  });
  const recentAttachmentSelectionRef = useRef<
    Record<AttachmentInputKind, { signature: string; handledAt: number } | null>
  >({
    image: null,
    file: null,
  });
  const messageNodeRefs = useRef(new Map<string, HTMLElement>());
  const messageLayoutContextRef = useRef<string | null>(null);
  const messageRectsRef = useRef(new Map<string, { left: number; top: number }>());
  const richTextEditorRef = useRef<MaxRichTextEditorHandle | null>(null);
  const ignoreNextBubbleClickRef = useRef(false);
  const queryClient = useQueryClient();
  const moderationToggleRef = useRef<HTMLButtonElement | null>(null);
  const { pushToast } = useToast();
  const fileInputActivationMode = resolveFileInputActivationMode(
    typeof document === 'undefined' ? undefined : document.documentElement.dataset.maxPlatform,
  );
  const useNativeTapFileInputs = fileInputActivationMode === 'native-tap';

  const dialogQueryKey = queryKeys.entityDialog(entityType, chatId, dialogType, token);
  const terminalDialogError =
    terminalDialogErrorState?.entityType === entityType &&
    terminalDialogErrorState.chatId === chatId &&
    terminalDialogErrorState.dialogType === dialogType &&
    terminalDialogErrorState.token === token
      ? terminalDialogErrorState.message
      : null;
  const shouldLoadDialog = Boolean(chatId && token) && terminalDialogError === null;

  const dialogQuery = useQuery({
    queryKey: dialogQueryKey,
    queryFn: ({ signal }) =>
      entityType === 'channel'
        ? getChannelDialog(api, chatId, dialogType, token, { signal })
        : getChatDialog(api, chatId, dialogType, token, { signal }),
    enabled: shouldLoadDialog,
    retry: (failureCount, error) =>
      !isTerminalDialogApiMessage(normalizeApiError(error)) && failureCount < 1,
    refetchOnWindowFocus: terminalDialogError === null,
    retryOnMount: terminalDialogError === null,
    refetchInterval: (query) => {
      const message = query.state.error ? normalizeApiError(query.state.error) : '';
      if (message && isTerminalDialogApiMessage(message)) {
        return false;
      }

      return 8_000;
    },
  });

  const moderationContext = { api, profile, entityType, chatId, token };
  const moderationQuery = useQuery({
    queryKey: commentModerationKey(moderationContext),
    queryFn: ({ signal }) => getCommentModerationState(moderationContext, signal),
    enabled: shouldLoadDialog && dialogType === 'comments' && dialogQuery.isSuccess,
    retry: false,
    refetchInterval: 8_000,
  });
  const commentRestriction = moderationQuery.data?.restriction;
  const commentBlocked = dialogType === 'comments' && Boolean(commentRestriction?.kind);

  useEffect(() => {
    setModerationSheet(null);
  }, [profile, entityType, chatId, token]);

  useEffect(() => {
    if (terminalDialogError) {
      return;
    }

    const message = dialogQuery.error ? normalizeApiError(dialogQuery.error) : '';
    if (!message || !isTerminalDialogApiMessage(message)) {
      return;
    }

    setTerminalDialogErrorState({ entityType, chatId, dialogType, token, message });
    void queryClient.cancelQueries({ queryKey: dialogQueryKey });
  }, [
    chatId,
    dialogQuery.error,
    dialogQueryKey,
    dialogType,
    entityType,
    queryClient,
    terminalDialogError,
    token,
  ]);

  useEffect(() => {
    if (!imageViewer) {
      return undefined;
    }

    const { body, documentElement } = document;
    const previousBodyOverflow = body.style.overflow;
    const previousDocumentOverflow = documentElement.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeCommentImageAlbum();
        return;
      }

      if (event.key === 'ArrowLeft') {
        showPreviousCommentImage();
      }

      if (event.key === 'ArrowRight') {
        showNextCommentImage();
      }
    };

    body.style.overflow = 'hidden';
    documentElement.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      body.style.overflow = previousBodyOverflow;
      documentElement.style.overflow = previousDocumentOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [imageViewer]);

  const messages = dialogQuery.data?.messages ?? [];
  const {
    viewportRef: scrollViewportRef,
    listRef: commentListRef,
    isNearBottom,
    firstUnreadMessageId,
    setFirstUnreadMessageId,
    handleScroll: handleBodyScroll,
    scrollToLatest,
  } = useCommentScroll(
    `${entityType}:${chatId}:${dialogType}:${token}`,
    messages,
    dialogType === 'comments' && dialogQuery.isSuccess,
  );
  const introText = dialogQuery.data?.introText?.trim() ?? '';
  const notificationSettings = dialogQuery.data?.notificationSettings ?? {
    mode: 'off' as const,
    canUseAll: true,
    scope: 'thread' as const,
    thread: {
      mode: 'off' as const,
      explicit: false,
    },
    channel: {
      mode: 'off' as const,
      explicit: false,
    },
    allChannels: {
      mode: 'off' as const,
      explicit: false,
    },
  };
  const notificationMode = notificationSettings.mode;
  const notificationScope = notificationSettings.scope;
  const canUseAllNotifications =
    notificationSettings.canUseAll === true || notificationMode === 'all';
  const notificationAvailableChannelCount = notificationSettings.availableChannelCount ?? 0;
  const messageIdSet = useMemo(() => new Set(messages.map((message) => message.id)), [messages]);
  const activeMessage = useMemo(
    () => messages.find((message) => message.id === activeMessageId) ?? null,
    [activeMessageId, messages],
  );
  const editingMessage = useMemo(
    () => messages.find((message) => message.id === editingMessageId) ?? null,
    [editingMessageId, messages],
  );
  const replyTarget = useMemo(
    () => messages.find((message) => message.id === replyToMessageId) ?? null,
    [messages, replyToMessageId],
  );
  const draftLength = draft.length;
  const draftAttachmentCount = draftAttachments.length;
  const editingAttachmentCount = editingMessage?.attachments.length ?? 0;
  const isPreparingAttachment = preparingAttachmentState !== null;
  const showComposeMeta =
    isPreparingAttachment ||
    draftLength >= COMMENT_DRAFT_MAX_LENGTH * 0.9 ||
    draftAttachmentCount > 0 ||
    editingAttachmentCount > 0;
  const canSubmitMessage =
    dialogQuery.isSuccess &&
    !isPreparingAttachment &&
    (draft.trim().length > 0 ||
      (canUploadCommentAttachments && draftAttachmentCount > 0) ||
      editingAttachmentCount > 0);
  const activeMessageIsOwn = activeMessage ? currentUserId === activeMessage.authorUserId : false;
  const unreadStartIndex = useMemo(
    () =>
      firstUnreadMessageId
        ? messages.findIndex((message) => message.id === firstUnreadMessageId)
        : -1,
    [firstUnreadMessageId, messages],
  );
  const unreadCount = unreadStartIndex >= 0 ? messages.length - unreadStartIndex : 0;
  const showJumpToLatest = messages.length > 0 && !isNearBottom;
  const draftAttachmentSummary = useMemo(
    () =>
      resolveCommentAttachmentSummary(
        draftAttachments.map((attachment) => ({
          kind: attachment.type,
          mimeType: attachment.mimeType,
          fileName: attachment.fileName,
        })),
      ),
    [draftAttachments],
  );
  const editingAttachmentSummary = useMemo(
    () => resolveCommentAttachmentSummary(editingMessage?.attachments),
    [editingMessage?.attachments],
  );
  const draftImageAttachments = useMemo(
    () =>
      draftAttachments.filter((attachment) => resolveCommentAttachmentKind(attachment) === 'image'),
    [draftAttachments],
  );
  const draftFileAttachments = useMemo(
    () =>
      draftAttachments.filter((attachment) => resolveCommentAttachmentKind(attachment) === 'file'),
    [draftAttachments],
  );
  const editingImageAttachments = useMemo(
    () =>
      (editingMessage?.attachments ?? []).filter(
        (attachment) => resolveCommentAttachmentKind(attachment) === 'image',
      ),
    [editingMessage?.attachments],
  );
  const editingFileAttachments = useMemo(
    () =>
      (editingMessage?.attachments ?? []).filter(
        (attachment) => resolveCommentAttachmentKind(attachment) === 'file',
      ),
    [editingMessage?.attachments],
  );
  const suggestPreparingImageSlots =
    dialogType === 'suggest' && preparingAttachmentState?.kind === 'image'
      ? preparingAttachmentState.total
      : 0;
  const suggestPreparingImageLabel =
    dialogType === 'suggest' && preparingAttachmentState?.kind === 'image'
      ? `Готовим ${Math.min(preparingAttachmentState.done + 1, preparingAttachmentState.total)}/${preparingAttachmentState.total}`
      : null;
  const composeMetaLabel = isPreparingAttachment
    ? dialogType === 'suggest'
      ? suggestPreparingImageLabel || 'Готовим фото'
      : 'Готовим вложения'
    : editingMessage
      ? editingAttachmentSummary
      : draftAttachmentSummary;
  const activeViewerAttachment = imageViewer?.attachments[imageViewer.activeIndex] ?? null;
  const activeViewerImageSrc = activeViewerAttachment
    ? getCommentAttachmentViewerUrl(activeViewerAttachment)
    : '';

  useDialogFocusTrap(Boolean(imageViewer), imageViewerPanelRef, imageViewerCloseButtonRef);
  useDialogFocusTrap(Boolean(activeMessage), reactionPopoverRef, reactionPopoverRef);
  useDialogFocusTrap(
    isCommentToolsOpen,
    commentToolsPanelRef,
    commentToolsCloseRef,
    themeToggleRef,
  );

  const clearMessagePress = () => {
    if (pressTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(pressTimerRef.current);
    }
    pressTimerRef.current = null;
    pressPointRef.current = null;
  };

  const clearSwipeReplyGesture = () => {
    swipeReplyGestureRef.current = null;
    setSwipeReplyPreview(null);
  };

  const openCommentImageAlbum = (
    attachments: ChannelDialogAttachment[],
    requestedIndex: number,
  ) => {
    const viewerAttachments = attachments.filter((attachment) =>
      Boolean(getCommentAttachmentViewerUrl(attachment)),
    );
    if (viewerAttachments.length === 0) {
      return;
    }

    const requestedAttachment = attachments[requestedIndex] ?? null;
    const activeIndex = requestedAttachment
      ? Math.max(
          0,
          viewerAttachments.findIndex((attachment) => attachment === requestedAttachment),
        )
      : 0;

    setActiveMessageId(null);
    setIsComposeEmojiOpen(false);
    setIsNotificationSettingsOpen(false);
    setImageViewer({
      attachments: viewerAttachments,
      activeIndex,
    });
  };

  const closeCommentImageAlbum = () => {
    setImageViewer(null);
  };

  const stepCommentImageAlbum = (direction: -1 | 1) => {
    setImageViewer((current) => {
      if (!current || current.attachments.length <= 1) {
        return current;
      }

      const nextIndex =
        (current.activeIndex + direction + current.attachments.length) % current.attachments.length;

      return {
        ...current,
        activeIndex: nextIndex,
      };
    });
  };

  const showPreviousCommentImage = () => {
    stepCommentImageAlbum(-1);
  };

  const showNextCommentImage = () => {
    stepCommentImageAlbum(1);
  };

  const clearSourceHighlight = () => {
    if (highlightTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = null;
    setHighlightedMessageId(null);
  };

  const resetAttachmentPickers = () => {
    attachmentInputWatchCleanupRef.current.image?.();
    attachmentInputWatchCleanupRef.current.file?.();
    attachmentInputWatchCleanupRef.current.image = null;
    attachmentInputWatchCleanupRef.current.file = null;
    lastHandledAttachmentSelectionRef.current.image = null;
    lastHandledAttachmentSelectionRef.current.file = null;
    if (imageInputRef.current) {
      imageInputRef.current.value = '';
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const flashSourceHighlight = (messageId: string) => {
    if (typeof window === 'undefined') {
      setHighlightedMessageId(messageId);
      return;
    }

    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }

    setHighlightedMessageId(messageId);
    highlightTimerRef.current = window.setTimeout(() => {
      highlightTimerRef.current = null;
      setHighlightedMessageId((current) => (current === messageId ? null : current));
    }, SOURCE_HIGHLIGHT_DURATION_MS);
  };

  const dismissMessageActions = () => {
    setActiveMessageId(null);
    setIsReactionPickerExpanded(false);
    setReactionPopoverLayout(null);
    clearSwipeReplyGesture();
  };

  const handleComposeEmojiInsert = (emoji: string) => {
    if (sendMutation.isPending || updateMutation.isPending) return;
    const field = composeFieldRef.current;

    setDraft((current) => {
      const selectionStart =
        field && field.value === current
          ? (field.selectionStart ?? current.length)
          : current.length;
      const selectionEnd =
        field && field.value === current ? (field.selectionEnd ?? selectionStart) : selectionStart;
      const remainingLength =
        COMMENT_DRAFT_MAX_LENGTH - (current.length - (selectionEnd - selectionStart));

      if (remainingLength < emoji.length) {
        return current;
      }

      const nextDraft =
        current.slice(0, selectionStart) +
        emoji +
        current.slice(selectionEnd, COMMENT_DRAFT_MAX_LENGTH);

      requestAnimationFrame(() => {
        const nextField = composeFieldRef.current;
        if (!nextField) {
          return;
        }

        const nextSelection = selectionStart + emoji.length;
        nextField.setSelectionRange(nextSelection, nextSelection);
      });

      return nextDraft;
    });

    maxSelectionChanged();
  };

  const cancelAttachmentPreparation = () => {
    attachmentPreparationGenerationRef.current += 1;
    setPreparingAttachmentState(null);
  };

  const cancelEditing = (options?: { restoreDraft?: boolean }) => {
    cancelAttachmentPreparation();
    if (options?.restoreDraft && editRestoreState) {
      setDraft(editRestoreState.draft);
      setReplyToMessageId(editRestoreState.replyToMessageId);
      setDraftAttachments(editRestoreState.draftAttachments);
    } else {
      setDraft('');
      setReplyToMessageId(null);
      setDraftAttachments([]);
    }

    setEditingMessageId(null);
    setEditRestoreState(null);
    setIsComposeEmojiOpen(false);
    resetAttachmentPickers();
  };

  useNativeBackHandler(
    () => {
      closeCommentImageAlbum();
      return true;
    },
    { enabled: Boolean(imageViewer), priority: 720 },
  );

  useNativeBackHandler(
    () => {
      dismissMessageActions();
      return true;
    },
    { enabled: Boolean(activeMessageId), priority: 630 },
  );

  useNativeBackHandler(
    () => {
      setIsComposeEmojiOpen(false);
      return true;
    },
    { enabled: isComposeEmojiOpen, priority: 620 },
  );

  const closeComposeTools = () => {
    setIsComposeToolsOpen(false);
    setIsComposeEmojiOpen(false);
    requestAnimationFrame(() => composeToolsToggleRef.current?.focus({ preventScroll: true }));
  };

  useNativeBackHandler(
    () => {
      closeComposeTools();
      return true;
    },
    { enabled: isComposeToolsOpen, priority: 615 },
  );

  useNativeBackHandler(
    () => {
      setIsNotificationSettingsOpen(false);
      return true;
    },
    { enabled: canManageCommentNotifications && isNotificationSettingsOpen, priority: 625 },
  );

  useNativeBackHandler(
    () => {
      setIsThemeSettingsOpen(false);
      return true;
    },
    { enabled: isThemeSettingsOpen, priority: 626 },
  );

  useNativeBackHandler(
    () => {
      setIsCommentToolsOpen(false);
      return true;
    },
    { enabled: isCommentToolsOpen, priority: 624 },
  );

  useEffect(() => {
    if (!isCommentToolsOpen) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setIsCommentToolsOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isCommentToolsOpen]);

  useEffect(() => {
    if (canManageCommentNotifications) {
      return;
    }
    setIsNotificationSettingsOpen(false);
  }, [canManageCommentNotifications]);

  useLayoutEffect(() => {
    cancelAttachmentPreparation();
    resetAttachmentPickers();
    return () => {
      attachmentPreparationGenerationRef.current += 1;
    };
  }, [
    api,
    currentUserId,
    profile,
    entityType,
    chatId,
    dialogType,
    token,
    canUploadCommentAttachments,
  ]);

  useEffect(() => {
    if (canUploadCommentAttachments) {
      return;
    }
    setDraftAttachments((current) => (current.length > 0 ? [] : current));
    setPreparingAttachmentState(null);
  }, [canUploadCommentAttachments]);

  useNativeBackHandler(
    () => {
      if (!updateMutation.isPending) cancelEditing({ restoreDraft: true });
      return true;
    },
    { enabled: Boolean(editingMessage), priority: 610 },
  );

  useNativeBackHandler(
    () => {
      setReplyToMessageId(null);
      return true;
    },
    { enabled: Boolean(replyTarget), priority: 600 },
  );

  useEffect(() => {
    clearMessagePress();
    clearSwipeReplyGesture();
    clearSourceHighlight();
    setActiveMessageId(null);
    setEditingMessageId(null);
    setEditRestoreState(null);
    setReplyToMessageId(null);
    setIsReactionPickerExpanded(false);
    setFirstUnreadMessageId(null);
    setTerminalDialogErrorState(null);
    setReactionPopoverLayout(null);
    setIsThemeSettingsOpen(false);
    setIsComposeToolsOpen(false);
    setIsComposeEmojiOpen(false);
    setDraft('');
    setDraftAttachments([]);
    setPreparingAttachmentState(null);
    messageNodeRefs.current.clear();
    messageLayoutContextRef.current = null;
    messageRectsRef.current.clear();
    ignoreNextBubbleClickRef.current = false;
    resetAttachmentPickers();
  }, [chatId, dialogType, entityType, token]);

  useEffect(() => {
    const field = composeFieldRef.current;
    if (!field) {
      return;
    }

    field.style.height = '0px';
    const minHeight = dialogType === 'suggest' ? 118 : 46;
    const maxHeight = dialogType === 'suggest' ? 240 : 132;
    const nextHeight = Math.max(minHeight, Math.min(field.scrollHeight, maxHeight));
    field.style.height = `${nextHeight}px`;
  }, [draft, editingMessage, replyTarget, draftAttachments.length, dialogType]);

  useLayoutEffect(() => {
    const field = composeFieldRef.current;
    if (!field || dialogType !== 'comments') return;
    const keepEndCaretVisible = () => {
      if (
        document.activeElement === field &&
        field.selectionStart === field.selectionEnd &&
        field.selectionEnd === field.value.length
      ) {
        field.scrollTop = field.scrollHeight;
      }
    };
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(keepEndCaretVisible);
    observer?.observe(field);
    window.addEventListener('resize', keepEndCaretVisible);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', keepEndCaretVisible);
    };
  }, [dialogType, dialogQuery.isSuccess]);

  useEffect(
    () => () => {
      attachmentInputWatchCleanupRef.current.image?.();
      attachmentInputWatchCleanupRef.current.file?.();
      attachmentInputWatchCleanupRef.current.image = null;
      attachmentInputWatchCleanupRef.current.file = null;
      if (highlightTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(highlightTimerRef.current);
      }
      highlightTimerRef.current = null;
      if (pressTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(pressTimerRef.current);
      }
      pressTimerRef.current = null;
      pressPointRef.current = null;
      swipeReplyGestureRef.current = null;
    },
    [],
  );

  useLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const currentLayoutContext = `${location.pathname}${location.search}`;
    const nextRects = new Map<string, { left: number; top: number }>();
    for (const [messageId, node] of messageNodeRefs.current.entries()) {
      if (node.isConnected) {
        const rect = node.getBoundingClientRect();
        nextRects.set(messageId, {
          left: rect.left,
          top: rect.top + (scrollViewportRef.current?.scrollTop ?? 0),
        });
      }
    }

    const shouldAnimateLayout =
      messageLayoutContextRef.current === currentLayoutContext &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (shouldAnimateLayout) {
      for (const [messageId, nextRect] of nextRects.entries()) {
        const node = messageNodeRefs.current.get(messageId);
        if (!node) {
          continue;
        }

        const previousRect = messageRectsRef.current.get(messageId);
        if (!previousRect) {
          node.animate(
            [
              { opacity: 0, transform: 'translateY(14px) scale(0.985)' },
              { opacity: 1, transform: 'translateY(0px) scale(1)' },
            ],
            {
              duration: 280,
              easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
            },
          );
          continue;
        }

        const deltaX = previousRect.left - nextRect.left;
        const deltaY = previousRect.top - nextRect.top;
        if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) {
          continue;
        }

        node.animate(
          [
            { transform: `translate(${deltaX}px, ${deltaY}px)` },
            { transform: 'translate(0px, 0px)' },
          ],
          {
            duration: 260,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          },
        );
      }
    }

    messageLayoutContextRef.current = currentLayoutContext;
    messageRectsRef.current = nextRects;
  }, [location.pathname, location.search, messages]);

  useEffect(() => {
    if (replyToMessageId && !messages.some((message) => message.id === replyToMessageId)) {
      setReplyToMessageId(null);
    }

    if (editingMessageId && !messages.some((message) => message.id === editingMessageId)) {
      cancelEditing({ restoreDraft: true });
    }

    if (activeMessageId && !messages.some((message) => message.id === activeMessageId)) {
      setActiveMessageId(null);
      setIsReactionPickerExpanded(false);
      setReactionPopoverLayout(null);
    }

    if (
      swipeReplyPreview &&
      !messages.some((message) => message.id === swipeReplyPreview.messageId)
    ) {
      swipeReplyGestureRef.current = null;
      setSwipeReplyPreview(null);
    }

    if (firstUnreadMessageId && !messageIdSet.has(firstUnreadMessageId)) {
      setFirstUnreadMessageId(null);
    }

    if (highlightedMessageId && !messageIdSet.has(highlightedMessageId)) {
      clearSourceHighlight();
    }
  }, [
    activeMessageId,
    editingMessageId,
    firstUnreadMessageId,
    highlightedMessageId,
    messageIdSet,
    messages,
    replyToMessageId,
    swipeReplyPreview,
  ]);

  useEffect(() => {
    if (!activeMessageId || typeof document === 'undefined') {
      return undefined;
    }

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (
        target.closest('.channel-dialog-message') ||
        target.closest('.channel-dialog-compose') ||
        target.closest('.channel-dialog-comments-header') ||
        target.closest('.channel-dialog-popover-layer')
      ) {
        return;
      }
      dismissMessageActions();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown, { passive: true });

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [activeMessageId]);

  useEffect(() => {
    if (
      !canManageCommentNotifications ||
      !isNotificationSettingsOpen ||
      typeof document === 'undefined'
    ) {
      return undefined;
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsNotificationSettingsOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [canManageCommentNotifications, isNotificationSettingsOpen]);

  useLayoutEffect(() => {
    if (dialogType !== 'comments' || typeof window === 'undefined') {
      commentsNotificationTopNudgeRef.current = 0;
      setCommentsNotificationTopNudge(0);
      return undefined;
    }

    const button = themeToggleRef.current;
    if (!button) {
      commentsNotificationTopNudgeRef.current = 0;
      setCommentsNotificationTopNudge(0);
      return undefined;
    }

    let frameId = 0;

    const updateNudge = () => {
      const currentNudge = commentsNotificationTopNudgeRef.current;
      const baseTop = button.getBoundingClientRect().top - currentNudge;
      const viewportTop = Math.max(0, Math.round(window.visualViewport?.offsetTop ?? 0));
      const minTop = viewportTop + COMMENT_NOTIFICATION_TOP_MARGIN_PX;
      const nextNudge = Math.min(
        COMMENT_NOTIFICATION_MAX_NUDGE_PX,
        Math.max(0, Math.ceil(minTop - baseTop)),
      );

      if (nextNudge !== currentNudge) {
        commentsNotificationTopNudgeRef.current = nextNudge;
        setCommentsNotificationTopNudge(nextNudge);
      }
    };

    const requestUpdate = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(updateNudge);
    };

    updateNudge();
    window.addEventListener('resize', requestUpdate, { passive: true });
    window.visualViewport?.addEventListener('resize', requestUpdate);
    window.visualViewport?.addEventListener('scroll', requestUpdate);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', requestUpdate);
      window.visualViewport?.removeEventListener('resize', requestUpdate);
      window.visualViewport?.removeEventListener('scroll', requestUpdate);
    };
  }, [canManageCommentNotifications, dialogType]);

  useLayoutEffect(() => {
    if (!activeMessageId || typeof document === 'undefined') {
      return undefined;
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      dismissMessageActions();
    };

    const screen = screenRef.current;
    const popover = reactionPopoverRef.current;
    const clearNativeSelection = () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed) return;
      const isCommentSelection = [selection.anchorNode, selection.focusNode].some((node) => {
        const element = node instanceof Element ? node : node?.parentElement;
        return (
          element &&
          screen?.contains(element) &&
          element.closest('.channel-dialog-message, .channel-dialog-popover-layer')
        );
      });
      if (isCommentSelection) selection.removeAllRanges();
    };
    const preventNativeSelection = (event: Event) => {
      event.preventDefault();
      clearNativeSelection();
    };

    // FLAG: Android may continue the original long press after the action menu has mounted.
    clearNativeSelection();
    popover?.addEventListener('selectstart', preventNativeSelection);
    popover?.addEventListener('contextmenu', preventNativeSelection);
    document.addEventListener('selectionchange', clearNativeSelection);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      popover?.removeEventListener('selectstart', preventNativeSelection);
      popover?.removeEventListener('contextmenu', preventNativeSelection);
      document.removeEventListener('selectionchange', clearNativeSelection);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeMessageId]);

  useLayoutEffect(() => {
    if (!activeMessageId) {
      setReactionPopoverLayout(null);
      return undefined;
    }

    const screen = screenRef.current;
    const viewport = scrollViewportRef.current;
    if (!screen || !viewport) {
      return undefined;
    }

    let frameId = 0;

    const updateLayout = () => {
      const bubble = screen.querySelector<HTMLElement>(
        `[data-message-bubble-id="${activeMessageId}"]`,
      );
      if (!bubble) {
        setReactionPopoverLayout(null);
        return;
      }

      const screenRect = screen.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const bubbleRect = bubble.getBoundingClientRect();
      const composeSurface = screen.querySelector<HTMLElement>('.channel-dialog-compose__surface');
      const composeTop = composeSurface?.getBoundingClientRect().top ?? screenRect.bottom;
      const availableWidth = Math.max(220, Math.min(screenRect.width - 24, 304));
      const visual = window.visualViewport;
      const topBoundary = Math.max(viewportRect.top + 6, (visual?.offsetTop ?? 0) + 6);
      const bottomBoundary = Math.min(
        viewportRect.bottom - 8,
        composeTop - 8,
        (visual ? visual.offsetTop + visual.height : window.innerHeight) - 8,
      );
      const popover = reactionPopoverRef.current;
      if (popover) popover.style.maxHeight = `${Math.max(0, bottomBoundary - topBoundary)}px`;
      const popoverHeight = popover?.getBoundingClientRect().height ?? 108;
      const topSpace = bubbleRect.top - topBoundary;
      const bottomSpace = bottomBoundary - bubbleRect.bottom;
      const placeBelow = topSpace < popoverHeight + 10 && bottomSpace > topSpace;
      const unclampedTop = placeBelow
        ? bubbleRect.bottom - screenRect.top + 8
        : bubbleRect.top - screenRect.top - popoverHeight - 8;
      const minTop = Math.max(8, topBoundary - screenRect.top);
      const maxTop = Math.max(minTop, bottomBoundary - screenRect.top - popoverHeight);
      const nextTop = Math.max(minTop, Math.min(unclampedTop, maxTop));
      const unclampedLeft = activeMessageIsOwn
        ? bubbleRect.right - screenRect.left - availableWidth
        : bubbleRect.left - screenRect.left;
      const nextLeft = Math.max(
        12,
        Math.min(unclampedLeft, screenRect.width - availableWidth - 12),
      );

      setReactionPopoverLayout((current) => {
        if (
          current &&
          current.left === nextLeft &&
          current.top === nextTop &&
          current.width === availableWidth &&
          current.placement === (placeBelow ? 'below' : 'above')
        ) {
          return current;
        }

        return {
          left: nextLeft,
          top: nextTop,
          width: availableWidth,
          placement: placeBelow ? 'below' : 'above',
        };
      });
    };

    const requestLayout = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(updateLayout);
    };

    requestLayout();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(requestLayout);
    observer?.observe(viewport);
    if (reactionPopoverRef.current) observer?.observe(reactionPopoverRef.current);
    viewport.addEventListener('scroll', requestLayout, { passive: true });
    window.addEventListener('resize', requestLayout);
    window.visualViewport?.addEventListener('resize', requestLayout);
    window.visualViewport?.addEventListener('scroll', requestLayout);

    return () => {
      cancelAnimationFrame(frameId);
      observer?.disconnect();
      viewport.removeEventListener('scroll', requestLayout);
      window.removeEventListener('resize', requestLayout);
      window.visualViewport?.removeEventListener('resize', requestLayout);
      window.visualViewport?.removeEventListener('scroll', requestLayout);
    };
  }, [activeMessageId, activeMessageIsOwn, isReactionPickerExpanded]);

  useEffect(() => {
    if (!activeMessageId || !reactionPopoverLayout) {
      return undefined;
    }

    const viewport = scrollViewportRef.current;
    if (!viewport) {
      return undefined;
    }

    let frameId = 0;

    const keepActiveMessageInView = () => {
      const activeBubble = viewport.querySelector<HTMLElement>(
        `[data-message-bubble-id="${activeMessageId}"]`,
      );
      if (!activeBubble) {
        return;
      }

      const viewportRect = viewport.getBoundingClientRect();
      const activeBubbleRect = activeBubble.getBoundingClientRect();
      const popoverHeight = reactionPopoverRef.current?.offsetHeight ?? 0;
      const desiredTopInset =
        14 + (reactionPopoverLayout?.placement === 'above' ? popoverHeight + 10 : 0);
      const desiredBottomInset =
        20 + (reactionPopoverLayout?.placement === 'below' ? popoverHeight + 10 : 0);

      // FLAG: The floating menu may overlap its bubble when both cannot fit together.
      // Opposing scroll targets in that case would keep moving the menu under the user's finger.
      if (desiredTopInset + activeBubbleRect.height + desiredBottomInset > viewportRect.height) {
        return;
      }

      const topOffset = activeBubbleRect.top - viewportRect.top;
      const bottomOffset = viewportRect.bottom - activeBubbleRect.bottom;
      const delta =
        topOffset < desiredTopInset - 1
          ? topOffset - desiredTopInset
          : bottomOffset < desiredBottomInset - 1
            ? desiredBottomInset - bottomOffset
            : 0;
      const target = Math.max(
        0,
        Math.min(viewport.scrollTop + delta, viewport.scrollHeight - viewport.clientHeight),
      );
      if (Math.abs(target - viewport.scrollTop) > 1) {
        viewport.scrollTo({ top: target, behavior: 'instant' });
      }
    };

    frameId = requestAnimationFrame(() => {
      keepActiveMessageInView();
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [activeMessageId, reactionPopoverLayout]);

  const appendDraftAttachments = (
    nextAttachments: CommentDraftAttachment[],
    isPreparationCurrent: () => boolean,
  ) => {
    if (!canUploadCommentAttachments || nextAttachments.length === 0) {
      return;
    }

    setDraftAttachments((current) => {
      if (!isPreparationCurrent()) {
        return current;
      }
      const accepted = [...current];
      const totalAttachmentLimit =
        dialogType === 'suggest'
          ? MAX_CHANNEL_DIALOG_SUGGEST_IMAGES
          : MAX_CHANNEL_DIALOG_ATTACHMENTS;
      let fileCount = current.filter((attachment) => attachment.type === 'file').length;
      let totalBase64Length = calculateDraftAttachmentsBase64Length(current);
      let rejectedByCount = 0;
      let rejectedByFileLimit = 0;
      let rejectedBySize = 0;

      for (const attachment of nextAttachments) {
        if (accepted.length >= totalAttachmentLimit) {
          rejectedByCount += 1;
          continue;
        }

        if (dialogType === 'suggest' && attachment.type !== 'image') {
          rejectedByFileLimit += 1;
          continue;
        }

        if (attachment.type === 'file' && fileCount >= MAX_CHANNEL_DIALOG_COMMENT_FILES) {
          rejectedByFileLimit += 1;
          continue;
        }

        if (attachment.base64.length > MAX_CHANNEL_DIALOG_IMAGE_BASE64_LENGTH) {
          rejectedBySize += 1;
          continue;
        }

        const nextTotalBase64Length = totalBase64Length + attachment.base64.length;
        if (nextTotalBase64Length > MAX_CHANNEL_DIALOG_ATTACHMENTS_TOTAL_BASE64) {
          rejectedBySize += 1;
          continue;
        }

        accepted.push(attachment);
        totalBase64Length = nextTotalBase64Length;
        if (attachment.type === 'file') {
          fileCount += 1;
        }
      }

      const addedCount = accepted.length - current.length;
      if (addedCount === 0) {
        const description =
          rejectedByCount > 0
            ? dialogType === 'suggest'
              ? `Можно добавить до ${MAX_CHANNEL_DIALOG_SUGGEST_IMAGES} фото.`
              : `Можно добавить до ${MAX_CHANNEL_DIALOG_ATTACHMENTS} вложений.`
            : rejectedByFileLimit > 0
              ? dialogType === 'suggest'
                ? 'К предложению пока можно добавить только фото.'
                : `Можно прикрепить до ${MAX_CHANNEL_DIALOG_COMMENT_FILES} файлов.`
              : 'Уберите часть файлов или фото и попробуйте снова.';

        pushToast({
          tone: 'danger',
          title:
            rejectedBySize > 0
              ? 'Вложения слишком тяжёлые'
              : rejectedByFileLimit > 0
                ? dialogType === 'suggest'
                  ? 'Нужны фото'
                  : 'Слишком много файлов'
                : 'Слишком много вложений',
          description,
        });
        return current;
      }

      if (rejectedByCount > 0 || rejectedByFileLimit > 0 || rejectedBySize > 0) {
        const rejectedCount = rejectedByCount + rejectedByFileLimit + rejectedBySize;
        const description =
          rejectedByCount > 0
            ? dialogType === 'suggest'
              ? `Можно добавить до ${MAX_CHANNEL_DIALOG_SUGGEST_IMAGES} фото. Остальные не добавлены.`
              : `Лимит комментария — ${MAX_CHANNEL_DIALOG_ATTACHMENTS} вложений. Остальные фото не добавили.`
            : rejectedByFileLimit > 0
              ? dialogType === 'suggest'
                ? 'Остальные вложения пропустили: нужны фото.'
                : `Лимит файлов — ${MAX_CHANNEL_DIALOG_COMMENT_FILES}. Остальные вложения пропустили.`
              : 'Часть фото не добавили, потому что суммарный размер получился слишком большим.';

        pushToast({
          tone: 'info',
          title: `Добавили ${addedCount} из ${nextAttachments.length}`,
          description:
            rejectedCount > 0 ? description : 'Оставшиеся вложения уже были в комментарии.',
        });
      }

      maxSelectionChanged();
      return accepted;
    });
  };

  const buildAttachmentSelectionSignature = (files: File[]): string =>
    files.map((file) => [file.name, file.size, file.type, file.lastModified].join(':')).join('|');

  const prepareDraftAttachmentsFromFiles = async (kind: AttachmentInputKind, files: File[]) => {
    if (!canUploadCommentAttachments || files.length === 0 || editingMessage) {
      resetAttachmentPickers();
      return;
    }

    const selectableFiles =
      kind === 'image'
        ? (() => {
            const imageLimit =
              dialogType === 'suggest'
                ? MAX_CHANNEL_DIALOG_SUGGEST_IMAGES
                : MAX_CHANNEL_DIALOG_ATTACHMENTS;
            const remainingSlots = Math.max(0, imageLimit - draftAttachmentCount);
            if (remainingSlots <= 0) {
              pushToast({
                tone: 'info',
                title: 'Больше фото не поместится',
                description:
                  dialogType === 'suggest'
                    ? `Можно добавить до ${MAX_CHANNEL_DIALOG_SUGGEST_IMAGES} фото.`
                    : `В одном комментарии может быть до ${MAX_CHANNEL_DIALOG_ATTACHMENTS} вложений.`,
              });
              return [];
            }

            if (files.length > remainingSlots) {
              pushToast({
                tone: 'info',
                title: `Добавим ${remainingSlots} фото`,
                description:
                  remainingSlots === imageLimit
                    ? `За один раз можно выбрать до ${imageLimit} фото.`
                    : `Сейчас осталось места только для ${remainingSlots} фото.`,
              });
            }

            return files.slice(0, remainingSlots);
          })()
        : files;

    if (selectableFiles.length === 0) {
      resetAttachmentPickers();
      return;
    }

    const preparationGeneration = ++attachmentPreparationGenerationRef.current;
    const isPreparationCurrent = () =>
      attachmentPreparationGenerationRef.current === preparationGeneration;
    setPreparingAttachmentState({ kind, total: selectableFiles.length, done: 0 });
    try {
      const {
        prepareCommentDialogFileAttachment,
        prepareCommentDialogImageAttachment,
        prepareSuggestionDialogImageAttachment,
        resolveSuggestionDialogImageMaxBytes,
      } = await import('../lib/dialog-attachments');
      if (!isPreparationCurrent()) {
        return;
      }
      const prepared: CommentDraftAttachment[] = [];
      let firstError: string | null = null;
      const suggestionImageMaxBytes =
        kind === 'image' && dialogType === 'suggest'
          ? resolveSuggestionDialogImageMaxBytes(
              selectableFiles.length,
              calculateDraftAttachmentsBase64Length(draftAttachments),
            )
          : null;

      for (const file of selectableFiles) {
        try {
          const attachment =
            kind === 'image'
              ? dialogType === 'suggest'
                ? await prepareSuggestionDialogImageAttachment(file, {
                    maxBytes: suggestionImageMaxBytes ?? undefined,
                  })
                : await prepareCommentDialogImageAttachment(file)
              : await prepareCommentDialogFileAttachment(file);
          if (!isPreparationCurrent()) {
            return;
          }
          prepared.push(attachment);
        } catch (error: unknown) {
          if (!isPreparationCurrent()) {
            return;
          }
          if (!firstError && error instanceof Error && error.message.trim()) {
            firstError = error.message;
          } else if (!firstError) {
            firstError =
              kind === 'image' ? 'Не удалось подготовить фото.' : 'Не удалось подготовить файл.';
          }
        } finally {
          if (isPreparationCurrent()) {
            setPreparingAttachmentState((current) =>
              isPreparationCurrent() && current?.kind === kind
                ? { ...current, done: Math.min(current.total, current.done + 1) }
                : current,
            );
          }
        }
      }

      if (!isPreparationCurrent()) {
        return;
      }
      if (prepared.length > 0) {
        appendDraftAttachments(prepared, isPreparationCurrent);
      }

      if (firstError) {
        pushToast({
          tone: 'danger',
          title: kind === 'image' ? 'Фото не добавлено' : 'Файл не добавлен',
          description: firstError,
        });
      }
    } catch (error: unknown) {
      if (!isPreparationCurrent()) {
        return;
      }
      pushToast({
        tone: 'danger',
        title: kind === 'image' ? 'Фото не добавлено' : 'Файл не добавлен',
        description:
          error instanceof Error && error.message.trim()
            ? error.message
            : kind === 'image'
              ? 'Не удалось подготовить фото.'
              : 'Не удалось подготовить файл.',
      });
    } finally {
      if (isPreparationCurrent()) {
        resetAttachmentPickers();
        setPreparingAttachmentState(null);
      }
    }
  };

  const handleDraftAttachmentInputSelection = (
    kind: AttachmentInputKind,
    input: HTMLInputElement | null,
  ): boolean => {
    const files = Array.from(input?.files ?? []);
    if (files.length === 0) {
      return false;
    }

    const signature = buildAttachmentSelectionSignature(files);
    const recentSelection = recentAttachmentSelectionRef.current[kind];
    if (
      recentSelection?.signature === signature &&
      Date.now() - recentSelection.handledAt < ATTACHMENT_SELECTION_DEDUPE_MS
    ) {
      attachmentInputWatchCleanupRef.current[kind]?.();
      attachmentInputWatchCleanupRef.current[kind] = null;
      return true;
    }

    if (lastHandledAttachmentSelectionRef.current[kind] === signature) {
      attachmentInputWatchCleanupRef.current[kind]?.();
      attachmentInputWatchCleanupRef.current[kind] = null;
      return true;
    }

    lastHandledAttachmentSelectionRef.current[kind] = signature;
    recentAttachmentSelectionRef.current[kind] = {
      signature,
      handledAt: Date.now(),
    };
    attachmentInputWatchCleanupRef.current[kind]?.();
    attachmentInputWatchCleanupRef.current[kind] = null;
    void prepareDraftAttachmentsFromFiles(kind, files);
    return true;
  };

  const armDraftAttachmentInputWatcher = (kind: AttachmentInputKind) => {
    armAttachmentInputWatcher(
      kind,
      kind === 'image' ? imageInputRef.current : fileInputRef.current,
    );
  };

  const armAttachmentInputWatcher = (kind: AttachmentInputKind, input: HTMLInputElement | null) => {
    attachmentInputWatchCleanupRef.current[kind]?.();
    attachmentInputWatchCleanupRef.current[kind] = null;

    if (
      typeof window === 'undefined' ||
      typeof document === 'undefined' ||
      !input ||
      input.disabled
    ) {
      return;
    }

    const timeoutIds = new Set<number>();
    const scheduleDrain = (delays: number[]) => {
      for (const delay of delays) {
        const timeoutId = window.setTimeout(() => {
          timeoutIds.delete(timeoutId);
          handleDraftAttachmentInputSelection(kind, input);
        }, delay);
        timeoutIds.add(timeoutId);
      }
    };

    const handleFocus = () => {
      scheduleDrain([80, 320, 900]);
    };
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        scheduleDrain([80, 320, 900]);
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    scheduleDrain([240, 900, 1600, 4200, 8200]);

    attachmentInputWatchCleanupRef.current[kind] = () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      for (const timeoutId of timeoutIds) {
        window.clearTimeout(timeoutId);
      }
      timeoutIds.clear();
    };
  };

  const handleDraftImagesChange = (event: ReactChangeEvent<HTMLInputElement>) => {
    handleDraftAttachmentInputSelection('image', event.currentTarget);
  };

  const handleDraftFilesChange = (event: ReactChangeEvent<HTMLInputElement>) => {
    handleDraftAttachmentInputSelection('file', event.currentTarget);
  };

  const handleDraftImagesInput = (event: ReactFormEvent<HTMLInputElement>) => {
    handleDraftAttachmentInputSelection('image', event.currentTarget);
  };

  const handleDraftFilesInput = (event: ReactFormEvent<HTMLInputElement>) => {
    handleDraftAttachmentInputSelection('file', event.currentTarget);
  };

  const handleDraftAttachmentRemove = (index: number) => {
    if (sendMutation.isPending || updateMutation.isPending) return;
    setDraftAttachments((current) =>
      current.filter((_, attachmentIndex) => attachmentIndex !== index),
    );
    maxSelectionChanged();
    resetAttachmentPickers();
  };

  const buildCreateMessagePayload = (payload: {
    text: string;
    attachments: CommentDraftAttachment[];
  }) => {
    const attachments = canUploadCommentAttachments ? payload.attachments : [];
    if (dialogType === 'suggest') {
      return {
        token,
        text: payload.text,
        textFormat: 'markdown' as const,
        images: attachments
          .filter((attachment) => attachment.type === 'image')
          .map((attachment) => ({
            base64: attachment.base64,
            mimeType: attachment.mimeType,
            fileName: attachment.fileName,
          })),
      };
    }

    return {
      token,
      text: payload.text,
      replyToMessageId: replyToMessageId,
      attachments: attachments.map((attachment) => ({
        type: attachment.type,
        base64: attachment.base64,
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        ...(attachment.width ? { width: attachment.width } : {}),
        ...(attachment.height ? { height: attachment.height } : {}),
      })),
    };
  };

  const sendMutation = useMutation({
    mutationFn: (payload: { text: string; attachments: CommentDraftAttachment[] }) =>
      entityType === 'channel'
        ? createChannelDialogMessage(api, chatId, dialogType, buildCreateMessagePayload(payload))
        : createChatDialogMessage(api, chatId, dialogType, buildCreateMessagePayload(payload)),
    onSuccess: (result) => {
      queryClient.setQueryData<ChannelDialogResponse | undefined>(dialogQueryKey, (current) =>
        updateDialogMessage(current, result.message),
      );
      if (dialogType === 'suggest') {
        pushToast({ tone: 'success', title: 'Предложение отправлено' });
      } else {
        maxNotify('success');
      }
      cancelAttachmentPreparation();
      setDraft('');
      setReplyToMessageId(null);
      setDraftAttachments([]);
      setIsComposeEmojiOpen(false);
      resetAttachmentPickers();
      dismissMessageActions();
      requestAnimationFrame(() => {
        scrollToLatest('smooth');
      });
      void queryClient.invalidateQueries({
        queryKey: dialogQueryKey,
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(
          error,
          dialogType === 'suggest'
            ? 'Не удалось отправить предложение'
            : 'Не удалось отправить комментарий',
        ),
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ messageId, text }: { messageId: string; text: string }) =>
      entityType === 'channel'
        ? updateChannelDialogMessage(api, chatId, dialogType, messageId, {
            token,
            text,
          })
        : updateChatDialogMessage(api, chatId, dialogType, messageId, {
            token,
            text,
          }),
    onSuccess: (result) => {
      queryClient.setQueryData<ChannelDialogResponse | undefined>(dialogQueryKey, (current) =>
        updateDialogMessage(current, result.message),
      );
      maxNotify('success');
      cancelEditing({ restoreDraft: true });
      dismissMessageActions();
      void queryClient.invalidateQueries({
        queryKey: dialogQueryKey,
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось обновить комментарий'),
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ messageId }: { messageId: string; deletedByAdmin: boolean }) =>
      entityType === 'channel'
        ? deleteChannelDialogMessage(api, chatId, dialogType, messageId, {
            token,
          })
        : deleteChatDialogMessage(api, chatId, dialogType, messageId, {
            token,
          }),
    onSuccess: (result, variables) => {
      queryClient.setQueryData<ChannelDialogResponse | undefined>(dialogQueryKey, (current) =>
        removeDialogMessage(current, result.deletedMessageId),
      );
      pushToast({
        tone: 'success',
        title: 'Комментарий удалён',
      });
      if (editingMessageId === variables.messageId) {
        cancelEditing({ restoreDraft: true });
      }
      dismissMessageActions();
      void queryClient.invalidateQueries({
        queryKey: dialogQueryKey,
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось удалить комментарий'),
      });
    },
  });

  const reactionMutation = useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      entityType === 'channel'
        ? toggleChannelDialogReaction(api, chatId, dialogType, messageId, {
            token,
            emoji,
          })
        : toggleChatDialogReaction(api, chatId, dialogType, messageId, {
            token,
            emoji,
          }),
    onMutate: async ({ messageId, emoji }) => {
      await queryClient.cancelQueries({ queryKey: dialogQueryKey });
      const previousDialog = queryClient.getQueryData<ChannelDialogResponse | undefined>(
        dialogQueryKey,
      );
      queryClient.setQueryData<ChannelDialogResponse | undefined>(dialogQueryKey, (current) =>
        toggleDialogReactionLocally(current, messageId, emoji),
      );
      return { previousDialog };
    },
    onSuccess: (result) => {
      queryClient.setQueryData<ChannelDialogResponse | undefined>(dialogQueryKey, (current) =>
        updateDialogMessage(current, result.message),
      );
    },
    onError: (error, _variables, context) => {
      if (context?.previousDialog) {
        queryClient.setQueryData(dialogQueryKey, context.previousDialog);
      }
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось сохранить реакцию'),
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: dialogQueryKey,
      });
    },
  });
  const profileHandoffMutation = useMutation({
    mutationFn: async ({ userId, displayName }: { userId: string; displayName: string }) => {
      const { handoffEntityMemberProfile } =
        await import('../lib/api/member-profile-handoff-client');
      return handoffEntityMemberProfile(api, entityType, chatId, userId, { displayName });
    },
    onSuccess: (result) => {
      if (!openMaxBotLinkAndClose(result.botUrl)) {
        pushToast({
          tone: 'danger',
          title: 'Не удалось открыть бота',
        });
      }
    },
    onError: (error: unknown) => {
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось открыть профиль'),
      });
    },
  });
  const notificationMutation = useMutation({
    mutationFn: (payload: {
      mode: ChannelDialogNotificationMode;
      scope: ChannelDialogNotificationScope;
    }) =>
      entityType === 'channel'
        ? updateChannelDialogNotifications(api, chatId, dialogType, {
            token,
            mode: payload.mode,
            scope: payload.scope,
          })
        : updateChatDialogNotifications(api, chatId, dialogType, {
            token,
            mode: payload.mode,
            scope: payload.scope,
          }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: dialogQueryKey });
    },
    onSuccess: (result, payload) => {
      queryClient.setQueryData<ChannelDialogResponse | undefined>(dialogQueryKey, (current) =>
        current
          ? {
              ...current,
              notificationSettings: result.notificationSettings,
            }
          : current,
      );
      pushToast({
        tone: 'success',
        title: `${payload.scope === 'thread' ? 'Пост' : payload.scope === 'channel' ? (entityType === 'channel' ? 'Канал' : 'Чат') : entityType === 'channel' ? 'Все каналы' : 'Все чаты'}: ${payload.mode === 'off' ? 'уведомления выключены' : payload.mode === 'replies' ? 'ответы на ваши комментарии' : 'все комментарии'}`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось обновить уведомления'),
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: dialogQueryKey,
      });
    },
  });

  const isComposePending = sendMutation.isPending || updateMutation.isPending || commentBlocked;
  const isCommentActionPending =
    sendMutation.isPending ||
    reactionMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending;
  const isNotificationPending = notificationMutation.isPending;

  const applySuggestTextModifier = (tool: MaxMarkdownTool) => {
    if (dialogType !== 'suggest' || isComposePending || isPreparingAttachment) {
      return;
    }

    richTextEditorRef.current?.applyTool(tool);
    maxSelectionChanged();
  };

  const openMessageActions = (
    messageId: string,
    options?: {
      haptic?: 'light' | 'medium';
      toggle?: boolean;
    },
  ) => {
    if (dialogType !== 'comments') {
      return;
    }

    maxImpact(options?.haptic ?? 'light');
    setIsNotificationSettingsOpen(false);
    setIsComposeEmojiOpen(false);
    clearSwipeReplyGesture();
    setIsReactionPickerExpanded(false);
    setActiveMessageId((current) => {
      const shouldToggle = options?.toggle !== false;
      return shouldToggle && current === messageId ? null : messageId;
    });
  };

  const handleBubblePointerDown =
    (message: ChannelDialogMessage, isOwnMessage: boolean) =>
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'mouse') {
        return;
      }

      clearMessagePress();
      clearSwipeReplyGesture();
      ignoreNextBubbleClickRef.current = false;
      pressPointRef.current = {
        x: event.clientX,
        y: event.clientY,
      };
      swipeReplyGestureRef.current = {
        messageId: message.id,
        startX: event.clientX,
        startY: event.clientY,
        isOwn: isOwnMessage,
        engaged: false,
        armed: false,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      pressTimerRef.current = window.setTimeout(() => {
        if (swipeReplyGestureRef.current?.engaged) {
          return;
        }
        ignoreNextBubbleClickRef.current = true;
        openMessageActions(message.id, {
          haptic: 'medium',
          toggle: false,
        });
      }, 340);
    };

  const handleBubblePointerMove =
    (message: ChannelDialogMessage, isOwnMessage: boolean) =>
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'mouse') {
        return;
      }

      const swipeGesture = swipeReplyGestureRef.current;
      if (!swipeGesture || swipeGesture.messageId !== message.id) {
        return;
      }

      const deltaX = event.clientX - swipeGesture.startX;
      const deltaY = event.clientY - swipeGesture.startY;
      const directionalDelta = deltaX * (isOwnMessage ? -1 : 1);

      if (!swipeGesture.engaged) {
        if (Math.abs(deltaY) > 10 && Math.abs(deltaY) > Math.abs(deltaX)) {
          clearMessagePress();
          clearSwipeReplyGesture();
          return;
        }

        if (
          directionalDelta > SWIPE_REPLY_ACTIVATION_DISTANCE &&
          Math.abs(deltaY) < SWIPE_REPLY_ACTIVATION_DISTANCE + 6
        ) {
          swipeGesture.engaged = true;
          clearMessagePress();
          ignoreNextBubbleClickRef.current = true;
        }
      }

      if (!swipeGesture.engaged) {
        if (!pressPointRef.current) {
          return;
        }

        const pressDeltaX = Math.abs(event.clientX - pressPointRef.current.x);
        const pressDeltaY = Math.abs(event.clientY - pressPointRef.current.y);
        if (pressDeltaX > 8 || pressDeltaY > 8) {
          clearMessagePress();
        }
        return;
      }

      event.preventDefault();
      const swipeDistance = Math.max(
        0,
        Math.min(directionalDelta - SWIPE_REPLY_ACTIVATION_DISTANCE, SWIPE_REPLY_MAX_OFFSET),
      );
      const isArmed = swipeDistance >= SWIPE_REPLY_TRIGGER_DISTANCE;
      if (swipeGesture.armed !== isArmed) {
        maxSelectionChanged();
      }
      swipeGesture.armed = isArmed;
      setSwipeReplyPreview({
        messageId: message.id,
        offset: swipeDistance * (isOwnMessage ? -1 : 1),
        progress: swipeDistance / SWIPE_REPLY_MAX_OFFSET,
        armed: isArmed,
      });
    };

  const handleBubblePointerUp =
    (message: ChannelDialogMessage) => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'mouse') {
        return;
      }

      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      clearMessagePress();
      const shouldReply =
        swipeReplyGestureRef.current?.messageId === message.id &&
        swipeReplyGestureRef.current.engaged &&
        swipeReplyGestureRef.current.armed;
      clearSwipeReplyGesture();
      if (!shouldReply) {
        return;
      }

      ignoreNextBubbleClickRef.current = true;
      handleReply(message);
    };

  const handleBubblePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse') {
      return;
    }

    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    clearMessagePress();
    clearSwipeReplyGesture();
  };

  const handleBubbleClick = (messageId: string) => (event: ReactMouseEvent<HTMLDivElement>) => {
    if (ignoreNextBubbleClickRef.current) {
      ignoreNextBubbleClickRef.current = false;
      return;
    }

    const target = event.currentTarget.ownerDocument.defaultView;
    if (target?.matchMedia('(pointer: coarse)').matches) {
      return;
    }

    openMessageActions(messageId);
  };

  const handleBubbleKeyDown =
    (messageId: string) => (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      event.preventDefault();
      openMessageActions(messageId);
    };

  const handleBubbleContextMenu =
    (messageId: string) => (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      ignoreNextBubbleClickRef.current = true;
      openMessageActions(messageId, {
        haptic: 'medium',
        toggle: false,
      });
    };

  const handleReply = (message: ChannelDialogMessage) => {
    if (commentBlocked) return;
    if (dialogType !== 'comments') {
      return;
    }

    maxImpact('soft');
    if (editingMessageId) cancelEditing({ restoreDraft: true });
    setReplyToMessageId(message.id);
    setIsComposeEmojiOpen(false);
    dismissMessageActions();
    resetAttachmentPickers();
    requestAnimationFrame(() => composeFieldRef.current?.focus());
  };

  const handleStartEditing = (message: ChannelDialogMessage) => {
    if (!message.canEdit) {
      return;
    }
    if (commentBlocked) return;

    cancelAttachmentPreparation();
    maxImpact('soft');
    setEditRestoreState(
      (current) =>
        current ?? {
          draft,
          replyToMessageId,
          draftAttachments,
        },
    );
    setReplyToMessageId(null);
    setEditingMessageId(message.id);
    setDraft(message.text);
    setDraftAttachments([]);
    setIsComposeEmojiOpen(false);
    dismissMessageActions();
    resetAttachmentPickers();
    requestAnimationFrame(() => composeFieldRef.current?.focus());
  };

  const handleDelete = (message: ChannelDialogMessage) => {
    if (deleteMutation.isPending || (!message.canDelete && !message.canDeleteAsAdmin)) {
      return;
    }

    const confirmationText =
      message.canDeleteAsAdmin && !message.canDelete
        ? 'Удалить чужой комментарий как администратор?'
        : 'Удалить комментарий?';
    if (typeof window !== 'undefined' && !window.confirm(confirmationText)) {
      return;
    }

    maxImpact('medium');
    deleteMutation.mutate({
      messageId: message.id,
      deletedByAdmin: message.canDeleteAsAdmin && !message.canDelete,
    });
  };

  const handleReactionToggle = (
    messageId: string,
    emoji: string,
    options?: {
      closePicker?: boolean;
    },
  ) => {
    if (isCommentActionPending || commentBlocked) {
      return;
    }

    maxImpact('soft');
    reactionMutation.mutate({ messageId, emoji });
    if (options?.closePicker) {
      dismissMessageActions();
    }
  };

  const handleNotificationDraftModeSelect = (mode: ChannelDialogNotificationMode) => {
    if (!canManageCommentNotifications || dialogType !== 'comments' || isNotificationPending) {
      return;
    }

    maxImpact('soft');
    setNotificationDraftMode(mode);
  };

  const handleNotificationSettingsApply = () => {
    if (!canManageCommentNotifications || dialogType !== 'comments' || isNotificationPending) {
      return;
    }

    const nextScope = notificationDraftScope;
    const currentScopeSettings = getNotificationSettingsForScope(notificationSettings, nextScope);
    if (
      nextScope === notificationScope &&
      notificationDraftMode === currentScopeSettings.mode &&
      currentScopeSettings.explicit
    ) {
      setIsNotificationSettingsOpen(false);
      return;
    }

    maxImpact('soft');
    notificationMutation.mutate(
      {
        mode: notificationDraftMode,
        scope: nextScope,
      },
      {
        onSuccess: () => {
          setIsNotificationSettingsOpen(false);
        },
      },
    );
  };

  const handleAuthorProfileActivate = (message: ChannelDialogMessage) => {
    if (dialogType !== 'comments' || profileHandoffMutation.isPending) {
      return;
    }

    const normalizedUserId = message.authorUserId.trim();
    if (!normalizedUserId || !chatId) {
      return;
    }

    const displayName = getAuthorLabel(message).trim() || 'Пользователь';
    maxImpact('soft');
    dismissMessageActions();
    profileHandoffMutation.mutate({
      userId: normalizedUserId,
      displayName,
    });
  };

  const scrollToMessage = (
    messageId: string,
    options?: {
      behavior?: ScrollBehavior;
      highlight?: boolean;
    },
  ): boolean => {
    const viewport = scrollViewportRef.current;
    const targetMessage = messageNodeRefs.current.get(messageId);
    if (!viewport || !targetMessage) {
      return false;
    }

    const viewportRect = viewport.getBoundingClientRect();
    const targetRect = targetMessage.getBoundingClientRect();
    const topInset = 18;
    const bottomInset = 18;
    const availableHeight = Math.max(140, viewport.clientHeight - topInset - bottomInset);
    const desiredTop =
      viewport.scrollTop +
      (targetRect.top - viewportRect.top) -
      topInset -
      Math.max(0, (availableHeight - targetRect.height) / 2);
    const nextTop = Math.max(
      0,
      Math.min(desiredTop, viewport.scrollHeight - viewport.clientHeight),
    );

    viewport.scrollTo({
      top: nextTop,
      behavior: options?.behavior ?? 'smooth',
    });

    if (options?.highlight !== false) {
      flashSourceHighlight(messageId);
    }

    return true;
  };

  const handleJumpToLatest = () => {
    const viewport = scrollViewportRef.current;
    if (!viewport) {
      return;
    }

    maxImpact('light');
    dismissMessageActions();
    scrollToLatest('smooth');
  };

  const handleJumpToSource = (messageId: string) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    maxImpact('light');
    dismissMessageActions();
    scrollToMessage(messageId);
  };

  const handleComposeReplySourceJump = () => {
    if (!replyTarget) {
      return;
    }

    maxImpact('light');
    scrollToMessage(replyTarget.id);
  };

  const onSubmit = () => {
    const text = draft.trim();
    if (isComposePending || !canSubmitMessage || !chatId || !token) {
      return;
    }

    if (editingMessage) {
      if (!text && editingMessage.attachments.length === 0) {
        return;
      }

      if (text === editingMessage.text.trim()) {
        cancelEditing({ restoreDraft: true });
        return;
      }

      updateMutation.mutate({
        messageId: editingMessage.id,
        text,
      });
      return;
    }

    if (!text && (!canUploadCommentAttachments || draftAttachments.length === 0)) {
      return;
    }

    sendMutation.mutate({
      text,
      attachments: canUploadCommentAttachments ? draftAttachments : [],
    });
  };
  const selectedDraftScope = notificationDraftScope;
  const selectedDraftScopeSettings = getNotificationSettingsForScope(
    notificationSettings,
    selectedDraftScope,
  );
  const notificationApplyDisabled =
    isNotificationPending ||
    (selectedDraftScope === notificationScope &&
      notificationDraftMode === selectedDraftScopeSettings.mode &&
      selectedDraftScopeSettings.explicit);
  const notificationToggleLabel =
    notificationMode === 'off' ? 'Уведомления выключены' : 'Уведомления включены';
  const commentsScreenStyle =
    dialogType === 'comments' && commentsNotificationTopNudge > 0
      ? ({
          '--comments-dialog-notification-top-nudge': `${commentsNotificationTopNudge}px`,
        } as CSSProperties)
      : undefined;

  const blurSuggestComposerFocus = () => {
    if (dialogType !== 'suggest' || typeof document === 'undefined') {
      return;
    }

    const composer = suggestComposerRef.current;
    const activeElement = document.activeElement;
    if (composer && activeElement instanceof HTMLElement && composer.contains(activeElement)) {
      activeElement.blur();
    }
    screenRef.current?.classList.remove('is-suggest-editor-focused');
    screenRef.current?.style.removeProperty('--suggest-keyboard-reserve');
    suggestionKeyboardBaselineRef.current = null;
  };

  useLayoutEffect(() => {
    if (
      dialogType !== 'suggest' ||
      typeof window === 'undefined' ||
      typeof document === 'undefined'
    ) {
      return undefined;
    }

    const viewport = scrollViewportRef.current;
    const composer = suggestComposerRef.current;
    if (!viewport || !composer) {
      return undefined;
    }

    let frameId = 0;
    let isEditorFocused = false;
    const timers = new Set<number>();

    const isSuggestEditorTarget = (target: EventTarget | null): target is Element =>
      target instanceof Element &&
      composer.contains(target) &&
      Boolean(
        target.closest(
          '.max-rich-text-editor__surface, .max-rich-text-editor__link-panel input, .channel-suggest-composer__field textarea',
        ),
      );

    const readKeyboardOverlap = () => {
      const rawValue = window
        .getComputedStyle(document.documentElement)
        .getPropertyValue('--app-keyboard-overlap');
      const value = Number.parseFloat(rawValue);
      return Number.isFinite(value) ? Math.max(0, value) : 0;
    };

    const getFocusedAnchor = (): HTMLElement => {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && composer.contains(activeElement)) {
        const linkPanel = activeElement.closest<HTMLElement>('.max-rich-text-editor__link-panel');
        const editorSurface = activeElement.closest<HTMLElement>(
          '.max-rich-text-editor__surface, .channel-suggest-composer__field textarea',
        );
        return linkPanel ?? editorSurface ?? activeElement;
      }

      return composer;
    };

    const readKeyboardLayout = () => {
      const visualViewport = window.visualViewport;
      const layoutHeight = window.innerHeight;
      const visualHeight = visualViewport?.height ?? layoutHeight;
      const baseline = suggestionKeyboardBaselineRef.current ?? {
        layoutHeight,
        visualHeight,
      };
      suggestionKeyboardBaselineRef.current = baseline;

      return resolveSuggestionKeyboardLayout({
        focused: isEditorFocused,
        fallbackEligible:
          document.documentElement.dataset.maxClient === 'native' ||
          Math.min(window.innerWidth, visualViewport?.width ?? window.innerWidth) <= 640,
        layoutHeight,
        visualHeight,
        visualOffsetTop: visualViewport?.offsetTop ?? 0,
        containerBottom: screenRef.current?.getBoundingClientRect().bottom ?? layoutHeight,
        keyboardOverlap: readKeyboardOverlap(),
        baseline,
      });
    };

    const syncKeyboardReserve = () => {
      const screen = screenRef.current;
      if (!screen || !isEditorFocused) {
        screen?.style.removeProperty('--suggest-keyboard-reserve');
        return null;
      }

      const layout = readKeyboardLayout();
      if (layout.barReservePx > 0) {
        screen.style.setProperty('--suggest-keyboard-reserve', `${layout.barReservePx}px`);
      } else {
        screen.style.removeProperty('--suggest-keyboard-reserve');
      }
      return layout;
    };

    const setEditorFocused = (focused: boolean) => {
      isEditorFocused = focused;
      screenRef.current?.classList.toggle('is-suggest-editor-focused', focused);
      if (focused) {
        syncKeyboardReserve();
        return;
      }

      screenRef.current?.style.removeProperty('--suggest-keyboard-reserve');
      suggestionKeyboardBaselineRef.current = null;
    };

    const keepFocusedEditorVisible = (behavior: ScrollBehavior) => {
      if (!isEditorFocused) {
        return;
      }

      const visualViewport = window.visualViewport;
      const viewportRect = viewport.getBoundingClientRect();
      const visualTop = visualViewport?.offsetTop ?? 0;
      const keyboardLayout = syncKeyboardReserve();
      if (!keyboardLayout) {
        return;
      }
      const visibleTop = Math.max(viewportRect.top, visualTop);
      const visibleBottom = Math.min(viewportRect.bottom, keyboardLayout.visibleBottomPx);
      const barTop = suggestBarRef.current?.getBoundingClientRect().top;
      const protectedBottom =
        typeof barTop === 'number' ? Math.min(visibleBottom, barTop - 12) : visibleBottom;
      const targetRect = getFocusedAnchor().getBoundingClientRect();
      const bottomGap = targetRect.bottom + 18 - protectedBottom;

      if (bottomGap > 1) {
        viewport.scrollBy({ top: Math.ceil(bottomGap), behavior });
        return;
      }

      const topGap = visibleTop + 10 - targetRect.top;
      if (topGap > 1) {
        viewport.scrollBy({ top: -Math.ceil(topGap), behavior });
      }
    };

    const scheduleKeepVisible = (behavior: ScrollBehavior = 'auto') => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => keepFocusedEditorVisible(behavior));
    };

    const scheduleSettlingPasses = () => {
      scheduleKeepVisible('smooth');
      for (const delay of [80, 180, 320]) {
        const timerId = window.setTimeout(() => {
          timers.delete(timerId);
          scheduleKeepVisible('auto');
        }, delay);
        timers.add(timerId);
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (!isSuggestEditorTarget(event.target)) {
        return;
      }

      setEditorFocused(true);
      scheduleSettlingPasses();
    };

    const handleFocusOut = (event: FocusEvent) => {
      const nextTarget = event.relatedTarget;
      if (isSuggestEditorTarget(nextTarget)) {
        return;
      }

      setEditorFocused(false);
    };

    const handleViewportChange = () => {
      syncKeyboardReserve();
      scheduleKeepVisible('auto');
    };

    composer.addEventListener('focusin', handleFocusIn);
    composer.addEventListener('focusout', handleFocusOut);
    composer.addEventListener('input', handleViewportChange);
    window.addEventListener('resize', handleViewportChange, { passive: true });
    window.visualViewport?.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('scroll', handleViewportChange);

    if (isSuggestEditorTarget(document.activeElement)) {
      setEditorFocused(true);
      scheduleSettlingPasses();
    }

    return () => {
      window.cancelAnimationFrame(frameId);
      screenRef.current?.classList.remove('is-suggest-editor-focused');
      screenRef.current?.style.removeProperty('--suggest-keyboard-reserve');
      suggestionKeyboardBaselineRef.current = null;
      for (const timerId of timers) {
        window.clearTimeout(timerId);
      }
      composer.removeEventListener('focusin', handleFocusIn);
      composer.removeEventListener('focusout', handleFocusOut);
      composer.removeEventListener('input', handleViewportChange);
      window.removeEventListener('resize', handleViewportChange);
      window.visualViewport?.removeEventListener('resize', handleViewportChange);
      window.visualViewport?.removeEventListener('scroll', handleViewportChange);
    };
  }, [dialogQuery.isSuccess, dialogType]);

  if (terminalDialogError) {
    const sessionExpired = isSessionExpiredApiMessage(terminalDialogError);
    return (
      <PublicDialogUnavailableState
        tone={sessionExpired ? 'danger' : 'warning'}
        title={sessionExpired ? 'Нужно открыть приложение заново' : 'Диалог недоступен'}
        description={
          sessionExpired
            ? 'Закройте мини-приложение и откройте этот диалог снова из сообщения в MAX.'
            : terminalDialogError
        }
      />
    );
  }

  if (!chatId) {
    return (
      <PublicDialogUnavailableState
        title={entityType === 'channel' ? 'Канал не найден' : 'Чат не найден'}
        description="Откройте диалог заново из сообщения."
      />
    );
  }

  if (!token) {
    return (
      <PublicDialogUnavailableState
        title="Кнопка устарела"
        description="Откройте сообщение и нажмите кнопку ещё раз."
      />
    );
  }

  const suggestImageControl =
    dialogType === 'suggest' && canUploadCommentAttachments ? (
      <div className="channel-suggest-composer__tools">
        {useNativeTapFileInputs ? (
          <label
            className={cn(
              'channel-suggest-composer__tool',
              (isComposePending || isPreparingAttachment) && 'is-disabled',
              draftImageAttachments.length > 0 && 'is-active',
            )}
            aria-label={`Добавить до ${MAX_CHANNEL_DIALOG_SUGGEST_IMAGES} фото`}
            aria-disabled={isComposePending || isPreparingAttachment}
            role="button"
            tabIndex={isComposePending || isPreparingAttachment ? -1 : 0}
            onClick={() => {
              blurSuggestComposerFocus();
              armDraftAttachmentInputWatcher('image');
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') {
                return;
              }
              event.preventDefault();
              blurSuggestComposerFocus();
              armDraftAttachmentInputWatcher('image');
              imageInputRef.current?.click();
            }}
          >
            <input
              ref={imageInputRef}
              className="channel-dialog-compose__attach-input"
              type="file"
              accept="image/*"
              multiple
              disabled={isComposePending || isPreparingAttachment}
              onChange={handleDraftImagesChange}
              onInput={handleDraftImagesInput}
              onClickCapture={() => {
                armDraftAttachmentInputWatcher('image');
              }}
              onPointerDownCapture={() => {
                armDraftAttachmentInputWatcher('image');
              }}
              tabIndex={-1}
            />
            <IconoirSprite variant="iconoir" icon="Camera" aria-hidden focusable="false" />
          </label>
        ) : (
          <>
            <button
              type="button"
              className={cn(
                'channel-suggest-composer__tool',
                draftImageAttachments.length > 0 && 'is-active',
              )}
              aria-label={`Добавить до ${MAX_CHANNEL_DIALOG_SUGGEST_IMAGES} фото`}
              disabled={isComposePending || isPreparingAttachment}
              onClick={() => {
                blurSuggestComposerFocus();
                armDraftAttachmentInputWatcher('image');
                openFileInputPicker(imageInputRef.current);
              }}
            >
              <IconoirSprite variant="iconoir" icon="Camera" aria-hidden focusable="false" />
            </button>
            <input
              ref={imageInputRef}
              className="channel-dialog-compose__picker-input"
              type="file"
              accept="image/*"
              multiple
              disabled={isComposePending || isPreparingAttachment}
              onChange={handleDraftImagesChange}
              onInput={handleDraftImagesInput}
              onClickCapture={() => {
                armDraftAttachmentInputWatcher('image');
              }}
              onPointerDownCapture={() => {
                armDraftAttachmentInputWatcher('image');
              }}
              tabIndex={-1}
            />
          </>
        )}

        {suggestPreparingImageLabel || draftImageAttachments.length > 0 ? (
          <span className="channel-suggest-composer__asset">
            {suggestPreparingImageLabel ??
              `${draftImageAttachments.length}/${MAX_CHANNEL_DIALOG_SUGGEST_IMAGES}`}
          </span>
        ) : null}
      </div>
    ) : null;

  return (
    <div
      ref={screenRef}
      className={cn('channel-dialog-screen', `channel-dialog-screen--${dialogType}`, 'page-enter')}
      data-comment-theme={dialogType === 'comments' ? commentTheme : undefined}
      style={commentsScreenStyle}
    >
      <div className="channel-dialog-screen__backdrop" aria-hidden />

      {dialogType === 'comments' ? (
        <header
          className="channel-dialog-comments-header"
          inert={
            Boolean(moderationSheet) ||
            isCommentToolsOpen ||
            isThemeSettingsOpen ||
            isNotificationSettingsOpen ||
            Boolean(imageViewer) ||
            Boolean(activeMessageId)
          }
        >
          <div className="channel-dialog-comments-header__inner">
            <div className="channel-dialog-comments-header__context">
              <small className="channel-dialog-comments-header__eyebrow">Обсуждение поста</small>
              <h1>{viewModel.title}</h1>
              {dialogQuery.isSuccess ? (
                <span
                  aria-label={`Комментариев: ${dialogQuery.data?.hasMoreMessages ? 'больше ' : ''}${messages.length}`}
                >
                  {messages.length}
                  {dialogQuery.data?.hasMoreMessages ? '+' : ''}
                </span>
              ) : null}
            </div>

            <div className="channel-dialog-header-actions">
              {moderationQuery.data?.canManage ? (
                <button
                  ref={moderationToggleRef}
                  type="button"
                  className="channel-dialog-theme-toggle"
                  aria-label="Ограничения участников"
                  title="Ограничения участников"
                  aria-haspopup="dialog"
                  onClick={() => {
                    dismissMessageActions();
                    setIsComposeEmojiOpen(false);
                    setIsThemeSettingsOpen(false);
                    setIsNotificationSettingsOpen(false);
                    composeFieldRef.current?.blur();
                    setModerationSheet({ target: null });
                  }}
                >
                  <IconoirSprite variant="iconoir" icon="ShieldCheck" aria-hidden />
                </button>
              ) : null}
              <button
                ref={themeToggleRef}
                type="button"
                className="channel-dialog-theme-toggle"
                aria-label="Параметры обсуждения"
                title="Параметры обсуждения"
                aria-haspopup="dialog"
                aria-expanded={isCommentToolsOpen}
                onClick={() => {
                  maxImpact('light');
                  dismissMessageActions();
                  setIsComposeEmojiOpen(false);
                  setIsNotificationSettingsOpen(false);
                  composeFieldRef.current?.blur();
                  setIsCommentToolsOpen(true);
                }}
              >
                <IconoirSprite variant="iconoir" icon="MoreHoriz" aria-hidden focusable="false" />
              </button>
            </div>
          </div>
        </header>
      ) : null}

      <div
        className={cn(
          'channel-dialog-shell',
          dialogType === 'suggest' && 'channel-dialog-shell--suggest',
          dialogType === 'comments' && 'has-comments-header',
        )}
        inert={
          dialogType === 'comments' &&
          (Boolean(moderationSheet) ||
            isCommentToolsOpen ||
            isThemeSettingsOpen ||
            isNotificationSettingsOpen ||
            Boolean(imageViewer) ||
            Boolean(activeMessageId))
        }
      >
        <section
          ref={scrollViewportRef}
          className={cn('channel-dialog-body', dialogType === 'suggest' && 'channel-suggest-body')}
          onScroll={handleBodyScroll}
        >
          <>
            {dialogQuery.isLoading ? (
              <div className="channel-dialog-skeletons" aria-label="Загрузка">
                {Array.from({ length: 3 }, (_, index) => (
                  <div key={index} className="channel-dialog-skeleton">
                    <span className="channel-dialog-skeleton__avatar" />
                    <div className="channel-dialog-skeleton__body">
                      <span className="channel-dialog-skeleton__line is-short" />
                      <span className="channel-dialog-skeleton__line" />
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {dialogQuery.error ? (
              <div className="channel-dialog-error">
                <StatusState
                  tone="danger"
                  title="Не удалось загрузить"
                  description={describeUserFacingError(
                    dialogQuery.error,
                    dialogType === 'suggest'
                      ? 'Не удалось загрузить предложения'
                      : 'Не удалось загрузить комментарии',
                  )}
                  action={
                    <button
                      type="button"
                      className="button button--danger"
                      onClick={() => void dialogQuery.refetch()}
                    >
                      Повторить
                    </button>
                  }
                />
              </div>
            ) : null}

            {!dialogQuery.isLoading && !dialogQuery.error ? (
              dialogType === 'suggest' ? (
                <div className="channel-suggest-workspace">
                  {introText ? <SuggestionRequirements text={introText} /> : null}

                  <section
                    ref={suggestComposerRef}
                    className={cn(
                      'channel-suggest-composer',
                      canSubmitMessage && 'is-ready',
                      isComposePending && 'is-busy',
                    )}
                    aria-label="Предложить пост"
                  >
                    {COMMENT_DRAFT_MAX_LENGTH - draftLength <= 200 ? (
                      <div className="channel-suggest-composer__head">
                        <span className="channel-suggest-composer__counter">
                          {draftLength}/{COMMENT_DRAFT_MAX_LENGTH}
                        </span>
                      </div>
                    ) : null}

                    <div
                      className={cn(
                        'channel-suggest-composer__phone',
                        !draft.trim() &&
                          draftImageAttachments.length === 0 &&
                          suggestPreparingImageSlots === 0 &&
                          'is-empty',
                      )}
                    >
                      <div className="channel-suggest-composer__bubble">
                        <SuggestComposeImageGrid
                          attachments={draftImageAttachments}
                          preparingCount={suggestPreparingImageSlots}
                          busy={isComposePending || suggestPreparingImageSlots > 0}
                          onRemove={(filteredIndex) => {
                            const attachment = draftImageAttachments[filteredIndex];
                            const originalIndex = attachment
                              ? draftAttachments.indexOf(attachment)
                              : -1;
                            if (originalIndex >= 0) {
                              handleDraftAttachmentRemove(originalIndex);
                            }
                          }}
                        />

                        <div className="channel-suggest-composer__field">
                          <Suspense fallback={null}>
                            <MaxRichTextEditor
                              ref={richTextEditorRef}
                              value={draft}
                              onChange={setDraft}
                              placeholder={viewModel.placeholder}
                              maxLength={COMMENT_DRAFT_MAX_LENGTH}
                              disabled={isComposePending}
                              ariaLabel="Текст предложения"
                              className="channel-suggest-composer__rich-editor"
                            />
                          </Suspense>
                        </div>

                        <span className="channel-suggest-composer__tail" aria-hidden />
                      </div>
                    </div>

                    <div ref={suggestBarRef} className="channel-suggest-composer__bar">
                      {suggestImageControl}

                      <div
                        className="channel-suggest-composer__modifier-row"
                        role="toolbar"
                        aria-label="Форматирование"
                      >
                        {MAX_MARKDOWN_TOOL_DEFINITIONS.map((tool) => (
                          <button
                            key={tool.id}
                            type="button"
                            className={cn(
                              'channel-suggest-composer__modifier',
                              tool.id === 'italic' && 'is-italic',
                              tool.id === 'code' && 'is-code',
                            )}
                            onMouseDown={(event) => {
                              event.preventDefault();
                            }}
                            onClick={() => applySuggestTextModifier(tool.id)}
                            disabled={isComposePending || isPreparingAttachment}
                            title={tool.title}
                            aria-label={tool.title}
                          >
                            {tool.id === 'link' ? (
                              <IconoirSprite
                                variant="iconoir"
                                icon="Link"
                                aria-hidden
                                focusable="false"
                              />
                            ) : (
                              <SuggestMarkdownToolIcon tool={tool.id} />
                            )}
                          </button>
                        ))}
                      </div>

                      <button
                        type="button"
                        className="channel-suggest-composer__submit"
                        onClick={onSubmit}
                        disabled={!canSubmitMessage || isComposePending}
                      >
                        {isComposePending ? (
                          <span className="channel-dialog-submit__loader" aria-hidden />
                        ) : (
                          <SendArrowIcon />
                        )}
                        <span>{sendMutation.isPending ? 'Отправка' : 'Отправить'}</span>
                      </button>
                    </div>
                  </section>

                  {messages.length ? (
                    <div className="channel-suggest-list channel-suggest-list--history">
                      {messages.map((message) => {
                        const status = resolveSuggestionStatus(message);
                        const suggestionText = message.text.trim();
                        const hasSuggestionText = suggestionText.length > 0;
                        const hasMedia =
                          message.hasImage ||
                          message.hasVideo ||
                          Boolean(message.imageFileName || message.videoFileName);

                        return (
                          <article
                            key={message.id}
                            ref={(node) => {
                              if (node) {
                                messageNodeRefs.current.set(message.id, node);
                                return;
                              }
                              messageNodeRefs.current.delete(message.id);
                            }}
                            className={cn('channel-suggest-card', `is-${status.tone}`)}
                          >
                            <div className="channel-suggest-card__head">
                              <span className={cn('channel-suggest-status', `is-${status.tone}`)}>
                                {status.badge}
                              </span>
                              <time dateTime={message.createdAt}>
                                {formatMessageTime(message.createdAt)}
                              </time>
                            </div>

                            {hasSuggestionText ? (
                              <p>
                                {message.textFormat === 'markdown' ? (
                                  <Suspense fallback={suggestionText}>
                                    <MaxMarkdownPreview
                                      value={message.text}
                                      preserveLinks
                                      fallback={suggestionText}
                                    />
                                  </Suspense>
                                ) : (
                                  suggestionText
                                )}
                              </p>
                            ) : null}

                            {hasMedia ? (
                              <span className="channel-suggest-card__media">
                                <IconoirSprite
                                  variant="iconoir"
                                  icon="Attachment"
                                  aria-hidden
                                  focusable="false"
                                />
                                {resolveSuggestionAttachmentLabel(message)}
                              </span>
                            ) : null}

                            {status.detail ? (
                              <p className="channel-suggest-card__status-detail">{status.detail}</p>
                            ) : null}

                            {message.publishedUrl ? (
                              <a
                                className="channel-suggest-card__link"
                                href={message.publishedUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Открыть пост
                              </a>
                            ) : null}
                          </article>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div ref={commentListRef} className="channel-dialog-message-list">
                  {messages.length ? (
                    messages.map((message, index) => {
                      const isOwnMessage = currentUserId === message.authorUserId;
                      const isAdminMessage = message.isAdmin === true;
                      const groupedWithPrevious = isGroupedWithPrevious(messages, index);
                      const isActiveMessage = activeMessageId === message.id;
                      const messageWidthTone = resolveMessageWidthTone(message);
                      const replySourceMessageId =
                        message.replyTo?.messageId ?? message.replyToMessageId ?? null;
                      const canJumpToReplySource = Boolean(
                        replySourceMessageId && messageIdSet.has(replySourceMessageId),
                      );
                      const isReactionPending = isCommentActionPending;

                      return (
                        <Fragment key={message.id}>
                          {(!messages[index - 1] ||
                            !isSameCommentDay(messages[index - 1]!.createdAt, message.createdAt)) &&
                          formatCommentDay(message.createdAt) ? (
                            <div className="channel-dialog-day">
                              <time dateTime={message.createdAt}>
                                {formatCommentDay(message.createdAt)}
                              </time>
                            </div>
                          ) : null}
                          {unreadStartIndex === index ? (
                            <div
                              className="channel-dialog-new-comments"
                              aria-label="Новые комментарии"
                            >
                              <span className="channel-dialog-new-comments__pill">
                                Новые комментарии
                              </span>
                            </div>
                          ) : null}

                          <article
                            ref={(node) => {
                              if (node) {
                                messageNodeRefs.current.set(message.id, node);
                                return;
                              }
                              messageNodeRefs.current.delete(message.id);
                            }}
                            className={cn(
                              'channel-dialog-message',
                              isOwnMessage && 'is-own',
                              isAdminMessage && 'is-admin',
                              groupedWithPrevious && 'is-grouped',
                              highlightedMessageId === message.id && 'is-source-highlighted',
                            )}
                          >
                            {groupedWithPrevious ? (
                              <span className="channel-dialog-message__avatar-spacer" aria-hidden />
                            ) : (
                              <DialogAvatar
                                avatarUrl={message.avatarUrl}
                                label={message.authorDisplayName || message.authorUserId}
                                onClick={() => handleAuthorProfileActivate(message)}
                                disabled={profileHandoffMutation.isPending}
                              />
                            )}

                            <div
                              className={cn(
                                'channel-dialog-message__content',
                                messageWidthTone,
                                swipeReplyPreview?.messageId === message.id && 'is-swipe-active',
                                swipeReplyPreview?.messageId === message.id &&
                                  swipeReplyPreview.armed &&
                                  'is-swipe-armed',
                                isActiveMessage && 'is-context-open',
                              )}
                              data-message-id={message.id}
                              style={buildSwipeReplyStyle(swipeReplyPreview, message.id)}
                            >
                              <div className="channel-dialog-message__swipe-indicator" aria-hidden>
                                <span className="channel-dialog-message__swipe-indicator-icon">
                                  <ReplyArrowIcon />
                                </span>
                              </div>

                              <div
                                className={cn(
                                  'channel-dialog-message__stack',
                                  swipeReplyPreview?.messageId === message.id && 'is-swipe-active',
                                )}
                              >
                                <div
                                  className={cn(
                                    'channel-dialog-message__bubble',
                                    'is-selectable',
                                    isAdminMessage && 'is-admin',
                                    isActiveMessage && 'is-active',
                                    groupedWithPrevious && 'is-grouped',
                                  )}
                                  data-message-bubble-id={message.id}
                                  style={buildAdminBubbleStyle(isAdminMessage, isOwnMessage)}
                                  onClick={handleBubbleClick(message.id)}
                                  onKeyDown={handleBubbleKeyDown(message.id)}
                                  onPointerDown={handleBubblePointerDown(message, isOwnMessage)}
                                  onPointerMove={handleBubblePointerMove(message, isOwnMessage)}
                                  onPointerUp={handleBubblePointerUp(message)}
                                  onPointerCancel={handleBubblePointerCancel}
                                  onContextMenu={handleBubbleContextMenu(message.id)}
                                  role="button"
                                  tabIndex={0}
                                  aria-pressed={isActiveMessage}
                                  aria-haspopup="dialog"
                                >
                                  {!groupedWithPrevious ? (
                                    <div className="channel-dialog-message__meta">
                                      <strong
                                        style={buildAdminAuthorStyle(isAdminMessage, isOwnMessage)}
                                      >
                                        {getAuthorLabel(message)}
                                      </strong>
                                      <time dateTime={message.createdAt}>
                                        {formatMessageTime(message.createdAt)}
                                        {message.editedAt ? ' · ред.' : ''}
                                      </time>
                                    </div>
                                  ) : null}

                                  {message.replyTo ? (
                                    canJumpToReplySource && replySourceMessageId ? (
                                      <button
                                        type="button"
                                        className={cn('channel-dialog-message__reply', 'is-link')}
                                        onPointerDown={(event) => event.stopPropagation()}
                                        onKeyDown={(event) => event.stopPropagation()}
                                        onClick={handleJumpToSource(replySourceMessageId)}
                                        aria-label="Перейти к исходному комментарию"
                                      >
                                        <span>
                                          {message.replyTo.authorDisplayName || 'Комментарий'}
                                        </span>
                                        <p>{summarizeReplyText(message.replyTo.text)}</p>
                                      </button>
                                    ) : (
                                      <div className="channel-dialog-message__reply">
                                        <span>
                                          {message.replyTo.authorDisplayName || 'Комментарий'}
                                        </span>
                                        <p>{summarizeReplyText(message.replyTo.text)}</p>
                                      </div>
                                    )
                                  ) : null}

                                  <CommentMessageAttachments
                                    attachments={message.attachments}
                                    onOpenImageAlbum={openCommentImageAlbum}
                                  />
                                  {renderPlainTextParagraphs(message.text)}
                                  {groupedWithPrevious ? (
                                    <time
                                      className="channel-dialog-message__grouped-time"
                                      dateTime={message.createdAt}
                                    >
                                      {formatMessageTime(message.createdAt)}
                                      {message.editedAt ? ' · ред.' : ''}
                                    </time>
                                  ) : null}
                                </div>

                                {message.reactionGroups.length > 0 ? (
                                  <div className="channel-dialog-message__footer channel-dialog-message__footer--comments">
                                    <div className="channel-dialog-message__reactions">
                                      {message.reactionGroups.map((group) => (
                                        <button
                                          key={group.emoji}
                                          type="button"
                                          className={cn(
                                            'channel-dialog-reaction-pill',
                                            group.reactedByMe && 'is-active',
                                          )}
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            handleReactionToggle(message.id, group.emoji);
                                          }}
                                          disabled={isReactionPending || commentBlocked}
                                          aria-label={`Реакция ${group.emoji}: ${group.count}`}
                                          aria-pressed={group.reactedByMe}
                                        >
                                          <b>{group.emoji}</b>
                                          <span>{group.count}</span>
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </article>
                        </Fragment>
                      );
                    })
                  ) : (
                    <div className="channel-dialog-empty">
                      <IconoirSprite
                        variant="iconoir"
                        icon="BubbleStar"
                        className="channel-dialog-empty__icon"
                        aria-hidden
                      />
                      <strong>Комментариев пока нет</strong>
                    </div>
                  )}
                </div>
              )
            ) : null}
          </>
        </section>

        {dialogType === 'comments' ? (
          <section
            className="channel-dialog-compose"
            aria-label="Новый комментарий"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && isComposeToolsOpen && !isComposeEmojiOpen) {
                event.preventDefault();
                event.stopPropagation();
                closeComposeTools();
              }
            }}
          >
            {showJumpToLatest ? (
              <button
                type="button"
                className="channel-dialog-jump-latest"
                onClick={handleJumpToLatest}
                aria-label={
                  unreadCount > 0
                    ? `Перейти к ${unreadCount} новым комментариям`
                    : 'К последнему комментарию'
                }
                title="К последнему комментарию"
              >
                <span className="channel-dialog-jump-latest__icon" aria-hidden>
                  <IconoirSprite
                    variant="iconoir"
                    icon="NavArrowDown"
                    aria-hidden
                    focusable="false"
                  />
                </span>
                {unreadCount > 0 ? <b>{unreadCount}</b> : null}
              </button>
            ) : null}

            {commentBlocked ? (
              <div
                className="channel-dialog-compose__surface channel-dialog-compose__restriction"
                role="status"
              >
                <strong>{commentRestrictionLabel(commentRestriction)}</strong>
                {commentRestriction?.reason ? <p>{commentRestriction.reason}</p> : null}
                <span>Участие в комментариях этого сообщества ограничено.</span>
              </div>
            ) : (
              <div className="channel-dialog-compose__surface">
                {editingMessage || replyTarget || draftAttachments.length > 0 ? (
                  <div className="channel-dialog-compose__context">
                    {editingMessage ? (
                      <div className={cn('channel-dialog-compose__reply', 'is-editing')}>
                        <button
                          type="button"
                          className={cn('channel-dialog-compose__reply-copy', 'is-link')}
                          onClick={() => scrollToMessage(editingMessage.id)}
                        >
                          <span>Редактирование комментария</span>
                          <p>
                            {summarizeReplyText(
                              editingMessage.text || editingAttachmentSummary || 'Комментарий',
                              84,
                            )}
                          </p>
                        </button>
                        <button
                          type="button"
                          className="channel-dialog-compose__reply-dismiss"
                          onClick={() => cancelEditing({ restoreDraft: true })}
                          disabled={isComposePending}
                          aria-label="Отменить редактирование"
                        >
                          <CloseIcon />
                        </button>
                      </div>
                    ) : replyTarget ? (
                      <div className="channel-dialog-compose__reply">
                        <button
                          type="button"
                          className={cn('channel-dialog-compose__reply-copy', 'is-link')}
                          onClick={handleComposeReplySourceJump}
                        >
                          <span>Ответ {replyTarget.authorDisplayName || 'участнику'}</span>
                          <p>{summarizeReplyText(replyTarget.text, 84)}</p>
                        </button>
                        <button
                          type="button"
                          className="channel-dialog-compose__reply-dismiss"
                          onClick={() => setReplyToMessageId(null)}
                          aria-label="Отменить ответ"
                        >
                          <CloseIcon />
                        </button>
                      </div>
                    ) : null}

                    {editingMessage?.attachments.length ? (
                      <>
                        <CommentComposeImageStrip attachments={editingImageAttachments} />
                        <CommentComposeFileList attachments={editingFileAttachments} />
                      </>
                    ) : !editingMessage &&
                      canUploadCommentAttachments &&
                      draftAttachments.length > 0 ? (
                      <>
                        <CommentComposeImageStrip
                          attachments={draftImageAttachments}
                          removable={!isComposePending}
                          onRemove={(filteredIndex) => {
                            const attachment = draftImageAttachments[filteredIndex];
                            const originalIndex = attachment
                              ? draftAttachments.indexOf(attachment)
                              : -1;
                            if (originalIndex >= 0) {
                              handleDraftAttachmentRemove(originalIndex);
                            }
                          }}
                        />
                        {dialogType === 'comments' ? (
                          <CommentComposeFileList
                            attachments={draftFileAttachments}
                            removable={!isComposePending}
                            onRemove={(filteredIndex) => {
                              const attachment = draftFileAttachments[filteredIndex];
                              const originalIndex = attachment
                                ? draftAttachments.indexOf(attachment)
                                : -1;
                              if (originalIndex >= 0) {
                                handleDraftAttachmentRemove(originalIndex);
                              }
                            }}
                          />
                        ) : null}
                      </>
                    ) : null}
                  </div>
                ) : null}

                <div
                  id="channel-dialog-compose-tools"
                  className="channel-dialog-compose__toolbar"
                  hidden={!isComposeToolsOpen}
                  role="group"
                  aria-label="Вложения и эмодзи"
                >
                  <div
                    className={cn(
                      'channel-dialog-compose__quick-actions',
                      editingMessage && 'is-editing',
                    )}
                  >
                    <button
                      type="button"
                      className={cn(
                        'channel-dialog-compose__attach',
                        'channel-dialog-compose__attach--icon',
                        'channel-dialog-compose__emoji-toggle',
                        isComposeEmojiOpen && 'is-active',
                      )}
                      onClick={() => {
                        maxImpact('light');
                        if (isComposeEmojiOpen) {
                          setIsComposeEmojiOpen(false);
                          requestAnimationFrame(() => composeFieldRef.current?.focus());
                        } else {
                          composeFieldRef.current?.blur();
                          setIsComposeEmojiOpen(true);
                        }
                      }}
                      aria-label="Эмодзи"
                      title="Эмодзи"
                      aria-expanded={isComposeEmojiOpen}
                      aria-controls="channel-dialog-compose-emoji-panel"
                      disabled={isComposePending}
                    >
                      <IconoirSprite
                        variant="iconoir"
                        icon="BubbleStar"
                        aria-hidden
                        focusable="false"
                      />
                    </button>

                    {!editingMessage && canUploadCommentAttachments ? (
                      useNativeTapFileInputs ? (
                        <>
                          <label
                            className={cn(
                              'channel-dialog-compose__attach',
                              'channel-dialog-compose__attach--icon',
                              (isComposePending || isPreparingAttachment) &&
                                'channel-dialog-compose__attach--disabled',
                              draftAttachments.some((attachment) => attachment.type === 'image') &&
                                'is-active',
                            )}
                            aria-label={`Добавить до ${MAX_CHANNEL_DIALOG_ATTACHMENTS} фото`}
                            title="Добавить фото"
                            aria-disabled={isComposePending || isPreparingAttachment}
                          >
                            <input
                              ref={imageInputRef}
                              className="channel-dialog-compose__attach-input"
                              aria-label={`Добавить до ${MAX_CHANNEL_DIALOG_ATTACHMENTS} фото`}
                              type="file"
                              accept="image/*"
                              multiple
                              disabled={isComposePending || isPreparingAttachment}
                              onChange={handleDraftImagesChange}
                              onInput={handleDraftImagesInput}
                              onClickCapture={() => {
                                armDraftAttachmentInputWatcher('image');
                              }}
                              onPointerDownCapture={() => {
                                armDraftAttachmentInputWatcher('image');
                              }}
                              tabIndex={0}
                            />
                            <IconoirSprite
                              variant="iconoir"
                              icon="Camera"
                              aria-hidden
                              focusable="false"
                            />
                          </label>
                          {dialogType === 'comments' ? (
                            <label
                              className={cn(
                                'channel-dialog-compose__attach',
                                'channel-dialog-compose__attach--icon',
                                (isComposePending || isPreparingAttachment) &&
                                  'channel-dialog-compose__attach--disabled',
                                draftAttachments.some((attachment) => attachment.type === 'file') &&
                                  'is-active',
                              )}
                              aria-label="Прикрепить файл"
                              title="Прикрепить файл"
                              aria-disabled={isComposePending || isPreparingAttachment}
                            >
                              <input
                                ref={fileInputRef}
                                className="channel-dialog-compose__attach-input"
                                aria-label="Прикрепить файл"
                                type="file"
                                multiple
                                disabled={isComposePending || isPreparingAttachment}
                                onChange={handleDraftFilesChange}
                                onInput={handleDraftFilesInput}
                                onClickCapture={() => {
                                  armDraftAttachmentInputWatcher('file');
                                }}
                                onPointerDownCapture={() => {
                                  armDraftAttachmentInputWatcher('file');
                                }}
                                tabIndex={0}
                              />
                              <IconoirSprite
                                variant="iconoir"
                                icon="Attachment"
                                aria-hidden
                                focusable="false"
                              />
                            </label>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={cn(
                              'channel-dialog-compose__attach',
                              'channel-dialog-compose__attach--icon',
                              (isComposePending || isPreparingAttachment) &&
                                'channel-dialog-compose__attach--disabled',
                              draftAttachments.some((attachment) => attachment.type === 'image') &&
                                'is-active',
                            )}
                            aria-label={`Добавить до ${MAX_CHANNEL_DIALOG_ATTACHMENTS} фото`}
                            title="Добавить фото"
                            aria-disabled={isComposePending || isPreparingAttachment}
                            disabled={isComposePending || isPreparingAttachment}
                            onClick={() => {
                              armDraftAttachmentInputWatcher('image');
                              openFileInputPicker(imageInputRef.current);
                            }}
                          >
                            <IconoirSprite
                              variant="iconoir"
                              icon="Camera"
                              aria-hidden
                              focusable="false"
                            />
                          </button>
                          <input
                            ref={imageInputRef}
                            className="channel-dialog-compose__picker-input"
                            type="file"
                            accept="image/*"
                            multiple
                            disabled={isComposePending || isPreparingAttachment}
                            onChange={handleDraftImagesChange}
                            onInput={handleDraftImagesInput}
                            onClickCapture={() => {
                              armDraftAttachmentInputWatcher('image');
                            }}
                            onPointerDownCapture={() => {
                              armDraftAttachmentInputWatcher('image');
                            }}
                            tabIndex={-1}
                          />
                          {dialogType === 'comments' ? (
                            <>
                              <button
                                type="button"
                                className={cn(
                                  'channel-dialog-compose__attach',
                                  'channel-dialog-compose__attach--icon',
                                  (isComposePending || isPreparingAttachment) &&
                                    'channel-dialog-compose__attach--disabled',
                                  draftAttachments.some(
                                    (attachment) => attachment.type === 'file',
                                  ) && 'is-active',
                                )}
                                aria-label="Прикрепить файл"
                                title="Прикрепить файл"
                                aria-disabled={isComposePending || isPreparingAttachment}
                                disabled={isComposePending || isPreparingAttachment}
                                onClick={() => {
                                  armDraftAttachmentInputWatcher('file');
                                  openFileInputPicker(fileInputRef.current);
                                }}
                              >
                                <IconoirSprite
                                  variant="iconoir"
                                  icon="Attachment"
                                  aria-hidden
                                  focusable="false"
                                />
                              </button>
                              <input
                                ref={fileInputRef}
                                className="channel-dialog-compose__picker-input"
                                type="file"
                                multiple
                                disabled={isComposePending || isPreparingAttachment}
                                onChange={handleDraftFilesChange}
                                onInput={handleDraftFilesInput}
                                onClickCapture={() => {
                                  armDraftAttachmentInputWatcher('file');
                                }}
                                onPointerDownCapture={() => {
                                  armDraftAttachmentInputWatcher('file');
                                }}
                                tabIndex={-1}
                              />
                            </>
                          ) : null}
                        </>
                      )
                    ) : null}
                  </div>
                </div>

                {isComposeEmojiOpen ? (
                  <Suspense fallback={null}>
                    <CommentComposeEmojiPicker
                      onSelect={handleComposeEmojiInsert}
                      onClose={() => {
                        setIsComposeEmojiOpen(false);
                        requestAnimationFrame(() => composeFieldRef.current?.focus());
                      }}
                    />
                  </Suspense>
                ) : null}

                <div className="channel-dialog-compose__row">
                  <button
                    ref={composeToolsToggleRef}
                    type="button"
                    className={cn(
                      'channel-dialog-compose__tools-toggle',
                      isComposeToolsOpen && 'is-active',
                    )}
                    aria-label="Вложения и эмодзи"
                    title="Вложения и эмодзи"
                    aria-expanded={isComposeToolsOpen}
                    aria-controls="channel-dialog-compose-tools"
                    disabled={isComposePending}
                    onClick={() => {
                      maxImpact('light');
                      setIsComposeEmojiOpen(false);
                      setIsComposeToolsOpen((current) => !current);
                      if (!isComposeToolsOpen) {
                        requestAnimationFrame(() =>
                          screenRef.current
                            ?.querySelector<HTMLButtonElement>(
                              '#channel-dialog-compose-tools button',
                            )
                            ?.focus({ preventScroll: true }),
                        );
                      }
                    }}
                  >
                    <IconoirSprite variant="iconoir" icon="Plus" aria-hidden />
                  </button>
                  <label className="channel-dialog-compose__field">
                    <textarea
                      ref={composeFieldRef}
                      rows={1}
                      value={draft}
                      readOnly={isComposePending}
                      aria-busy={isComposePending}
                      onChange={(event) => setDraft(event.target.value)}
                      onFocus={() => {
                        setIsComposeEmojiOpen(false);
                        setIsComposeToolsOpen(false);
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key === 'Enter' &&
                          (event.ctrlKey || event.metaKey) &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          onSubmit();
                        }
                      }}
                      aria-label={
                        editingMessage
                          ? 'Текст редактируемого комментария'
                          : replyTarget
                            ? 'Текст ответа'
                            : 'Текст комментария'
                      }
                      placeholder={
                        editingMessage
                          ? editingMessage.attachments.length > 0 && !editingMessage.text.trim()
                            ? 'Подпись'
                            : 'Правка'
                          : replyTarget
                            ? 'Ответ'
                            : viewModel.placeholder
                      }
                      maxLength={COMMENT_DRAFT_MAX_LENGTH}
                    />
                  </label>

                  <div className="channel-dialog-compose__actions">
                    <button
                      type="button"
                      className="channel-dialog-submit"
                      onClick={onSubmit}
                      disabled={!canSubmitMessage || isComposePending}
                      aria-label={
                        editingMessage
                          ? updateMutation.isPending
                            ? 'Сохранение'
                            : 'Сохранить'
                          : sendMutation.isPending
                            ? 'Отправка'
                            : 'Отправить'
                      }
                    >
                      {isComposePending ? (
                        <span className="channel-dialog-submit__loader" aria-hidden />
                      ) : (
                        <IconoirSprite variant="iconoir" icon="ArrowUp" aria-hidden />
                      )}
                    </button>
                  </div>
                </div>
                {showComposeMeta ? (
                  <div
                    className="channel-dialog-compose__meta"
                    role={isPreparingAttachment ? 'status' : undefined}
                  >
                    {composeMetaLabel ? <span>{composeMetaLabel}</span> : null}
                    <span>
                      {draftLength}/{COMMENT_DRAFT_MAX_LENGTH}
                    </span>
                  </div>
                ) : null}
              </div>
            )}
          </section>
        ) : null}
      </div>

      {moderationSheet && dialogType === 'comments' ? (
        <Suspense fallback={null}>
          <LazyCommentModerationSheet
            context={moderationContext}
            target={moderationSheet.target}
            onClose={() => {
              setModerationSheet(null);
              requestAnimationFrame(() => {
                if (document.activeElement === document.body) {
                  moderationToggleRef.current?.focus({ preventScroll: true });
                }
              });
            }}
          />
        </Suspense>
      ) : null}

      {imageViewer && activeViewerAttachment && activeViewerImageSrc
        ? createPortal(
            <div className="channel-dialog-image-viewer">
              <button
                type="button"
                className="channel-dialog-image-viewer__backdrop"
                aria-label="Закрыть просмотр фото"
                onClick={closeCommentImageAlbum}
              />

              <section
                ref={imageViewerPanelRef}
                className="channel-dialog-image-viewer__panel"
                role="dialog"
                aria-modal="true"
                aria-label="Просмотр фото"
                tabIndex={-1}
              >
                <div className="channel-dialog-image-viewer__topbar">
                  {imageViewer.attachments.length > 1 ? (
                    <div className="channel-dialog-image-viewer__counter">
                      {imageViewer.activeIndex + 1} / {imageViewer.attachments.length}
                    </div>
                  ) : (
                    <span aria-hidden />
                  )}
                  <button
                    ref={imageViewerCloseButtonRef}
                    type="button"
                    className="channel-dialog-image-viewer__close"
                    onClick={closeCommentImageAlbum}
                    aria-label="Закрыть просмотр"
                  >
                    <CloseIcon />
                  </button>
                </div>

                <div
                  className="channel-dialog-image-viewer__stage"
                  onClick={closeCommentImageAlbum}
                  aria-label="Закрыть фото"
                >
                  {imageViewer.attachments.length > 1 ? (
                    <button
                      type="button"
                      className="channel-dialog-image-viewer__nav"
                      onClick={(event) => {
                        event.stopPropagation();
                        showPreviousCommentImage();
                      }}
                      aria-label="Предыдущее фото"
                    >
                      <BackIcon />
                    </button>
                  ) : null}

                  <div className="channel-dialog-image-viewer__frame">
                    <img
                      src={activeViewerImageSrc}
                      alt={activeViewerAttachment.fileName?.trim() || 'Фото комментария'}
                      loading="eager"
                    />
                  </div>

                  {imageViewer.attachments.length > 1 ? (
                    <button
                      type="button"
                      className={cn('channel-dialog-image-viewer__nav', 'is-next')}
                      onClick={(event) => {
                        event.stopPropagation();
                        showNextCommentImage();
                      }}
                      aria-label="Следующее фото"
                    >
                      <BackIcon />
                    </button>
                  ) : null}
                </div>

                {imageViewer.attachments.length > 1 ? (
                  <div
                    className="channel-dialog-image-viewer__thumbs"
                    role="group"
                    aria-label="Фото в сообщении"
                  >
                    {imageViewer.attachments.map((attachment, attachmentIndex) => {
                      const previewUrl = getCommentAttachmentPreviewUrl(attachment);
                      const fileName = attachment.fileName?.trim() || `Фото ${attachmentIndex + 1}`;

                      return (
                        <button
                          key={`${fileName}-${attachmentIndex}`}
                          type="button"
                          className={cn(
                            'channel-dialog-image-viewer__thumb',
                            attachmentIndex === imageViewer.activeIndex && 'is-active',
                          )}
                          onClick={(event) => {
                            event.stopPropagation();
                            setImageViewer((current) =>
                              current
                                ? {
                                    ...current,
                                    activeIndex: attachmentIndex,
                                  }
                                : current,
                            );
                          }}
                          aria-pressed={attachmentIndex === imageViewer.activeIndex}
                          aria-label={`Открыть ${fileName}`}
                        >
                          {previewUrl ? <img src={previewUrl} alt="" loading="lazy" /> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </section>
            </div>,
            document.body,
          )
        : null}

      {dialogType === 'comments' && activeMessage
        ? createPortal(
            <div
              className="channel-dialog-popover-layer"
              onPointerDownCapture={() => {
                ignoreNextBubbleClickRef.current = false;
              }}
              onClickCapture={(event) => {
                // FLAG: The opening long press's release click must not activate the newly mounted menu.
                if (ignoreNextBubbleClickRef.current && event.detail > 0) {
                  ignoreNextBubbleClickRef.current = false;
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
              onClick={dismissMessageActions}
            >
              <div
                ref={reactionPopoverRef}
                className={cn(
                  'channel-dialog-reaction-popover',
                  'is-floating',
                  reactionPopoverLayout?.placement === 'below' && 'is-below',
                  !reactionPopoverLayout && 'is-measuring',
                )}
                role="dialog"
                aria-modal="true"
                aria-label="Действия с комментарием"
                tabIndex={-1}
                style={
                  reactionPopoverLayout
                    ? {
                        left: `${reactionPopoverLayout.left}px`,
                        top: `${reactionPopoverLayout.top}px`,
                        width: `${reactionPopoverLayout.width}px`,
                      }
                    : undefined
                }
                onClick={(event) => event.stopPropagation()}
              >
                <div className="channel-dialog-reaction-popover__surface">
                  <div className="channel-dialog-reaction-popover__rail">
                    <div className="channel-dialog-reaction-popover__emoji-rail">
                      {COMMENT_REACTION_PRIMARY_OPTIONS.map((emoji) => {
                        const reactedByMe = activeMessage.reactionGroups.some(
                          (group) => group.emoji === emoji && group.reactedByMe,
                        );

                        return (
                          <button
                            key={emoji}
                            type="button"
                            className={cn(
                              'channel-dialog-reaction-popover__emoji',
                              reactedByMe && 'is-active',
                            )}
                            onClick={() =>
                              handleReactionToggle(activeMessage.id, emoji, {
                                closePicker: true,
                              })
                            }
                            disabled={isCommentActionPending || commentBlocked}
                            aria-label={`Поставить реакцию ${emoji}`}
                            aria-pressed={reactedByMe}
                          >
                            {emoji}
                          </button>
                        );
                      })}
                    </div>

                    <div className="channel-dialog-reaction-popover__rail-actions">
                      {activeMessage.text ? (
                        <Suspense fallback={null}>
                          <CommentCopyAction
                            key={activeMessage.id}
                            text={activeMessage.text}
                            onCopied={dismissMessageActions}
                          />
                        </Suspense>
                      ) : null}
                      <button
                        type="button"
                        className={cn(
                          'channel-dialog-reaction-popover__action',
                          'channel-dialog-reaction-popover__action--reply',
                        )}
                        onClick={() => handleReply(activeMessage)}
                        disabled={isCommentActionPending || commentBlocked}
                      >
                        <ReplyArrowIcon />
                        Ответить
                      </button>

                      {activeMessage.canEdit && !commentBlocked ? (
                        <button
                          type="button"
                          className="channel-dialog-reaction-popover__action"
                          onClick={() => handleStartEditing(activeMessage)}
                          disabled={isCommentActionPending}
                        >
                          <EditIcon />
                          Изменить
                        </button>
                      ) : null}

                      {activeMessage.canDelete || activeMessage.canDeleteAsAdmin ? (
                        <button
                          type="button"
                          className={cn(
                            'channel-dialog-reaction-popover__action',
                            'channel-dialog-reaction-popover__action--danger',
                          )}
                          onClick={() => handleDelete(activeMessage)}
                          disabled={isCommentActionPending}
                        >
                          <TrashIcon />
                          Удалить
                        </button>
                      ) : null}

                      {moderationQuery.data?.canManage &&
                      !activeMessage.isAdmin &&
                      activeMessage.authorUserId !== currentUserId ? (
                        <button
                          type="button"
                          className="channel-dialog-reaction-popover__action"
                          onClick={() => {
                            setModerationSheet({
                              target: {
                                userId: activeMessage.authorUserId,
                                displayName: activeMessage.authorDisplayName,
                                sourceMessageId: activeMessage.id,
                              },
                            });
                            dismissMessageActions();
                            composeFieldRef.current?.blur();
                          }}
                          disabled={isCommentActionPending}
                        >
                          <IconoirSprite variant="iconoir" icon="ShieldCheck" aria-hidden />
                          Ограничить автора
                        </button>
                      ) : null}

                      <button
                        type="button"
                        className={cn(
                          'channel-dialog-reaction-popover__toggle',
                          isReactionPickerExpanded && 'is-active',
                        )}
                        onClick={() => setIsReactionPickerExpanded((current) => !current)}
                        disabled={isCommentActionPending}
                        aria-label="Показать больше реакций"
                      >
                        <IconoirSprite variant="iconoir" icon="Plus" aria-hidden />
                      </button>
                    </div>
                  </div>

                  {isReactionPickerExpanded ? (
                    <div className="channel-dialog-reaction-popover__grid">
                      {COMMENT_REACTION_EXPANDED_OPTIONS.map((emoji) => {
                        const reactedByMe = activeMessage.reactionGroups.some(
                          (group) => group.emoji === emoji && group.reactedByMe,
                        );

                        return (
                          <button
                            key={emoji}
                            type="button"
                            className={cn(
                              'channel-dialog-reaction-popover__emoji',
                              'is-secondary',
                              reactedByMe && 'is-active',
                            )}
                            onClick={() =>
                              handleReactionToggle(activeMessage.id, emoji, {
                                closePicker: true,
                              })
                            }
                            disabled={isCommentActionPending || commentBlocked}
                            aria-label={`Поставить реакцию ${emoji}`}
                            aria-pressed={reactedByMe}
                          >
                            {emoji}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>,
            screenRef.current ?? document.body,
          )
        : null}

      {dialogType === 'comments' && isCommentToolsOpen
        ? createPortal(
            <div className="comment-theme-sheet comment-tools-sheet">
              <button
                type="button"
                className="comment-theme-sheet__backdrop"
                aria-label="Закрыть параметры обсуждения"
                tabIndex={-1}
                onClick={() => setIsCommentToolsOpen(false)}
              />
              <section
                ref={commentToolsPanelRef}
                className="comment-theme-sheet__panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby="comment-tools-title"
                tabIndex={-1}
              >
                <header className="comment-theme-sheet__head">
                  <h2 id="comment-tools-title">Параметры обсуждения</h2>
                  <button
                    ref={commentToolsCloseRef}
                    type="button"
                    className="comment-theme-sheet__close"
                    aria-label="Закрыть параметры обсуждения"
                    onClick={() => setIsCommentToolsOpen(false)}
                  >
                    <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
                  </button>
                </header>
                <button
                  type="button"
                  className="comment-tools-sheet__action"
                  aria-label="Оформление комментариев"
                  onClick={() => {
                    setIsCommentToolsOpen(false);
                    setIsThemeSettingsOpen(true);
                  }}
                >
                  <IconoirSprite variant="iconoir" icon="Palette" aria-hidden />
                  <span>
                    <strong>Оформление</strong>
                    <small>Тема и фон комментариев</small>
                  </span>
                </button>
                {canManageCommentNotifications ? (
                  <button
                    type="button"
                    className="comment-tools-sheet__action"
                    aria-label="Настройки уведомлений"
                    disabled={isNotificationPending}
                    onClick={() => {
                      setNotificationDraftScope(notificationScope);
                      setNotificationDraftMode(
                        getNotificationSettingsForScope(notificationSettings, notificationScope)
                          .mode,
                      );
                      setIsCommentToolsOpen(false);
                      setIsNotificationSettingsOpen(true);
                    }}
                  >
                    {notificationMode === 'off' ? (
                      <IconoirSprite variant="iconoir" icon="BellOff" aria-hidden />
                    ) : (
                      <IconoirSprite variant="iconoir" icon="Bell" aria-hidden />
                    )}
                    <span>
                      <strong>Уведомления</strong>
                      <small>{notificationToggleLabel}</small>
                    </span>
                  </button>
                ) : null}
              </section>
            </div>,
            screenRef.current ?? document.body,
          )
        : null}

      {dialogType === 'comments' && isThemeSettingsOpen ? (
        <Suspense fallback={null}>
          <CommentThemeSheet
            returnFocusRef={themeToggleRef}
            portalTarget={screenRef.current ?? document.body}
            theme={commentTheme}
            onSelect={selectCommentTheme}
            onClose={() => setIsThemeSettingsOpen(false)}
          />
        </Suspense>
      ) : null}

      {canManageCommentNotifications && dialogType === 'comments' && isNotificationSettingsOpen ? (
        <Suspense fallback={null}>
          <LazyChannelDialogNotificationSheet
            returnFocusRef={themeToggleRef}
            portalTarget={screenRef.current ?? document.body}
            entityType={entityType}
            profile={profile}
            threadOverrideMode={
              notificationSettings.thread.explicit ? notificationSettings.thread.mode : null
            }
            draftMode={notificationDraftMode}
            draftScope={notificationDraftScope}
            availableTargetCount={notificationAvailableChannelCount}
            canUseAllNotifications={canUseAllNotifications}
            isPending={isNotificationPending}
            applyDisabled={notificationApplyDisabled}
            onClose={() => setIsNotificationSettingsOpen(false)}
            onDraftModeSelect={handleNotificationDraftModeSelect}
            onDraftScopeSelect={(scope) => {
              maxImpact('soft');
              setNotificationDraftScope(scope);
              setNotificationDraftMode(
                getNotificationSettingsForScope(notificationSettings, scope).mode,
              );
            }}
            onApply={handleNotificationSettingsApply}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
