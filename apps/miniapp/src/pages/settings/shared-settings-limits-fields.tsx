import { AppIcon } from '../../components/ui/app-icon';
import { useEffect, useRef, useState } from 'react';
import type {
  ChatSettingsFieldAdapter,
  SettingsFieldState,
} from '../../features/network-settings/field-model';
import {
  setChatBoolean,
  type ChatBooleanField,
  type ChatNumberField,
} from '../../features/network-settings/chat-field-intents';
import { cn } from '../../lib/cn';
import type { ReactNode } from 'react';
import type { SharedChatSettingsContext } from './shared-chat-settings-section';
import {
  MESSAGE_COUNT_LIMIT_MAX,
  MESSAGE_COUNT_LIMIT_MIN,
  MESSAGE_COUNT_LIMIT_WINDOW_MAX_HOURS,
  MESSAGE_COUNT_LIMIT_WINDOW_MIN_HOURS,
  MESSAGE_LENGTH_MAX,
  MESSAGE_LENGTH_MIN,
  MESSAGE_LENGTH_STEP,
  MaxMessageLengthSlider,
  PHOTO_COOLDOWN_MAX_HOURS,
  PHOTO_COOLDOWN_MIN_HOURS,
  STICKER_COOLDOWN_MAX_MINUTES,
  STICKER_COOLDOWN_MIN_MINUTES,
} from './settings-limits-controls';

type FieldsProps = { fields: ChatSettingsFieldAdapter };
const cascadedFlags = new Set<ChatBooleanField>([
  'messageCountLimitEnabled',
  'maxMessageLengthEnabled',
  'photoMessageCooldownEnabled',
  'stickerMessageCooldownEnabled',
  'photoMessagesEnabled',
  'videoMessagesEnabled',
  'fileMessagesEnabled',
  'voiceMessagesEnabled',
  'forwardedMessagesEnabled',
]);

// FLAG: Mixed checkboxes remain indeterminate; rendering does not author any flag or dependent setting.
function LimitsSwitch({ fields, path }: FieldsProps & { path: ChatBooleanField }) {
  const state = fields.read(path);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = state.kind === 'mixed';
  }, [state.kind]);
  return (
    <input
      ref={input}
      type="checkbox"
      checked={state.kind === 'common' && state.value}
      aria-checked={state.kind === 'mixed' ? 'mixed' : state.kind === 'common' && state.value}
      aria-description={state.kind === 'mixed' ? 'Разные значения' : undefined}
      disabled={fields.readOnly || state.kind === 'loading'}
      onChange={(event) => {
        try {
          fields.setError(path, null);
          if (cascadedFlags.has(path)) setChatBoolean(fields, path, event.target.checked);
          else fields.setScalar(path, event.target.checked);
        } catch (cause) {
          fields.setError(path, cause instanceof Error ? cause.message : 'Проверьте значение.');
        }
      }}
    />
  );
}

function stateNumber(state: SettingsFieldState<number>) {
  return state.kind === 'common' ? state.value : undefined;
}

function LimitsRange({
  fields,
  path,
  label,
  ariaLabel,
  min,
  max,
  unit = '',
}: FieldsProps & {
  path: ChatNumberField;
  label: string;
  ariaLabel: string;
  min: number;
  max: number;
  unit?: string;
}) {
  const state = fields.read(path);
  const value = stateNumber(state);
  const write = (value: number) => {
    try {
      fields.setError(path, null);
      fields.setScalar(path, value);
    } catch (cause) {
      fields.setError(path, cause instanceof Error ? cause.message : 'Проверьте значение.');
    }
  };
  return (
    <>
      <div className="settings-native-toggle__row">
        <span className="settings-native-toggle__title settings-native-toggle__title--sub">
          {label}
        </span>
        <output className="settings-length-limit__value" aria-live="polite">
          {value === undefined
            ? state.kind === 'loading'
              ? 'Загрузка…'
              : 'Разные значения'
            : `${value}${unit}`}
        </output>
      </div>
      {value === undefined ? (
        <button
          type="button"
          className="settings-duration-editor__preset"
          disabled={fields.readOnly || state.kind === 'loading'}
          onClick={() => write(min)}
        >
          Задать значение: {label.toLowerCase()}
        </button>
      ) : (
        <>
          <input
            className="settings-length-limit__slider"
            type="range"
            min={min}
            max={max}
            step={1}
            value={value}
            disabled={fields.readOnly}
            aria-label={ariaLabel}
            onChange={(event) => write(Number(event.target.value))}
          />
          <div className="settings-length-limit__labels" aria-hidden="true">
            <span>
              {min}
              {unit}
            </span>
            <span>
              {max}
              {unit}
            </span>
          </div>
        </>
      )}
    </>
  );
}

