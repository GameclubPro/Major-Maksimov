import { AppIcon as IconoirSprite } from '../../components/ui/app-icon';

import type { ChatSettings } from '@maxim/contracts/settings';
import { Suspense } from 'react';
import { BroadcastLinkButtonsEditor } from '../../components/broadcast-link-buttons-editor';
import { createEmptyBroadcastLinkButton } from '../../lib/broadcast-link-buttons';
import { cn } from '../../lib/cn';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import { enableDefaultSanctionStages } from '../settings-page-state';
import { EditToggleButton } from './settings-edit-toggle-button';
import { SettingsTrafficControls } from './settings-traffic-controls';
import type { BotMessageEditorProps } from './settings-page-helpers';
import type { SettingsLimitsSectionProps } from './settings-limits-section';
import {
  MESSAGE_COUNT_LIMIT_MAX,
  MESSAGE_COUNT_LIMIT_MIN,
  MESSAGE_COUNT_LIMIT_WINDOW_MAX_HOURS,
  MESSAGE_COUNT_LIMIT_WINDOW_MIN_HOURS,
  MESSAGE_LENGTH_MAX,
  MESSAGE_LENGTH_MIN,
  MESSAGE_LENGTH_STEP,
  MESSAGE_LIMITS_ADMIN_CONTACT_BUTTON_GROUP,
  MESSAGE_LIMITS_BOT_BUTTON_GROUP,
  MaxMessageLengthSlider,
  PHOTO_COOLDOWN_MAX_HOURS,
  PHOTO_COOLDOWN_MIN_HOURS,
  STICKER_COOLDOWN_MAX_MINUTES,
  STICKER_COOLDOWN_MIN_MINUTES,
} from './settings-limits-controls';

const LazyBotMessageEditor = recoverableLazyNamedComponent<BotMessageEditorProps>(
  () => import('../../components/bot-speech-message-editor'),
  'BotMessageEditor',
);

