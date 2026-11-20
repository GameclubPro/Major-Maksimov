import { AppIcon as IconoirSprite } from './ui/app-icon';
import {
  type BroadcastImage,
  type BroadcastLinkButton,
  type BroadcastTextFormat,
} from '@maxim/contracts';

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import './broadcast-content-composer.css';
import { MAX_MARKDOWN_TOOL_DEFINITIONS, type MaxMarkdownTool } from './max-markdown-editor';
import { MaxRichTextEditor, type MaxRichTextEditorHandle } from './max-rich-text-editor';
import { cn } from '../lib/cn';
import {
  normalizeComposerBroadcastImages,
  resolveBroadcastImageMaxCount,
} from '../lib/broadcast-image-list';
import { prepareComposerImageFiles } from '../lib/broadcast-image-preparation';
import {
  buildBroadcastPreviewButtonRows,
  formatBroadcastButtonsPreview,
} from '../lib/broadcast-link-buttons';
import type { BroadcastSystemButtonPreview } from '../lib/broadcast-system-buttons';
import {
  captureFilePickerReturnState,
  openFileInputPicker,
  resolveFileInputActivationMode,
  restoreFilePickerReturnState,
  type FilePickerReturnState,
} from '../lib/file-input-picker';

type BroadcastContentComposerImage = {
  enabled: boolean;
  base64: string;
  mimeType: string;
  fileName: string;
};

type PreparingImagesState = {
  done: number;
  total: number;
};

function isBroadcastSystemButtonPreview(
  button: BroadcastLinkButton | BroadcastSystemButtonPreview,
): button is BroadcastSystemButtonPreview {
  return 'kind' in button;
}

export type BroadcastContentComposerProps = {
  className?: string;
  text: string;
  sourceFormat?: BroadcastTextFormat;
  maxLength: number;
  image?: BroadcastContentComposerImage;
  images?: BroadcastImage[];
  orderedMedia?: ReactNode;
  orderedMediaLabel?: string | null;
  retainedImages?: ReactNode;
  retainedImageCount?: number;
  maxImages?: number;
  allowImages?: boolean;
  buttons?: BroadcastLinkButton[];
  systemButtons?: BroadcastSystemButtonPreview[];
  buttonsStatusLabel?: string;
  buttonsActive?: boolean;
  buttonsError?: boolean;
  buttonsPerRow?: number;
  videoLabel?: string | null;
  disabled?: boolean;
  textError?: string;
  imageError?: string;
  messageAriaLabel?: string;
  textPlaceholder?: string;
  textAriaLabel?: string;
  showToolLabels?: boolean;
  toolbarPosition?: 'top' | 'bottom';
  showButtonsLabel?: boolean;
  additionalMediaAction?: ReactNode;
  onTextChange: (value: string) => void;
  onImageChange?: (image: BroadcastContentComposerImage) => void;
  onImagesChange?: (images: BroadcastImage[]) => void;
  onImagePreparationChange?: (preparing: boolean) => void;
  onOpenButtons?: () => void;
  onClearVideo?: () => void;
  onError?: (message: string) => void;
};