function SharedMessageLengthSlider({ fields }: FieldsProps) {
  const state = fields.read('maxMessageLength');
  return state.kind === 'common' ? (
    <MaxMessageLengthSlider
      value={state.value}
      min={MESSAGE_LENGTH_MIN}
      max={MESSAGE_LENGTH_MAX}
      step={MESSAGE_LENGTH_STEP}
      disabled={fields.readOnly}
      onCommit={(value) => fields.setScalar('maxMessageLength', value)}
    />
  ) : (
    <LimitsRange
      fields={fields}
      path="maxMessageLength"
      label="Максимум"
      ariaLabel="Лимит длины сообщения"
      min={MESSAGE_LENGTH_MIN}
      max={MESSAGE_LENGTH_MAX}
      unit=" симв."
    />
  );
}

const trafficControls = [
  { enabled: 'slowModeEnabled', interval: 'slowModeIntervalSeconds', title: 'Медленный режим' },
  {
    enabled: 'mediaMessageCooldownEnabled',
    interval: 'mediaMessageCooldownSeconds',
    title: 'Интервал для вложений',
  },
] as const;

function TrafficInterval({
  fields,
  path,
  title,
}: FieldsProps & {
  path: 'slowModeIntervalSeconds' | 'mediaMessageCooldownSeconds';
  title: string;
}) {
  const state = fields.read(path);
  const key = state.kind === 'common' ? state.value : state.kind;
  const [buffer, setBuffer] = useState<string | null>(null);
  useEffect(() => setBuffer(null), [key]);
  return (
    <div className="settings-native-toggle__row">
      <label
        className="settings-native-toggle__title settings-native-toggle__title--sub"
        htmlFor={path}
      >
        Интервал, с
      </label>
      <input
        id={path}
        className="field__input"
        type="number"
        inputMode="numeric"
        min={10}
        max={86400}
        step={1}
        value={buffer ?? (state.kind === 'common' ? state.value : '')}
        placeholder={state.kind === 'mixed' ? 'Разные значения' : undefined}
        disabled={fields.readOnly || state.kind === 'loading'}
        style={{ width: 88, flex: '0 0 88px' }}
        aria-label={`${title}: интервал в секундах`}
        aria-invalid={Boolean(fields.error(path))}
        aria-describedby={fields.error(path) ? `${path}-error` : undefined}
        onChange={(event) => {
          const raw = event.target.value;
          setBuffer(raw);
          const value = Number(raw);
          if (!raw.trim() || !Number.isInteger(value) || value < 10 || value > 86400) {
            fields.setError(path, 'Укажите целое число от 10 до 86400.');
            return;
          }
          try {
            fields.setError(path, null);
            fields.setScalar(path, value);
          } catch (cause) {
            fields.setError(path, cause instanceof Error ? cause.message : 'Проверьте интервал.');
          }
        }}
      />
    </div>
  );
}

function SharedTrafficControls({ fields }: FieldsProps) {
  return trafficControls.map(({ enabled, interval, title }) => {
    const state = fields.read(enabled);
    return (
      <div className="settings-native-toggle" key={enabled}>
        <div className="settings-native-toggle__row">
          <span className="settings-native-toggle__title">{title}</span>
          <label className="settings-native-switch" aria-label={title}>
            <LimitsSwitch fields={fields} path={enabled} />
            <span className="toggle-switch" aria-hidden="true">
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>
        {state.kind === 'mixed' || (state.kind === 'common' && state.value) ? (
          <TrafficInterval fields={fields} path={interval} title={title} />
        ) : null}
        {fields.error(interval) ? (
          <small id={`${interval}-error`} className="field__hint" role="alert">
            {fields.error(interval)}
          </small>
        ) : null}
      </div>
    );
  });
}

