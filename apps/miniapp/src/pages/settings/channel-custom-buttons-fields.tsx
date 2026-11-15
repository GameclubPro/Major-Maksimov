import { useEffect, useId, useRef, useState } from 'react';
import {
  channelCustomPostButtonSchema,
  MAX_CHANNEL_CUSTOM_BUTTONS,
  type ChannelCustomPostButton,
} from '@maxim/contracts/channel-post-signature';
import type { ChannelSettingsFieldAdapter } from '../../features/network-settings/field-model';
import { AppIcon } from '../../components/ui/app-icon';
import { ActionConfirmSheet } from '../../components/ui/action-confirm-sheet';
import { useNativeBackHandler } from '../../lib/native-back';
import { openLink } from '../../lib/max-bridge';
import './channel-custom-buttons.css';

export function ChannelCustomButtonsFields({
  fields,
  onEditorOpen,
}: {
  fields: ChannelSettingsFieldAdapter;
  onEditorOpen?: (open: boolean) => void;
}) {
  const list = fields.read('customButtons');
  const enabled = fields.read('customButtonsEnabled');
  const buttons = list.kind === 'common' ? list.value : [];
  const [editing, setEditing] = useState<ChannelCustomPostButton | null>(null);
  const [original, setOriginal] = useState<ChannelCustomPostButton | null>(null);
  const [error, setError] = useState<{ field: 'text' | 'url'; message: string } | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [removed, setRemoved] = useState<{ button: ChannelCustomPostButton; index: number } | null>(
    null,
  );
  const [dragging, setDragging] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const switchRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const readOnly = fields.readOnly || list.kind === 'loading';
  const editorOpen = editing !== null;
  useEffect(() => {
    onEditorOpen?.(editorOpen);
    return () => onEditorOpen?.(false);
  }, [editorOpen, onEditorOpen]);
  const dirty = Boolean(editing && JSON.stringify(editing) !== JSON.stringify(original));
  const close = () => {
    setEditing(null);
    setConfirmClose(false);
    requestAnimationFrame(() => addRef.current?.focus({ preventScroll: true }));
  };
  const requestClose = () => (dirty ? setConfirmClose(true) : close());
  useNativeBackHandler(
    () => {
      requestClose();
      return true;
    },
    { enabled: Boolean(editing), priority: 690 },
  );
  useEffect(() => {
    if (switchRef.current) switchRef.current.indeterminate = enabled.kind === 'mixed';
  }, [enabled.kind]);
  useEffect(() => {
    if (editing) titleRef.current?.focus({ preventScroll: true });
  }, [editing?.id]);
  useEffect(() => {
    if (!editing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !confirmClose) {
        event.preventDefault();
        event.stopImmediatePropagation();
        requestClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, dirty, confirmClose]);

  const start = (button?: ChannelCustomPostButton) => {
    const next = button ?? { id: crypto.randomUUID(), text: '', url: '' };
    setOriginal(next);
    setEditing({ ...next });
    setError(null);
    setRemoved(null);
  };
  const apply = () => {
    if (!editing || readOnly) return;
    const result = channelCustomPostButtonSchema.safeParse(editing);
    if (!result.success) {
      const issue = result.error.issues[0]!;
      setError({ field: issue.path[0] === 'text' ? 'text' : 'url', message: issue.message });
      return;
    }
    if (buttons.some((button) => button.id !== editing.id && button.url === result.data.url)) {
      setError({ field: 'url', message: 'Кнопка с этой ссылкой уже есть.' });
      return;
    }
    const next = buttons.some((button) => button.id === editing.id)
      ? buttons.map((button) => (button.id === editing.id ? result.data : button))
      : [...buttons, result.data];
    try {
      fields.transact([
        { op: 'replace', path: 'customButtons', value: next },
        ...(buttons.length === 0
          ? [{ op: 'set' as const, path: 'customButtonsEnabled', value: true }]
          : []),
      ]);
      close();
    } catch (cause) {
      setError({
        field: 'url',
        message: cause instanceof Error ? cause.message : 'Проверьте кнопку.',
      });
    }
  };
  const move = (from: number, to: number) => {
    if (readOnly || from < 0 || to < 0 || to >= buttons.length || from === to) return;
    const next = [...buttons];
    const [button] = next.splice(from, 1);
    next.splice(to, 0, button!);
    fields.replaceList('customButtons', next);
  };
  const editingIndex = editing ? buttons.findIndex((button) => button.id === editing.id) : -1;

  return (
    <section className="channel-custom-buttons" aria-label="Свои кнопки">
      <div className="channel-custom-buttons__head">
        <h3>Свои кнопки</h3>
        <label className="settings-native-switch">
          <input
            ref={switchRef}
            type="checkbox"
            aria-label="Добавлять свои кнопки"
            aria-checked={
              enabled.kind === 'mixed' ? 'mixed' : enabled.kind === 'common' && enabled.value
            }
            checked={enabled.kind === 'common' && enabled.value}
            disabled={readOnly || Boolean(editing)}
            onChange={(event) => fields.setScalar('customButtonsEnabled', event.target.checked)}
          />
          <span className="toggle-switch" aria-hidden>
            <span className="toggle-switch__thumb" />
          </span>
        </label>
      </div>
      {editing ? (
        <div className="channel-custom-buttons__editor" aria-label="Редактор кнопки">
          <div className="channel-custom-buttons__editor-head">
            <button
              type="button"
              className="channel-custom-buttons__icon"
              aria-label="Назад к кнопкам"
              onClick={requestClose}
            >
              <AppIcon icon="ArrowLeft" />
            </button>
            <strong>{editingIndex < 0 ? 'Новая кнопка' : 'Изменить кнопку'}</strong>
          </div>
          <label htmlFor={`${id}-text`}>
            Название <small>{editing.text.length} / 32</small>
          </label>
          <input
            ref={titleRef}
            id={`${id}-text`}
            value={editing.text}
            maxLength={32}
            placeholder="Открыть каталог"
            disabled={readOnly}
            aria-invalid={error?.field === 'text'}
            aria-describedby={error?.field === 'text' ? `${id}-error` : undefined}
            onChange={(event) => {
              setEditing({ ...editing, text: event.target.value });
              setError(null);
            }}
          />
          <label htmlFor={`${id}-url`}>Ссылка</label>
          <input
            id={`${id}-url`}
            type="url"
            inputMode="url"
            value={editing.url}
            maxLength={2048}
            placeholder="https://example.com"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={readOnly}
            aria-invalid={error?.field === 'url'}
            aria-describedby={error?.field === 'url' ? `${id}-error` : undefined}
            onChange={(event) => {
              setEditing({ ...editing, url: event.target.value });
              setError(null);
            }}
          />
          {error && (
            <p id={`${id}-error`} className="channel-custom-buttons__error" role="alert">
              {error.message}
            </p>
          )}
          <div className="channel-custom-buttons__sample" aria-label="Предпросмотр кнопки">
            <span>{editing.text.trim() || 'Название кнопки'}</span>
            <AppIcon icon="ArrowUpRight" />
          </div>
          {channelCustomPostButtonSchema.safeParse(editing).success && (
            <button
              type="button"
              className="channel-custom-buttons__link"
              onClick={() => openLink(channelCustomPostButtonSchema.parse(editing).url)}
            >
              Открыть ссылку
              <AppIcon icon="ArrowUpRight" />
            </button>
          )}
          {editingIndex >= 0 && (
            <div className="channel-custom-buttons__order">
              <button
                type="button"
                disabled={readOnly || editingIndex === 0}
                onClick={() => move(editingIndex, editingIndex - 1)}
              >
                <AppIcon icon="ArrowUp" />
                Выше
              </button>
              <button
                type="button"
                disabled={readOnly || editingIndex === buttons.length - 1}
                onClick={() => move(editingIndex, editingIndex + 1)}
              >
                <AppIcon icon="NavArrowDown" />
                Ниже
              </button>
            </div>
          )}
          <div className="channel-custom-buttons__actions">
            {editingIndex >= 0 ? (
              <button
                type="button"
                className="channel-custom-buttons__delete"
                disabled={readOnly}
                onClick={() => {
                  setRemoved({ button: buttons[editingIndex]!, index: editingIndex });
                  fields.replaceList(
                    'customButtons',
                    buttons.filter((button) => button.id !== editing.id),
                  );
                  close();
                }}
              >
                Удалить
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              className="button button--accent"
              onClick={apply}
              disabled={readOnly}
            >
              Готово
            </button>
          </div>
        </div>
      ) : (
        <>
          {list.kind === 'mixed' ? (
            <div className="channel-custom-buttons__mixed">
              <span>Разные кнопки</span>
              <button
                type="button"
                className="button button--ghost"
                disabled={readOnly}
                onClick={() => fields.replaceList('customButtons', [])}
              >
                Заменить набор
              </button>
            </div>
          ) : (
            <div className="channel-custom-buttons__list">
              {buttons.map((button, index) => (
                <div
                  key={button.id}
                  data-custom-button-id={button.id}
                  className={`channel-custom-buttons__row${dragging === button.id ? ' is-dragging' : ''}`}
                >
                  <button
                    type="button"
                    className="channel-custom-buttons__grip"
                    disabled={readOnly}
                    aria-label={`Переместить «${button.text}»`}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                        event.preventDefault();
                        move(index, index + (event.key === 'ArrowUp' ? -1 : 1));
                      }
                    }}
                    onPointerDown={(event) => {
                      if (!readOnly) {
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setDragging(button.id);
                      }
                    }}
                    onPointerCancel={() => setDragging(null)}
                    onPointerUp={(event) => {
                      const target = document
                        .elementFromPoint(event.clientX, event.clientY)
                        ?.closest<HTMLElement>('[data-custom-button-id]')?.dataset.customButtonId;
                      if (target)
                        move(
                          index,
                          buttons.findIndex((item) => item.id === target),
                        );
                      setDragging(null);
                    }}
                  >
                    <span className="channel-custom-buttons__grip-dots" aria-hidden>
                      ⠿
                    </span>
                  </button>
                  <button
                    type="button"
                    className="channel-custom-buttons__item"
                    disabled={readOnly}
                    onClick={() => start(button)}
                    aria-label={`Изменить кнопку «${button.text}»`}
                  >
                    <span>
                      <strong>{button.text}</strong>
                      <small>{new URL(button.url).hostname}</small>
                    </span>
                    <AppIcon icon="NavArrowRight" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {list.kind !== 'mixed' && (
            <button
              ref={addRef}
              type="button"
              className="channel-custom-buttons__add"
              disabled={readOnly || buttons.length >= MAX_CHANNEL_CUSTOM_BUTTONS}
              onClick={() => start()}
            >
              <AppIcon icon="Plus" />
              {buttons.length >= MAX_CHANNEL_CUSTOM_BUTTONS
                ? 'Добавлено 8 кнопок'
                : 'Добавить кнопку'}
            </button>
          )}
          {removed && (
            <div className="channel-custom-buttons__undo" role="status">
              Кнопка удалена
              <button
                type="button"
                disabled={readOnly || buttons.length >= MAX_CHANNEL_CUSTOM_BUTTONS}
                onClick={() => {
                  const next = [...buttons];
                  next.splice(removed.index, 0, removed.button);
                  fields.replaceList('customButtons', next);
                  setRemoved(null);
                }}
              >
                Вернуть
              </button>
            </div>
          )}
        </>
      )}
      <ActionConfirmSheet
        id={`${id}-discard`}
        open={confirmClose}
        title="Сохранить кнопку?"
        confirmLabel="Готово"
        tone="accent"
        extraActionLabel="Не сохранять"
        extraActionTone="danger"
        onExtraAction={close}
        onClose={() => setConfirmClose(false)}
        onConfirm={() => {
          setConfirmClose(false);
          apply();
        }}
      />
    </section>
  );
}
