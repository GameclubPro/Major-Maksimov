import { useId, useRef, useState } from 'react';
import { AppIcon as IconoirSprite } from '../ui/app-icon';

import { cn } from '../../lib/cn';
import { PostVideoChoice } from './post-video-preview';

type PostMediaPickerProps = {
  photoUrls: string[];
  videoUrls: string[];
  linkUrls: string[];
  selectedPhotoUrls: string[];
  selectedVideoUrls: string[];
  selectedLinkUrls: string[];
  stripLinksEnabled: boolean;
  disabled: boolean;
  onTogglePhoto: (url: string) => void;
  onToggleVideo: (url: string) => void;
  onToggleLink: (url: string) => void;
};

export function PostPhotoChoice({
  url,
  index,
  checked,
  disabled,
  onToggle,
}: {
  url: string;
  index: number;
  checked: boolean;
  disabled: boolean;
  onToggle: (url: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const errorId = useId();
  const choiceRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div className="vk-parsing-photo-option">
      <button
        ref={choiceRef}
        type="button"
        className={cn('vk-parsing-photo-choice', checked && 'is-selected')}
        aria-pressed={checked}
        aria-describedby={failed ? errorId : undefined}
        aria-label={`${checked ? 'Убрать' : 'Вернуть'} фото ${index + 1}`}
        title={checked ? 'Убрать фото' : 'Вернуть фото'}
        disabled={disabled}
        onClick={() => onToggle(url)}
      >
        {failed ? (
          <span id={errorId} className="vk-parsing-photo-choice__unavailable">
            Фото {index + 1} недоступно
          </span>
        ) : (
          <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
        )}
        <IconoirSprite variant="iconoir" icon="Camera" aria-hidden />
      </button>
      {failed ? (
        <button
          type="button"
          className="vk-parsing-photo-option__retry"
          aria-label={`Повторить загрузку фото ${index + 1}`}
          disabled={disabled}
          onClick={(event) => {
            if (document.activeElement === event.currentTarget) choiceRef.current?.focus();
            setFailed(false);
          }}
        >
          Повторить
        </button>
      ) : null}
    </div>
  );
}

export function PostMediaPicker({
  photoUrls,
  videoUrls,
  linkUrls,
  selectedPhotoUrls,
  selectedVideoUrls,
  selectedLinkUrls,
  stripLinksEnabled,
  disabled,
  onTogglePhoto,
  onToggleVideo,
  onToggleLink,
}: PostMediaPickerProps) {
  return (
    <>
      {photoUrls.length > 0 ? (
        <div className="vk-parsing-editor__media">
          {photoUrls.map((url, index) => {
            const checked = selectedPhotoUrls.includes(url);
            return (
              <PostPhotoChoice
                key={url}
                url={url}
                index={index}
                checked={checked}
                disabled={disabled}
                onToggle={onTogglePhoto}
              />
            );
          })}
        </div>
      ) : null}

      {videoUrls.length > 0 ? (
        <div className="vk-parsing-editor__videos">
          {videoUrls.map((url, index) => {
            const checked = selectedVideoUrls.includes(url);
            return (
              <PostVideoChoice
                key={url}
                url={url}
                index={index}
                checked={checked}
                disabled={disabled}
                onToggle={onToggleVideo}
              />
            );
          })}
        </div>
      ) : null}

      {linkUrls.length > 0 && !stripLinksEnabled ? (
        <div className="vk-parsing-editor__links">
          {linkUrls.map((url) => {
            const checked = selectedLinkUrls.includes(url);
            return (
              <label key={url} className="vk-parsing-link-choice">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onToggleLink(url)}
                />
                <IconoirSprite variant="iconoir" icon="Link" aria-hidden />
                <span>{url}</span>
              </label>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
