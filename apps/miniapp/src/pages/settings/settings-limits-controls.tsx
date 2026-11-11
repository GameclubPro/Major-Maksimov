import {
  MAX_MESSAGE_LENGTH_MAX,
  MAX_MESSAGE_LENGTH_MIN,
  type ChatSettings,
} from '@maxim/contracts/settings';
import { useEffect, useId, useRef, useState } from 'react';
import type { AdminContactButtonGroup, ChatSettingsButtonGroup } from './settings-page-helpers';
import './settings-limits-controls.css';

export const MESSAGE_COUNT_LIMIT_MIN = 1;
export const MESSAGE_COUNT_LIMIT_MAX = 10;
export const MESSAGE_COUNT_LIMIT_WINDOW_MIN_HOURS = 1;
export const MESSAGE_COUNT_LIMIT_WINDOW_MAX_HOURS = 24;
export const MESSAGE_LENGTH_MIN = MAX_MESSAGE_LENGTH_MIN;
export const MESSAGE_LENGTH_MAX = MAX_MESSAGE_LENGTH_MAX;
export const MESSAGE_LENGTH_STEP = 10;
export const PHOTO_COOLDOWN_MIN_HOURS = 1;
export const PHOTO_COOLDOWN_MAX_HOURS = 24;
export const STICKER_COOLDOWN_MIN_MINUTES = 1;
export const STICKER_COOLDOWN_MAX_MINUTES = 60;

export const MESSAGE_LIMITS_BOT_BUTTON_GROUP = {
  buttonsKey: 'messageLimitsBotButtons',
  enabledKey: 'messageLimitsBotButtonEnabled',
  urlKey: 'messageLimitsBotButtonUrl',
  textKey: 'messageLimitsBotButtonText',
} as const satisfies ChatSettingsButtonGroup;

export const MESSAGE_LIMITS_ADMIN_CONTACT_BUTTON_GROUP = {
  enabledKey: 'messageLimitsAdminContactButtonEnabled',
  urlKey: 'messageLimitsAdminContactButtonUrl',
} as const satisfies AdminContactButtonGroup;

export type MaxMessageLengthSliderProps = {
  value: ChatSettings['maxMessageLength'];
  min: number;
  max: number;
  step: number;
  onCommit: (value: ChatSettings['maxMessageLength']) => void;
  disabled?: boolean;
  error?: string | null;
  onError: (message: string | null) => void;
};

export function MaxMessageLengthSlider({
  value,
  min,
  max,
  step,
  onCommit,
  disabled,
  error,
  onError,
}: MaxMessageLengthSliderProps) {
  const errorId = useId();
  const [localValue, setLocalValue] = useState(value);
  const [numberBuffer, setNumberBuffer] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const rangeChangedRef = useRef(false);

  useEffect(() => {
    if (!isDraggingRef.current) {
      setLocalValue(value);
      setNumberBuffer(null);
    }
  }, [value]);

  function normalizeValue(rawValue: string): ChatSettings['maxMessageLength'] {
    const parsedValue = Number(rawValue);
    const safeValue = Number.isFinite(parsedValue) ? parsedValue : value;
    return Math.min(max, Math.max(min, safeValue)) as ChatSettings['maxMessageLength'];
  }

  function commitValue(nextValue: ChatSettings['maxMessageLength']) {
    onError(null);
    setNumberBuffer(null);
    isDraggingRef.current = false;
    setIsDragging(false);
    setLocalValue(nextValue);
    if (nextValue !== value) {
      onCommit(nextValue);
    }
  }

  function finishRangeDrag(raw: string) {
    if (rangeChangedRef.current) commitValue(normalizeValue(raw));
    else {
      isDraggingRef.current = false;
      setIsDragging(false);
    }
  }

  return (
    <>
      <div className="settings-native-toggle__row settings-length-limit__value-row">
        <span className="settings-native-toggle__title settings-native-toggle__title--sub">
          Максимум
        </span>
        <label className="settings-length-limit__number">
          <input
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            step={1}
            value={numberBuffer ?? localValue}
            disabled={disabled}
            aria-label="Лимит длины сообщения, символы"
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => {
              const raw = event.target.value;
              setNumberBuffer(raw);
              const next = Number(raw);
              if (!raw.trim() || !Number.isInteger(next) || next < min || next > max) {
                onError(`Укажите целое число от ${min} до ${max}.`);
                return;
              }
              onError(null);
              setLocalValue(next);
              if (next !== value) onCommit(next);
            }}
          />
          <span>симв.</span>
        </label>
      </div>

      <input
        className="settings-length-limit__slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={localValue}
        disabled={disabled}
        onPointerDown={() => {
          rangeChangedRef.current = false;
          isDraggingRef.current = true;
          setIsDragging(true);
        }}
        onChange={(event) => {
          rangeChangedRef.current = true;
          setNumberBuffer(null);
          onError(null);
          const nextValue = normalizeValue(event.target.value);
          setLocalValue(nextValue);
          if (!isDraggingRef.current) {
            onCommit(nextValue);
          }
        }}
        onPointerUp={(event) => {
          finishRangeDrag(event.currentTarget.value);
        }}
        onPointerCancel={(event) => {
          finishRangeDrag(event.currentTarget.value);
        }}
        onBlur={(event) => {
          if (isDragging || isDraggingRef.current) finishRangeDrag(event.currentTarget.value);
        }}
        aria-label="Лимит длины сообщения"
        aria-valuetext={`${localValue} символов`}
      />

      <div className="settings-length-limit__labels" aria-hidden>
        <span>{min}</span>
        <span>{max}</span>
      </div>
      {error ? (
        <small id={errorId} className="field__hint" role="alert">
          {error}
        </small>
      ) : null}
    </>
  );
}
