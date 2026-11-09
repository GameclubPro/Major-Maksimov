import { buildVkParsingSourceLink } from '@maxim/contracts/vk-parsing';
import { AppIcon as IconoirSprite } from '../ui/app-icon';

import type {
  ChannelPostSignatureSettings,
  VkParsingPost,
  VkParsingSettings,
} from '@maxim/contracts';
import { lazy, Suspense, useState } from 'react';
import { cn } from '../../lib/cn';
import { MaxMarkdownPreview } from '../max-markdown-preview';
import {
  formatUnsupportedAttachmentSummary,
  formatVkPostDate,
  formatVkPostIssue,
  formatVkPostStatus,
  formatVkPublishState,
  normalizeApiError,
} from './format';
import { resolveVkParsingFallbackLink } from './link-selection';
import { PostVideoPreview } from './post-video-preview';
import { VkInfoButton } from './info-button';
import { vkPostBlockedReason, vkReviewLabel } from './workflow';

const loadPostEditor = () => import('./post-editor');
const LazyPhotoViewer = lazy(() =>
  import('./photo-viewer').then((module) => ({ default: module.VkPhotoViewer })),
);
const LazyPostEditor = lazy(async () => {
  const module = await loadPostEditor();
  return { default: module.PostEditor };
});

type PostCardProps = {
  onSendForBotReview?: (postId: string) => void;
  isSubmittingBotReview?: boolean;
  post: VkParsingPost;
  settings: VkParsingSettings;
  postSignature: ChannelPostSignatureSettings;
  channelLinkUrl?: string;
  isEditing: boolean;
  isPublishing: boolean;
  isRetrying: boolean;
  draftText: string;
  draftTextFormat: VkParsingPost['textFormat'];
  selectedPhotoUrls: string[];
  selectedVideoUrls: string[];
  selectedLinkUrls: string[];
  onStartEditing: (post: VkParsingPost) => void;
  onCancelEditing: () => void;
  onPublishEditingPost: () => void;
  onRetryPost: (postId: string) => void;
  onDraftTextChange: (value: string) => void;
  onTogglePhoto: (url: string) => void;
  onToggleVideo: (url: string) => void;
  onToggleLink: (url: string) => void;
};

function renderStatusIcon(post: VkParsingPost) {
  if (post.status === 'FAILED') {
    return <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />;
  }
  if (post.status === 'PUBLISHED') {
    return <IconoirSprite variant="iconoir" icon="CheckCircle" aria-hidden />;
  }
  if (post.status === 'SKIPPED') {
    return <IconoirSprite variant="iconoir" icon="ShieldCheck" aria-hidden />;
  }
  if (post.status === 'CHANGED_AFTER_PUBLISH') {
    return <IconoirSprite variant="iconoir" icon="RefreshCircle" aria-hidden />;
  }

  return null;
}

