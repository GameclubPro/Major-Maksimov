import { AppIcon as IconoirSprite } from './ui/app-icon';

import { useEffect, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { COMMENT_THEMES, type CommentTheme } from '../lib/comment-theme';
import { useDialogFocusTrap } from '../lib/dialog-focus';
import { maxSelectionChanged } from '../lib/max-bridge';
import { useNativeBackHandler } from '../lib/native-back';
import { resolveRadioGroupNavigationIndex } from '../lib/radio-group-navigation';
import './comment-theme-sheet.css';

type CommentThemeSheetProps = {
  portalTarget: Element;
  theme: CommentTheme;
  onSelect: (theme: CommentTheme) => void;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
};

export default function CommentThemeSheet({
  portalTarget,
  theme,
  onSelect,
  onClose,
  returnFocusRef,
}: CommentThemeSheetProps) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useDialogFocusTrap(true, panelRef, closeRef, returnFocusRef);
  useNativeBackHandler(
    () => {
      onClose();
      return true;
    },
    { priority: 700 },
  );
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return createPortal(
    <div className="comment-theme-sheet">
      <button
        type="button"
        className="comment-theme-sheet__backdrop"
        aria-label="Закрыть оформление"
        tabIndex={-1}
        onClick={onClose}
      />
      <section
        ref={panelRef}
        className="comment-theme-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="comment-theme-title"
        tabIndex={-1}
      >
        <header className="comment-theme-sheet__head">
          <h2 id="comment-theme-title">Оформление</h2>
          <button
            ref={closeRef}
            type="button"
            className="comment-theme-sheet__close"
            aria-label="Закрыть оформление"
            title="Закрыть"
            onClick={onClose}
          >
            <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
          </button>
        </header>
        <div
          className="comment-theme-sheet__options"
          role="radiogroup"
          aria-label="Тема комментариев"
        >
          {COMMENT_THEMES.map((option, index) => (
            <button
              key={option.id}
              type="button"
              className="comment-theme-sheet__option"
              data-comment-preview={option.id}
              role="radio"
              aria-checked={theme === option.id}
              tabIndex={theme === option.id ? 0 : -1}
              onClick={() => {
                maxSelectionChanged();
                onSelect(option.id);
              }}
              onKeyDown={(event) => {
                const next = resolveRadioGroupNavigationIndex(
                  index,
                  COMMENT_THEMES.length,
                  event.key,
                );
                if (next === null) return;
                event.preventDefault();
                const target = event.currentTarget.parentElement?.children[next];
                if (target instanceof HTMLButtonElement) target.focus();
                maxSelectionChanged();
                onSelect(COMMENT_THEMES[next]!.id);
              }}
            >
              <span className="comment-theme-sheet__wallpaper" aria-hidden>
                <i />
                <i />
                <i />
                <IconoirSprite
                  variant="iconoir"
                  icon="Check"
                  className="comment-theme-sheet__selected"
                />
              </span>
              <span className="comment-theme-sheet__label">{option.label}</span>
            </button>
          ))}
        </div>
        <button type="button" className="comment-theme-sheet__done" onClick={onClose}>
          Готово
        </button>
      </section>
    </div>,
    portalTarget,
  );
}
