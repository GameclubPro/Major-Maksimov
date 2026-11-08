import { AppIcon as IconoirSprite } from '../../components/ui/app-icon';
import { getNetworkSettingsSectionPresentation } from './settings-workspace-sections';

import type { ChatSettings, ChatClosureStatus } from '@maxim/contracts/settings';
import { Suspense } from 'react';
import SettingsChatClosureStatus from './settings-chat-closure-status';
import { getNightTimezoneOptions } from './settings-timezones';
import './settings-night-status.css';
import { BroadcastLinkButtonsEditor } from '../../components/broadcast-link-buttons-editor';
import { GlassCard } from '../../components/ui/glass-card';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import {
  SettingsSectionIcon,
  SettingsSectionToggle,
} from '../../components/ui/settings-section-toggle';
import type { ApiTransport } from '../../lib/api/transport';
import {
  createEmptyBroadcastLinkButton,
  type BroadcastLinkButtonFieldErrors,
} from '../../lib/broadcast-link-buttons';
import { cn } from '../../lib/cn';
import {
  applyNightModeBotMessageEnabledChange,
  applyNightModeEnabledChange,
} from '../settings-page-state';
import {
  EditToggleButton,
  LazyBotMessageEditor,
  LazySettingsTimeFields,
  NIGHT_FORCE_CLOSE_MAX_DAYS,
  NIGHT_FORCE_CLOSE_MAX_HOURS,
  NIGHT_FORCE_CLOSE_MIN_DAYS,
  NIGHT_FORCE_CLOSE_MIN_HOURS,
  NIGHT_MODE_BOT_BUTTON_GROUP,
  PublishedRulesButtonToggleSlot,
  SettingsHintAnchor,
} from './settings-page-helpers';
import type {
  SettingsSectionEditorProps,
  SettingsSectionHintProps,
  SettingsSectionMutationProps,
  SettingsSectionShellProps,
} from './settings-section-shared';

export type SettingsNightSectionProps = SettingsSectionShellProps &
  Pick<
    SettingsSectionEditorProps,
    | 'botSpeechEditorProps'
    | 'botSpeechPreviewContext'
    | 'openBotEditorKey'
    | 'setOpenBotEditorKey'
    | 'toggleBotMessageEditor'
  > &
  SettingsSectionHintProps &
  Pick<
    SettingsSectionMutationProps,
    | 'draft'
    | 'setDraft'
    | 'setFieldValue'
    | 'clearFieldError'
    | 'clearButtonGroupErrors'
    | 'updateDraftButtonGroup'
  > & {
    api: ApiTransport;
    closureStatus?: ChatClosureStatus;
    closureRefreshFailed?: boolean;
    hasNightBotButtonError: boolean;
    hasNightForceCloseDurationError: boolean;
    hasPublishedRules: boolean;
    nightBotButtonErrors: BroadcastLinkButtonFieldErrors[];
    nightCardStatus: string;
    nightForceCloseDaysError?: string;
    nightForceCloseHoursError?: string;
    nightHeaderSummary: string;
    nightTimeError?: string;
    nightTimezoneError?: string;
  };

const SECTION_PRESENTATION = getNetworkSettingsSectionPresentation('chat', 'night');