export function PostCard({
  onSendForBotReview,
  isSubmittingBotReview = false,
  post,
  settings,
  postSignature,
  channelLinkUrl,
  isEditing,
  isPublishing,
  isRetrying,
  draftText,
  draftTextFormat,
  selectedPhotoUrls,
  selectedVideoUrls,
  selectedLinkUrls,
  onStartEditing,
  onCancelEditing,
  onPublishEditingPost,
  onRetryPost,
  onDraftTextChange,
  onTogglePhoto,
  onToggleVideo,
  onToggleLink,
}: PostCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [failedPhotos, setFailedPhotos] = useState<string[]>([]);
  const [photoPreview, setPhotoPreview] = useState<{ urls: string[]; index: number } | null>(null);
  const blockedReason = vkPostBlockedReason(post);
  const dateLabel = formatVkPostDate(post.vkPublishedAt);
  const statusLabel = formatVkPostStatus(post);
  const publishState = formatVkPublishState(post);
  const postIssue = formatVkPostIssue(post);
  const photoCount = post.photoUrls.length;
  const videoCount = post.videoUrls.length;
  const linkCount = post.linkUrls.length;
  const unsupportedSummary = formatUnsupportedAttachmentSummary(post);
  const unsupportedVideo =
    videoCount === 0
      ? post.unsupportedAttachments.find((item) => item.type === 'video' || item.type === 'clip')
      : null;
  const unsupportedVideoFallbackUrl = resolveVkParsingFallbackLink(post);
  const visiblePhotoUrls = post.photoUrls.slice(0, 4);
  const extraPhotoCount = Math.max(0, post.photoUrls.length - visiblePhotoUrls.length);
  const isReviewMode =
    (post.sourcePublishMode === 'REVIEW' || post.sourcePublishMode === 'BOT_REVIEW') &&
    (post.status === 'NEW' || post.status === 'FAILED');
  const botReviewLabel = vkReviewLabel(post);
  const visibleStatusLabel = post.deletedAt
    ? 'Удалён'
    : isReviewMode
      ? null
      : (publishState?.label ?? statusLabel);
  const visiblePostIssue = blockedReason ? null : postIssue;

  return (
    <article
      className={cn(
        'vk-parsing-post-card',
        `vk-parsing-post-card--${post.status.toLowerCase().replace(/_/gu, '-')}`,
        isReviewMode && 'is-review-mode',
        isEditing && 'is-editing',
        publishState && 'has-publish-state',
        visiblePostIssue?.isMediaIssue && 'has-media-issue',
      )}
    >
      <div className="vk-parsing-post-card__head">
        <div className="vk-parsing-post-card__identity">
          <div className="vk-parsing-post-card__source">
            <strong>{post.sourceTitle}</strong>
            <span>{dateLabel || 'VK'}</span>
          </div>
        </div>
        <div className="vk-parsing-post-card__head-actions">
          {visibleStatusLabel ? (
            <span
              className={cn(
                'vk-parsing-status-pill',
                post.status === 'PUBLISHED' && !post.deletedAt && 'is-success',
                post.status === 'FAILED' && !publishState && 'is-danger',
                publishState?.tone === 'warning' && 'is-warning',
                publishState?.tone === 'danger' && 'is-danger',
                post.status === 'SKIPPED' && 'is-muted',
                post.status === 'CHANGED_AFTER_PUBLISH' && 'is-warning',
              )}
            >
              {publishState ? (
                publishState.tone === 'danger' ? (
                  <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
                ) : (
                  <IconoirSprite variant="iconoir" icon="RefreshCircle" aria-hidden />
                )
              ) : (
                renderStatusIcon(post)
              )}
              {visibleStatusLabel}
            </span>
          ) : null}
          <a
            className="vk-parsing-post-card__vk-link"
            href={post.url}
            target="_blank"
            rel="noreferrer"
            aria-label="Открыть пост VK"
            title="Открыть пост VK"
          >
            <IconoirSprite variant="iconoir" icon="OpenNewWindow" aria-hidden />
          </a>
        </div>
      </div>

      {blockedReason && !['Пост уже в очереди.', 'Пост отправляется.'].includes(blockedReason) ? (
        <div className="vk-parsing-post-card__issue" role="status">
          <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
          <span>{blockedReason}</span>
        </div>
      ) : null}

      {visiblePostIssue ? (
        <div className="vk-parsing-post-card__issue" role="status">
          <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
          <span>
            <strong>{visiblePostIssue.title}</strong>
            {visiblePostIssue.detail}
          </span>
        </div>
      ) : null}

      {isEditing ? (
        <Suspense
          fallback={
            <div
              className="vk-parsing-editor__loading"
              role="status"
              aria-label="Загрузка редактора"
            >
              <span />
              <span />
              <span />
            </div>
          }
        >
          <LazyPostEditor
            post={post}
            sourceLink={buildVkParsingSourceLink(post.url, settings)}
            draftText={draftText}
            draftTextFormat={draftTextFormat}
            selectedPhotoUrls={selectedPhotoUrls}
            selectedVideoUrls={selectedVideoUrls}
            selectedLinkUrls={selectedLinkUrls}
            stripLinksEnabled={settings.stripLinksEnabled}
            appendChannelLinkEnabled={
              postSignature.enabled && postSignature.presentation === 'signature'
            }
            channelLinkText={postSignature.text}
            channelLinkUrl={channelLinkUrl}
            customChannelLinkUrl={postSignature.url}
            preserveLinkUrls={
              unsupportedVideoFallbackUrl ? [unsupportedVideoFallbackUrl] : undefined
            }
            isPublishing={isPublishing}
            onDraftTextChange={onDraftTextChange}
            onTogglePhoto={onTogglePhoto}
            onToggleVideo={onToggleVideo}
            onToggleLink={onToggleLink}
            onCancel={onCancelEditing}
            onPublish={onPublishEditingPost}
            submitLabel={isReviewMode ? 'Сохранить' : 'Опубликовать'}
            pendingLabel={isReviewMode ? 'Сохраняем...' : 'Публикуем...'}
          />
        </Suspense>
      ) : (
        <>
          <MaxMarkdownPreview
            value={post.text}
            sourceFormat={post.textFormat}
            className={cn(
              'vk-parsing-post-card__text',
              !expanded && 'max-markdown-preview--clamp-3',
            )}
            fallback={
              post.photoUrls.length > 0
                ? 'Фото без текста'
                : videoCount > 0
                  ? 'Видео без текста'
                  : 'Без текста'
            }
          />
          {post.text.length > 160 || post.text.split('\n').length > 3 ? (
            <button
              type="button"
              className="vk-text-expand"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? 'Свернуть' : 'Читать полностью'}
            </button>
          ) : null}

          {post.photoUrls.length > 0 ? (
            <div
              className={cn(
                'vk-parsing-post-card__photos',
                photoCount === 1 && 'is-single',
                photoCount === 2 && 'is-pair',
              )}
            >
              {visiblePhotoUrls.map((url, index) => (
                <button
                  key={url}
                  type="button"
                  className="vk-parsing-post-card__photo"
                  aria-label={`Открыть фото ${index + 1}`}
                  onClick={() => setPhotoPreview({ urls: [...post.photoUrls], index })}
                >
                  {failedPhotos.includes(url) ? (
                    <span className="vk-photo-unavailable">
                      <IconoirSprite variant="iconoir" icon="Camera" aria-hidden />
                      <span>Фото недоступно</span>
                    </span>
                  ) : (
                    <img
                      src={url}
                      alt="Фото из поста VK"
                      loading="lazy"
                      onError={() =>
                        setFailedPhotos((current) =>
                          current.includes(url) ? current : [...current, url],
                        )
                      }
                    />
                  )}
                  {index === visiblePhotoUrls.length - 1 && extraPhotoCount > 0 ? (
                    <em>+{extraPhotoCount}</em>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}

          {videoCount > 0 ? <PostVideoPreview url={post.videoUrls[0]} /> : null}

          {unsupportedVideo ? (
            <div
              className={cn(
                'vk-parsing-post-card__unsupported-video',
                unsupportedVideoFallbackUrl && 'has-fallback-link',
              )}
              role="status"
            >
              <span>
                {unsupportedVideoFallbackUrl ? (
                  <IconoirSprite variant="iconoir" icon="Link" aria-hidden />
                ) : (
                  <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
                )}
              </span>
              <strong>
                {unsupportedVideoFallbackUrl
                  ? 'Видео будет опубликовано ссылкой'
                  : 'Видео недоступно'}
              </strong>
              <VkInfoButton title="О видео в этом посте">
                <p>
                  {unsupportedVideoFallbackUrl
                    ? 'VK не предоставил файл видео. Вместо него доступна ссылка на исходный пост.'
                    : 'VK не предоставил доступный файл видео. Остальные вложения и текст сохраняются.'}
                </p>
              </VkInfoButton>
              {unsupportedVideoFallbackUrl ? (
                <a
                  href={unsupportedVideoFallbackUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Открыть VK-клип"
                  title="Открыть VK-клип"
                >
                  <IconoirSprite variant="iconoir" icon="OpenNewWindow" aria-hidden />
                </a>
              ) : null}
            </div>
          ) : null}

          {isReviewMode ? (
            <div className="vk-parsing-review-state" role="status">
              <span className="vk-parsing-review-state__icon">
                <IconoirSprite variant="iconoir" icon="ShieldCheck" aria-hidden />
              </span>
              <strong>
                {post.sourcePublishMode === 'BOT_REVIEW' ? botReviewLabel : 'Ручная проверка'}
              </strong>
            </div>
          ) : (
            <div className="vk-parsing-post-card__facts">
              {photoCount > 0 ? (
                <span>
                  <IconoirSprite variant="iconoir" icon="Camera" aria-hidden />
                  {photoCount}
                </span>
              ) : null}
              {videoCount > 0 ? (
                <span>
                  <IconoirSprite variant="iconoir" icon="Play" aria-hidden />
                  {videoCount}
                </span>
              ) : null}
              {linkCount > 0 ? (
                <span>
                  <IconoirSprite variant="iconoir" icon="Link" aria-hidden />
                  {linkCount}
                </span>
              ) : null}
              {post.isAdvertising ? (
                <span
                  className="vk-parsing-status-pill is-warning"
                  title="В посте есть признаки рекламы"
                >
                  <IconoirSprite variant="iconoir" icon="ShieldCheck" aria-hidden />
                  Реклама
                </span>
              ) : null}
              {unsupportedSummary ? (
                <span title={unsupportedSummary}>
                  <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
                  {unsupportedSummary}
                </span>
              ) : null}
            </div>
          )}

          {post.botReview?.lastError ? (
            <p className="vk-parsing-post-card__issue" role="status">
              {normalizeApiError(new Error(post.botReview.lastError))}
            </p>
          ) : null}

          {post.deletedAt || post.autoDeleteAt ? (
            <div className="vk-parsing-post-card__facts">
              <span>
                <IconoirSprite icon="Timer" aria-hidden />
                {post.deletedAt
                  ? 'Удалён из MAX'
                  : `Удаление ${formatVkPostDate(post.autoDeleteAt)}`}
              </span>
            </div>
          ) : null}
          {!post.deletedAt &&
          (post.status === 'PUBLISHED' || post.status === 'CHANGED_AFTER_PUBLISH') &&
          post.publishedUrl ? (
            <div className="vk-parsing-post-card__actions">
              <a
                className="button button--ghost vk-parsing-action-button"
                href={post.publishedUrl}
                target="_blank"
                rel="noreferrer"
              >
                <IconoirSprite variant="iconoir" icon="OpenNewWindow" aria-hidden />
                MAX
              </a>
            </div>
          ) : null}

          {post.status !== 'PUBLISHED' &&
          post.status !== 'SKIPPED' &&
          post.status !== 'UNAVAILABLE' ? (
            <div className="vk-parsing-post-card__actions">
              {post.sourcePublishMode === 'BOT_REVIEW' &&
              post.status === 'NEW' &&
              !blockedReason &&
              (!post.botReview ||
                (post.botReview.status === 'PENDING' &&
                  post.botReview.deliveryState === 'ERROR')) &&
              onSendForBotReview ? (
                <button
                  type="button"
                  className="button button--ghost vk-parsing-action-button"
                  disabled={isSubmittingBotReview}
                  onClick={() => onSendForBotReview(post.id)}
                >
                  <IconoirSprite variant="iconoir" icon="ShieldCheck" aria-hidden />
                  {isSubmittingBotReview ? 'Отправляем...' : 'На согласование'}
                </button>
              ) : null}
              {post.status === 'FAILED' && !isReviewMode && !blockedReason ? (
                <button
                  type="button"
                  className="button button--ghost vk-parsing-action-button"
                  disabled={isRetrying}
                  onClick={() => onRetryPost(post.id)}
                >
                  <IconoirSprite variant="iconoir" icon="RefreshCircle" aria-hidden />
                  {isRetrying ? 'В очереди...' : 'Повторить'}
                </button>
              ) : null}
              <button
                type="button"
                className="button button--ghost vk-parsing-action-button vk-parsing-action-button--primary"
                disabled={
                  Boolean(blockedReason) ||
                  (post.sourcePublishMode === 'BOT_REVIEW' &&
                    (post.botReview?.status !== 'PENDING' ||
                      post.botReview.deliveryState === 'AMBIGUOUS'))
                }
                onPointerDown={() => void loadPostEditor()}
                onFocus={() => void loadPostEditor()}
                onClick={() => onStartEditing(post)}
              >
                <IconoirSprite variant="iconoir" icon="EditPencil" aria-hidden />
                {post.status === 'CHANGED_AFTER_PUBLISH'
                  ? 'Подготовить новый пост'
                  : 'Редактировать'}
              </button>
            </div>
          ) : null}
        </>
      )}
      {photoPreview ? (
        <Suspense fallback={null}>
          <LazyPhotoViewer
            urls={photoPreview.urls}
            initialIndex={photoPreview.index}
            onClose={() => setPhotoPreview(null)}
          />
        </Suspense>
      ) : null}
    </article>
  );
}