export function SettingsLimitsEditor(props: SettingsLimitsSectionProps) {
  const {
    adjustStickerMessageCooldown,
    api,
    botSpeechEditorProps,
    botSpeechPreviewContext,
    clearButtonGroupErrors,
    deleteSpammersRuntimeStatus,
    draft,
    fieldErrors,
    hasMessageLimitsBotButtonError,
    messageLimitsBotButtonErrors,
    openBotEditorKey,
    openHintKey,
    renderAdminContactToggle,
    renderInlineHint,
    renderMuteStageToggle,
    setFieldValue,
    setOpenBotEditorKey,
    spammerReviewMetricsQuery,
    toggleBotMessageEditor,
    toggleHint,
    updateDraftButtonGroup,
  } = props;

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
              <IconoirSprite variant="iconoir" icon="InfoCircle" aria-hidden />
            </button>
          </div>

          <label className="settings-native-switch" aria-label="Включить антиспам">
            <input
              type="checkbox"
              checked={draft.antiSpamEnabled}
              onChange={(event) => setFieldValue('antiSpamEnabled', event.target.checked)}
            />
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

      <SettingsTrafficControls
        draft={draft}
        setFieldValue={setFieldValue}
        fieldErrors={fieldErrors}
      />

      <div className="settings-native-toggle">
        <div className="settings-native-toggle__row">
          <div className="settings-native-toggle__title-wrap">
            <span className="settings-native-toggle__title">Удалять спамеров</span>
            <div className="settings-native-toggle__title-actions">
              <span
                className={cn(
                  'settings-native-toggle__status',
                  draft.deleteSpammersEnabled && 'is-active',
                  spammerReviewMetricsQuery.data?.enforcementMode === 'shadow' &&
                    draft.deleteSpammersEnabled &&
                    'is-shadow',
                )}
              >
                {deleteSpammersRuntimeStatus}
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
                <IconoirSprite variant="iconoir" icon="InfoCircle" aria-hidden />
              </button>
            </div>
          </div>

          <label className="settings-native-switch" aria-label="Включить удаление спамеров">
            <input
              type="checkbox"
              checked={draft.deleteSpammersEnabled}
              onChange={(event) => setFieldValue('deleteSpammersEnabled', event.target.checked)}
            />
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
          (fieldErrors.messageCountLimitMessages || fieldErrors.messageCountLimitWindowHours) &&
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
              <IconoirSprite variant="iconoir" icon="InfoCircle" aria-hidden />
            </button>
          </div>

          <label className="settings-native-switch" aria-label="Включить лимит сообщений">
            <input
              type="checkbox"
              checked={draft.messageCountLimitEnabled}
              onChange={(event) => {
                const enabled = event.target.checked;
                setFieldValue('messageCountLimitEnabled', enabled);
                if (enabled) {
                  enableDefaultSanctionStages(setFieldValue, 'messageLimits');
                }
              }}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>

        {draft.messageCountLimitEnabled ? (
          <>
            <div className="settings-native-toggle__row">
              <span className="settings-native-toggle__title settings-native-toggle__title--sub">
                Сообщений
              </span>
              <output className="settings-length-limit__value" aria-live="polite">
                {draft.messageCountLimitMessages}
              </output>
            </div>
            <input
              className="settings-length-limit__slider"
              type="range"
              min={MESSAGE_COUNT_LIMIT_MIN}
              max={MESSAGE_COUNT_LIMIT_MAX}
              step={1}
              value={draft.messageCountLimitMessages}
              onChange={(event) =>
                setFieldValue(
                  'messageCountLimitMessages',
                  Number(event.target.value) as ChatSettings['messageCountLimitMessages'],
                )
              }
              aria-label="Лимит сообщений за выбранный период"
            />
            <div className="settings-length-limit__labels" aria-hidden>
              <span>{MESSAGE_COUNT_LIMIT_MIN}</span>
              <span>{MESSAGE_COUNT_LIMIT_MAX}</span>
            </div>

            <div className="settings-native-toggle__row">
              <span className="settings-native-toggle__title settings-native-toggle__title--sub">
                Период
              </span>
              <output className="settings-length-limit__value" aria-live="polite">
                {draft.messageCountLimitWindowHours}ч
              </output>
            </div>
            <input
              className="settings-length-limit__slider"
              type="range"
              min={MESSAGE_COUNT_LIMIT_WINDOW_MIN_HOURS}
              max={MESSAGE_COUNT_LIMIT_WINDOW_MAX_HOURS}
              step={1}
              value={draft.messageCountLimitWindowHours}
              onChange={(event) =>
                setFieldValue(
                  'messageCountLimitWindowHours',
                  Number(event.target.value) as ChatSettings['messageCountLimitWindowHours'],
                )
              }
              aria-label="Период лимита сообщений в часах"
            />
            <div className="settings-length-limit__labels" aria-hidden>
              <span>{MESSAGE_COUNT_LIMIT_WINDOW_MIN_HOURS}ч</span>
              <span>{MESSAGE_COUNT_LIMIT_WINDOW_MAX_HOURS}ч</span>
            </div>
          </>
        ) : null}

        {fieldErrors.messageCountLimitMessages ? (
          <small className="field__hint">{fieldErrors.messageCountLimitMessages}</small>
        ) : fieldErrors.messageCountLimitWindowHours ? (
          <small className="field__hint">{fieldErrors.messageCountLimitWindowHours}</small>
        ) : openHintKey === 'messageCountLimit' ? (
          <p id="message-count-limit-hint" className="settings-native-toggle__hint">
            Лимит действует отдельно для каждого участника за последние выбранные часы. Учитываются
            новые сообщения, включая ответы; фото одного альбома — как одна публикация.
            Редактирование не расходует лимит. Попытки сверх лимита не продлевают ожидание.
          </p>
        ) : null}
      </div>

      <div className={cn('settings-native-toggle', fieldErrors.maxMessageLength && 'field--error')}>
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
              <IconoirSprite variant="iconoir" icon="InfoCircle" aria-hidden />
            </button>
          </div>

          <label
            className="settings-native-switch"
            aria-label="Включить ограничение длины сообщения"
          >
            <input
              type="checkbox"
              checked={draft.maxMessageLengthEnabled}
              onChange={(event) => {
                const enabled = event.target.checked;
                setFieldValue('maxMessageLengthEnabled', enabled);
                if (!enabled) props.onMaxMessageLengthError(null);
                if (enabled) {
                  enableDefaultSanctionStages(setFieldValue, 'messageLimits');
                }
              }}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>

        {draft.maxMessageLengthEnabled ? (
          <MaxMessageLengthSlider
            value={draft.maxMessageLength}
            min={MESSAGE_LENGTH_MIN}
            max={MESSAGE_LENGTH_MAX}
            step={MESSAGE_LENGTH_STEP}
            error={fieldErrors.maxMessageLength}
            onError={props.onMaxMessageLengthError}
            onCommit={(value) =>
              setFieldValue('maxMessageLength', value as ChatSettings['maxMessageLength'])
            }
          />
        ) : null}

        {openHintKey === 'maxMessageLength' ? (
          <p id="max-message-length-hint" className="settings-native-toggle__hint">
            Удаляет сообщения длиннее выбранного лимита. Учитывает текст и подписи к медиа, в том
            числе в пересылках, а также пробелы и переносы строк. Один эмодзи — один символ. Текст
            цитаты при ответе не учитывается.
          </p>
        ) : null}

        {fieldErrors.maxMessageLength && !draft.maxMessageLengthEnabled ? (
          <small className="field__hint">{fieldErrors.maxMessageLength}</small>
        ) : null}
      </div>

      <div
        className={cn(
          'settings-native-toggle',
          fieldErrors.photoMessageCooldownHours && 'field--error',
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
              <IconoirSprite variant="iconoir" icon="InfoCircle" aria-hidden />
            </button>
          </div>

          <label
            className="settings-native-switch"
            aria-label="Ограничить отправку фото по времени"
          >
            <input
              type="checkbox"
              checked={draft.photoMessageCooldownEnabled}
              onChange={(event) => {
                const enabled = event.target.checked;
                setFieldValue('photoMessageCooldownEnabled', enabled);
                if (enabled) {
                  enableDefaultSanctionStages(setFieldValue, 'messageLimits');
                }
              }}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>

        {draft.photoMessageCooldownEnabled ? (
          <>
            <div className="settings-native-toggle__row">
              <span className="settings-native-toggle__title settings-native-toggle__title--sub">
                Интервал
              </span>
              <output className="settings-length-limit__value" aria-live="polite">
                {draft.photoMessageCooldownHours}ч
              </output>
            </div>
            <input
              className="settings-length-limit__slider"
              type="range"
              min={PHOTO_COOLDOWN_MIN_HOURS}
              max={PHOTO_COOLDOWN_MAX_HOURS}
              step={1}
              value={draft.photoMessageCooldownHours}
              onChange={(event) =>
                setFieldValue(
                  'photoMessageCooldownHours',
                  Number(event.target.value) as ChatSettings['photoMessageCooldownHours'],
                )
              }
              aria-label="Интервал отправки фото в часах"
            />
            <div className="settings-length-limit__labels" aria-hidden>
              <span>{PHOTO_COOLDOWN_MIN_HOURS}ч</span>
              <span>{PHOTO_COOLDOWN_MAX_HOURS}ч</span>
            </div>
          </>
        ) : null}

        {fieldErrors.photoMessageCooldownHours ? (
          <small className="field__hint">{fieldErrors.photoMessageCooldownHours}</small>
        ) : openHintKey === 'photoCooldown' ? (
          <p id="photo-cooldown-hint" className="settings-native-toggle__hint">
            Каждый участник может отправить одно сообщение с фото за выбранное время. Следующее
            сообщение с фото до окончания этого времени будет удалено.
          </p>
        ) : null}
      </div>

      {draft.stickerMessagesEnabled ? (
        <div
          className={cn(
            'settings-native-toggle',
            fieldErrors.stickerMessageCooldownMinutes && 'field--error',
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
                <IconoirSprite variant="iconoir" icon="InfoCircle" aria-hidden />
              </button>
            </div>

            <label
              className="settings-native-switch"
              aria-label="Ограничить отправку стикеров по времени"
            >
              <input
                type="checkbox"
                checked={draft.stickerMessageCooldownEnabled}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setFieldValue('stickerMessageCooldownEnabled', enabled);
                  if (enabled) {
                    enableDefaultSanctionStages(setFieldValue, 'messageLimits');
                  }
                }}
              />
              <span className="toggle-switch" aria-hidden>
                <span className="toggle-switch__thumb" />
              </span>
            </label>
          </div>

          {draft.stickerMessageCooldownEnabled ? (
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
                  disabled={draft.stickerMessageCooldownMinutes <= STICKER_COOLDOWN_MIN_MINUTES}
                  aria-label="Уменьшить интервал отправки стикеров"
                >
                  -
                </button>
                <output className="ban-duration-stepper__value" aria-live="polite">
                  {draft.stickerMessageCooldownMinutes} мин
                </output>
                <button
                  type="button"
                  className="ban-duration-stepper__button"
                  onClick={() => adjustStickerMessageCooldown(1)}
                  disabled={draft.stickerMessageCooldownMinutes >= STICKER_COOLDOWN_MAX_MINUTES}
                  aria-label="Увеличить интервал отправки стикеров"
                >
                  +
                </button>
              </div>
            </div>
          ) : null}

          {fieldErrors.stickerMessageCooldownMinutes ? (
            <small className="field__hint">{fieldErrors.stickerMessageCooldownMinutes}</small>
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
            <input
              type="checkbox"
              checked={draft.stickerMessagesEnabled}
              onChange={(event) => setFieldValue('stickerMessagesEnabled', event.target.checked)}
            />
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
            <input
              type="checkbox"
              checked={draft.photoMessagesEnabled}
              onChange={(event) => {
                const enabled = event.target.checked;
                setFieldValue('photoMessagesEnabled', enabled);
                if (!enabled) {
                  enableDefaultSanctionStages(setFieldValue, 'messageLimits');
                }
              }}
            />
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
            <input
              type="checkbox"
              checked={draft.videoMessagesEnabled}
              onChange={(event) => {
                const enabled = event.target.checked;
                setFieldValue('videoMessagesEnabled', enabled);
                if (!enabled) {
                  enableDefaultSanctionStages(setFieldValue, 'messageLimits');
                }
              }}
            />
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
            <input
              type="checkbox"
              checked={draft.fileMessagesEnabled}
              onChange={(event) => {
                const enabled = event.target.checked;
                setFieldValue('fileMessagesEnabled', enabled);
                if (!enabled) {
                  enableDefaultSanctionStages(setFieldValue, 'messageLimits');
                }
              }}
            />
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
            <input
              type="checkbox"
              checked={draft.voiceMessagesEnabled}
              onChange={(event) => {
                const enabled = event.target.checked;
                setFieldValue('voiceMessagesEnabled', enabled);
                if (!enabled) {
                  enableDefaultSanctionStages(setFieldValue, 'messageLimits');
                }
              }}
            />
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
            <input
              type="checkbox"
              checked={draft.forwardedMessagesEnabled}
              onChange={(event) => {
                const enabled = event.target.checked;
                setFieldValue('forwardedMessagesEnabled', enabled);
                if (!enabled) {
                  enableDefaultSanctionStages(setFieldValue, 'messageLimits');
                }
              }}
            />
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
            <input
              type="checkbox"
              checked={draft.phoneNumbersEnabled}
              onChange={(event) => setFieldValue('phoneNumbersEnabled', event.target.checked)}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>
      </div>

      <div className="settings-subsection-divider" role="separator" aria-label="Блок действий бота">
        <span>Действия бота</span>
      </div>

      <div className="settings-native-toggle">
        <div className="settings-native-toggle__row">
          <div className="settings-native-toggle__title-wrap">
            <span className="settings-native-toggle__title">Сообщение от бота</span>
            <div className="settings-native-toggle__title-actions">
              <EditToggleButton
                label="Редактировать текст сообщения об ограничениях"
                onClick={() => toggleBotMessageEditor('messageLimits')}
                disabled={!draft.messageLimitsBotMessageEnabled}
                isOpen={openBotEditorKey === 'messageLimits'}
              />
              <button
                type="button"
                className={cn(
                  'settings-info-button',
                  openHintKey === 'messageLimitsBotMessage' && 'is-open',
                )}
                aria-label="Пояснение для тумблера сообщений в блоке ограничений"
                aria-controls="message-limits-bot-message-hint"
                aria-expanded={openHintKey === 'messageLimitsBotMessage'}
                data-hint-key="messageLimitsBotMessage"
                onClick={() => toggleHint('messageLimitsBotMessage')}
              >
                <IconoirSprite variant="iconoir" icon="InfoCircle" aria-hidden />
              </button>
            </div>
          </div>

          <label
            className="settings-native-switch"
            aria-label="Включить сообщение от бота для ограничений сообщений"
          >
            <input
              type="checkbox"
              checked={draft.messageLimitsBotMessageEnabled}
              onChange={(event) => {
                const enabled = event.target.checked;
                setFieldValue('messageLimitsBotMessageEnabled', enabled);
                if (!enabled) {
                  setFieldValue('messageLimitsBotButtonEnabled', false);
                  clearButtonGroupErrors(MESSAGE_LIMITS_BOT_BUTTON_GROUP);
                }
              }}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>

        {openHintKey === 'messageLimitsBotMessage' ? (
          <p id="message-limits-bot-message-hint" className="settings-native-toggle__hint">
            Бот отправляет пояснение при удалении сообщения по правилам этого блока. Текст можно
            настроить вручную или вернуть к выбранному стилю.
          </p>
        ) : null}

        {draft.messageLimitsBotMessageEnabled && openBotEditorKey === 'messageLimits' ? (
          <Suspense fallback={null}>
            <LazyBotMessageEditor
              editorKey="messageLimits"
              {...botSpeechEditorProps!}
              botSpeechPreviewContext={botSpeechPreviewContext}
              value={draft.messageLimitsBotMessageText}
              onChange={(nextValue) =>
                setFieldValue(
                  'messageLimitsBotMessageText',
                  nextValue as ChatSettings['messageLimitsBotMessageText'],
                )
              }
              onReset={() => setFieldValue('messageLimitsBotMessageText', '')}
              onClose={() => setOpenBotEditorKey(null)}
            />
          </Suspense>
        ) : null}
      </div>

      <div className="settings-native-toggle settings-native-toggle--nested">
        <div className="settings-native-toggle__row">
          <span className="settings-native-toggle__title">2. Предупреждение</span>

          <label
            className="settings-native-switch"
            aria-label="Включить предупреждение за второе нарушение ограничений сообщений за 12 часов"
          >
            <input
              type="checkbox"
              checked={draft.messageLimitsWarnEnabled}
              onChange={(event) => {
                const enabled = event.target.checked;
                setFieldValue('messageLimitsWarnEnabled', enabled);
                if (enabled) {
                  setFieldValue('messageLimitsBotMessageEnabled', true);
                }
              }}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>
      </div>

      {renderMuteStageToggle({
        enabledKey: 'messageLimitsMuteEnabled',
        durationKey: 'messageLimitsMuteDurationHours',
        title: '3. Ограничение',
        onEnable: () => {
          setFieldValue('messageLimitsWarnEnabled', true);
          setFieldValue('messageLimitsBotMessageEnabled', true);
        },
      })}

      <div className="settings-native-toggle settings-native-toggle--nested">
        <div className="settings-native-toggle__row">
          <span className="settings-native-toggle__title">4. Блокировка</span>

          <label
            className="settings-native-switch"
            aria-label="Включить блокировку за повторные нарушения"
          >
            <input
              type="checkbox"
              checked={draft.messageLimitsBanEnabled}
              onChange={(event) => {
                const enabled = event.target.checked;
                setFieldValue('messageLimitsBanEnabled', enabled);
                if (enabled) {
                  setFieldValue('messageLimitsWarnEnabled', true);
                  setFieldValue('messageLimitsBotMessageEnabled', true);
                }
              }}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>
      </div>

      {draft.messageLimitsBotMessageEnabled ? (
        <div
          className={cn(
            'settings-native-toggle',
            'settings-native-toggle--nested',
            hasMessageLimitsBotButtonError && 'field--error',
          )}
        >
          <div className="settings-native-toggle__row">
            <div className="settings-native-toggle__title-wrap">
              <span className="settings-native-toggle__title">Добавить кнопку</span>
              <button
                type="button"
                className={cn(
                  'settings-info-button',
                  openHintKey === 'messageLimitsBotButton' && 'is-open',
                )}
                aria-label="Пояснение для кнопки в сообщении ограничений"
                aria-controls="message-limits-bot-button-hint"
                aria-expanded={openHintKey === 'messageLimitsBotButton'}
                data-hint-key="messageLimitsBotButton"
                onClick={() => toggleHint('messageLimitsBotButton')}
              >
                <IconoirSprite variant="iconoir" icon="InfoCircle" aria-hidden />
              </button>
            </div>

            <label
              className="settings-native-switch"
              aria-label="Добавить кнопку в сообщение бота для ограничений сообщений"
            >
              <input
                type="checkbox"
                checked={draft.messageLimitsBotButtonEnabled}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  updateDraftButtonGroup(MESSAGE_LIMITS_BOT_BUTTON_GROUP, {
                    enabled,
                    ...(enabled && draft.messageLimitsBotButtons.length === 0
                      ? { buttons: [createEmptyBroadcastLinkButton()] }
                      : {}),
                  });
                }}
              />
              <span className="toggle-switch" aria-hidden>
                <span className="toggle-switch__thumb" />
              </span>
            </label>
          </div>

          {renderInlineHint(
            'messageLimitsBotButton',
            'message-limits-bot-button-hint',
            'Добавляет кнопку в сообщение бота с переходом на чат, канал или профиль.',
            hasMessageLimitsBotButtonError,
          )}

          {draft.messageLimitsBotButtonEnabled ? (
            <BroadcastLinkButtonsEditor
              api={api}
              buttons={draft.messageLimitsBotButtons}
              errors={messageLimitsBotButtonErrors}
              onChange={(nextButtons) =>
                updateDraftButtonGroup(MESSAGE_LIMITS_BOT_BUTTON_GROUP, {
                  buttons: nextButtons,
                  enabled: nextButtons.length > 0,
                })
              }
              urlPlaceholder="https://max.ru/channel/..."
              textPlaceholder="Открыть"
              title="Кнопки сообщения"
              subtitle="Название и ссылка"
            />
          ) : null}
        </div>
      ) : null}

      {draft.messageLimitsBotMessageEnabled
        ? renderAdminContactToggle(
            MESSAGE_LIMITS_ADMIN_CONTACT_BUTTON_GROUP,
            'Добавить связь с админом в сообщения об ограничениях',
          )
        : null}
    </div>
  );
}
