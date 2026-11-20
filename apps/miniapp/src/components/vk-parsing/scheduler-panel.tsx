import { AppIcon as IconoirSprite } from '../ui/app-icon';

import { useState, type ReactNode } from 'react';
import { resolveVkParsingSourceSpacingMinutes } from '@maxim/contracts/vk-parsing';
import type {
  UpdateVkParsingSettingsRequest,
  VkParsingSettings,
  VkParsingPost,
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
  getVkAutoEnableSources,
  isVkAutomaticSource,
  parseVkParsingIntegerDraft,
  resolveVkParsingCommonNumericInput,
  resolveVkParsingAutopostMode,
  type VkParsingAutopostMode,
} from './model';
import type { VkBulkSourceResult, VkBulkSourceUpdate } from './use-vk-parsing-card';
import { getQueuePostTitle } from './queue-title';
import { vkPostBlockedReason } from './workflow';

type SchedulerPanelProps = {
  children?: ReactNode;
  settings: VkParsingSettings;
  sources: VkParsingSource[];
  status: AutopostStatusModel;
  queueCount: number;
  queue: VkParsingPost[];
  now: Date;
  windowStorageKey: string;
  onOpenQueue: () => void;
  onOpenSource: (sourceId: string) => void;
  isSaving: boolean;
  isSavingSource: boolean;
  settingsSaved: boolean;
  onUpdateSetting: (payload: UpdateVkParsingSettingsRequest) => Promise<boolean>;
  onUpdateSources: (
    sourceIds: string[],
    payload: VkBulkSourceUpdate,
  ) => Promise<VkBulkSourceResult | null>;
};

const AUTOPOST_MODES: ReadonlyArray<{ value: VkParsingAutopostMode; label: string }> = [
  { value: 'manual', label: 'Вручную' },
  { value: 'auto', label: 'Авто' },
  { value: 'pause', label: 'Пауза' },
];

const FREQUENCY_OPTIONS = [
  { value: 'SLOW', label: '3 часа', minutes: 180 },
  { value: 'NORMAL', label: '1 час', minutes: 60 },
  { value: 'FAST', label: '20 мин', minutes: 20 },
  { value: 'CUSTOM', label: 'Другой', minutes: null },
] as const;

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

