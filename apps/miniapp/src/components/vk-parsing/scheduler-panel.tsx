import { AppIcon as IconoirSprite } from '../ui/app-icon';

import { useState } from 'react';
import type {
  UpdateVkParsingSettingsRequest,
  UpdateVkParsingSourceRequest,
  VkParsingSettings,
  VkParsingSource,
} from '@maxim/contracts';
import { cn } from '../../lib/cn';
import { AsyncRadioGroup } from '../ui/async-radio-group';
import { ScheduleTimePanel } from './schedule-time-panel';
import { VkInfoButton } from './info-button';
import { VkSettingSwitch } from './setting-switch';
import { ActionConfirmSheet } from '../ui/action-confirm-sheet';
import { formatTimezoneLabel } from '../../lib/timezone-label';
import type { AutopostStatusModel, AutopostStatusTone } from './autopost-status';
import { CommittedNumberField } from './committed-number-field';
import {
  buildVkParsingAutopostModeUpdate,
  buildVkParsingSourceIntervalUpdate,
  resolveVkParsingCommonNumericInput,
  resolveVkParsingAutopostMode,
  type VkParsingAutopostMode,
} from './model';

type SchedulerPanelProps = {
  botReviewEnabled?: boolean;
  settings: VkParsingSettings;
  sources: VkParsingSource[];
  status: AutopostStatusModel;
  queueCount: number;
  publishedCount: number;
  isSaving: boolean;
  isSavingSource: boolean;
  settingsSaved: boolean;
  onUpdateSetting: (payload: UpdateVkParsingSettingsRequest) => Promise<boolean>;
  onUpdateSources: (sourceIds: string[], payload: UpdateVkParsingSourceRequest) => Promise<boolean>;
};

const AUTOPOST_MODES: ReadonlyArray<{ value: VkParsingAutopostMode; label: string }> = [
  { value: 'manual', label: 'Ручной' },
  { value: 'auto', label: 'Авто' },
  { value: 'pause', label: 'Пауза' },
];

const FREQUENCY_OPTIONS = [
  { value: 'SLOW', label: '3 часа', minutes: 180 },
  { value: 'NORMAL', label: '1 час', minutes: 60 },
  { value: 'FAST', label: '20 мин', minutes: 20 },
  { value: 'CUSTOM', label: 'Свой', minutes: null },
] as const;

const CUSTOM_FREQUENCY_MINUTES = 90;

type FrequencyOption = (typeof FREQUENCY_OPTIONS)[number]['value'];

function SwitchRow({
  label,
  checked,
  disabled,
  danger = false,
  id,
  title,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  danger?: boolean;
  id?: string;
  title?: string;
  onChange: (checked: boolean) => Promise<boolean>;
}) {
  return (
    <VkSettingSwitch
      className={cn('vk-setup-switch', danger && 'vk-setup-switch--danger')}
      label={label}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      id={id}
      title={title}
    />
  );
}

function resolveFrequencyPreset(minutes: number | null): FrequencyOption {
  if (minutes === null) {
    return 'CUSTOM';
  }
  return FREQUENCY_OPTIONS.find((item) => item.minutes === minutes)?.value ?? 'CUSTOM';
}

function renderAutopostStatusIcon(tone: AutopostStatusTone) {
  if (tone === 'success') {
    return <IconoirSprite variant="iconoir" icon="CheckCircle" aria-hidden />;
  }
  if (tone === 'danger') {
    return <IconoirSprite variant="iconoir" icon="Pause" aria-hidden />;
  }
  if (tone === 'warning') {
    return <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />;
  }
  return <IconoirSprite variant="iconoir" icon="Clock" aria-hidden />;
}

