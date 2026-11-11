import { AppIcon as IconoirSprite } from './ui/app-icon';
import type { ChannelDialogMessage } from '@maxim/contracts/channel-dialog';

import { resolveSuggestionStatus } from '../lib/channel-suggestion-status';
import { cn } from '../lib/cn';
import { openLink } from '../lib/max-bridge';
import { MaxMarkdownPreview } from './max-markdown-preview';

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
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

export default function ChannelSuggestionHistory({
  messages,
}: {
  messages: ChannelDialogMessage[];
}) {
  return (
    <div className="channel-suggest-list channel-suggest-list--history">
      {messages
        .slice()
        .reverse()
        .map((message) => {
          const status = resolveSuggestionStatus(message);
          const suggestionText = message.text.trim();
          const hasSuggestionText = suggestionText.length > 0;
          const hasMedia =
            message.hasImage ||
            message.hasVideo ||
            Boolean(message.imageFileName || message.videoFileName);

          return (
            <article key={message.id} className={cn('channel-suggest-card', `is-${status.tone}`)}>
              <div className="channel-suggest-card__head">
                <span className={cn('channel-suggest-status', `is-${status.tone}`)}>
                  {status.badge}
                </span>
                <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
              </div>

              {hasSuggestionText ? (
                <p>
                  {message.textFormat === 'markdown' ? (
                    <MaxMarkdownPreview
                      value={message.text}
                      preserveLinks
                      fallback={suggestionText}
                    />
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
                  onClick={(event) => {
                    if (
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    ) {
                      return;
                    }
                    try {
                      if (openLink(event.currentTarget.href) !== 'noop') event.preventDefault();
                    } catch {
                      // Keep ordinary navigation available if the native bridge fails.
                    }
                  }}
                >
                  Открыть пост
                </a>
              ) : null}
            </article>
          );
        })}
    </div>
  );
}