export function SharedSettingsLimitsFields({
  fields,
  context,
  actions,
}: FieldsProps & {
  context: SharedChatSettingsContext;
  actions: ReactNode;
}) {
  const [openHintKey, setOpenHintKey] = useState<string | null>(null);
  const toggleHint = (key: string) => setOpenHintKey((current) => (current === key ? null : key));
  const show = (path: ChatBooleanField) => {
    const state = fields.read(path);
    return state.kind === 'mixed' || (state.kind === 'common' && state.value);
  };
  const isEnabled = (path: ChatBooleanField) => {
    const state = fields.read(path);
    return state.kind === 'common' && state.value;
  };
  const status = (path: ChatBooleanField) => {
    const state = fields.read(path);
    return state.kind === 'common'
      ? state.value
        ? 'Включено'
        : 'Выкл'
      : state.kind === 'mixed'
        ? 'Разные значения'
        : 'Загрузка…';
  };
  const stickerMinutes = stateNumber(fields.read('stickerMessageCooldownMinutes'));
  const setStickerMinutes = (value: number) => {
    try {
      fields.setError('stickerMessageCooldownMinutes', null);
      fields.setScalar('stickerMessageCooldownMinutes', value);
    } catch (cause) {
      fields.setError(
        'stickerMessageCooldownMinutes',
        cause instanceof Error ? cause.message : 'Проверьте интервал.',
      );
    }
  };
  const adjustStickerMessageCooldown = (delta: number) => {
    if (stickerMinutes === undefined) return;
    setStickerMinutes(
      Math.max(
        STICKER_COOLDOWN_MIN_MINUTES,
        Math.min(STICKER_COOLDOWN_MAX_MINUTES, stickerMinutes + delta),
      ),
    );
  };
  return (
    <div className="settings-section__collapse-inner">
      <div className="settings-subsection-divider" role="separator" aria-label="Защита от спама">
        <span>Защита от спама</span>
      </div>

      <div className="settings-native-toggle">
        <div className="settings-native-toggle__row">
          <div className="settings-native-toggle__title-wrap">
            <span className="settings-native-toggle__title">Антиспам</span>
            <button
              type="button"
              className={cn('settings-info-button', openHintKey === 'antiSpam' && 'is-open')}
              aria-label="Пояснение для антиспама"
              aria-controls="anti-spam-hint"
              aria-expanded={openHintKey === 'antiSpam'}
              data-hint-key="antiSpam"
              onClick={() => toggleHint('antiSpam')}
            >
              <AppIcon
                icon="InfoCircle"
                width="1.5em"
                height="1.5em"
                style={{ strokeWidth: 1.5 }}
                aria-hidden
              />
            </button>
          </div>

          <label className="settings-native-switch" aria-label="Включить антиспам">
            <LimitsSwitch fields={fields} path="antiSpamEnabled" />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>

        {openHintKey === 'antiSpam' ? (
          <p id="anti-spam-hint" className="settings-native-toggle__hint">
            Защищает чат от серии сообщений подряд: если участник отправит больше пяти сообщений за
            шесть секунд, бот удалит спам и заблокирует отправителя.
          </p>
        ) : null}
      </div>

      <SharedTrafficControls fields={fields} />

      <div className="settings-native-toggle">
        <div className="settings-native-toggle__row">
          <div className="settings-native-toggle__title-wrap">
            <span className="settings-native-toggle__title">Удалять спамеров</span>
            <div className="settings-native-toggle__title-actions">
              <span
                className={cn(
                  'settings-native-toggle__status',
                  isEnabled('deleteSpammersEnabled') && 'is-active',
                  context.limitsRuntime?.enforcementMode === 'shadow' &&
                    isEnabled('deleteSpammersEnabled') &&
                    'is-shadow',
                )}
              >
                {context.limitsRuntime?.deleteSpammersStatus ?? status('deleteSpammersEnabled')}
              </span>
              <button
                type="button"
                className={cn(
                  'settings-info-button',
                  openHintKey === 'deleteSpammers' && 'is-open',
                )}
                aria-label="Пояснение для удаления спамеров"
                aria-controls="delete-spammers-hint"
                aria-expanded={openHintKey === 'deleteSpammers'}
                data-hint-key="deleteSpammers"
                onClick={() => toggleHint('deleteSpammers')}
              >
                <AppIcon
                  icon="InfoCircle"
                  width="1.5em"
                  height="1.5em"
                  style={{ strokeWidth: 1.5 }}
                  aria-hidden
                />
              </button>
            </div>
          </div>

          <label className="settings-native-switch" aria-label="Включить удаление спамеров">
            <LimitsSwitch fields={fields} path="deleteSpammersEnabled" />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>

        {openHintKey === 'deleteSpammers' ? (
          <p id="delete-spammers-hint" className="settings-native-toggle__hint">
            Бот удаляет из чата участников, которых проверка подтвердила как спамеров. В режиме
            наблюдения участники не удаляются.
          </p>
        ) : null}
      </div>

      <div className="settings-subsection-divider" role="separator" aria-label="Лимиты активности">
        <span>Лимиты активности</span>
      </div>

      <div
        className={cn(
          'settings-native-toggle',
          (fields.error('messageCountLimitMessages') ||
            fields.error('messageCountLimitWindowHours')) &&
            'field--error',
        )}
      >
        <div className="settings-native-toggle__row">
          <div className="settings-native-toggle__title-wrap">
            <span className="settings-native-toggle__title">Лимит сообщений</span>
            <button
              type="button"
              className={cn(
                'settings-info-button',
                openHintKey === 'messageCountLimit' && 'is-open',
              )}
              aria-label="Пояснение для лимита сообщений"
              aria-controls="message-count-limit-hint"
              aria-expanded={openHintKey === 'messageCountLimit'}
              data-hint-key="messageCountLimit"
              onClick={() => toggleHint('messageCountLimit')}
            >
              <AppIcon
                icon="InfoCircle"
                width="1.5em"
                height="1.5em"
                style={{ strokeWidth: 1.5 }}
                aria-hidden
              />
            </button>
          </div>

          <label className="settings-native-switch" aria-label="Включить лимит сообщений">
            <LimitsSwitch fields={fields} path="messageCountLimitEnabled" />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>

        {show('messageCountLimitEnabled') ? (
          <>
            <LimitsRange
              fields={fields}
              path="messageCountLimitMessages"
              label="Сообщений"
              ariaLabel="Лимит сообщений за выбранный период"
              min={MESSAGE_COUNT_LIMIT_MIN}
              max={MESSAGE_COUNT_LIMIT_MAX}
              unit=""
            />

            <LimitsRange
              fields={fields}
              path="messageCountLimitWindowHours"
              label="Период"
              ariaLabel="Период лимита сообщений в часах"
              min={MESSAGE_COUNT_LIMIT_WINDOW_MIN_HOURS}
              max={MESSAGE_COUNT_LIMIT_WINDOW_MAX_HOURS}
              unit="ч"
            />
          </>
        ) : null}

        {fields.error('messageCountLimitMessages') ? (
          <small className="field__hint">{fields.error('messageCountLimitMessages')}</small>
        ) : fields.error('messageCountLimitWindowHours') ? (
          <small className="field__hint">{fields.error('messageCountLimitWindowHours')}</small>
        ) : openHintKey === 'messageCountLimit' ? (
          <p id="message-count-limit-hint" className="settings-native-toggle__hint">
            Лимит действует отдельно для каждого участника за последние выбранные часы. Учитываются
            новые сообщения, включая ответы; фото одного альбома — как одна публикация.
            Редактирование не расходует лимит. Попытки сверх лимита не продлевают ожидание.
          </p>
        ) : null}
      </div>

      <div
        className={cn('settings-native-toggle', fields.error('maxMessageLength') && 'field--error')}
      >
        <div className="settings-native-toggle__row">
          <div className="settings-native-toggle__title-wrap">
            <span className="settings-native-toggle__title">Лимит длины сообщения</span>
            <button
              type="button"
              className={cn(
                'settings-info-button',
                openHintKey === 'maxMessageLength' && 'is-open',
              )}
              aria-label="Пояснение для лимита длины сообщения"
              aria-controls="max-message-length-hint"
              aria-expanded={openHintKey === 'maxMessageLength'}
              data-hint-key="maxMessageLength"
              onClick={() => toggleHint('maxMessageLength')}
            >
              <AppIcon
                icon="InfoCircle"
                width="1.5em"
                height="1.5em"
                style={{ strokeWidth: 1.5 }}
                aria-hidden
              />
            </button>
          </div>

          <label
            className="settings-native-switch"
            aria-label="Включить ограничение длины сообщения"
          >
            <LimitsSwitch fields={fields} path="maxMessageLengthEnabled" />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>

        {show('maxMessageLengthEnabled') ? <SharedMessageLengthSlider fields={fields} /> : null}

        {openHintKey === 'maxMessageLength' ? (
          <p id="max-message-length-hint" className="settings-native-toggle__hint">
            Удаляет сообщения длиннее выбранного лимита. Учитывает текст и подписи к медиа, в том
            числе в пересылках, а также пробелы и переносы строк. Один эмодзи — один символ. Текст
            цитаты при ответе не учитывается.
          </p>
        ) : null}

        {fields.error('maxMessageLength') ? (
          <small className="field__hint">{fields.error('maxMessageLength')}</small>
        ) : null}
      </div>

      <div
        className={cn(
          'settings-native-toggle',
          fields.error('photoMessageCooldownHours') && 'field--error',
        )}
      >
        <div className="settings-native-toggle__row">
          <div className="settings-native-toggle__title-wrap">
            <span className="settings-native-toggle__title">Фото: не чаще 1 раза</span>
            <button
              type="button"
              className={cn('settings-info-button', openHintKey === 'photoCooldown' && 'is-open')}
              aria-label="Пояснение для ограничения частоты фото"
              aria-controls="photo-cooldown-hint"
              aria-expanded={openHintKey === 'photoCooldown'}
              data-hint-key="photoCooldown"
              onClick={() => toggleHint('photoCooldown')}
            >
              <AppIcon
                icon="InfoCircle"
                width="1.5em"
                height="1.5em"
                style={{ strokeWidth: 1.5 }}
                aria-hidden
              />
            </button>
          </div>

          <label
            className="settings-native-switch"
            aria-label="Ограничить отправку фото по времени"
          >
            <LimitsSwitch fields={fields} path="photoMessageCooldownEnabled" />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>

        {show('photoMessageCooldownEnabled') ? (
          <>
            <LimitsRange
              fields={fields}
              path="photoMessageCooldownHours"
              label="Интервал"
              ariaLabel="Интервал отправки фото в часах"
              min={PHOTO_COOLDOWN_MIN_HOURS}
              max={PHOTO_COOLDOWN_MAX_HOURS}
              unit="ч"
            />
          </>
        ) : null}

        {fields.error('photoMessageCooldownHours') ? (
          <small className="field__hint">{fields.error('photoMessageCooldownHours')}</small>
        ) : openHintKey === 'photoCooldown' ? (
          <p id="photo-cooldown-hint" className="settings-native-toggle__hint">
            Каждый участник может отправить одно сообщение с фото за выбранное время. Следующее
            сообщение с фото до окончания этого времени будет удалено.
          </p>
        ) : null}
      </div>

      {show('stickerMessagesEnabled') ? (
        <div
          className={cn(
            'settings-native-toggle',
            fields.error('stickerMessageCooldownMinutes') && 'field--error',
          )}
        >
          <div className="settings-native-toggle__row">
            <div className="settings-native-toggle__title-wrap">
              <span className="settings-native-toggle__title">Стикеры: не чаще 1 раза</span>
              <button
                type="button"
                className={cn(
                  'settings-info-button',
                  openHintKey === 'stickerCooldown' && 'is-open',
                )}
                aria-label="Пояснение для ограничения частоты стикеров"
                aria-controls="sticker-cooldown-hint"
                aria-expanded={openHintKey === 'stickerCooldown'}
                data-hint-key="stickerCooldown"
                onClick={() => toggleHint('stickerCooldown')}
              >
                <AppIcon
                  icon="InfoCircle"
                  width="1.5em"
                  height="1.5em"
                  style={{ strokeWidth: 1.5 }}
                  aria-hidden
                />
              </button>
            </div>

            <label
              className="settings-native-switch"
              aria-label="Ограничить отправку стикеров по времени"
            >
              <LimitsSwitch fields={fields} path="stickerMessageCooldownEnabled" />
              <span className="toggle-switch" aria-hidden>
                <span className="toggle-switch__thumb" />
              </span>
            </label>
          </div>

          {show('stickerMessageCooldownEnabled') ? (
            <div className="settings-native-toggle__row">
              <span className="settings-native-toggle__title settings-native-toggle__title--sub">
                Интервал
              </span>
              <div
                className="ban-duration-stepper"
                role="group"
                aria-label="Интервал отправки стикеров в минутах"
              >
                <button
                  type="button"
                  className="ban-duration-stepper__button"
                  onClick={() => adjustStickerMessageCooldown(-1)}
                  disabled={
                    fields.readOnly ||
                    stickerMinutes === undefined ||
                    stickerMinutes <= STICKER_COOLDOWN_MIN_MINUTES
                  }
                  aria-label="Уменьшить интервал отправки стикеров"
                >
                  -
                </button>
                <output className="ban-duration-stepper__value" aria-live="polite">
                  {stickerMinutes === undefined ? 'Разные значения' : `${stickerMinutes} мин`}
                </output>
                {stickerMinutes === undefined ? (
                  <button
                    type="button"
                    className="settings-duration-editor__preset"
                    disabled={
                      fields.readOnly ||
                      fields.read('stickerMessageCooldownMinutes').kind === 'loading'
                    }
                    onClick={() => setStickerMinutes(STICKER_COOLDOWN_MIN_MINUTES)}
                  >
                    Задать интервал
                  </button>
                ) : null}
                <button
                  type="button"
                  className="ban-duration-stepper__button"
                  onClick={() => adjustStickerMessageCooldown(1)}
                  disabled={
                    fields.readOnly ||
                    stickerMinutes === undefined ||
                    stickerMinutes >= STICKER_COOLDOWN_MAX_MINUTES
                  }
                  aria-label="Увеличить интервал отправки стикеров"
                >
                  +
                </button>
              </div>
            </div>
          ) : null}

          {fields.error('stickerMessageCooldownMinutes') ? (
            <small className="field__hint">{fields.error('stickerMessageCooldownMinutes')}</small>
          ) : openHintKey === 'stickerCooldown' ? (
            <p id="sticker-cooldown-hint" className="settings-native-toggle__hint">
              Каждый участник может отправить один стикер за выбранное время. Следующие стикеры до
              окончания этого времени удаляются. Лимит фото считается отдельно.
            </p>
          ) : null}
        </div>
      ) : null}

      <div
        className="settings-subsection-divider"
        role="separator"
        aria-label="Разрешённые типы сообщений"
      >
        <span>Разрешённые типы</span>
      </div>

      <div className="settings-native-toggle">
        <div className="settings-native-toggle__row">
          <span className="settings-native-toggle__title">Разрешить стикеры</span>
          <label className="settings-native-switch" aria-label="Разрешить отправку стикеров">
            <LimitsSwitch fields={fields} path="stickerMessagesEnabled" />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>
      </div>

      <div className="settings-native-toggle">
        <div className="settings-native-toggle__row">
          <span className="settings-native-toggle__title">Разрешить фото</span>

          <label className="settings-native-switch" aria-label="Разрешить отправку фото">
            <LimitsSwitch fields={fields} path="photoMessagesEnabled" />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>
      </div>

      <div className="settings-native-toggle">
        <div className="settings-native-toggle__row">
          <span className="settings-native-toggle__title">Разрешить видео</span>

          <label className="settings-native-switch" aria-label="Разрешить отправку видео">
            <LimitsSwitch fields={fields} path="videoMessagesEnabled" />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>
      </div>

      <div className="settings-native-toggle">
        <div className="settings-native-toggle__row">
          <span className="settings-native-toggle__title">Разрешить файлы</span>

          <label className="settings-native-switch" aria-label="Разрешить отправку файлов">
            <LimitsSwitch fields={fields} path="fileMessagesEnabled" />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>
      </div>

      <div className="settings-native-toggle">
        <div className="settings-native-toggle__row">
          <span className="settings-native-toggle__title">Разрешить голосовые</span>

          <label className="settings-native-switch" aria-label="Разрешить отправку голосовых">
            <LimitsSwitch fields={fields} path="voiceMessagesEnabled" />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>
      </div>

      <div className="settings-native-toggle">
        <div className="settings-native-toggle__row">
          <span className="settings-native-toggle__title">Разрешить пересланные сообщения</span>

          <label className="settings-native-switch" aria-label="Разрешить пересланные сообщения">
            <LimitsSwitch fields={fields} path="forwardedMessagesEnabled" />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>
      </div>

      <div className="settings-native-toggle">
        <div className="settings-native-toggle__row">
          <span className="settings-native-toggle__title">Разрешить телефоны</span>

          <label className="settings-native-switch" aria-label="Разрешить номера телефонов">
            <LimitsSwitch fields={fields} path="phoneNumbersEnabled" />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>
      </div>
      {actions}
    </div>
  );
}
