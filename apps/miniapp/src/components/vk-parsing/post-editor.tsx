import { AppIcon as IconoirSprite } from '../ui/app-icon';

import {
  VK_PARSING_MAX_PUBLISH_TEXT_LENGTH,
  type VkParsingPost,
} from '@maxim/contracts/vk-parsing';
import { useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { MAX_MARKDOWN_TOOL_DEFINITIONS, type MaxMarkdownTool } from '../max-markdown-editor';
import { MaxRichTextEditor, type MaxRichTextEditorHandle } from '../max-rich-text-editor';
import { PostMediaPicker } from './post-media-picker';
import { measureVkParsingPublishTextLength } from './publish-text';

type PostEditorProps = {
  sourceLink?: { url: string; html: string } | null;
  post: VkParsingPost;
  draftText: string;
  draftTextFormat: VkParsingPost['textFormat'];
  selectedPhotoUrls: string[];
  selectedVideoUrls: string[];
  selectedLinkUrls: string[];
  stripLinksEnabled: boolean;
  appendChannelLinkEnabled: boolean;
  channelLinkText: string;
  channelLinkUrl?: string;
  customChannelLinkUrl?: string;
  preserveLinkUrls?: string[];
  isPublishing: boolean;
  submitLabel?: string;
  pendingLabel?: string;
  onDraftTextChange: (value: string) => void;
  onTogglePhoto: (url: string) => void;
  onToggleVideo: (url: string) => void;
  onToggleLink: (url: string) => void;
  onCancel: () => void;
  onPublish: () => void;
};

export function PostEditor({
  post,
  sourceLink,
  draftText,
  draftTextFormat,
  selectedPhotoUrls,
  selectedVideoUrls,
  selectedLinkUrls,
  stripLinksEnabled,
  appendChannelLinkEnabled,
  channelLinkText,
  channelLinkUrl,
  customChannelLinkUrl,
  preserveLinkUrls,
  isPublishing,
  submitLabel = 'Опубликовать',
  pendingLabel = 'Публикуем...',
  onDraftTextChange,
  onTogglePhoto,
  onToggleVideo,
  onToggleLink,
  onCancel,
  onPublish,
}: PostEditorProps) {
  const editorRef = useRef<MaxRichTextEditorHandle | null>(null);
  const [formatToolsOpen, setFormatToolsOpen] = useState(false);
  const [normalizationReady, setNormalizationReady] = useState(true);
  const measuredTextLength = measureVkParsingPublishTextLength({
    text: draftText,
    textFormat: draftTextFormat,
    linkUrls: selectedLinkUrls,
    stripLinksEnabled,
    appendChannelLinkEnabled,
    channelLinkText,
    channelLinkUrl,
    customChannelLinkUrl,
    preserveLinkUrls,
    sourceLinkHtml: sourceLink?.html,
  });
  const remainingLength = VK_PARSING_MAX_PUBLISH_TEXT_LENGTH - measuredTextLength;
  const isOverLimit = remainingLength < 0;
  const isEditorBusy = isPublishing || !normalizationReady;

  function applyTextModifier(tool: MaxMarkdownTool) {
    editorRef.current?.applyTool(tool);
  }

  return (
    <div className="vk-parsing-editor">
      <div className={cn('vk-parsing-editor__composer', isOverLimit && 'is-limit')}>
        <div className="vk-parsing-editor__message">
          <MaxRichTextEditor
            ref={editorRef}
            value={draftText}
            sourceFormat={draftTextFormat}
            onChange={onDraftTextChange}
            disabled={isPublishing}
            onNormalizationReadyChange={setNormalizationReady}
            maxLength={VK_PARSING_MAX_PUBLISH_TEXT_LENGTH}
            placeholder="Текст поста"
            ariaLabel="Текст VK-поста"
            className="vk-parsing-editor__rich-text"
          />

          {sourceLink ? (
            <a
              className="vk-parsing-editor__channel-link"
              href={sourceLink.url}
              target="_blank"
              rel="noreferrer"
            >
              Источник
            </a>
          ) : null}
          {appendChannelLinkEnabled ? (
            <span className="vk-parsing-editor__channel-link">
              <IconoirSprite variant="iconoir" icon="Link" aria-hidden />
              {channelLinkText}
            </span>
          ) : null}
        </div>

        <div className="vk-parsing-editor__format-bar">
          <button
            type="button"
            className={cn('vk-parsing-editor__format-toggle', formatToolsOpen && 'is-active')}
            disabled={isEditorBusy}
            aria-expanded={formatToolsOpen}
            aria-label="Форматирование"
            title="Форматирование"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setFormatToolsOpen((current) => !current)}
          >
            A
          </button>
          {remainingLength <= 120 ? (
            <span
              className={cn('vk-parsing-editor__counter', remainingLength < 0 && 'is-limit')}
              aria-live="polite"
            >
              {measuredTextLength}/{VK_PARSING_MAX_PUBLISH_TEXT_LENGTH}
            </span>
          ) : null}
        </div>

        {formatToolsOpen ? (
          <div
            className="vk-parsing-editor__format-tools"
            role="toolbar"
            aria-label="Форматирование MAX"
          >
            {MAX_MARKDOWN_TOOL_DEFINITIONS.map((tool) => (
              <button
                key={tool.id}
                type="button"
                className={cn(
                  'vk-parsing-editor__format-tool',
                  tool.id === 'italic' && 'is-italic',
                  tool.id === 'code' && 'is-code',
                )}
                disabled={isEditorBusy}
                title={tool.title}
                aria-label={tool.title}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyTextModifier(tool.id)}
              >
                {tool.id === 'link' ? (
                  <IconoirSprite variant="iconoir" icon="Link" aria-hidden />
                ) : (
                  tool.label
                )}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <PostMediaPicker
        photoUrls={post.photoUrls}
        videoUrls={post.videoUrls}
        linkUrls={post.linkUrls}
        selectedPhotoUrls={selectedPhotoUrls}
        selectedVideoUrls={selectedVideoUrls}
        selectedLinkUrls={selectedLinkUrls}
        stripLinksEnabled={stripLinksEnabled}
        disabled={isPublishing}
        onTogglePhoto={onTogglePhoto}
        onToggleVideo={onToggleVideo}
        onToggleLink={onToggleLink}
      />

      <div className="vk-parsing-post-card__actions">
        <button
          type="button"
          className="button button--ghost"
          disabled={isPublishing}
          onClick={onCancel}
        >
          <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
          Отмена
        </button>
        <button
          type="button"
          className="button button--accent"
          disabled={isEditorBusy || isOverLimit}
          onClick={onPublish}
        >
          <IconoirSprite variant="iconoir" icon="SendDiagonal" aria-hidden />
          {isPublishing ? pendingLabel : submitLabel}
        </button>
      </div>
    </div>
  );
}
