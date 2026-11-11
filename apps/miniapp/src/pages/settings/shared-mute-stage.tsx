import { useEffect, useId, useRef, useState } from 'react';
import type { ChatSettingsFieldAdapter } from '../../features/network-settings/field-model';
import type {
  ChatBooleanField,
  ChatNumberField,
} from '../../features/network-settings/chat-field-intents';
import { AppIcon } from '../../components/ui/app-icon';
import './settings-duplicate-stage.css';

export function formatMuteDurationCompact(hours: number) {
  return hours >= 24 && hours % 24 === 0 ? `${hours / 24}д` : `${hours}ч`;
}

export function SharedMuteStage({
  fields,
  enabledPath,
  durationPath,
  title,
  onChange,
  activationLabel = title,
  durationLabel = title,
}: {
  fields: ChatSettingsFieldAdapter;
  enabledPath: ChatBooleanField;
  durationPath: ChatNumberField;
  title: string;
  onChange: (enabled: boolean) => void;
  activationLabel?: string;
  durationLabel?: string;
}) {
  const id = useId();
  const editorId = `${id}-duration`;
  const errorId = `${id}-error`;
  const [open, setOpen] = useState(false);
  const [buffer, setBuffer] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const enabled = fields.read(enabledPath);
  const duration = fields.read(durationPath);
  const hours = duration.kind === 'common' ? duration.value : null;
  const key = duration.kind === 'common' ? duration.value : duration.kind;
  useEffect(() => setBuffer(null), [key]);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = enabled.kind === 'mixed';
  }, [enabled.kind]);
  const error = fields.error(durationPath);
  const disabled = fields.readOnly || duration.kind === 'loading';
  const setHours = (next: number) => {
    fields.setError(durationPath, null);
    fields.setScalar(durationPath, next);
  };
  const display = hours === null ? 'Разные значения' : formatMuteDurationCompact(hours);
  return (
    <div
      className={`settings-native-toggle settings-native-toggle--nested${error ? ' field--error' : ''}`}
    >
      <div className="settings-native-toggle__row">
        <div className="settings-native-toggle__title-wrap">
          <span className="settings-native-toggle__title">{title}</span>
          <div className="settings-native-toggle__title-actions">
            <button
              type="button"
              className={`settings-duration-editor__preset settings-duration-editor__preset--trigger${open ? ' is-active' : ''}`}
              aria-label={`Срок: ${display}`}
              aria-expanded={open}
              aria-controls={open ? editorId : undefined}
              aria-describedby={error ? errorId : undefined}
              disabled={disabled}
              onClick={() => setOpen(!open)}
            >
              <AppIcon icon="Clock" />
              <span>{display}</span>
            </button>
          </div>
        </div>
        <label className="settings-native-switch" aria-label={activationLabel}>
          <input
            ref={ref}
            type="checkbox"
            checked={enabled.kind === 'common' && enabled.value}
            aria-checked={
              enabled.kind === 'mixed' ? 'mixed' : enabled.kind === 'common' && enabled.value
            }
            disabled={fields.readOnly || enabled.kind === 'loading'}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="toggle-switch" aria-hidden="true">
            <span className="toggle-switch__thumb" />
          </span>
        </label>
      </div>
      {enabled.kind === 'mixed' ? <p className="field__hint">Разные значения</p> : null}
      {open ? (
        <div
          id={editorId}
          className="settings-duration-editor"
          role="group"
          aria-label={`Срок ограничения: ${durationLabel}`}
        >
          <div className="settings-native-toggle__row">
            <div className="settings-native-toggle__title-wrap">
              <AppIcon icon="Clock" />
              <span className="settings-native-toggle__title">Срок ограничения</span>
            </div>
            <output className="ban-duration-stepper__value" aria-live="polite">
              {display}
            </output>
          </div>
          <div className="settings-duration-editor__presets">
            {[1, 6, 24, 168].map((preset) => (
              <button
                key={preset}
                type="button"
                disabled={disabled}
                aria-pressed={hours === preset}
                className={`settings-duration-editor__preset${hours === preset ? ' is-active' : ''}`}
                onClick={() => {
                  setBuffer(null);
                  setHours(preset);
                }}
              >
                {formatMuteDurationCompact(preset)}
              </button>
            ))}
          </div>
          <div className="settings-duration-editor__controls">
            <div className="ban-duration-stepper">
              <button
                type="button"
                className="ban-duration-stepper__button"
                aria-label={`Уменьшить срок: ${durationLabel}`}
                disabled={disabled || hours === null || hours <= 1}
                onClick={() => {
                  if (hours !== null) {
                    setBuffer(null);
                    setHours(hours - 1);
                  }
                }}
              >
                -
              </button>
              <output className="ban-duration-stepper__value" aria-live="polite">
                {hours === null ? '—' : `${hours}ч`}
              </output>
              <button
                type="button"
                className="ban-duration-stepper__button"
                aria-label={`Увеличить срок: ${durationLabel}`}
                disabled={disabled || hours === null || hours >= 168}
                onClick={() => {
                  if (hours !== null) {
                    setBuffer(null);
                    setHours(hours + 1);
                  }
                }}
              >
                +
              </button>
            </div>
            <label className="settings-duration-editor__hours-input">
              <span>Часы</span>
              <input
                type="number"
                min={1}
                max={168}
                step={1}
                aria-label={`Срок ограничения в часах: ${durationLabel}`}
                aria-invalid={Boolean(error) || undefined}
                aria-describedby={error ? errorId : undefined}
                disabled={disabled}
                value={buffer ?? (hours === null ? '' : String(hours))}
                placeholder={duration.kind === 'mixed' ? 'Разные значения' : undefined}
                onChange={(event) => {
                  const raw = event.target.value;
                  setBuffer(raw);
                  const next = Number(raw);
                  if (!raw.trim() || !Number.isInteger(next) || next < 1 || next > 168) {
                    fields.setError(durationPath, 'Укажите срок от 1 до 168 часов.');
                    return;
                  }
                  setHours(next);
                }}
              />
              <small>1–168ч</small>
            </label>
          </div>
        </div>
      ) : null}
      {error ? (
        <small id={errorId} className="field__hint" role="alert">
          {error}
        </small>
      ) : null}
    </div>
  );
}
