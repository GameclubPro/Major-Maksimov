import { AppIcon as IconoirSprite } from '../ui/app-icon';

import { useState, type FormEvent } from 'react';
import { resolveVkParsingSourceSpacingMinutes } from '@maxim/contracts/vk-parsing';
import type {
  BulkUpdateVkParsingSourcesRequest,
  UpdateVkParsingSourceRequest,
  VkParsingSettings,
  VkParsingSource,
} from '@maxim/contracts';
import { ActionConfirmSheet } from '../ui/action-confirm-sheet';
import { SettingsDrilldownPanel } from '../ui/settings-drilldown-panel';
import { CommittedNumberField } from './committed-number-field';
import { formatVkPostDate, formatVkSourceProblem } from './format';
import { VkInfoButton } from './info-button';
import { VkSettingSwitch } from './setting-switch';
import { VkTimeRange } from './schedule-time-panel';
import {
  buildSourceDeliveryUpdate,
  describeVkSource,
  resolveSourceDeliveryMode,
  type VkSourceDeliveryMode,
} from './workflow';

type SourceDashboardProps = {
  botReviewSupported?: boolean;
  botReviewEnabled?: boolean;
  settings: VkParsingSettings;
  sourceUrl: string;
  sources: VkParsingSource[];
  selectedBulkSourceIds: string[];
  isAdding: boolean;
  isRefreshing: boolean;
  isRemoving: boolean;
  isSavingSource: boolean;
  isApplyingPreset: boolean;
  refreshingSourceId: string | null;
  onSourceUrlChange: (value: string) => void;
  onSubmitSource: (event: FormEvent<HTMLFormElement>) => void;
  onToggleBulkSource: (sourceId: string) => void;
  onSelectAllBulkSources: () => void;
  onApplyPreset: (preset: BulkUpdateVkParsingSourcesRequest['preset']) => void;
  onUpdateSource: (sourceId: string, payload: UpdateVkParsingSourceRequest) => Promise<boolean>;
  onRefresh: () => void;
  onRefreshSource: (sourceId: string) => void;
  onRemoveSource: (sourceId: string) => void;
  configuredId: string | null;
  onConfigureSource: (sourceId: string | null) => void;
  onOpenAutomation: () => void;
};

