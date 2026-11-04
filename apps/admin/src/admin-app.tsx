import { Check, Download, Refresh } from 'iconoir-react';
import {
  type SafetyDeskDeleteIntentItem,
  type SafetyDeskDeleteRuntimeResponse,
} from '@maxim/contracts/safety-desk';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { DeleteDesk, DeleteRuntimeMetrics } from './delete-desk';
import { ReviewDesk } from './review-desk';
import { CommercialReviewDesk } from './commercial-review-desk';
import { RetentionDeskPane, RetentionRuntimeMetrics } from './retention-desk-shell';
import { useRetentionDeskControls } from './retention-desk-state';
import { safetyDeskApiClient, type SafetyDeskDecisionAction } from './safety-desk-api-client';
import {
  buildDeleteRuntimeSnapshot,
  buildReviewQueueSnapshot,
  buildSupportQueueSnapshot,
  canRetryDeleteIntent,
  createMutationGuard,
  emptyMetrics,
  emptySupportMetrics,
  filterDeleteItems,
  filterReviewItems,
  filterSupportItems,
  findSelectedItem,
  getApprovableReviewItems,
  readErrorMessage,
  type AuditEntry,
  type DeleteFilter,
  type DeskView,
  type Metrics,
  type ModerationItem,
  type QueueStatus,
  type SupportMetrics,
  type SupportStatus,
  type SupportTicket,
} from './safety-desk-model';
import { Metric } from './safety-desk-ui';
import { SupportDesk } from './support-desk';
import { supportRequestsApiClient } from './support-requests-api-client';
import { SafetyDeskNavigation } from './safety-desk-navigation';
import { ObservabilityDesk } from './observability-desk';