export function SettingsNightSection(props: SettingsNightSectionProps) {
  const {
    api,
    botSpeechEditorProps,
    botSpeechPreviewContext,
    clearButtonGroupErrors,
    clearFieldError,
    discardSectionChanges,
    draft,
    expanded,
    hasNightBotButtonError,
    hasNightForceCloseDurationError,
    hasPublishedRules,
    isSectionDirty,
    nightBotButtonErrors,
    nightCardStatus,
    nightForceCloseDaysError,
    nightForceCloseHoursError,
    nightHeaderSummary,
    nightTimeError,
    nightTimezoneError,
    openBotEditorKey,
    openHintKey,
    renderApplyTargetHeaderAction,
    renderInlineHint,
    renderSectionSaveFooter,
    setDraft,
    setFieldValue,
    setOpenBotEditorKey,
    toggleBotMessageEditor,
    toggleHint,
    toggleSection,
    updateDraftButtonGroup,
  } = props;

  return (
    <GlassCard
      className="settings-section settings-home-entry settings-home-entry--list settings-home-entry--wide stagger-in"
      style={{ animationDelay: '250ms', order: SECTION_PRESENTATION.order }}
      aria-label="Ночной режим"
    >
      <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
        <SettingsSectionToggle
          title={SECTION_PRESENTATION.title}
          enabled={draft.nightModeEnabled || draft.nightModeForceCloseEnabled}
          summary={nightHeaderSummary}
          status={nightCardStatus}
          icon={SECTION_PRESENTATION.icon}
          tone={SECTION_PRESENTATION.tone}
          open={expanded}
          controls="settings-night-content"
          onClick={() => toggleSection('night')}
        />
      </div>

      <SettingsDrilldownPanel
        id="settings-night-content"
        icon={<SettingsSectionIcon name={SECTION_PRESENTATION.icon} />}
        open={expanded}
        title={SECTION_PRESENTATION.title}
        summary={nightHeaderSummary}
        tone={SECTION_PRESENTATION.tone}
        className={SECTION_PRESENTATION.panelClassName}
        onClose={() => toggleSection('night')}
        headerAction={renderApplyTargetHeaderAction('night')}
        confirmCloseWhen={isSectionDirty('night')}
        onDiscardChanges={() => discardSectionChanges('night')}
        footer={renderSectionSaveFooter('night')}
      >
        {props.sharedContent ? (
          <>
            {expanded ? (
              <>
                {props.closureStatus ? (
                  <SettingsChatClosureStatus
                    status={props.closureStatus}
                    refreshFailed={props.closureRefreshFailed}
                  />
                ) : (
                  <p role="status">Текущее состояние закрытия неизвестно.</p>
                )}
                {props.sharedContent}
              </>
            ) : null}
          </>
        ) : (
          <>
            <div
              id="settings-night-content"
              className={cn('settings-section__collapse', expanded && 'is-open')}
            >
              {expanded ? (
                <div className="settings-section__collapse-inner">
                  {props.closureStatus ? (
                    <SettingsChatClosureStatus
                      status={props.closureStatus}
                      refreshFailed={props.closureRefreshFailed}
                    />
                  ) : null}
                  <div className="settings-native-toggle">
                    <div className="settings-native-toggle__row">
                      <div className="settings-native-toggle__title-wrap">
                        <span className="settings-native-toggle__title">
                          Закрывать по расписанию
                        </span>
                        <button
                          type="button"
                          className={cn(
                            'settings-info-button',
                            openHintKey === 'nightModeEnabled' && 'is-open',
                          )}
                          aria-label="Пояснение для ночного режима"
                          aria-controls="night-mode-enabled-hint"
                          aria-expanded={openHintKey === 'nightModeEnabled'}
                          data-hint-key="nightModeEnabled"
                          onClick={() => toggleHint('nightModeEnabled')}
                        >
                          <IconoirSprite variant="iconoir" icon="InfoCircle" aria-hidden />
                        </button>
                      </div>

                      <label
                        className="settings-native-switch"
                        aria-label="Включить закрытие чата на ночь"
                      >
                        <input
                          type="checkbox"
                          checked={draft.nightModeEnabled}
                          onChange={(event) => {
                            const enabled = event.target.checked;
                            setDraft((current) =>
                              current ? applyNightModeEnabledChange(current, enabled) : current,
                            );
                            clearFieldError('nightModeEnabled');
                            clearFieldError('nightModeStartTimeMinutes');
                            clearFieldError('nightModeEndTimeMinutes');
                            if (!enabled) {
                              clearFieldError('nightModeBotMessageEnabled');
                              clearFieldError('nightModeCommentsEnabled');
                              clearFieldError('nightModeBotButtonEnabled');
                              clearFieldError('nightModeRulesButtonEnabled');
                              clearButtonGroupErrors(NIGHT_MODE_BOT_BUTTON_GROUP);
                            }
                          }}
                        />
                        <span className="toggle-switch" aria-hidden>
                          <span className="toggle-switch__thumb" />
                        </span>
                      </label>
                    </div>

                    {openHintKey === 'nightModeEnabled' ? (
                      <p id="night-mode-enabled-hint" className="settings-native-toggle__hint">
                        Каждый день в выбранное время бот удаляет новые сообщения участников.
                        Администраторы могут продолжать писать. Расписание работает по часовому
                        поясу, выбранному ниже.
                      </p>
                    ) : null}
                  </div>

                  {draft.nightModeEnabled ? (
                    <div
                      className={cn(
                        'settings-native-toggle',
                        (nightTimeError || nightTimezoneError) && 'field--error',
                      )}
                    >
                      <div className="night-window-grid">
                        <Suspense fallback={null}>
                          <LazySettingsTimeFields
                            kind="night"
                            startMinutes={draft.nightModeStartTimeMinutes}
                            endMinutes={draft.nightModeEndTimeMinutes}
                            error={nightTimeError}
                            onChange={(key, nextValue) => {
                              setFieldValue(key, nextValue as ChatSettings[typeof key]);
                              clearFieldError('nightModeStartTimeMinutes');
                              clearFieldError('nightModeEndTimeMinutes');
                            }}
                          />
                        </Suspense>
                      </div>

                      <label className={cn('field', nightTimezoneError && 'field--error')}>
                        <span className="field__label">Часовой пояс</span>
                        <select
                          value={draft.nightModeTimezone}
                          onChange={(event) =>
                            setFieldValue('nightModeTimezone', event.target.value)
                          }
                        >
                          {getNightTimezoneOptions(draft.nightModeTimezone).map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        {nightTimezoneError ? (
                          <small className="field__hint">{nightTimezoneError}</small>
                        ) : null}
                      </label>
                    </div>
                  ) : null}

                  {draft.nightModeEnabled ? (
                    <>
                      <div
                        className="settings-subsection-divider"
                        role="separator"
                        aria-label="Блок действий бота для ночного режима"
                      >
                        <span>Действия бота</span>
                      </div>

                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">Сообщение от бота</span>
                            <div className="settings-native-toggle__title-actions">
                              <EditToggleButton
                                label="Редактировать текст сообщения ночного режима"
                                onClick={() => toggleBotMessageEditor('night')}
                                disabled={!draft.nightModeBotMessageEnabled}
                                isOpen={openBotEditorKey === 'night'}
                              />
                              <button
                                type="button"
                                className={cn(
                                  'settings-info-button',
                                  openHintKey === 'nightBotMessage' && 'is-open',
                                )}
                                aria-label="Пояснение для тумблера сообщений ночного режима"
                                aria-controls="night-bot-message-hint"
                                aria-expanded={openHintKey === 'nightBotMessage'}
                                data-hint-key="nightBotMessage"
                                onClick={() => toggleHint('nightBotMessage')}
                              >
                                <IconoirSprite variant="iconoir" icon="InfoCircle" aria-hidden />
                              </button>
                            </div>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить сообщение от бота для ночного режима"
                          >
                            <input
                              type="checkbox"
                              checked={draft.nightModeBotMessageEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setDraft((current) =>
                                  current
                                    ? applyNightModeBotMessageEnabledChange(current, enabled)
                                    : current,
                                );
                                clearFieldError('nightModeBotMessageEnabled');
                                clearFieldError('nightModeStartTimeMinutes');
                                clearFieldError('nightModeEndTimeMinutes');
                                if (!enabled) {
                                  clearFieldError('nightModeCommentsEnabled');
                                  clearFieldError('nightModeBotButtonEnabled');
                                  clearFieldError('nightModeRulesButtonEnabled');
                                  clearButtonGroupErrors(NIGHT_MODE_BOT_BUTTON_GROUP);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'nightBotMessage' ? (
                          <p id="night-bot-message-hint" className="settings-native-toggle__hint">
                            Бот пишет, что чат закрыт на ночь, и поясняет удаление сообщения.
                          </p>
                        ) : null}

                        {draft.nightModeBotMessageEnabled && openBotEditorKey === 'night' ? (
                          <LazyBotMessageEditor
                            editorKey="night"
                            {...botSpeechEditorProps!}
                            botSpeechPreviewContext={botSpeechPreviewContext}
                            value={draft.nightModeBotMessageText}
                            onChange={(nextValue) =>
                              setFieldValue(
                                'nightModeBotMessageText',
                                nextValue as ChatSettings['nightModeBotMessageText'],
                              )
                            }
                            onReset={() => setFieldValue('nightModeBotMessageText', '')}
                            onClose={() => setOpenBotEditorKey(null)}
                          />
                        ) : null}
                      </div>

                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">
                              Сообщение об открытии
                            </span>
                            <div className="settings-native-toggle__title-actions">
                              <EditToggleButton
                                label="Редактировать текст сообщения об открытии группы"
                                onClick={() => toggleBotMessageEditor('nightOpen')}
                                disabled={!draft.nightModeOpenMessageEnabled}
                                isOpen={openBotEditorKey === 'nightOpen'}
                              />
                              <button
                                type="button"
                                className={cn(
                                  'settings-info-button',
                                  openHintKey === 'nightOpenMessage' && 'is-open',
                                )}
                                aria-label="Пояснение для сообщения об открытии группы"
                                aria-controls="night-open-message-hint"
                                aria-expanded={openHintKey === 'nightOpenMessage'}
                                data-hint-key="nightOpenMessage"
                                onClick={() => toggleHint('nightOpenMessage')}
                              >
                                <IconoirSprite variant="iconoir" icon="InfoCircle" aria-hidden />
                              </button>
                            </div>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить сообщение об открытии группы после ночного режима"
                          >
                            <input
                              type="checkbox"
                              checked={draft.nightModeOpenMessageEnabled}
                              onChange={(event) => {
                                setFieldValue('nightModeOpenMessageEnabled', event.target.checked);
                                clearFieldError('nightModeStartTimeMinutes');
                                clearFieldError('nightModeEndTimeMinutes');
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'nightOpenMessage' ? (
                          <p id="night-open-message-hint" className="settings-native-toggle__hint">
                            После окончания ночного режима бот пишет, что группа снова открыта, и
                            удаляет предыдущее ночное сообщение.
                          </p>
                        ) : null}

                        {draft.nightModeOpenMessageEnabled && openBotEditorKey === 'nightOpen' ? (
                          <LazyBotMessageEditor
                            editorKey="nightOpen"
                            {...botSpeechEditorProps!}
                            botSpeechPreviewContext={botSpeechPreviewContext}
                            value={draft.nightModeOpenMessageText}
                            onChange={(nextValue) =>
                              setFieldValue(
                                'nightModeOpenMessageText',
                                nextValue as ChatSettings['nightModeOpenMessageText'],
                              )
                            }
                            onReset={() => setFieldValue('nightModeOpenMessageText', '')}
                            onClose={() => setOpenBotEditorKey(null)}
                          />
                        ) : null}
                        {draft.nightModeOpenMessageEnabled ? (
                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title">
                                Удалять после первого сообщения
                              </span>
                              <label
                                className="settings-native-switch"
                                aria-label="Удалять сообщение об открытии после первого сообщения участника"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.nightModeOpenMessageDeleteOnFirstMessageEnabled}
                                  onChange={(event) =>
                                    setFieldValue(
                                      'nightModeOpenMessageDeleteOnFirstMessageEnabled',
                                      event.target.checked,
                                    )
                                  }
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>
                          </div>
                        ) : null}
                      </div>

                      {draft.nightModeBotMessageEnabled ? (
                        <div
                          className={cn('settings-native-toggle', 'settings-native-toggle--nested')}
                        >
                          <div className="settings-native-toggle__row">
                            <div className="settings-native-toggle__title-wrap">
                              <span className="settings-native-toggle__title">Комментарии</span>
                              <div className="settings-native-toggle__title-actions">
                                <SettingsHintAnchor
                                  hintKey="nightComments"
                                  openHintKey={openHintKey}
                                  onToggleHint={toggleHint}
                                  label="Как работают комментарии под ночным сообщением"
                                >
                                  Кнопка «Комментарии» под сообщением о закрытии группы.
                                </SettingsHintAnchor>
                              </div>
                            </div>

                            <label
                              className="settings-native-switch"
                              aria-label="Добавить комментарии под сообщением ночного режима"
                            >
                              <input
                                type="checkbox"
                                checked={draft.nightModeCommentsEnabled}
                                onChange={(event) =>
                                  setFieldValue('nightModeCommentsEnabled', event.target.checked)
                                }
                              />
                              <span className="toggle-switch" aria-hidden>
                                <span className="toggle-switch__thumb" />
                              </span>
                            </label>
                          </div>
                        </div>
                      ) : null}

                      {draft.nightModeBotMessageEnabled ? (
                        <div
                          className={cn(
                            'settings-native-toggle',
                            'settings-native-toggle--nested',
                            hasNightBotButtonError && 'field--error',
                          )}
                        >
                          <div className="settings-native-toggle__row">
                            <div className="settings-native-toggle__title-wrap">
                              <span className="settings-native-toggle__title">Добавить кнопку</span>
                              <button
                                type="button"
                                className={cn(
                                  'settings-info-button',
                                  openHintKey === 'nightBotButton' && 'is-open',
                                )}
                                aria-label="Пояснение для кнопки в сообщении ночного режима"
                                aria-controls="night-bot-button-hint"
                                aria-expanded={openHintKey === 'nightBotButton'}
                                data-hint-key="nightBotButton"
                                onClick={() => toggleHint('nightBotButton')}
                              >
                                <IconoirSprite variant="iconoir" icon="InfoCircle" aria-hidden />
                              </button>
                            </div>

                            <label
                              className="settings-native-switch"
                              aria-label="Добавить кнопку в сообщение бота для ночного режима"
                            >
                              <input
                                type="checkbox"
                                checked={draft.nightModeBotButtonEnabled}
                                onChange={(event) => {
                                  const enabled = event.target.checked;
                                  updateDraftButtonGroup(NIGHT_MODE_BOT_BUTTON_GROUP, {
                                    enabled,
                                    ...(enabled && draft.nightModeBotButtons.length === 0
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
                            'nightBotButton',
                            'night-bot-button-hint',
                            'Добавляет кнопку в сообщение о закрытии чата на ночь.',
                            hasNightBotButtonError,
                          )}

                          {draft.nightModeBotButtonEnabled ? (
                            <BroadcastLinkButtonsEditor
                              api={api}
                              buttons={draft.nightModeBotButtons}
                              errors={nightBotButtonErrors}
                              onChange={(nextButtons) =>
                                updateDraftButtonGroup(NIGHT_MODE_BOT_BUTTON_GROUP, {
                                  buttons: nextButtons,
                                  enabled: nextButtons.length > 0,
                                })
                              }
                              urlPlaceholder="https://max.ru/channel/..."
                              textPlaceholder="Правила чата"
                              title="Кнопки сообщения"
                              subtitle="Название и ссылка"
                            />
                          ) : null}
                        </div>
                      ) : null}

                      {draft.nightModeBotMessageEnabled ? (
                        <PublishedRulesButtonToggleSlot
                          ariaLabel="Кнопка Правила в ночном режиме"
                          enabled={draft.nightModeRulesButtonEnabled}
                          hasRules={hasPublishedRules}
                          onChange={(enabled) =>
                            setFieldValue('nightModeRulesButtonEnabled', enabled)
                          }
                        />
                      ) : null}
                    </>
                  ) : null}

                  <div
                    className="settings-subsection-divider"
                    role="separator"
                    aria-label="Блок закрытия чата вручную"
                  >
                    <span>Закрыть сейчас</span>
                  </div>

                  <div className="settings-native-toggle">
                    <div className="settings-native-toggle__row">
                      <div className="settings-native-toggle__title-wrap">
                        <span className="settings-native-toggle__title">Закрыть вручную</span>
                        <button
                          type="button"
                          className={cn(
                            'settings-info-button',
                            openHintKey === 'nightForceClose' && 'is-open',
                          )}
                          aria-label="Пояснение для ручного закрытия чата"
                          aria-controls="night-force-close-hint"
                          aria-expanded={openHintKey === 'nightForceClose'}
                          data-hint-key="nightForceClose"
                          onClick={() => toggleHint('nightForceClose')}
                        >
                          <IconoirSprite variant="iconoir" icon="InfoCircle" aria-hidden />
                        </button>
                      </div>

                      <label
                        className="settings-native-switch"
                        aria-label="Включить ручное закрытие чата"
                      >
                        <input
                          type="checkbox"
                          checked={draft.nightModeForceCloseEnabled}
                          onChange={(event) => {
                            const enabled = event.target.checked;
                            setFieldValue('nightModeForceCloseEnabled', enabled);
                            setFieldValue('nightModeForceCloseUntil', '');
                            clearFieldError('nightModeForceCloseHours');
                            clearFieldError('nightModeForceCloseDays');
                            if (
                              enabled &&
                              !draft.nightModeForceCloseForever &&
                              draft.nightModeForceCloseDays === 0 &&
                              draft.nightModeForceCloseHours === 0
                            ) {
                              setFieldValue('nightModeForceCloseHours', 8);
                            }
                          }}
                        />
                        <span className="toggle-switch" aria-hidden>
                          <span className="toggle-switch__thumb" />
                        </span>
                      </label>
                    </div>

                    {openHintKey === 'nightForceClose' ? (
                      <p id="night-force-close-hint" className="settings-native-toggle__hint">
                        После сохранения бот начнёт удалять новые сообщения участников без
                        пояснений. Администраторы смогут продолжать писать. Ручное закрытие
                        действует независимо от ночного расписания, до конца выбранного срока или
                        пока вы его не выключите.
                      </p>
                    ) : null}
                  </div>

                  {draft.nightModeForceCloseEnabled ? (
                    <div className="settings-native-toggle settings-native-toggle--nested">
                      <div className="settings-native-toggle__row">
                        <span className="settings-native-toggle__title">Без срока</span>

                        <label
                          className="settings-native-switch"
                          aria-label="Включить бессрочное ручное закрытие чата"
                        >
                          <input
                            type="checkbox"
                            checked={draft.nightModeForceCloseForever}
                            onChange={(event) => {
                              const enabled = event.target.checked;
                              setFieldValue('nightModeForceCloseForever', enabled);
                              setFieldValue('nightModeForceCloseUntil', '');
                              clearFieldError('nightModeForceCloseHours');
                              clearFieldError('nightModeForceCloseDays');
                              if (
                                !enabled &&
                                draft.nightModeForceCloseDays === 0 &&
                                draft.nightModeForceCloseHours === 0
                              ) {
                                setFieldValue('nightModeForceCloseHours', 8);
                              }
                            }}
                          />
                          <span className="toggle-switch" aria-hidden>
                            <span className="toggle-switch__thumb" />
                          </span>
                        </label>
                      </div>
                    </div>
                  ) : null}

                  {draft.nightModeForceCloseEnabled && !draft.nightModeForceCloseForever ? (
                    <div
                      className={cn(
                        'settings-native-toggle',
                        'settings-native-toggle--nested',
                        hasNightForceCloseDurationError && 'field--error',
                      )}
                    >
                      <div className="settings-duration-stack">
                        <div className="settings-duration-stack__item">
                          <div className="settings-native-toggle__row">
                            <span className="settings-native-toggle__title settings-native-toggle__title--sub">
                              Часы
                            </span>
                            <output className="settings-length-limit__value" aria-live="polite">
                              {draft.nightModeForceCloseHours}ч
                            </output>
                          </div>
                          <input
                            className="settings-length-limit__slider"
                            type="range"
                            min={NIGHT_FORCE_CLOSE_MIN_HOURS}
                            max={NIGHT_FORCE_CLOSE_MAX_HOURS}
                            step={1}
                            value={draft.nightModeForceCloseHours}
                            onChange={(event) => {
                              setFieldValue(
                                'nightModeForceCloseHours',
                                Number(
                                  event.target.value,
                                ) as ChatSettings['nightModeForceCloseHours'],
                              );
                              setFieldValue('nightModeForceCloseUntil', '');
                              clearFieldError('nightModeForceCloseDays');
                            }}
                            aria-label="Сколько часов держать чат закрытым"
                          />
                          <div className="settings-length-limit__labels" aria-hidden>
                            <span>{NIGHT_FORCE_CLOSE_MIN_HOURS}ч</span>
                            <span>{NIGHT_FORCE_CLOSE_MAX_HOURS}ч</span>
                          </div>
                        </div>

                        <div className="settings-duration-stack__item">
                          <div className="settings-native-toggle__row">
                            <span className="settings-native-toggle__title settings-native-toggle__title--sub">
                              Дни
                            </span>
                            <output className="settings-length-limit__value" aria-live="polite">
                              {draft.nightModeForceCloseDays}д
                            </output>
                          </div>
                          <input
                            className="settings-length-limit__slider"
                            type="range"
                            min={NIGHT_FORCE_CLOSE_MIN_DAYS}
                            max={NIGHT_FORCE_CLOSE_MAX_DAYS}
                            step={1}
                            value={draft.nightModeForceCloseDays}
                            onChange={(event) => {
                              setFieldValue(
                                'nightModeForceCloseDays',
                                Number(
                                  event.target.value,
                                ) as ChatSettings['nightModeForceCloseDays'],
                              );
                              setFieldValue('nightModeForceCloseUntil', '');
                              clearFieldError('nightModeForceCloseHours');
                            }}
                            aria-label="Сколько дней держать чат закрытым"
                          />
                          <div className="settings-length-limit__labels" aria-hidden>
                            <span>{NIGHT_FORCE_CLOSE_MIN_DAYS}д</span>
                            <span>{NIGHT_FORCE_CLOSE_MAX_DAYS}д</span>
                          </div>
                        </div>
                      </div>

                      {nightForceCloseHoursError || nightForceCloseDaysError ? (
                        <small className="field__hint">
                          {nightForceCloseHoursError ?? nightForceCloseDaysError}
                        </small>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        )}
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