function resolveDisplayZone(timezone: string) {
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: timezone });
    return timezone;
  } catch {
    return 'Europe/Moscow';
  }
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
  queue,
  now,
  windowStorageKey,
  onOpenQueue,
  onOpenSource,
  children,
  isSaving,
  isSavingSource,
  settingsSaved,
  onUpdateSetting,
  onUpdateSources,
}: SchedulerPanelProps) {
  const [section, setSection] = useState<'publication' | 'time' | 'safety'>('publication');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<VkParsingAutopostMode | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState('');
  const [bulkFailure, setBulkFailure] = useState<{
    payload: VkBulkSourceUpdate;
    result: VkBulkSourceResult;
  } | null>(null);
  const automaticSources = sources.filter(isVkAutomaticSource);
  const blockedSources = sources.filter(
    (source) => source.autoPublishPausedReason === 'circuit_breaker',
  );
  const enablingSources = getVkAutoEnableSources(settings, sources);
  const cancellationCount = sources.every((source) => source.cancellableAutoPostCount !== undefined)
    ? sources.reduce((sum, source) => sum + (source.cancellableAutoPostCount ?? 0), 0)
    : null;
  const sourceIds = automaticSources.map((source) => source.id);
  const intervalInput = resolveVkParsingCommonNumericInput(
    automaticSources.map((source) => source.publishIntervalMinutes),
  );
  const commonInterval = intervalInput.value === '' ? null : intervalInput.value;
  const dailyLimitInput = resolveVkParsingCommonNumericInput(
    automaticSources.map((source) => source.dailyLimit),
  );
  const effectiveIntervals = automaticSources.map((source) =>
    resolveVkParsingSourceSpacingMinutes(settings.distributeEvenlyEnabled, source),
  );
  const minEffectiveInterval = effectiveIntervals.length ? Math.min(...effectiveIntervals) : null;
  const maxEffectiveInterval = effectiveIntervals.length ? Math.max(...effectiveIntervals) : null;
  const frequencyPreset = commonInterval === null ? null : resolveFrequencyPreset(commonInterval);
  const sourceControlsDisabled = sourceIds.length === 0 || isSavingSource || isSaving;
  const autopostMode: VkParsingAutopostMode = resolveVkParsingAutopostMode(settings, sources);
  const timezone = settings.schedulerTimezone;
  const scheduled = queue
    .filter((post) => {
      const source = sources.find((item) => item.id === post.sourceId);
      if (
        !source?.importEnabled ||
        !post.publishScheduledAt ||
        Date.parse(post.publishScheduledAt) <= now.getTime()
      )
        return false;
      if (post.queueKind !== 'manual' && (autopostMode !== 'auto' || !isVkAutomaticSource(source)))
        return false;
      return !vkPostBlockedReason({ ...post, publishQueuedAt: null });
    })
    .sort((left, right) => left.publishScheduledAt!.localeCompare(right.publishScheduledAt!));
  const nextAt = scheduled[0]?.publishScheduledAt;
  const displayZone = resolveDisplayZone(timezone);
  const dayFormat = new Intl.DateTimeFormat('ru-RU', {
    timeZone: displayZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const dateFormat = new Intl.DateTimeFormat('ru-RU', {
    timeZone: displayZone,
    month: 'short',
    day: 'numeric',
  });
  const timeFormat = new Intl.DateTimeFormat('ru-RU', {
    timeZone: displayZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const today = dayFormat.format(now);
  const formatSlot = (value: string) => {
    const slot = new Date(value);
    const time = timeFormat.format(slot);
    return dayFormat.format(slot) === today ? time : `${dateFormat.format(slot)}, ${time}`;
  };
  const customMinutes = parseVkParsingIntegerDraft(customDraft, 5, 10080);

  async function applySourceSettings(ids: string[], payload: VkBulkSourceUpdate) {
    const result = await onUpdateSources(ids, payload);
    if (!result) return false;
    setBulkFailure(result.failed ? { payload, result } : null);
    return result.failed === undefined;
  }

  return (
    <section
      className={`vk-scheduler-panel vk-autopost-panel vk-autopost-panel--${status.tone}`}
      aria-label="Публикация VK"
    >
      <header className="vk-autopost-panel__heading">
        <h2>Автопостинг</h2>
        <VkInfoButton title="Об автоматической публикации">
          <p>
            Первое включение отправляет только новые посты. Согласование в личке работает
            круглосуточно.
          </p>
          <p>
            Пауза сохраняет очередь. В ручном режиме не начатые автоматические отправки снимаются с
            очереди.
          </p>
        </VkInfoButton>
        <span aria-live="polite">
          {isSaving || isSavingSource ? 'Сохраняю…' : settingsSaved ? 'Сохранено' : ''}
        </span>
      </header>
      <div className="vk-autopost-panel__main">
        <AsyncRadioGroup
          className="vk-autopost-mode"
          ariaLabel="Режим автопостинга"
          value={autopostMode}
          options={AUTOPOST_MODES}
          disabled={isSaving || isSavingSource}
          onChange={(mode) => {
            if (mode === 'auto' || mode === 'manual') {
              setPendingMode(mode);
              return Promise.resolve(false);
            }
            return onUpdateSetting(buildVkParsingAutopostModeUpdate(mode));
          }}
        />
        <div className="vk-autopost-status" role="status">
          <span className="vk-autopost-status__icon">{renderAutopostStatusIcon(status.tone)}</span>
          <span className="vk-autopost-status__copy">
            <strong>
              {nextAt && autopostMode === 'auto'
                ? 'Запланировано на'
                : status.tone === 'success' && !queueCount
                  ? 'Ожидаем новые посты'
                  : status.title}
            </strong>
            {nextAt && autopostMode === 'auto' ? (
              <span className="vk-autopost-next">{formatSlot(nextAt)}</span>
            ) : status.reason ? (
              <small>{status.reason}</small>
            ) : null}
          </span>
        </div>
        <div className="vk-autopost-queue">
          <button type="button" className="vk-text-link" onClick={onOpenQueue}>
            Очередь <strong>{queueCount}</strong>
            <IconoirSprite variant="iconoir" icon="NavArrowRight" aria-hidden />
          </button>
          {nextAt && autopostMode === 'auto' ? (
            <ul>
              {scheduled.slice(0, 3).map((post) => (
                <li key={post.id}>
                  <time dateTime={post.publishScheduledAt!}>
                    {formatSlot(post.publishScheduledAt!)}
                  </time>
                  <span>
                    <strong>{getQueuePostTitle(post)}</strong>
                    <small>{post.sourceTitle}</small>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      {blockedSources.length > 0 ? (
        <details className="vk-autopost-protected">
          <summary>Защита остановила группы · {blockedSources.length}</summary>
          <ul>
            {blockedSources.map((source) => (
              <li key={source.id}>
                <button
                  type="button"
                  className="vk-text-link"
                  onClick={() => onOpenSource(source.id)}
                >
                  {source.title}
                  <IconoirSprite variant="iconoir" icon="NavArrowRight" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="vk-autopost-panel__schedule" hidden={advancedOpen && section === 'time'}>
        <IconoirSprite variant="iconoir" icon="Clock" aria-hidden />
        <span>
          {settings.workHoursStart === settings.workHoursEnd
            ? settings.quietHoursStart && settings.quietHoursEnd
              ? null
              : 'Круглосуточно'
            : `${settings.workHoursStart}–${settings.workHoursEnd}`}
        </span>
        {settings.quietHoursStart && settings.quietHoursEnd ? (
          <span>
            {settings.quietHoursStart === settings.quietHoursEnd
              ? 'Перерыв на весь день'
              : `Перерыв ${settings.quietHoursStart}–${settings.quietHoursEnd}`}
          </span>
        ) : null}
        <span>{formatTimezoneLabel(timezone)}</span>
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
                  {FREQUENCY_OPTIONS.map((option) => {
                    const selected =
                      option.value === 'CUSTOM'
                        ? customOpen || frequencyPreset === 'CUSTOM'
                        : !customOpen && frequencyPreset === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={cn(selected && 'is-active')}
                        aria-pressed={selected}
                        disabled={
                          sourceControlsDisabled ||
                          (option.minutes !== null && !settings.distributeEvenlyEnabled)
                        }
                        onClick={() => {
                          if (option.minutes === null) {
                            setCustomDraft(commonInterval === null ? '' : String(commonInterval));
                            setCustomOpen(true);
                            return;
                          }
                          setCustomOpen(false);
                          void applySourceSettings(sourceIds, {
                            publishIntervalMinutes: option.minutes,
                          });
                        }}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
                {customOpen ? (
                  <form
                    className="vk-custom-interval"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (
                        customMinutes === null ||
                        sourceControlsDisabled ||
                        !settings.distributeEvenlyEnabled
                      )
                        return;
                      void applySourceSettings(sourceIds, {
                        publishIntervalMinutes: customMinutes,
                      }).then((saved) => {
                        if (saved) setCustomOpen(false);
                      });
                    }}
                  >
                    <label className="vk-quick-custom-field">
                      <span>Интервал, мин</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={5}
                        max={10080}
                        step={1}
                        aria-label="Интервал публикаций в минутах"
                        value={customDraft}
                        disabled={sourceControlsDisabled || !settings.distributeEvenlyEnabled}
                        onChange={(event) => setCustomDraft(event.target.value)}
                      />
                    </label>
                    <button
                      type="submit"
                      className="button button--accent"
                      disabled={
                        customMinutes === null ||
                        sourceControlsDisabled ||
                        !settings.distributeEvenlyEnabled
                      }
                    >
                      Сохранить
                    </button>
                    <button
                      type="button"
                      className="vk-text-link"
                      disabled={isSavingSource}
                      onClick={() => setCustomOpen(false)}
                    >
                      Отмена
                    </button>
                  </form>
                ) : null}
                {minEffectiveInterval !== null ? (
                  <span className="vk-effective-interval">
                    Минимальный перерыв ·{' '}
                    {minEffectiveInterval === maxEffectiveInterval
                      ? minEffectiveInterval
                      : `${minEffectiveInterval}–${maxEffectiveInterval}`}{' '}
                    мин
                  </span>
                ) : null}
                {!settings.distributeEvenlyEnabled && sourceIds.length ? (
                  <span className="vk-effective-interval">Равномерная отправка выключена</span>
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
                onCommit={(dailyLimit) => applySourceSettings(sourceIds, { dailyLimit })}
              />
              {bulkFailure?.result.failed ? (
                <div className="vk-bulk-failure" role="alert">
                  <strong>
                    Сохранено · {bulkFailure.result.saved.length} из{' '}
                    {bulkFailure.result.saved.length + bulkFailure.result.remaining.length}
                  </strong>
                  <span>
                    {sources.find((source) => source.id === bulkFailure.result.failed?.id)?.title ??
                      'Группа'}{' '}
                    · {bulkFailure.result.failed.error}
                  </span>
                  <button
                    type="button"
                    className="vk-text-link"
                    disabled={isSavingSource}
                    onClick={() => {
                      const remaining = bulkFailure.result.remaining.filter((id) =>
                        sourceIds.includes(id),
                      );
                      if (remaining.length)
                        void applySourceSettings(remaining, bulkFailure.payload);
                      else setBulkFailure(null);
                    }}
                  >
                    Повторить для оставшихся
                  </button>
                </div>
              ) : null}
            </div>
          </section>

          <section
            id="vk-parsing-work-time"
            className="vk-advanced-group"
            hidden={section !== 'time'}
          >
            <ScheduleTimePanel
              settings={settings}
              storageKey={windowStorageKey}
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
      {children}
      <ActionConfirmSheet
        id="vk-auto-confirm"
        open={pendingMode !== null}
        title={pendingMode === 'auto' ? 'Включить автопубликацию?' : 'Перейти в ручной режим?'}
        summary={
          pendingMode === 'auto'
            ? 'Новые посты будут публиковаться по сохранённым настройкам. История не отправляется автоматически. Группы с согласованием остаются на согласовании.'
            : 'Ещё не начатые автоматические отправки будут отменены. Уже опубликованные посты останутся в MAX.'
        }
        previewTitle={
          pendingMode === 'auto'
            ? `Групп с автоматической отправкой · ${enablingSources.length}`
            : cancellationCount === null
              ? undefined
              : `Снимем из очереди · ${cancellationCount}`
        }
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