export function AdminApp() {
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const overviewAccessScope = useMemo(() => ({ denied: false }), []);
  const queueRequestSequence = useRef(0);
  const [view, setView] = useState<DeskView>('review');
  const [filter, setFilter] = useState<'all' | QueueStatus>('all');
  const [supportFilter, setSupportFilter] = useState<'all' | SupportStatus>('new');
  const [deleteFilter, setDeleteFilter] = useState<DeleteFilter>('attention');
  const [query, setQuery] = useState('');
  const [supportQuery, setSupportQuery] = useState('');
  const [deleteQuery, setDeleteQuery] = useState('');
  const [queueItems, setQueueItems] = useState<ModerationItem[]>([]);
  const [supportItems, setSupportItems] = useState<SupportTicket[]>([]);
  const [deleteRuntime, setDeleteRuntime] = useState<SafetyDeskDeleteRuntimeResponse | null>(null);
  const retention = useRetentionDeskControls();
  const [observationRefreshToken, setObservationRefreshToken] = useState(0);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [metrics, setMetrics] = useState<Metrics>(emptyMetrics);
  const [supportMetrics, setSupportMetrics] = useState<SupportMetrics>(emptySupportMetrics);
  const [selectedId, setSelectedId] = useState('');
  const [supportSelectedId, setSupportSelectedId] = useState('');
  const [deleteSelectedId, setDeleteSelectedId] = useState('');
  const [notice, setNotice] = useState('Загружаю данные…');
  const [loading, setLoading] = useState(true);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [busySupportId, setBusySupportId] = useState<string | null>(null);
  const [busyAmbiguousSendId, setBusyAmbiguousSendId] = useState<string | null>(null);
  const [busyDeleteIntentId, setBusyDeleteIntentId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [mutationGuard] = useState(createMutationGuard);

  const visibleItems = useMemo(
    () => filterReviewItems(queueItems, filter, query),
    [filter, query, queueItems],
  );
  const visibleSupportItems = useMemo(
    () => filterSupportItems(supportItems, supportFilter, supportQuery),
    [supportFilter, supportItems, supportQuery],
  );
  const visibleDeleteItems = useMemo(
    () => filterDeleteItems(deleteRuntime, deleteFilter, deleteQuery),
    [deleteFilter, deleteQuery, deleteRuntime],
  );

  const selectedItem = findSelectedItem(visibleItems, selectedId);
  const selectedSupportItem = findSelectedItem(visibleSupportItems, supportSelectedId);
  const selectedDeleteItem = findSelectedItem(visibleDeleteItems, deleteSelectedId);
  const isReviewScopeFiltered = filter !== 'all' || query.trim().length > 0;
  const visibleReviewItems = useMemo(() => getApprovableReviewItems(visibleItems), [visibleItems]);
  const bulkReviewCount = visibleReviewItems.length;

  const loadInitialQueues = useEffectEvent((isCurrent: () => boolean) =>
    refreshQueue('Очередь загружена', isCurrent),
  );
  useEffect(() => {
    let current = true;
    void loadInitialQueues(() => current);
    return () => {
      current = false;
      ++queueRequestSequence.current;
    };
  }, []);

  async function refreshQueue(
    successMessage = 'Очередь обновлена с сервера',
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    const sequence = ++queueRequestSequence.current;
    const canApply = () => isCurrent() && sequence === queueRequestSequence.current;
    setLoading(true);
    try {
      const [queueResult, supportResult, deleteResult] = await Promise.allSettled([
        safetyDeskApiClient.fetchQueue(),
        supportRequestsApiClient.fetchQueue(),
        safetyDeskApiClient.fetchDeleteRuntime(),
      ]);
      // FLAG: Superseded or disposed reads cannot apply their late queue responses.
      if (!canApply()) return false;
      if (queueResult.status === 'fulfilled') {
        applyQueueResponse(queueResult.value);
      }
      if (supportResult.status === 'fulfilled') {
        applySupportQueueResponse(supportResult.value);
      }
      if (deleteResult.status === 'fulfilled') {
        applyDeleteRuntimeResponse(deleteResult.value);
      }

      if (
        queueResult.status === 'fulfilled' &&
        supportResult.status === 'fulfilled' &&
        deleteResult.status === 'fulfilled'
      ) {
        setHasSnapshot(true);
        setNotice(successMessage);
        return true;
      }

      const errors = [queueResult, supportResult, deleteResult]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => readErrorMessage(result.reason));
      const loaded = [
        queueResult.status === 'fulfilled' ? 'публикации' : null,
        supportResult.status === 'fulfilled' ? 'обращения' : null,
        deleteResult.status === 'fulfilled' ? 'удаления' : null,
      ].filter(Boolean);
      if (loaded.length > 0) setHasSnapshot(true);
      setNotice(
        loaded.length > 0
          ? `Частично обновлено: ${loaded.join(', ')}. ${errors.join('; ')}`
          : errors.join('; '),
      );
      return loaded.length > 0;
    } catch (error) {
      if (canApply()) setNotice(readErrorMessage(error));
      return false;
    } finally {
      if (canApply()) setLoading(false);
    }
  }

  async function closeSupportItem(itemId: string) {
    const lease = mutationGuard.acquire(`support:${itemId}`);
    if (!lease) {
      return;
    }
    setBusySupportId(itemId);
    setNotice('Закрываю обращение');
    try {
      const response = await supportRequestsApiClient.close(itemId);
      applySupportQueueResponse(response.queue, response.item?.id ?? itemId);
      setNotice(response.message);
    } catch (error) {
      setNotice(readErrorMessage(error));
    } finally {
      setBusySupportId(null);
      mutationGuard.release(lease);
    }
  }

  async function approveItem(itemId: string) {
    await runDecision(itemId, 'approve', 'Публикую материал после одобрения');
  }

  async function rejectItem(itemId: string) {
    await runDecision(itemId, 'reject', 'Отклоняю материал без отправки в MAX');
  }

  async function recheckItem(itemId: string) {
    await runDecision(itemId, 'recheck', 'Возвращаю материал на повторную проверку');
  }

  async function allowAmbiguousSendRetry(
    item: SafetyDeskDeleteRuntimeResponse['ambiguousSends'][number],
  ) {
    const lease = mutationGuard.acquire(`ambiguous-send:${item.id}`);
    if (!lease) {
      return;
    }
    try {
      if (
        !window.confirm(
          'Разрешить повторную публикацию? Сначала убедитесь в MAX, что предыдущая отправка не появилась.',
        )
      ) {
        return;
      }
      if (!item.messageId) {
        setNotice('У операции отсутствует идентификатор отправки');
        return;
      }
      setBusyAmbiguousSendId(item.id);
      setNotice('Снимаю блокировку повторной публикации');
      applyDeleteRuntimeResponse(await safetyDeskApiClient.allowAmbiguousSendRetry(item));
      setNotice('Повторная публикация правил разрешена');
    } catch (error) {
      setNotice(readErrorMessage(error));
    } finally {
      setBusyAmbiguousSendId(null);
      mutationGuard.release(lease);
    }
  }

  async function retryDeleteIntent(item: SafetyDeskDeleteIntentItem) {
    if (
      !canRetryDeleteIntent(item) ||
      (item.status !== 'EXPIRED' && item.status !== 'FAILED_TERMINAL')
    ) {
      return;
    }
    const lease = mutationGuard.acquire(`delete-intent:${item.id}`);
    if (!lease) {
      return;
    }
    try {
      if (
        !window.confirm(
          'Поставить удаление в очередь повторно? Действие будет записано в аудит и не обходит проверку MAX.',
        )
      ) {
        return;
      }
      setBusyDeleteIntentId(item.id);
      setNotice('Возвращаю удаление в безопасную очередь');
      applyDeleteRuntimeResponse(
        await safetyDeskApiClient.retryDeleteIntent({
          id: item.id,
          status: item.status,
          updatedAt: item.updatedAt,
          attemptCount: item.attemptCount,
        }),
      );
      setNotice('Удаление возвращено в очередь');
    } catch (error) {
      setNotice(readErrorMessage(error));
    } finally {
      setBusyDeleteIntentId(null);
      mutationGuard.release(lease);
    }
  }

  async function approveAllVisible() {
    const reviewCount = bulkReviewCount;
    if (reviewCount === 0) {
      setNotice('Нет материалов для массового одобрения');
      return;
    }

    const itemIds = visibleReviewItems.map((item) => item.id);
    const leases = mutationGuard.acquireMany(itemIds.map((itemId) => `review:${itemId}`));
    if (!leases) {
      return;
    }
    const scopeLabel = isReviewScopeFiltered ? 'видимые материалы' : 'загруженную очередь проверки';
    try {
      if (!window.confirm(`Одобрить ${scopeLabel}? Материалов: ${reviewCount}.`)) {
        return;
      }
      setBulkBusy(true);
      setNotice(
        isReviewScopeFiltered ? 'Одобряю видимые материалы' : 'Одобряю материалы из очереди',
      );
      const response = await safetyDeskApiClient.approveAll(itemIds);
      applyQueueResponse(response.queue);
      setNotice(response.message);
    } catch (error) {
      setNotice(readErrorMessage(error));
    } finally {
      setBulkBusy(false);
      leases.forEach((lease) => mutationGuard.release(lease));
    }
  }

  async function runDecision(
    itemId: string,
    action: SafetyDeskDecisionAction,
    progressMessage: string,
  ) {
    const lease = mutationGuard.acquire(`review:${itemId}`);
    if (!lease) {
      return;
    }
    setBusyItemId(itemId);
    setNotice(progressMessage);
    try {
      const response = await safetyDeskApiClient.decide(itemId, action);
      applyQueueResponse(response.queue, response.item?.id ?? itemId);
      setNotice(response.message);
    } catch (error) {
      setNotice(readErrorMessage(error));
    } finally {
      setBusyItemId(null);
      mutationGuard.release(lease);
    }
  }

  function applyQueueResponse(
    response: Parameters<typeof buildReviewQueueSnapshot>[0],
    preferredId = selectedId,
  ) {
    const snapshot = buildReviewQueueSnapshot(response, preferredId);
    setQueueItems(snapshot.items);
    setAuditEntries(snapshot.auditEntries);
    setMetrics(snapshot.metrics);
    setSelectedId(snapshot.selectedId);
  }

  function applySupportQueueResponse(
    response: Parameters<typeof buildSupportQueueSnapshot>[0],
    preferredId = supportSelectedId,
  ) {
    const snapshot = buildSupportQueueSnapshot(response, preferredId);
    setSupportItems(snapshot.items);
    setSupportMetrics(snapshot.metrics);
    setSupportSelectedId(snapshot.selectedId);
  }

  function applyDeleteRuntimeResponse(
    response: SafetyDeskDeleteRuntimeResponse,
    preferredId = deleteSelectedId,
  ) {
    const snapshot = buildDeleteRuntimeSnapshot(response, preferredId);
    setDeleteRuntime(snapshot.runtime);
    setDeleteSelectedId(snapshot.selectedId);
  }

  function exportForMax() {
    const exportedAt = new Date().toISOString();
    const payload =
      view === 'deletes'
        ? { exportedAt, deleteRuntime }
        : view === 'retention'
          ? { exportedAt, retentionRuntime: retention.runtime }
          : view === 'support'
            ? { exportedAt, summary: supportMetrics, queue: supportItems }
            : { exportedAt, summary: metrics, queue: queueItems, audit: auditEntries };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `maxim-safety-desk-${view}-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice('Экспорт текущей очереди подготовлен и скачан');
  }

  if (!hasSnapshot) {
    return (
      <main className="auth-shell">
        <section className="auth-panel" aria-labelledby="desk-load-title" aria-busy={loading}>
          <h1 id="desk-load-title">Safety Desk</h1>
          <p className={loading ? undefined : 'auth-alert'} role={loading ? 'status' : 'alert'}>
            {loading ? 'Загружаю данные…' : notice}
          </p>
          {!loading && (
            <button className="primary-action" type="button" onClick={() => void refreshQueue()}>
              <Refresh width={18} height={18} />
              Повторить загрузку
            </button>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="desk-shell">
      <header className="desk-topbar">
        <div className="desk-title">
          <strong>Safety Desk</strong>
          <span>{loading ? 'Обновляю...' : notice}</span>
        </div>
        <SafetyDeskNavigation view={view} disabled={retention.busy} onSelect={setView} />
        <div className="desk-metrics" aria-label="Сводка">
          {view === 'review' ? (
            <>
              <Metric label="К проверке" value={String(metrics.review)} tone="warning" />
              <Metric label="Ок" value={String(metrics.approved)} tone="success" />
              <Metric label="Стоп" value={String(metrics.stopped)} tone="danger" />
              <Metric label="Сервис" value={String(metrics.servicePosts)} tone="neutral" />
            </>
          ) : view === 'support' ? (
            <>
              <Metric label="Новые" value={String(supportMetrics.new)} tone="warning" />
              <Metric label="Закрытые" value={String(supportMetrics.closed)} tone="success" />
            </>
          ) : view === 'commercial' ? (
            <Metric label="Режим" value="Проверка качества" tone="neutral" />
          ) : view === 'retention' ? (
            <RetentionRuntimeMetrics runtime={retention.runtime} />
          ) : view === 'observations' ? (
            <Metric label="Режим" value="Наблюдение" tone="neutral" />
          ) : (
            <DeleteRuntimeMetrics runtime={deleteRuntime} />
          )}
        </div>
        <div className="topbar__actions">
          {view === 'review' && (
            <button
              className="primary-action"
              type="button"
              disabled={loading || bulkBusy || bulkReviewCount === 0}
              onClick={() => void approveAllVisible()}
            >
              <Check width={18} height={18} />
              {bulkBusy ? 'Одобряю' : 'Одобрить все'}
            </button>
          )}
          <button
            className="ghost-action icon-action"
            type="button"
            disabled={loading || bulkBusy || retention.busy}
            onClick={() =>
              view === 'observations'
                ? setObservationRefreshToken((value) => value + 1)
                : view === 'retention'
                  ? retention.refresh()
                  : void refreshQueue()
            }
            title="Обновить"
            aria-label="Обновить"
          >
            <Refresh width={18} height={18} />
          </button>
          {view !== 'commercial' && view !== 'observations' && (
            <button className="ghost-action" type="button" onClick={exportForMax}>
              <Download width={18} height={18} />
              Экспорт
            </button>
          )}
        </div>
      </header>

      {view === 'review' ? (
        <ReviewDesk
          auditEntries={auditEntries}
          busyItemId={busyItemId}
          filter={filter}
          query={query}
          selectedItem={selectedItem}
          visibleItems={visibleItems}
          onApprove={approveItem}
          onFilterChange={setFilter}
          onQueryChange={setQuery}
          onRecheck={recheckItem}
          onReject={rejectItem}
          onSelect={setSelectedId}
        />
      ) : view === 'support' ? (
        <SupportDesk
          busyItemId={busySupportId}
          filter={supportFilter}
          query={supportQuery}
          selectedItem={selectedSupportItem}
          visibleItems={visibleSupportItems}
          onClose={closeSupportItem}
          onFilterChange={setSupportFilter}
          onQueryChange={setSupportQuery}
          onSelect={setSupportSelectedId}
        />
      ) : view === 'commercial' ? (
        <CommercialReviewDesk />
      ) : view === 'retention' ? (
        <RetentionDeskPane controls={retention} />
      ) : view === 'observations' ? (
        <ObservabilityDesk
          refreshToken={observationRefreshToken}
          accessScope={overviewAccessScope}
        />
      ) : (
        <DeleteDesk
          busyAmbiguousSendId={busyAmbiguousSendId}
          busyDeleteIntentId={busyDeleteIntentId}
          filter={deleteFilter}
          query={deleteQuery}
          runtime={deleteRuntime}
          selectedItem={selectedDeleteItem}
          visibleItems={visibleDeleteItems}
          onFilterChange={setDeleteFilter}
          onAllowAmbiguousSendRetry={allowAmbiguousSendRetry}
          onQueryChange={setDeleteQuery}
          onSelect={setDeleteSelectedId}
          onRetryDeleteIntent={retryDeleteIntent}
        />
      )}
    </main>
  );
}