export function SourceDashboard(props: SourceDashboardProps) {
  const {
    sources,
    settings,
    sourceUrl,
    selectedBulkSourceIds,
    isAdding,
    isRefreshing,
    isRemoving,
    isSavingSource,
    isApplyingPreset,
    refreshingSourceId,
    botReviewEnabled = false,
    botReviewSupported = false,
    onSourceUrlChange,
    onSubmitSource,
    onRefresh,
    onRefreshSource,
    onRemoveSource,
    onUpdateSource,
    onToggleBulkSource,
    onSelectAllBulkSources,
    onApplyPreset,
    onOpenAutomation,
    configuredId,
    onConfigureSource: setConfiguredId,
  } = props;
  const [removing, setRemoving] = useState<VkParsingSource | null>(null);
  const configured = sources.find((source) => source.id === configuredId) ?? null;
  const mode = configured ? resolveSourceDeliveryMode(configured) : 'MANUAL';
  const automatic = mode === 'QUEUE' || mode === 'IMMEDIATE';
  const autoRunning = settings.autoPublishEnabled && !settings.autoPublishKillSwitchEnabled;

  return (
    <section id="vk-parsing-source-section" className="vk-source-dashboard" aria-label="Группы VK">
      <div className="vk-section-heading">
        <h3>
          Группы VK <span>{sources.length}</span>
        </h3>
        <VkInfoButton title="О подключении групп">
          <p>
            Доступны открытые сообщества VK. Первое обновление загружает записи в приложение без
            автоматической публикации истории.
          </p>
          <p>
            Способ доставки задаётся для каждой группы отдельно. Пауза сбора не удаляет уже
            загруженные посты.
          </p>
        </VkInfoButton>
        <button
          type="button"
          className="vk-parsing-icon-button"
          title="Обновить группы"
          aria-label="Обновить группы"
          disabled={isRefreshing || !sources.length}
          onClick={onRefresh}
        >
          <IconoirSprite variant="iconoir" icon="RefreshCircle" aria-hidden />
        </button>
      </div>
      <form className="vk-parsing-card__source-form" onSubmit={onSubmitSource}>
        <label className="vk-parsing-source-input">
          <span className="vk-parsing-sr-only">Ссылка на группу VK</span>
          <input
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={sourceUrl}
            onChange={(event) => onSourceUrlChange(event.target.value)}
            placeholder="Ссылка на группу VK"
            disabled={isAdding}
          />
        </label>
        <button
          type="submit"
          className="vk-parsing-icon-button vk-parsing-icon-button--accent"
          aria-label="Добавить группу"
          title="Добавить группу"
          disabled={isAdding || !sourceUrl.trim()}
        >
          <IconoirSprite variant="iconoir" icon="Plus" aria-hidden />
        </button>
      </form>
      {selectedBulkSourceIds.length > 0 ? (
        <div className="vk-source-bulk">
          <label>
            <input
              type="checkbox"
              checked={
                selectedBulkSourceIds.length ===
                sources.filter((source) => source.publishMode !== 'BOT_REVIEW').length
              }
              onChange={onSelectAllBulkSources}
            />
            Выбрано: {selectedBulkSourceIds.length}
          </label>
          <select
            aria-label="Применить настройки к выбранным группам"
            value=""
            disabled={isApplyingPreset}
            onChange={(event) =>
              onApplyPreset(event.target.value as BulkUpdateVkParsingSourcesRequest['preset'])
            }
          >
            <option value="" disabled>
              Настроить выбранные
            </option>
            <option value="SLOW">Спокойный темп</option>
            <option value="NEWS">Чаще</option>
            <option value="CLEAN">Без рекламы и ссылок</option>
          </select>
        </div>
      ) : null}
      <div className="vk-source-grid">
        {sources.map((source) => {
          const status = describeVkSource(source, settings);
          const problem = source.importEnabled ? formatVkSourceProblem(source) : null;
          return (
            <article key={source.id} className={`vk-source-card vk-source-card--${status.tone}`}>
              <header className="vk-source-card__head">
                {source.publishMode === 'BOT_REVIEW' ? (
                  <span
                    className="vk-source-check"
                    title="Настройки согласования задаются отдельно"
                  >
                    <IconoirSprite
                      variant="iconoir"
                      icon="ChatBubble"
                      width={20}
                      height={20}
                      aria-hidden
                    />
                  </span>
                ) : (
                  <label className="vk-source-check">
                    <input
                      type="checkbox"
                      aria-label={`Выбрать ${source.title}`}
                      checked={selectedBulkSourceIds.includes(source.id)}
                      onChange={() => onToggleBulkSource(source.id)}
                    />
                  </label>
                )}
                <button
                  type="button"
                  className="vk-source-card__title"
                  onClick={() => setConfiguredId(source.id)}
                >
                  <strong>{source.title}</strong>
                  <span>{source.screenName}</span>
                </button>
                <button
                  type="button"
                  className="vk-parsing-icon-button"
                  title="Настройки группы"
                  aria-label={`Настройки группы ${source.title}`}
                  onClick={() => setConfiguredId(source.id)}
                >
                  <IconoirSprite variant="iconoir" icon="Settings" aria-hidden />
                </button>
              </header>
              <div className="vk-source-card__summary-row">
                <span className={`vk-workflow-status is-${status.tone}`}>{status.label}</span>
                <span>{source.newPostCount} новых</span>
                {source.queuedPostCount > 0 ? (
                  <span>{source.queuedPostCount} в очереди</span>
                ) : null}
              </div>
              {problem ? (
                <div className="vk-source-card__problem">
                  <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
                  <span>{problem}</span>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      <SettingsDrilldownPanel
        id="vk-source-settings"
        open={Boolean(configured)}
        title={configured?.title ?? 'Группа VK'}
        overlayClassName="vk-dialog-overlay"
        className="vk-parsing-surface vk-workspace-dialog"
        onClose={() => setConfiguredId(null)}
      >
        {configured ? (
          <div className="vk-source-config">
            <div className="vk-source-detail-actions">
              <a href={configured.url} target="_blank" rel="noreferrer" className="vk-text-link">
                {configured.screenName}
                <IconoirSprite variant="iconoir" icon="OpenNewWindow" aria-hidden />
              </a>
              <button
                type="button"
                className="vk-parsing-icon-button"
                title="Обновить группу"
                aria-label="Обновить группу"
                disabled={refreshingSourceId === configured.id || !configured.importEnabled}
                onClick={() => onRefreshSource(configured.id)}
              >
                <IconoirSprite variant="iconoir" icon="RefreshCircle" aria-hidden />
              </button>
            </div>
            <VkSettingSwitch
              label="Собирать новые посты"
              checked={configured.importEnabled}
              disabled={isSavingSource}
              onChange={(importEnabled) => onUpdateSource(configured.id, { importEnabled })}
            />
            <label className="vk-source-delivery">
              <span>Куда отправлять</span>
              <select
                aria-label="Способ доставки постов группы"
                value={mode}
                disabled={isSavingSource}
                onChange={(event) =>
                  void onUpdateSource(
                    configured.id,
                    buildSourceDeliveryUpdate(event.target.value as VkSourceDeliveryMode),
                  )
                }
              >
                <option value="MANUAL">Оставлять в приложении</option>
                <option value="QUEUE">Публиковать по очереди</option>
                <option value="IMMEDIATE">Публиковать сразу</option>
                {botReviewSupported || mode === 'BOT_REVIEW' ? (
                  <option value="BOT_REVIEW" disabled={!botReviewEnabled}>
                    На согласование в личку
                  </option>
                ) : null}
                {mode === 'REVIEW' ? <option value="REVIEW">Ручная проверка</option> : null}
              </select>
            </label>
            {mode === 'BOT_REVIEW' ? (
              <div className="vk-setting-note">
                Согласование в личке <span>Круглосуточно</span>
              </div>
            ) : null}
            {botReviewSupported && !botReviewEnabled ? (
              <button
                type="button"
                className="vk-text-link"
                onClick={() => {
                  setConfiguredId(null);
                  onOpenAutomation();
                }}
              >
                Подключить согласование
              </button>
            ) : null}
            {automatic && !autoRunning ? (
              <div className="vk-inline-warning">
                <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
                <span>Автопубликация выключена</span>
                <button
                  type="button"
                  onClick={() => {
                    setConfiguredId(null);
                    onOpenAutomation();
                  }}
                >
                  Настроить
                </button>
              </div>
            ) : null}
            {automatic ? (
              <>
                <div className="vk-section-heading">
                  <h4>Частота публикаций</h4>
                  <VkInfoButton title="О частоте публикаций">
                    <p>
                      Лимит относится к этой группе. Учитываются общие часы публикаций и записи,
                      которые уже стоят в очереди.
                    </p>
                    <p>Новая частота меняет только ещё не начатые автоматические отправки.</p>
                  </VkInfoButton>
                </div>
                <div className="vk-field-grid">
                  <CommittedNumberField
                    label="Интервал, мин"
                    ariaLabel={`Интервал публикаций для ${configured.title}, минут`}
                    value={configured.publishIntervalMinutes}
                    min={5}
                    max={10080}
                    disabled={isSavingSource || !settings.distributeEvenlyEnabled}
                    onCommit={(publishIntervalMinutes) =>
                      onUpdateSource(configured.id, { publishIntervalMinutes })
                    }
                  />
                  <CommittedNumberField
                    label="Постов в день"
                    ariaLabel={`Лимит публикаций для ${configured.title} в день`}
                    value={configured.dailyLimit}
                    min={1}
                    max={500}
                    disabled={isSavingSource}
                    onCommit={(dailyLimit) => onUpdateSource(configured.id, { dailyLimit })}
                  />
                </div>
                <span className="vk-effective-interval">
                  Минимальный перерыв ·{' '}
                  {resolveVkParsingSourceSpacingMinutes(
                    settings.distributeEvenlyEnabled,
                    configured,
                  )}{' '}
                  мин
                </span>
                <details className="vk-workspace-details">
                  <summary>Дополнительные настройки</summary>
                  <CommittedNumberField
                    label="Минимальная пауза, минут"
                    ariaLabel={`Минимальная пауза для ${configured.title}, минут`}
                    value={configured.minPublishIntervalMinutes}
                    min={0}
                    max={1440}
                    disabled={isSavingSource}
                    onCommit={(minPublishIntervalMinutes) =>
                      onUpdateSource(configured.id, { minPublishIntervalMinutes })
                    }
                  />
                  <VkTimeRange
                    label="Перерыв в публикациях"
                    start={configured.quietHoursStart}
                    end={configured.quietHoursEnd}
                    optional
                    disabled={isSavingSource}
                    onSave={(quietHoursStart, quietHoursEnd) =>
                      onUpdateSource(configured.id, { quietHoursStart, quietHoursEnd })
                    }
                  />
                  <label className="vk-source-delivery">
                    <span>Очередность группы</span>
                    <select
                      value={configured.priority}
                      disabled={isSavingSource}
                      onChange={(event) =>
                        void onUpdateSource(configured.id, {
                          priority: event.target.value as VkParsingSource['priority'],
                        })
                      }
                    >
                      <option value="HIGH">Раньше остальных</option>
                      <option value="NORMAL">Обычная</option>
                      <option value="LOW">После остальных</option>
                    </select>
                  </label>
                </details>
              </>
            ) : null}
            <div className="vk-source-updated" role="status">
              {isSavingSource
                ? 'Сохраняем...'
                : `Последнее обновление: ${formatVkPostDate(configured.lastSuccessAt) || 'ещё не завершено'}`}
            </div>
            <button
              type="button"
              className="vk-disconnect-button"
              disabled={isRemoving}
              onClick={() => setRemoving(configured)}
            >
              <IconoirSprite variant="iconoir" icon="LinkSlash" aria-hidden />
              Отключить группу
            </button>
          </div>
        ) : null}
      </SettingsDrilldownPanel>
      <ActionConfirmSheet
        id="vk-source-remove"
        open={Boolean(removing)}
        title="Отключить группу?"
        previewTitle={removing?.title}
        summary="Новые посты из этой группы больше не будут загружаться. Не начатые отправки будут отменены. Уже опубликованные посты останутся в MAX."
        confirmLabel="Отключить"
        isBusy={isRemoving}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) {
            onRemoveSource(removing.id);
            setRemoving(null);
            setConfiguredId(null);
          }
        }}
      />
    </section>
  );
}
