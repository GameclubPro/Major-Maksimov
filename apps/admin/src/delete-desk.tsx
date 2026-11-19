import { useState } from 'react';
import { safetyDeskApiClient } from './safety-desk-api-client';
import {
  type SafetyDeskDeleteIntentItem,
  type SafetyDeskDeleteIntentStatus,
  type SafetyDeskDeleteRuntimeResponse,
  type SafetyDeskGiveawayWinnerNotificationDeadEndItem,
} from '@maxim/contracts/safety-desk';
import { Refresh, Search } from 'iconoir-react';
import { DeleteEvidence } from './delete-evidence';
import {
  giveawayWinnerNotificationEventAt,
  matchesGiveawayWinnerNotificationQuery,
} from './giveaway-notification-observability';
import {
  ambiguousSendSourceLabel,
  canRetryDeleteIntent,
  deleteCapabilityReasonLabel,
  deleteCapabilityStateLabel,
  deleteRolloutLabel,
  deleteRolloutModeLabel,
  deleteRoutingPolicyLabel,
  deleteStatusTone,
  formatDateTime,
  formatDuration,
  type DeleteFilter,
} from './safety-desk-model';
import { DiagnosticTimeline, InfoCell, Metric } from './safety-desk-ui';

export function DeleteRuntimeMetrics({
  runtime,
}: {
  runtime: SafetyDeskDeleteRuntimeResponse | null;
}) {
  const summary = runtime?.summary;
  const pendingResults = runtime?.giveawayPendingResults;
  const metrics = [
    ['Режим', deleteRolloutModeLabel(runtime?.rolloutMode ?? 'off'), 'neutral'],
    [
      'Cleanup',
      runtime?.replacementCleanupEnabled ? 'Вкл' : 'Выкл',
      runtime?.replacementCleanupEnabled ? 'success' : 'neutral',
    ],
    ['Открыто', summary?.open ?? 0, 'warning'],
    ['Просрочено', summary?.due.count ?? 0, 'danger'],
    ['Зависло', summary?.staleLeases.count ?? 0, 'danger'],
    ['Неясные отправки', summary?.ambiguousSends.count ?? 0, 'danger'],
    ['DM победителям', summary?.giveawayWinnerNotificationDeadEnds.count ?? 0, 'danger'],
    [
      'Итоги в очереди',
      pendingResults ? `${pendingResults.items.length}${pendingResults.hasMore ? '+' : ''}` : '—',
      'warning',
    ],
    ['Ошибки', summary?.failed ?? 0, 'danger'],
    [
      'Старейшее',
      summary?.oldestOpen.ageMs == null ? 'Нет' : formatDuration(summary.oldestOpen.ageMs),
      'neutral',
    ],
  ] as const;
  return metrics.map(([label, value, tone]) => (
    <Metric key={label} label={label} value={String(value)} tone={tone} />
  ));
}