export function SchedulerPanel({
  settings,
  sources,
  status,
  queueCount,
  publishedCount,
  isSaving,
  isSavingSource,
  settingsSaved,
  onUpdateSetting,
  onUpdateSources,
}: SchedulerPanelProps) {
  const [section, setSection] = useState<'publication' | 'time' | 'safety'>('publication');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<VkParsingAutopostMode | null>(null);
  const automaticSources = sources.filter(
    (source) => source.publishMode !== 'BOT_REVIEW' && source.publishMode !== 'REVIEW',
  );
  const sourceIds = automaticSources.map((source) => source.id);
  const intervalInput = resolveVkParsingCommonNumericInput(
    automaticSources.map((source) => source.publishIntervalMinutes),
  );
  const commonInterval = intervalInput.value === '' ? null : intervalInput.value;
  const dailyLimitInput = resolveVkParsingCommonNumericInput(
    automaticSources.map((source) => source.dailyLimit),
  );
  const frequencyPreset = commonInterval === null ? null : resolveFrequencyPreset(commonInterval);
  const sourceControlsDisabled = sourceIds.length === 0 || isSavingSource || isSaving;
  const autopostMode: VkParsingAutopostMode = resolveVkParsingAutopostMode(settings, sources);

  return (
    <section
      className={`vk-scheduler-panel vk-autopost-panel vk-autopost-panel--${status.tone}`}
      aria-label="Публикация VK"
    >
      <header className="vk-autopost-panel__heading">
        <h2>Автопубликация</h2>
        <VkInfoButton title="Об автоматической публикации">
          <p>
            Авто публикует новые записи из групп с автоматической доставкой. Первое включение не
            отправляет архив.
          </p>
          <p>
            Пауза сохраняет очередь. Ручной режим отменяет ещё не начатые автоматические отправки.
            Согласование в личке работает отдельно и круглосуточно.
          </p>
        </VkInfoButton>
        <span aria-live="polite">
          {isSaving || isSavingSource ? 'Сохраняю...' : settingsSaved ? 'Сохранено' : ''}
        </span>
      </header>
      <div className="vk-autopost-panel__main" aria-label="Автопостинг">
        <div className="vk-autopost-status" role="status" aria-label="Статус автопостинга">
          <span className="vk-autopost-status__icon">{renderAutopostStatusIcon(status.tone)}</span>
          <span className="vk-autopost-status__copy">
            <strong>{status.title}</strong>
            <small>{status.reason}</small>
          </span>
        </div>

        <div className="vk-autopost-metrics" aria-label="Сводка автопостинга">
          <span>
            <b>{queueCount}</b>
            <small>В очереди</small>
          </span>
          <span>
            <b>{publishedCount}</b>
            <small>Вышло</small>
          </span>
        </div>

        <AsyncRadioGroup
          className="vk-autopost-mode"
          ariaLabel="Режим автопостинга"
          value={autopostMode}
          options={AUTOPOST_MODES}
          disabled={isSaving || isSavingSource}
          onChange={(mode) => {
            if (mode === 'auto' || (mode === 'manual' && queueCount > 0)) {
              setPendingMode(mode);
              return Promise.resolve(false);
            }
            return onUpdateSetting(buildVkParsingAutopostModeUpdate(mode));
          }}
        />
      </div>

      <div className="vk-autopost-panel__schedule" hidden={advancedOpen && section === 'time'}>
        <IconoirSprite variant="iconoir" icon="Clock" aria-hidden />
        <span>
          {settings.workHoursStart === settings.workHoursEnd
            ? 'Круглосуточно'
            : `${settings.workHoursStart} - ${settings.workHoursEnd}`}
        </span>
        <span>{formatTimezoneLabel(settings.schedulerTimezone)}</span>
      </div>

      <details
        className="vk-autopost-advanced"
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary>Параметры публикации</summary>
        <div className="vk-autopost-advanced__body">
          <div
            className="vk-scheduler-sections vk-segmented-buttons"
            role="group"
            aria-label="Раздел настроек автопостинга"
          >
            {(
              [
                { value: 'publication', label: 'Частота' },
                { value: 'time', label: 'Время' },
                { value: 'safety', label: 'Фильтры' },
              ] as const
            ).map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={section === item.value}
                className={cn(section === item.value && 'is-active')}
                onClick={() => setSection(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <section className="vk-advanced-group" hidden={section !== 'publication'}>
            <div className="vk-section-heading">
              <h3>Частота для групп с авто</h3>
              <VkInfoButton title="О частоте автопубликации">
                <p>
                  Параметры применяются к группам с автоматическим способом доставки. Согласование в
                  личке не ограничивается этим расписанием.
                </p>
                <p>У каждой группы можно сохранить свою частоту в её настройках.</p>
              </VkInfoButton>
            </div>
            <div className="vk-tempo-controls">
              <div className="vk-tempo-controls__frequency">
                <div className="vk-segmented-buttons" role="group" aria-label="Темп публикации">
                  {FREQUENCY_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={cn(frequencyPreset === option.value && 'is-active')}
                      aria-pressed={frequencyPreset === option.value}
                      disabled={sourceControlsDisabled}
                      onClick={() => {
                        void onUpdateSources(
                          sourceIds,
                          buildVkParsingSourceIntervalUpdate(
                            option.minutes ?? CUSTOM_FREQUENCY_MINUTES,
                          ),
                        );
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {frequencyPreset === 'CUSTOM' || intervalInput.mixed ? (
                  <CommittedNumberField
                    className="vk-quick-custom-field"
                    label="Интервал, мин"
                    ariaLabel="Интервал публикаций в минутах"
                    value={intervalInput.value}
                    mixed={intervalInput.mixed}
                    min={5}
                    max={10080}
                    available={sourceIds.length > 0}
                    disabled={isSavingSource}
                    onCommit={(publishIntervalMinutes) =>
                      onUpdateSources(sourceIds, { publishIntervalMinutes })
                    }
                  />
                ) : null}
              </div>
              <CommittedNumberField
                className="vk-quick-custom-field vk-tempo-controls__daily-limit"
                label="Постов в день"
                ariaLabel="Лимит публикаций в день"
                value={dailyLimitInput.value}
                mixed={dailyLimitInput.mixed}
                min={1}
                max={500}
                available={sourceIds.length > 0}
                disabled={isSavingSource}
                onCommit={(dailyLimit) => onUpdateSources(sourceIds, { dailyLimit })}
              />
            </div>
          </section>

          <section
            id="vk-parsing-work-time"
            className="vk-advanced-group"
            hidden={section !== 'time'}
          >
            <ScheduleTimePanel
              settings={settings}
              disabled={isSaving || isSavingSource}
              onUpdate={onUpdateSetting}
            />
          </section>

          <section className="vk-advanced-group" hidden={section !== 'safety'}>
            <h3>Содержимое постов</h3>
            <div className="vk-scheduler-toggles">
              <SwitchRow
                label="Удалять ссылки"
                checked={settings.stripLinksEnabled}
                disabled={isSaving}
                title="Удалять ссылки перед публикацией"
                onChange={(checked) => onUpdateSetting({ stripLinksEnabled: checked })}
              />
              <SwitchRow
                label="Пропускать рекламу"
                checked={settings.skipAdsEnabled}
                disabled={isSaving}
                title="Пропускать рекламные посты"
                onChange={(checked) => onUpdateSetting({ skipAdsEnabled: checked })}
              />
              <SwitchRow
                label="Равномерно по времени"
                checked={settings.distributeEvenlyEnabled}
                disabled={isSaving}
                title="Распределять публикации по рабочему времени"
                onChange={(checked) => onUpdateSetting({ distributeEvenlyEnabled: checked })}
              />
              <SwitchRow
                label="Чередовать группы"
                checked={settings.roundRobinEnabled}
                disabled={isSaving}
                title="Чередовать группы"
                onChange={(checked) => onUpdateSetting({ roundRobinEnabled: checked })}
              />
            </div>
          </section>

          <section className="vk-advanced-group" hidden={section !== 'safety'}>
            <div className="vk-section-heading">
              <h3>Защита от массовой отправки</h3>
              <VkInfoButton title="О защите публикаций">
                <p>
                  Если за короткое время появляется слишком много публикаций, автоматическая
                  отправка группы приостанавливается. Уже отправленные посты не удаляются.
                </p>
              </VkInfoButton>
            </div>
            <div className="vk-scheduler-protection">
              <SwitchRow
                label="Защита включена"
                checked={settings.circuitBreakerEnabled}
                disabled={isSaving}
                title="Останавливать автопостинг при подозрительном всплеске"
                onChange={(checked) => onUpdateSetting({ circuitBreakerEnabled: checked })}
              />
              <CommittedNumberField
                label="За сколько минут"
                ariaLabel="Окно защиты в минутах"
                min={1}
                max={1440}
                value={settings.circuitBreakerWindowMinutes}
                disabled={isSaving || isSavingSource || !settings.circuitBreakerEnabled}
                onCommit={(circuitBreakerWindowMinutes) =>
                  onUpdateSetting({ circuitBreakerWindowMinutes })
                }
              />
              <CommittedNumberField
                label="Больше постов"
                ariaLabel="Порог постов для защиты"
                min={1}
                max={500}
                value={settings.circuitBreakerPostLimit}
                disabled={isSaving || isSavingSource || !settings.circuitBreakerEnabled}
                onCommit={(circuitBreakerPostLimit) => onUpdateSetting({ circuitBreakerPostLimit })}
              />
            </div>
          </section>
        </div>
      </details>
      <ActionConfirmSheet
        id="vk-auto-confirm"
        open={pendingMode !== null}
        title={pendingMode === 'auto' ? 'Включить автопубликацию?' : 'Перейти в ручной режим?'}
        summary={
          pendingMode === 'auto'
            ? 'Новые посты будут публиковаться по сохранённым настройкам. История не отправляется автоматически. Группы с согласованием остаются на согласовании.'
            : 'Ещё не начатые автоматические отправки будут отменены. Уже опубликованные посты останутся в MAX.'
        }
        previewTitle={`Группы с автоматической доставкой: ${automaticSources.length}`}
        confirmLabel={pendingMode === 'auto' ? 'Включить' : 'Перейти'}
        tone={pendingMode === 'auto' ? 'accent' : 'danger'}
        isBusy={isSaving}
        onClose={() => setPendingMode(null)}
        onConfirm={() => {
          if (pendingMode)
            void onUpdateSetting(buildVkParsingAutopostModeUpdate(pendingMode)).then((saved) => {
              if (saved) setPendingMode(null);
            });
        }}
      />
    </section>
  );
}