export function BroadcastContentComposer({
  className,
  text,
  sourceFormat = 'markdown',
  maxLength,
  image,
  images,
  retainedImages,
  orderedMedia,
  orderedMediaLabel,
  retainedImageCount = 0,
  maxImages,
  allowImages = true,
  buttons = [],
  systemButtons = [],
  buttonsStatusLabel = 'Без кнопки',
  buttonsActive = false,
  buttonsError = false,
  buttonsPerRow,
  videoLabel = null,
  disabled = false,
  textError = '',
  imageError = '',
  messageAriaLabel = 'Сообщение автопостинга',
  textPlaceholder = 'Текст',
  textAriaLabel = textPlaceholder,
  showToolLabels = false,
  toolbarPosition = 'bottom',
  showButtonsLabel = false,
  additionalMediaAction,
  onTextChange,
  onImageChange,
  onImagesChange,
  onImagePreparationChange,
  onOpenButtons,
  onClearVideo,
  onError,
}: BroadcastContentComposerProps) {
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const composerRootRef = useRef<HTMLDivElement | null>(null);
  const richTextEditorRef = useRef<MaxRichTextEditorHandle | null>(null);
  const preparationRunIdRef = useRef(0);
  const preparationAbortRef = useRef<AbortController | null>(null);
  const pickerReturnStateRef = useRef<FilePickerReturnState | null>(null);
  const pickerRestoreFrameRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const textErrorId = useId();
  const imageErrorId = useId();
  const preparationCallbackRef = useRef(onImagePreparationChange);
  preparationCallbackRef.current = onImagePreparationChange;
  const [formatToolsOpen, setFormatToolsOpen] = useState(false);
  const [activeTools, setActiveTools] = useState<ReadonlySet<MaxMarkdownTool>>(() => new Set());
  const [normalizationReady, setNormalizationReady] = useState(true);
  const [preparingImages, setPreparingImages] = useState<PreparingImagesState>({
    done: 0,
    total: 0,
  });
  const maxImageCount = resolveBroadcastImageMaxCount(
    maxImages ?? (images || onImagesChange ? undefined : 1),
  );
  const currentImages = useMemo(
    () =>
      normalizeComposerBroadcastImages(
        images ??
          (image?.enabled && image.base64 && image.mimeType
            ? [
                {
                  base64: image.base64,
                  mimeType: image.mimeType,
                  fileName: image.fileName,
                },
              ]
            : []),
        maxImageCount,
      ),
    [image?.base64, image?.enabled, image?.fileName, image?.mimeType, images, maxImageCount],
  );
  const imagePreviewItems = useMemo(
    () =>
      currentImages
        .filter((item) => item.base64 && item.mimeType)
        .slice(0, maxImageCount)
        .map((item, index) => ({
          ...item,
          index,
          url: `data:${item.mimeType};base64,${item.base64}`,
        })),
    [currentImages, maxImageCount],
  );
  const pendingImageSlots = Math.max(0, preparingImages.total - preparingImages.done);
  const previewImageCount = imagePreviewItems.length + retainedImageCount;
  const normalizedText = text.trim();
  const previewButtons = buttons.filter((button) => button.text.trim());
  const previewSystemButtons = systemButtons.filter((button) => button.text.trim());
  const previewButtonRows = buildBroadcastPreviewButtonRows(
    previewButtons,
    previewSystemButtons,
    buttonsPerRow,
  );
  const previewButtonCount = previewButtons.length + previewSystemButtons.length;
  const previewButtonLabel = formatBroadcastButtonsPreview([
    ...previewButtons,
    ...previewSystemButtons,
  ]);
  const customButtonLabel = formatBroadcastButtonsPreview(previewButtons);
  const openButtonsCount = showButtonsLabel ? previewButtons.length : previewButtonCount;
  const openButtonsLabel =
    openButtonsCount > 0
      ? `Кнопки: ${showButtonsLabel ? customButtonLabel : previewButtonLabel}`
      : buttonsStatusLabel;
  const hasPreview = Boolean(normalizedText || previewImageCount > 0 || videoLabel);
  const remainingLength = maxLength - text.length;
  const isNearTextLimit =
    remainingLength >= 0 && remainingLength <= Math.min(120, maxLength * 0.08);
  const showTextCounter = text.length > 0 && (isNearTextLimit || remainingLength < 0);
  const isPreparingImage = pendingImageSlots > 0;
  const editorDisabled = disabled;
  const isBusy = disabled || isPreparingImage || !normalizationReady;
  const useNativeTapFileInput =
    resolveFileInputActivationMode(
      typeof document === 'undefined' ? undefined : document.documentElement.dataset.maxPlatform,
    ) === 'native-tap';

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      preparationRunIdRef.current += 1;
      if (preparationAbortRef.current) preparationCallbackRef.current?.(false);
      preparationAbortRef.current?.abort();
      preparationAbortRef.current = null;
      if (pickerRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(pickerRestoreFrameRef.current);
      }
    };
  }, []);

  function emitImages(nextImages: BroadcastImage[]) {
    const normalizedImages = nextImages
      .filter((item) => item.base64.trim() && item.mimeType.trim())
      .slice(0, maxImageCount);
    onImagesChange?.(normalizedImages);
    const firstImage = normalizedImages[0];
    onImageChange?.({
      enabled: Boolean(firstImage),
      base64: firstImage?.base64 ?? '',
      mimeType: firstImage?.mimeType ?? '',
      fileName: firstImage?.fileName ?? '',
    });
  }

  function updatePreparingImages(nextState: PreparingImagesState) {
    if (!mountedRef.current) {
      return;
    }
    setPreparingImages(nextState);
    onImagePreparationChange?.(nextState.total > nextState.done);
  }

  function rememberImagePickerReturn() {
    if (!pickerReturnStateRef.current) {
      pickerReturnStateRef.current = captureFilePickerReturnState(
        undefined,
        undefined,
        composerRootRef.current?.closest<HTMLElement>('.publications-editor') ?? null,
      );
    }
  }

  function restoreImagePickerReturn() {
    const returnState = pickerReturnStateRef.current;
    pickerReturnStateRef.current = null;
    if (!returnState) {
      return;
    }
    if (pickerRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(pickerRestoreFrameRef.current);
    }
    pickerRestoreFrameRef.current = window.requestAnimationFrame(() => {
      pickerRestoreFrameRef.current = null;
      if (mountedRef.current) {
        restoreFilePickerReturnState(returnState);
      }
    });
  }

  function openImagePicker() {
    rememberImagePickerReturn();
    openFileInputPicker(imageInputRef.current);
  }

  useEffect(() => {
    const input = imageInputRef.current;
    if (!input) {
      return undefined;
    }
    const handlePickerCancel = () => restoreImagePickerReturn();
    input.addEventListener('cancel', handlePickerCancel);
    return () => input.removeEventListener('cancel', handlePickerCancel);
  }, [useNativeTapFileInput]);

  async function handleImageFiles(files: FileList | File[] | null) {
    restoreImagePickerReturn();
    if (!allowImages) {
      onError?.('Сначала уберите одно из добавленных фото.');
      return;
    }

    const selectedFiles = Array.from(files ?? []);
    if (selectedFiles.length === 0) {
      return;
    }

    if (preparationAbortRef.current && !preparationAbortRef.current.signal.aborted) {
      onError?.('Дождитесь завершения подготовки выбранных фото.');
      return;
    }

    const freeSlots = maxImageCount - imagePreviewItems.length;
    if (freeSlots <= 0) {
      onError?.(`Можно добавить до ${maxImageCount} фото.`);
      if (imageInputRef.current) {
        imageInputRef.current.value = '';
      }
      return;
    }

    const filesToPrepare = selectedFiles.slice(0, freeSlots);
    if (selectedFiles.length > freeSlots) {
      onError?.(`Можно добавить до ${maxImageCount} фото.`);
    }

    const controller = new AbortController();
    const runId = preparationRunIdRef.current + 1;
    preparationRunIdRef.current = runId;
    preparationAbortRef.current = controller;
    const isCurrentRun = () =>
      mountedRef.current &&
      preparationRunIdRef.current === runId &&
      preparationAbortRef.current === controller &&
      !controller.signal.aborted;

    updatePreparingImages({ done: 0, total: filesToPrepare.length });
    try {
      const result = await prepareComposerImageFiles({
        files: filesToPrepare,
        currentImages,
        maxImageCount,
        signal: controller.signal,
        onProgress: (progress) => {
          if (isCurrentRun()) {
            updatePreparingImages(progress);
          }
        },
        onImagesReady: (nextImages) => {
          if (isCurrentRun()) {
            emitImages(nextImages);
          }
        },
      });

      if (!isCurrentRun() || result.aborted) {
        return;
      }
      if (result.duplicateCount > 0 && result.addedCount === 0) {
        onError?.('Это фото уже добавлено.');
      } else if (result.duplicateCount > 0) {
        onError?.('Повторяющиеся фото пропущены.');
      }
      if (result.limitCount > 0) {
        onError?.(`Можно добавить до ${maxImageCount} фото.`);
      }
      if (result.oversizedCount > 0) {
        onError?.('Суммарный размер фото слишком большой.');
      }
      if (result.failedMessages.length > 0) {
        if (result.addedCount > 0) {
          onError?.(
            `Не удалось подготовить ${result.failedMessages.length} фото. Остальные добавлены.`,
          );
        } else {
          onError?.(result.failedMessages[0] ?? 'Не удалось подготовить фото.');
        }
      }
    } catch (error) {
      if (isCurrentRun()) {
        onError?.(error instanceof Error ? error.message : 'Не удалось подготовить фото.');
      }
    } finally {
      if (isCurrentRun()) {
        preparationAbortRef.current = null;
        updatePreparingImages({ done: 0, total: 0 });
        if (imageInputRef.current) {
          imageInputRef.current.value = '';
        }
      }
    }
  }

  function removeImage(imageIndex: number) {
    emitImages(currentImages.filter((_, index) => index !== imageIndex));
  }

  function cancelImagePreparation() {
    preparationAbortRef.current?.abort();
    preparationAbortRef.current = null;
    preparationRunIdRef.current += 1;
    updatePreparingImages({ done: 0, total: 0 });
    if (imageInputRef.current) imageInputRef.current.value = '';
  }

  function applyTextModifier(tool: MaxMarkdownTool) {
    richTextEditorRef.current?.applyTool(tool);
  }

  const toolbar = (
    <div className="broadcast-content-composer__toolbar">
      <div className="broadcast-content-composer__bar">
        <div
          className="broadcast-content-composer__media-actions"
          role="group"
          aria-label="Инструменты сообщения"
        >
          <button
            type="button"
            className={cn(
              'broadcast-content-composer__tool',
              'broadcast-content-composer__tool--format',
              showToolLabels && 'has-label',
              formatToolsOpen && 'is-active',
            )}
            onClick={() => setFormatToolsOpen((current) => !current)}
            disabled={isBusy}
            aria-expanded={formatToolsOpen}
            aria-label="Форматирование"
            title="Форматирование"
          >
            A
            {showToolLabels ? (
              <span className="broadcast-content-composer__tool-label">Формат</span>
            ) : null}
          </button>
          {useNativeTapFileInput ? (
            <label
              className={cn(
                'broadcast-content-composer__tool',
                'broadcast-content-composer__tool--native-file',
                showToolLabels && 'has-label',
                imagePreviewItems.length > 0 && 'is-active',
                (!allowImages || isBusy || imagePreviewItems.length >= maxImageCount) &&
                  'is-disabled',
              )}
              aria-label={isPreparingImage ? 'Готовим фото' : 'Добавить фото'}
              title={isPreparingImage ? 'Готовим фото' : 'Добавить фото'}
              aria-disabled={!allowImages || isBusy || imagePreviewItems.length >= maxImageCount}
              onPointerDown={rememberImagePickerReturn}
            >
              <IconoirSprite variant="iconoir" icon="Camera" aria-hidden focusable="false" />
              {showToolLabels ? (
                <span className="broadcast-content-composer__tool-label">Фото</span>
              ) : null}
              <input
                ref={imageInputRef}
                className="broadcast-content-composer__file-input broadcast-content-composer__file-input--native"
                type="file"
                accept="image/*"
                aria-invalid={Boolean(imageError) || undefined}
                aria-describedby={imageError ? imageErrorId : undefined}
                multiple={maxImageCount > 1}
                disabled={!allowImages || isBusy || imagePreviewItems.length >= maxImageCount}
                onChange={(event) => void handleImageFiles(event.currentTarget.files)}
                aria-label={isPreparingImage ? 'Готовим фото' : 'Добавить фото'}
              />
            </label>
          ) : (
            <>
              <button
                type="button"
                className={cn(
                  'broadcast-content-composer__tool',
                  showToolLabels && 'has-label',
                  imagePreviewItems.length > 0 && 'is-active',
                )}
                onPointerDown={rememberImagePickerReturn}
                onClick={openImagePicker}
                disabled={!allowImages || isBusy || imagePreviewItems.length >= maxImageCount}
                aria-label={isPreparingImage ? 'Готовим фото' : 'Добавить фото'}
                title={isPreparingImage ? 'Готовим фото' : 'Добавить фото'}
              >
                <IconoirSprite variant="iconoir" icon="Camera" aria-hidden focusable="false" />
                {showToolLabels ? (
                  <span className="broadcast-content-composer__tool-label">Фото</span>
                ) : null}
              </button>
              <input
                ref={imageInputRef}
                className="broadcast-content-composer__file-input"
                type="file"
                accept="image/*"
                aria-invalid={Boolean(imageError) || undefined}
                aria-describedby={imageError ? imageErrorId : undefined}
                multiple={maxImageCount > 1}
                disabled={!allowImages || isBusy}
                onChange={(event) => void handleImageFiles(event.currentTarget.files)}
                tabIndex={-1}
              />
            </>
          )}
          {additionalMediaAction}
          {onOpenButtons ? (
            <button
              type="button"
              className={cn(
                'broadcast-content-composer__tool',
                'broadcast-content-composer__tool--buttons',
                (showToolLabels || showButtonsLabel) && 'has-label',
                buttonsActive && 'is-active',
                buttonsError && 'is-danger',
              )}
              onClick={onOpenButtons}
              disabled={isBusy}
              aria-label={buttonsActive ? openButtonsLabel : 'Добавить кнопки'}
              title={buttonsActive ? openButtonsLabel : 'Добавить кнопки'}
            >
              <IconoirSprite variant="iconoir" icon="Link" aria-hidden focusable="false" />
              {showToolLabels || showButtonsLabel ? (
                <span className="broadcast-content-composer__tool-label">
                  {buttonsActive && previewButtons.length > 0
                    ? `Кнопки · ${previewButtons.length}`
                    : 'Кнопка'}
                </span>
              ) : null}
            </button>
          ) : null}
        </div>

        <span className="broadcast-content-composer__asset-strip">
          {isPreparingImage ? (
            <button
              type="button"
              className="broadcast-content-composer__tool"
              onClick={cancelImagePreparation}
              aria-label="Отменить подготовку фото"
              title="Отменить подготовку фото"
            >
              <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden focusable="false" />
            </button>
          ) : null}
          {isPreparingImage || previewImageCount > 0 || videoLabel ? (
            <span className="broadcast-content-composer__media-label" aria-live="polite">
              {isPreparingImage
                ? `${preparingImages.done}/${preparingImages.total}`
                : (orderedMediaLabel ??
                  (previewImageCount ? `${previewImageCount} фото` : videoLabel))}
            </span>
          ) : null}
          {onOpenButtons && buttonsActive && !showToolLabels && !showButtonsLabel ? (
            <button
              type="button"
              className={cn(
                'broadcast-content-composer__button-label',
                buttonsError && 'is-danger',
              )}
              onClick={onOpenButtons}
              disabled={isBusy}
              title={openButtonsLabel}
            >
              {previewButtonCount > 0 ? previewButtonLabel : buttonsStatusLabel}
            </button>
          ) : null}
        </span>
      </div>

      {formatToolsOpen ? (
        <div className="broadcast-content-composer__modifier-row" aria-label="Форматирование">
          {MAX_MARKDOWN_TOOL_DEFINITIONS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className={cn(
                'broadcast-content-composer__modifier',
                activeTools.has(tool.id) && 'is-active',
                tool.id === 'italic' && 'is-italic',
                tool.id === 'code' && 'is-code',
              )}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => applyTextModifier(tool.id)}
              disabled={isBusy}
              title={tool.title}
              aria-label={tool.title}
              aria-pressed={
                ['bold', 'italic', 'underline', 'strike'].includes(tool.id)
                  ? activeTools.has(tool.id)
                  : undefined
              }
            >
              {tool.id === 'link' ? (
                <IconoirSprite variant="iconoir" icon="Link" aria-hidden focusable="false" />
              ) : (
                tool.label
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <div
      ref={composerRootRef}
      className={cn(
        'broadcast-content-composer',
        className,
        hasPreview && 'has-preview',
        !hasPreview && 'is-empty',
        previewButtonRows.length > 0 && 'has-buttons',
        (textError || imageError) && 'field--error',
      )}
      aria-busy={isPreparingImage || undefined}
    >
      <div
        className={cn(
          'broadcast-content-composer__workspace',
          'broadcast-content-composer__workspace--rich',
          hasPreview && 'has-preview',
        )}
      >
        <div className="broadcast-content-composer__editor broadcast-content-composer__editor--rich">
          {toolbarPosition === 'top' ? toolbar : null}
          {showTextCounter ? (
            <div className="broadcast-content-composer__editor-head">
              <span
                className={cn(
                  'broadcast-content-composer__counter',
                  isNearTextLimit && 'is-warning',
                  remainingLength < 0 && 'is-limit',
                )}
                aria-live="polite"
              >
                {text.length}/{maxLength}
              </span>
            </div>
          ) : null}

          <div
            className={cn(
              'broadcast-message-card',
              'broadcast-message-card--editable',
              !hasPreview && 'is-empty',
            )}
            aria-label={messageAriaLabel}
          >
            <div className="broadcast-message-card__phone">
              <div className="broadcast-message-card__bubble">
                {orderedMedia ??
                  (previewImageCount > 0 || pendingImageSlots > 0 ? (
                    <div
                      className={cn(
                        'broadcast-message-card__media-grid',
                        `is-count-${Math.min(maxImageCount + retainedImageCount, previewImageCount + pendingImageSlots)}`,
                      )}
                    >
                      {retainedImages}
                      {imagePreviewItems.map((item) => (
                        <figure
                          key={`${item.fileName}-${item.index}`}
                          className="broadcast-message-card__media-frame"
                        >
                          <img className="broadcast-message-card__image" src={item.url} alt="" />
                          <button
                            type="button"
                            className="broadcast-message-card__media-remove"
                            onClick={() => removeImage(item.index)}
                            disabled={isBusy}
                            aria-label={`Убрать фото ${item.index + 1}`}
                            title={`Убрать фото ${item.index + 1}`}
                          >
                            <IconoirSprite
                              variant="iconoir"
                              icon="Xmark"
                              aria-hidden
                              focusable="false"
                            />
                          </button>
                        </figure>
                      ))}
                      {Array.from({ length: pendingImageSlots }, (_, index) => (
                        <span
                          key={`pending-image-${index}`}
                          className="broadcast-message-card__media-frame broadcast-message-card__media-frame--loading"
                          aria-hidden
                        />
                      ))}
                    </div>
                  ) : null)}

                {videoLabel ? (
                  <span className="broadcast-message-card__video-preview">
                    {videoLabel}
                    {onClearVideo ? (
                      <button
                        type="button"
                        className="broadcast-message-card__media-remove"
                        onClick={onClearVideo}
                        disabled={isBusy}
                        aria-label="Убрать видео"
                        title="Убрать видео"
                      >
                        <IconoirSprite
                          variant="iconoir"
                          icon="Xmark"
                          aria-hidden
                          focusable="false"
                        />
                      </button>
                    ) : null}
                  </span>
                ) : null}

                <MaxRichTextEditor
                  ref={richTextEditorRef}
                  value={text}
                  sourceFormat={sourceFormat}
                  onChange={onTextChange}
                  maxLength={maxLength}
                  placeholder={textPlaceholder}
                  disabled={editorDisabled}
                  onNormalizationReadyChange={setNormalizationReady}
                  onActiveToolsChange={setActiveTools}
                  ariaLabel={textAriaLabel}
                  ariaInvalid={Boolean(textError)}
                  ariaDescribedBy={textError ? textErrorId : undefined}
                  className="broadcast-message-card__rich-editor"
                  onPasteFiles={(files) => void handleImageFiles(files)}
                />

                {previewButtonRows.length > 0 ? (
                  <div className="broadcast-message-card__buttons">
                    {previewButtonRows.map((row, rowIndex) => (
                      <div
                        key={`preview-row-${rowIndex}`}
                        className="broadcast-message-card__button-row"
                      >
                        {row.map((button, buttonIndex) => {
                          const isSystemButton = isBroadcastSystemButtonPreview(button);

                          return (
                            <span
                              key={`${rowIndex}-${buttonIndex}-${button.text}-${
                                isSystemButton ? button.kind : button.url
                              }`}
                              className={cn(
                                'broadcast-message-card__button',
                                isSystemButton && 'is-system',
                              )}
                            >
                              {button.text.trim()}
                            </span>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                ) : null}

                <span className="broadcast-message-card__tail" />
                <span className="broadcast-message-card__checks" />
              </div>
            </div>
          </div>

          {toolbarPosition === 'bottom' ? toolbar : null}
        </div>
      </div>

      {textError ? (
        <small id={textErrorId} className="field__hint" role="alert">
          {textError}
        </small>
      ) : null}
      {imageError ? (
        <small id={imageErrorId} className="field__hint" role="alert">
          {imageError}
        </small>
      ) : null}
    </div>
  );
}

export default BroadcastContentComposer;