export function DeleteDesk({
  busyAmbiguousSendId,
  busyDeleteIntentId,
  filter,
  query,
  runtime,
  selectedItem,
  visibleItems,
  onFilterChange,
  onAllowAmbiguousSendRetry,
  onQueryChange,
  onRetryDeleteIntent,
  onSelect,
}: {
  busyAmbiguousSendId: string | null;
  busyDeleteIntentId: string | null;
  filter: DeleteFilter;
  query: string;
  runtime: SafetyDeskDeleteRuntimeResponse | null;
  selectedItem: SafetyDeskDeleteIntentItem | undefined;
  visibleItems: SafetyDeskDeleteIntentItem[];
  onFilterChange: (filter: DeleteFilter) => void;
  onAllowAmbiguousSendRetry: (
    item: SafetyDeskDeleteRuntimeResponse['ambiguousSends'][number],
  ) => void;
  onQueryChange: (query: string) => void;
  onRetryDeleteIntent: (item: SafetyDeskDeleteIntentItem) => void;
  onSelect: (itemId: string) => void;
}) {
  const giveawayWinnerNotificationDeadEnds = (
    runtime?.giveawayWinnerNotificationDeadEnds ?? []
  ).filter((item) => matchesGiveawayWinnerNotificationQuery(item, query));

  const normalizedQuery = query.trim().toLowerCase();
  const pendingGiveawayResults = (runtime?.giveawayPendingResults?.items ?? []).filter((item) =>
    [item.giveawayId, item.sourceChatId, item.title].some((value) =>
      value.toLowerCase().includes(normalizedQuery),
    ),
  );
  return (
    <section className="desk-grid delete-grid">
      <section className="queue-panel" aria-label="Диагностика удалений">
        <div className="queue-toolbar delete-toolbar">
          <label className="search-field">
            <Search width={17} height={17} />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Чат, сообщение, ошибка"
            />
          </label>
          <div className="segmented" aria-label="Фильтр удалений">
            {[
              ['attention', 'Открытые'],
              ['waiting', 'Права'],
              ['failed', 'Ошибки'],
              ['observed', 'Shadow'],
              ['all', 'Все'],
            ].map(([value, label]) => (
              <button
                key={value}
                className={filter === value ? 'is-active' : ''}
                type="button"
                aria-pressed={filter === value}
                onClick={() => onFilterChange(value as DeleteFilter)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="queue-list">
          {runtime?.giveawayPendingResults && runtime.giveawayPendingResults.items.length > 0 && (
            <section className="ambiguous-send-strip" aria-label="Публикация итогов розыгрышей">
              <header>
                <strong>Публикация итогов</strong>
                <span>
                  {runtime.giveawayPendingResults.hasMore
                    ? 'Первые 50 по сроку'
                    : runtime.giveawayPendingResults.items.length}
                </span>
              </header>
              {pendingGiveawayResults.map((item) => (
                <article key={item.giveawayId} className="ambiguous-send-row">
                  <span>
                    <strong>{item.title}</strong>
                    <small>
                      Розыгрыш {item.giveawayId} · чат {item.sourceChatId}
                    </small>
                    {item.claimDeadlineAt && (
                      <small>
                        Ближайший срок подтверждения{' '}
                        {formatDateTime(new Date(item.claimDeadlineAt))}
                      </small>
                    )}
                  </span>
                  <span>
                    {item.status === 'PROCESSING'
                      ? 'В обработке'
                      : item.status === 'DUE'
                        ? `Задержка ${formatDuration(item.overdueMs)}`
                        : 'Ожидает попытки'}
                    <small>
                      {formatDateTime(new Date(item.nextAttemptAt))} · попыток {item.attempts}
                    </small>
                  </span>
                </article>
              ))}
              {!pendingGiveawayResults.length && <p>В показанных итогах совпадений нет.</p>}
            </section>
          )}
          {runtime && runtime.summary.giveawayWinnerNotificationDeadEnds.count > 0 && (
            <section
              className="ambiguous-send-strip giveaway-notification-strip"
              aria-label="Сбои уведомлений победителям"
            >
              <header>
                <strong>Уведомления победителям</strong>
                <span>
                  {runtime.giveawayWinnerNotificationDeadEnds.length} из{' '}
                  {runtime.summary.giveawayWinnerNotificationDeadEnds.count}
                </span>
              </header>
              <div>
                {giveawayWinnerNotificationDeadEnds.map((item) => (
                  <GiveawayNotificationRow key={item.notificationId} item={item} />
                ))}
                {giveawayWinnerNotificationDeadEnds.length === 0 && (
                  <div className="delete-empty-line">В показанных уведомлениях совпадений нет.</div>
                )}
                {!giveawayWinnerNotificationDeadEnds.some(
                  (item) => item.notificationId === query.trim(),
                ) &&
                  /^[a-zA-Z0-9_-]{1,128}$/u.test(query.trim()) && (
                    <GiveawayNotificationLookup key={query.trim()} id={query.trim()} />
                  )}
              </div>
            </section>
          )}
          {runtime && runtime.ambiguousSends.length > 0 && (
            <section className="ambiguous-send-strip" aria-label="Неясные отправки MAX">
              <header>
                <strong>Неясные отправки MAX</strong>
                <span>{runtime.ambiguousSends.length}</span>
              </header>
              <div>
                {runtime.ambiguousSends.slice(0, 10).map((item) => (
                  <article className="ambiguous-send-row" key={item.id} title={item.lastError}>
                    <span className="risk-dot is-high" />
                    <span>
                      <strong>{item.chatTitle || item.chatId}</strong>
                      <small>
                        {ambiguousSendSourceLabel(item.source)} ·{' '}
                        {item.messageId || 'ID не получен'}
                      </small>
                    </span>
                    <span className="ambiguous-send-row__actions">
                      <code>{item.botId || 'bot неизвестен'}</code>
                      {item.source === 'chat_rules' && (
                        <button
                          className="icon-action"
                          type="button"
                          disabled={busyAmbiguousSendId === item.id || !item.messageId}
                          title="Разрешить повторную публикацию после проверки MAX"
                          aria-label="Разрешить повторную публикацию после проверки MAX"
                          onClick={() => onAllowAmbiguousSendRetry(item)}
                        >
                          <Refresh width={15} height={15} />
                        </button>
                      )}
                    </span>
                  </article>
                ))}
              </div>
            </section>
          )}
          {visibleItems.map((item) => (
            <button
              key={item.id}
              className={`queue-item delete-queue-item ${selectedItem?.id === item.id ? 'is-selected' : ''}`}
              type="button"
              aria-pressed={selectedItem?.id === item.id}
              onClick={() => onSelect(item.id)}
            >
              <span className={`risk-dot is-${deleteStatusTone(item.status)}`} />
              <span className="queue-item__body">
                <span className="queue-item__title">{item.chatTitle || item.chatId}</span>
                <span className="queue-item__meta">
                  {formatDuration(item.ageMs)} · попыток {item.attemptCount}
                </span>
              </span>
              <DeleteStatusBadge status={item.status} />
            </button>
          ))}
          {visibleItems.length === 0 && (
            <div className="queue-empty">
              {runtime ? 'Под выбранный фильтр записей нет.' : 'Диагностика загружается.'}
            </div>
          )}
        </div>
      </section>

      <section className="delete-detail-column" aria-label="Состояние удаления">
        {selectedItem ? (
          <DeleteDetails
            item={selectedItem}
            busy={busyDeleteIntentId === selectedItem.id}
            onRetry={onRetryDeleteIntent}
          />
        ) : (
          <article className="empty-card">
            <h2>Пусто</h2>
            <p>Открытых или завершившихся ошибкой удалений нет.</p>
          </article>
        )}
      </section>
    </section>
  );
}

function DeleteDetails({
  item,
  busy,
  onRetry,
}: {
  item: SafetyDeskDeleteIntentItem;
  busy: boolean;
  onRetry: (item: SafetyDeskDeleteIntentItem) => void;
}) {
  const terminal = item.status === 'EXPIRED' || item.status === 'FAILED_TERMINAL';
  return (
    <article className="review-card delete-card" aria-label="Детали удаления">
      <header className="review-card__header">
        <div className="review-card__title">
          <div className="badge-row">
            <DeleteStatusBadge status={item.status} />
            <span className={`risk-badge ${item.capability.confirmed ? 'is-low' : 'is-high'}`}>
              {item.capability.confirmed ? 'Право подтверждено' : 'Нет подтвержденного права'}
            </span>
            <span className="risk-badge is-neutral">{deleteRolloutLabel(item.rollout)}</span>
            {item.retentionOwned && <span className="risk-badge is-neutral">Очистка по сроку</span>}
          </div>
          <h2>{item.chatTitle || item.chatId}</h2>
        </div>
      </header>

      <div className="review-meta delete-meta">
        {[
          ['Чат', item.chatId],
          ['Сообщение', item.messageId],
          ['Возраст', formatDuration(item.ageMs)],
          ['Попытки', String(item.attemptCount)],
          ['Тип', item.entityType ?? 'Не определен'],
          ['Маршрут', item.routingState],
          ['Эффективная политика', deleteRoutingPolicyLabel(item.effectiveRoutingPolicy)],
          ['Заданная политика', deleteRoutingPolicyLabel(item.routingPolicy)],
          ['Cross-bot', item.crossBotEnabled ? 'Разрешён' : 'Выключен'],
          ['Исходный бот', item.originBotId || 'Не указан'],
        ].map(([label, value]) => (
          <InfoCell key={label} label={label} value={value} />
        ))}
      </div>

      <div className="delete-detail-scroll">
        <DeleteEvidence key={item.id} intentId={item.id} />
        <section className="delete-section">
          <div className="delete-section__head">
            <h3>Активные боты</h3>
            <span>{item.capability.activeMembershipCount}</span>
          </div>
          <div className="delete-capability-list">
            {item.capability.memberships.length > 0 ? (
              item.capability.memberships.map((membership) => (
                <div className="delete-capability-row" key={membership.botId}>
                  <div>
                    <strong>{membership.botId}</strong>
                    <span>{membership.role === 'PRIMARY' ? 'Основной' : 'Резервный'}</span>
                  </div>
                  <div>
                    <strong>{deleteCapabilityStateLabel(membership.state)}</strong>
                    <span>{deleteCapabilityReasonLabel(membership.reason)}</span>
                  </div>
                  <div>
                    <strong>{membership.accessState}</strong>
                    <span>
                      Runtime {membership.botRuntimeState} ·{' '}
                      {membership.checkedAt
                        ? `проверено ${formatDateTime(new Date(membership.checkedAt))}`
                        : 'время проверки неизвестно'}
                    </span>
                  </div>
                  <code>{membership.permissions.join(', ') || 'нет permissions'}</code>
                </div>
              ))
            ) : (
              <div className="delete-empty-line">Активных membership нет.</div>
            )}
          </div>
        </section>

        <section className="delete-section delete-section--split">
          <div>
            <div className="delete-section__head">
              <h3>Причины</h3>
              <span>{item.reasons.length}</span>
            </div>
            <div className="delete-reason-list">
              {item.reasons.length > 0 ? (
                item.reasons.map((reason) => (
                  <div key={`${reason.reasonKey}-${reason.createdAt}`}>
                    <strong>{reason.ruleCode}</strong>
                    <span>{reason.reasonKey}</span>
                  </div>
                ))
              ) : (
                <div className="delete-empty-line">Причины не записаны.</div>
              )}
            </div>
          </div>
          <div>
            <div className="delete-section__head">
              <h3>Последняя ошибка</h3>
              {item.lastStatusCode !== null && <span>HTTP {item.lastStatusCode}</span>}
            </div>
            <div className="delete-error">
              <strong>{item.lastErrorCode || 'Нет кода ошибки'}</strong>
              <p>{item.lastError || 'Ошибка не зафиксирована.'}</p>
            </div>
          </div>
        </section>

        <section className="delete-section">
          <div className="delete-section__head">
            <h3>Временная шкала</h3>
          </div>
          <DiagnosticTimeline
            rows={[
              ['Создано', formatDateTime(new Date(item.createdAt))],
              ['Следующая попытка', formatDateTime(new Date(item.nextAttemptAt))],
              ['Повторять до', formatDateTime(new Date(item.retryUntilAt))],
              [
                'Последняя попытка',
                item.lastAttemptAt ? formatDateTime(new Date(item.lastAttemptAt)) : 'Еще не было',
              ],
              [
                'Lease до',
                item.leaseExpiresAt
                  ? formatDateTime(new Date(item.leaseExpiresAt))
                  : 'Нет активного lease',
              ],
              [
                'Незакрытый dispatch',
                item.deleteDispatchStartedAt
                  ? `${formatDateTime(new Date(item.deleteDispatchStartedAt))} · ${item.deleteDispatchStartedBotId || 'бот неизвестен'}`
                  : 'Нет',
              ],
              [
                'Подтверждение MAX',
                item.remoteDeleteSucceededAt
                  ? `${formatDateTime(new Date(item.remoteDeleteSucceededAt))} · ${item.remoteDeleteSucceededBotId || 'бот неизвестен'}`
                  : 'Не зафиксировано',
              ],
              ['Последний бот', item.lastBotId || 'Не выбран'],
            ]}
          />
        </section>
      </div>
      {terminal && (
        <footer className="review-actions">
          <div className="action-status" aria-live="polite">
            {item.retentionOwned
              ? 'Диагностика и безопасный повтор доступны в разделе «Очистка».'
              : canRetryDeleteIntent(item)
                ? busy
                  ? 'Возвращаю в очередь...'
                  : 'Повтор сохранит историю попыток и проверку результата.'
                : 'Сервер не разрешает повтор для текущего состояния.'}
          </div>
          {canRetryDeleteIntent(item) && (
            <button
              className="primary-action"
              type="button"
              disabled={busy}
              onClick={() => onRetry(item)}
            >
              <Refresh width={18} height={18} />
              {busy ? 'Возвращаю' : 'Повторить удаление'}
            </button>
          )}
        </footer>
      )}
    </article>
  );
}

function DeleteStatusBadge({ status }: { status: SafetyDeskDeleteIntentStatus }) {
  const labels: Record<SafetyDeskDeleteIntentStatus, string> = {
    OBSERVED: 'Shadow',
    PENDING: 'Ожидает',
    IN_PROGRESS: 'Выполняется',
    RETRYABLE: 'Повтор',
    WAITING_CAPABILITY: 'Нет права',
    AMBIGUOUS: 'Неясно',
    SUCCEEDED: 'Удалено',
    ALREADY_ABSENT: 'Уже отсутствует',
    EXPIRED: 'Истекло',
    FAILED_TERMINAL: 'Ошибка',
  };
  const statusClass = status.toLowerCase().replaceAll('_', '-');

  return <span className={`status-badge is-delete-${statusClass}`}>{labels[status]}</span>;
}

function GiveawayNotificationRow({
  item,
}: {
  item: SafetyDeskGiveawayWinnerNotificationDeadEndItem;
}) {
  return (
    <article
      className="ambiguous-send-row giveaway-notification-row"
      key={item.notificationId}
      title={item.lastError ?? undefined}
    >
      <span className="risk-dot is-high" />
      <span>
        <strong>{item.giveawayTitle || item.giveawayId}</strong>
        <small>
          Чат {item.sourceChatId} · пользователь {item.userId}
        </small>
        <small>
          notification {item.notificationId} · winner {item.winnerId}
        </small>
        <small>{item.lastError || 'Ошибка не зафиксирована'}</small>
      </span>
      <span className="giveaway-notification-row__meta">
        <DeleteStatusBadge status={item.status} />
        <code>{item.botId || 'bot неизвестен'}</code>
        <small>
          попыток {item.attemptCount} ·{' '}
          {formatDateTime(new Date(giveawayWinnerNotificationEventAt(item)))}
        </small>
      </span>
    </article>
  );
}

function GiveawayNotificationLookup({ id }: { id: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'missing' | 'error'>('idle');
  const [item, setItem] = useState<SafetyDeskGiveawayWinnerNotificationDeadEndItem | null>(null);
  async function lookup() {
    setState('loading');
    try {
      const result = await safetyDeskApiClient.fetchGiveawayNotificationDeadEnd(id);
      setItem(result.item);
      setState(result.item ? 'idle' : 'missing');
    } catch {
      setState('error');
    }
  }
  if (item) return <GiveawayNotificationRow item={item} />;
  return (
    <div>
      <button
        className="ghost-action"
        type="button"
        disabled={state === 'loading'}
        onClick={() => void lookup()}
      >
        Найти по точному ID уведомления
      </button>
      {state === 'missing' && <small role="status">Сбоя с таким ID нет.</small>}
      {state === 'error' && <small role="alert">Не удалось проверить уведомление.</small>}
    </div>
  );
}
