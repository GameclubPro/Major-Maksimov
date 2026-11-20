import { formatPublicationMediaSummary } from './publication-page-formatters';
import type { PublicationVideoRead } from './publication-remote-video';
import { AppIcon as IconoirSprite } from '../../components/ui/app-icon';
import type { BroadcastLinkButton } from '@maxim/contracts';
import { MAX_PUBLICATION_IMAGES } from '@maxim/contracts/publication';
import type { PublisherPostImportOmission } from '@maxim/contracts/publisher';
import { useId, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';

import { BroadcastContentComposer } from '../../components/broadcast-content-composer';
import type { BroadcastSystemButtonPreview } from '../../lib/broadcast-system-buttons';
import { describeUserFacingError } from '../../lib/user-facing-error';
import type { PublicationVideoUploadProgress } from '../../lib/api/publication-video-upload';
import { PublicationImportButtonsNotice } from './publication-import-buttons-notice';
import {
  getPublicationTargetKey,
  getPublicationTargetTitle,
  PUBLICATION_TEXT_MAX_LENGTH,
  type PublicationDraft,
  type PublicationTarget,
} from './publication-model';
import { PublicationImportReviewPanel } from './publication-import-review';
import { restoreImportAsset } from './publication-album';
import { PublicationAlbumEditor } from './publication-album-editor';
import { publicationAlbum, withAlbumPhotos } from './publication-album';
import type { PublisherPostImportAssetPreview } from './use-publisher-post-import-asset-previews';
import { PublicationVideoTool } from './publication-video-tool';
import './publication-content-editor-section.css';

type PublicationContentEditorSectionProps = {
  sectionRef: RefObject<HTMLElement | null>;
  draft: PublicationDraft;
  setDraft: Dispatch<SetStateAction<PublicationDraft>>;
  importOmissions: PublisherPostImportOmission[];
  importing: boolean;
  videoRead: PublicationVideoRead;
  importedAssetPreviews: readonly PublisherPostImportAssetPreview[];
  customButtons: BroadcastLinkButton[];
  systemButtons: BroadcastSystemButtonPreview[];
  previewTargets: readonly PublicationTarget[];
  previewTargetKey: string | null;
  customButtonCount: number;
  hasButtonErrors: boolean;
  showButtonsLabel: boolean;
  isBusy: boolean;
  operationBusy: boolean;
  imagesNeedReselection: boolean;
  missingImageCount: number;
  retainedVideo: boolean;
  videoPreparing: boolean;
  videoUploadProgress?: PublicationVideoUploadProgress | null;
  onCancelVideoUpload?: () => void;
  videoNeedsReselection: boolean;
  fieldError: string;
  onDiscardMissingImages: () => void;
  onResolveMissingImages: (currentImageCount: number) => void;
  onPreviewTargetChange: (targetKey: string) => void;
  onOpenButtons: () => void;
  onVideoFile: (
    file: File | undefined,
    replaceKey?: string,
    warningIndex?: number,
  ) => Promise<void>;
  onImagePreparationChange: (preparing: boolean) => void;
  onFieldError: (message: string) => void;
  onInfo: (message: string) => void;
};

export function PublicationContentEditorSection({
  sectionRef,
  draft,
  setDraft,
  importOmissions,
  importing,
  importedAssetPreviews,
  videoRead,
  customButtons,
  systemButtons,
  previewTargets,
  previewTargetKey,
  customButtonCount,
  hasButtonErrors,
  showButtonsLabel,
  isBusy,
  operationBusy,
  imagesNeedReselection,
  missingImageCount,
  retainedVideo,
  videoPreparing,
  videoUploadProgress,
  onCancelVideoUpload,
  videoNeedsReselection,
  fieldError,
  onDiscardMissingImages,
  onResolveMissingImages,
  onPreviewTargetChange,
  onOpenButtons,
  onVideoFile,
  onImagePreparationChange,
  onFieldError,
  onInfo,
}: PublicationContentEditorSectionProps) {
  const [videoError, setVideoError] = useState('');
  const videoErrorId = useId();
  const album = publicationAlbum(draft);
  const albumSize = album.length;
  const videoCount = album.filter((item) => item.type === 'video').length;
  const retainedImageCount = albumSize - draft.images.length;
  const maxLocalImageCount = Math.max(0, MAX_PUBLICATION_IMAGES - retainedImageCount);
  const imageInputAllowed = albumSize < MAX_PUBLICATION_IMAGES;
  const videoBlockedReason =
    missingImageCount > 0
      ? 'Сначала завершите восстановление фото'
      : albumSize >= MAX_PUBLICATION_IMAGES
        ? 'В альбоме уже 10 вложений'
        : null;

  async function handleVideoFile(file: File | undefined): Promise<void> {
    if (!file) {
      return;
    }
    setVideoError('');
    try {
      await onVideoFile(file);
    } catch (error) {
      setVideoError(
        error instanceof Error && error.name === 'AbortError'
          ? 'Загрузка видео отменена.'
          : describeUserFacingError(error, 'Не удалось подготовить видео. Повторите выбор.'),
      );
    }
  }

  async function restoreWarningFile(file: File, index: number) {
    const warning = draft.importReview?.warnings[index];
    if (!warning || isBusy) return;
    setVideoError('');
    try {
      if (publicationAlbum(draft).length >= MAX_PUBLICATION_IMAGES)
        throw new Error('В альбоме уже 10 вложений');
      if (warning.kind === 'video') {
        await onVideoFile(file, undefined, index);
      } else {
        onImagePreparationChange(true);
        const { prepareComposerImageFiles } = await import('../../lib/broadcast-image-preparation');
        const prepared = await prepareComposerImageFiles({
          files: [file],
          currentImages: draft.images,
          signal: new AbortController().signal,
        });
        if (!prepared.addedCount)
          throw new Error(
            prepared.failedMessages[0] || 'Фото не добавлено. Проверьте размер и повторы.',
          );
        setDraft((current) =>
          restoreImportAsset(current, index, { photo: prepared.images.at(-1)! }),
        );
      }
    } catch (error) {
      setVideoError(describeUserFacingError(error, 'Не удалось восстановить вложение.'));
    } finally {
      if (warning.kind !== 'video') onImagePreparationChange(false);
    }
  }

  return (
    <section
      ref={sectionRef}
      className="publication-editor-section publication-editor-section--content"
    >
      <div className="publication-editor-section__head">
        <strong>Пост</strong>
        {previewTargets.length > 1 ? (
          <select
            className="publication-editor-section__preview-target"
            value={previewTargetKey ?? ''}
            disabled={isBusy}
            aria-label="Получатель в предпросмотре"
            onChange={(event) => onPreviewTargetChange(event.currentTarget.value)}
          >
            {previewTargets.map((target) => (
              <option key={getPublicationTargetKey(target)} value={getPublicationTargetKey(target)}>
                {getPublicationTargetTitle(target)}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {draft.timingMode === 'schedule' ? (
        <input
          className="publication-title-input"
          value={draft.title}
          maxLength={120}
          placeholder="Название расписания"
          aria-label="Название расписания"
          onChange={(event) => {
            const title = event.currentTarget.value;
            setDraft((current) => ({ ...current, title }));
          }}
          disabled={isBusy}
        />
      ) : null}
      <PublicationImportReviewPanel
        draft={draft}
        setDraft={setDraft}
        busy={isBusy}
        onRestore={restoreWarningFile}
      />
      <PublicationImportButtonsNotice
        omissions={draft.importReview?.omissions ?? (importing ? importOmissions : [])}
        customButtonCount={customButtonCount}
        disabled={isBusy}
        onAdd={onOpenButtons}
      />
      {imagesNeedReselection ? (
        <div className="publications-inline-notice is-warning" role="alert">
          <span>
            {missingImageCount > 1
              ? `Не удалось восстановить ${missingImageCount} фото. Добавьте их снова.`
              : 'Не удалось восстановить фото. Добавьте его снова.'}
          </span>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => {
              onDiscardMissingImages();
              onFieldError('');
            }}
          >
            {draft.images.length > 0 ? 'Оставить выбранные' : 'Без фото'}
          </button>
        </div>
      ) : null}
      <BroadcastContentComposer
        className="publication-content-composer"
        text={draft.text}
        sourceFormat={draft.textFormat}
        maxLength={PUBLICATION_TEXT_MAX_LENGTH}
        images={draft.images}
        retainedImageCount={retainedImageCount}
        orderedMediaLabel={formatPublicationMediaSummary({
          mediaCount: albumSize,
          videoCount,
          hasVideo: videoCount > 0,
        })}
        orderedMedia={
          albumSize ? (
            <PublicationAlbumEditor
              draft={draft}
              setDraft={setDraft}
              previews={importedAssetPreviews}
              videoRead={videoRead}
              busy={isBusy}
              onVideoFile={onVideoFile}
              onPreparing={onImagePreparationChange}
              onError={setVideoError}
            />
          ) : undefined
        }
        maxImages={Math.max(1, maxLocalImageCount)}
        allowImages={imageInputAllowed}
        buttons={customButtons}
        systemButtons={systemButtons}
        buttonsPerRow={1}
        buttonsStatusLabel="Кнопка"
        buttonsActive={customButtonCount > 0}
        buttonsError={hasButtonErrors}
        showButtonsLabel={showButtonsLabel}
        showToolLabels
        toolbarPosition="top"
        additionalMediaAction={
          <PublicationVideoTool
            showLabel
            active={draft.mediaType === 'video' || retainedVideo}
            disabled={isBusy || videoPreparing}
            preparing={videoPreparing}
            needsReselection={videoNeedsReselection}
            errorId={videoError ? videoErrorId : undefined}
            blockedReason={videoBlockedReason}
            onFile={handleVideoFile}
            onBlocked={() => videoBlockedReason && onInfo(videoBlockedReason)}
          />
        }
        videoLabel={null}
        disabled={operationBusy}
        textError={
          fieldError.includes('текст') ||
          fieldError.includes('фото') ||
          fieldError.includes('видео')
            ? fieldError
            : ''
        }
        textPlaceholder="Текст публикации"
        messageAriaLabel="Текст публикации"
        onTextChange={(text) => {
          setDraft((current) => ({ ...current, text, textFormat: 'markdown' }));
          onFieldError('');
        }}
        onImagesChange={(images) => {
          setVideoError('');
          onResolveMissingImages(images.length);
          setDraft((current) => withAlbumPhotos(current, images));
          onFieldError('');
        }}
        onImagePreparationChange={onImagePreparationChange}
        onOpenButtons={onOpenButtons}
        onError={onInfo}
      />
      {videoPreparing ? (
        <div className="publication-video-upload" role="status">
          <span>
            {videoUploadProgress?.processing
              ? 'Обработка видео в MAX'
              : `Загрузка видео: ${videoUploadProgress?.percent ?? 0}%`}
          </span>
          <button
            type="button"
            onClick={onCancelVideoUpload}
            aria-label="Отменить загрузку видео"
            title="Отменить загрузку видео"
          >
            <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
          </button>
        </div>
      ) : null}
      {videoError ? (
        <p
          id={videoErrorId}
          className="publication-field-error publication-video-error"
          role="alert"
        >
          {videoError}
        </p>
      ) : null}
    </section>
  );
}
