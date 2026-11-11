import { AppIcon as IconoirSprite } from '../../components/ui/app-icon';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ReportJournalFilters, ReportsPage, ReportSummary } from '@maxim/contracts/settings';
import { ActionConfirmSheet } from '../../components/ui/action-confirm-sheet';
import type { ApiTransport } from '../../lib/api/transport';
import { dismissReport, getReport, getReports } from '../../lib/api/reports-client';
import { formatApiError } from './settings-page-helpers';
import {
  isReportActive,
  mergeReportPages,
  newestReport,
  reportDetailsMatch,
} from './report-journal-model';
import { ReportProfileLink } from './report-profile-link';

const statuses: Record<ReportSummary['status'], string> = {
  COLLECTING: 'Сбор голосов',
  PENDING: 'В очереди',
  RUNNING: 'Исполняется',
  COMPLETED: 'Выполнено',
  PARTIAL: 'Частично',
  FAILED: 'Ошибка',
  DISMISSED: 'Отклонено',
  EXPIRED: 'Срок истёк',
  CANCELLED: 'Отменено',
};

const executionLabels: Record<ReportSummary['status'], string> = {
  COLLECTING: 'Ожидаем голоса',
  PENDING: 'Меры ожидают исполнения',
  RUNNING: 'Применяем выбранные меры',
  COMPLETED: 'Все меры выполнены',
  PARTIAL: 'Меры выполнены частично',
  FAILED: 'Меры не выполнены',
  DISMISSED: 'Сбор закрыт администратором',
  EXPIRED: 'Время сбора закончилось',
  CANCELLED: 'Применение мер отменено',
};

export function ReportJournal({ api, chatId }: { api: ApiTransport; chatId: string }) {
  const [filters, setFilters] = useState<ReportJournalFilters>({ status: 'ALL' });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [periodError, setPeriodError] = useState('');
  useEffect(() => {
    setFilters({ status: 'ALL' });
    setFrom('');
    setTo('');
  }, [chatId]);
  return (
    <div
      className="reports-journal"
      role="tabpanel"
      id="reports-journal-pane"
      aria-labelledby="reports-journal-tab"
    >
      <form
        className="reports-filters"
        onSubmit={(event) => {
          event.preventDefault();
          if (from && to && from > to) {
            setPeriodError('Конец периода раньше начала.');
            return;
          }
          setPeriodError('');
          const start = from ? new Date(`${from}T00:00:00`) : null;
          const end = to ? new Date(`${to}T23:59:59.999`) : null;
          if (
            (start && !Number.isFinite(start.getTime())) ||
            (end && !Number.isFinite(end.getTime()))
          ) {
            setPeriodError('Проверьте даты периода.');
            return;
          }
          setFilters((current) => ({
            ...current,
            from: start?.toISOString(),
            to: end?.toISOString(),
          }));
        }}
      >
        <label className="reports-field">
          <span>Статус</span>
          <select
            value={filters.status}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                status: event.target.value as ReportJournalFilters['status'],
              }))
            }
          >
            <option value="ALL">Все жалобы</option>
            <option value="ACTIVE">В работе</option>
            <option value="FAILED">С ошибками</option>
            <option value="COMPLETED">Завершённые</option>
          </select>
        </label>
        <details className="reports-period">
          <summary>Период{filters.from || filters.to ? ' · выбран' : ''}</summary>
          <div className="reports-period__fields">
            <label className="reports-field">
              <span>С даты</span>
              <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <label className="reports-field">
              <span>По дату</span>
              <input
                type="date"
                value={to}
                aria-invalid={Boolean(periodError) || undefined}
                aria-describedby={periodError ? 'reports-period-error' : undefined}
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
            <button type="submit" className="button button--ghost">
              Применить период
            </button>
          </div>
          {periodError && (
            <p id="reports-period-error" role="alert">
              {periodError}
            </p>
          )}
        </details>
        {filters.authorId && (
          <p className="reports-author-filter" role="status">
            Выбран автор жалобы
          </p>
        )}
        {(filters.status !== 'ALL' || filters.from || filters.to || filters.authorId) && (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              setFilters({ status: 'ALL' });
              setFrom('');
              setTo('');
              setPeriodError('');
            }}
          >
            Сбросить фильтры
          </button>
        )}
      </form>
      <ReportJournalResults
        key={`${chatId}:${JSON.stringify(filters)}`}
        api={api}
        chatId={chatId}
        filters={filters}
        onAuthorFilter={(authorId) => setFilters((current) => ({ ...current, authorId }))}
      />
    </div>
  );
}

const dateLabel = (value: string) =>
  new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
function ReportJournalResults({
  api,
  chatId,
  filters,
  onAuthorFilter,
}: {
  api: ApiTransport;
  chatId: string;
  filters: ReportJournalFilters;
  onAuthorFilter: (id: string) => void;
}) {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmDismiss, setConfirmDismiss] = useState<string | null>(null);
  const [history, setHistory] = useState<ReportsPage[]>([]);
  const historyController = useRef<AbortController | null>(null);
  const detailRefreshVersion = useRef('');
  useEffect(() => () => historyController.current?.abort(), []);
  const key = ['chat-reports', chatId] as const;
  const headKey = [...key, 'head', filters];
  const detailKey = [...key, 'detail', selected];
  const list = useQuery({
    queryKey: headKey,
    queryFn: ({ signal }) => getReports(api, chatId, null, signal, filters),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
  const items = mergeReportPages([...(list.data ? [list.data] : []), ...history]);
  const listedSelected = items.find((item) => item.id === selected);
  const detail = useQuery({
    queryKey: detailKey,
    enabled: Boolean(selected),
    queryFn: ({ signal }) => getReport(api, chatId, selected!, signal),
    refetchInterval: (query) => {
      const current = listedSelected
        ? newestReport(listedSelected, query.state.data)
        : query.state.data;
      return isReportActive(current) ? 10_000 : false;
    },
    refetchIntervalInBackground: false,
  });
  const currentSelected = listedSelected ? newestReport(listedSelected, detail.data) : detail.data;
  useEffect(() => {
    if (
      !selected ||
      !listedSelected ||
      !detail.data ||
      reportDetailsMatch(listedSelected, detail.data)
    )
      return;
    const stamp = `${selected}:${listedSelected.snapshotVersion ?? listedSelected.updatedAt}`;
    if (
      detailRefreshVersion.current === stamp ||
      newestReport(listedSelected, detail.data) !== listedSelected
    )
      return;
    detailRefreshVersion.current = stamp;
    void detail.refetch({ cancelRefetch: false });
  }, [selected, listedSelected, detail.data, detail.refetch]);
  const nextCursor = history.length
    ? history[history.length - 1]!.nextCursor
    : list.data?.nextCursor;
  const loadOlder = useMutation({
    mutationFn: async (cursor: string) => {
      historyController.current?.abort();
      const controller = new AbortController();
      historyController.current = controller;
      return getReports(api, chatId, cursor, controller.signal, filters);
    },
    onSuccess: (page) => setHistory((current) => [...current, page]),
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => dismissReport(api, chatId, id),
    onMutate: () => client.cancelQueries({ queryKey: key }),
    onSuccess: (report) => {
      setConfirmDismiss(null);
      client.setQueryData([...key, 'detail', report.id], report);
      client.setQueryData<ReportsPage>(headKey, (page) =>
        page
          ? {
              ...page,
              observedAt: report.observedAt ?? page.observedAt,
              items: page.items.map((item) => (item.id === report.id ? report : item)),
            }
          : page,
      );
      void client.invalidateQueries({ queryKey: key });
    },
    onError: () => {
      setConfirmDismiss(null);
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const canDismiss = currentSelected && ['COLLECTING', 'PENDING'].includes(currentSelected.status);
  return (
    <>
      <div className="reports-journal__head">
        <div>
          <h3>Жалобы участников</h3>
          {list.data?.observedAt && <small>Обновлено {dateLabel(list.data.observedAt)}</small>}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Обновить жалобы"
          title="Обновить жалобы"
          disabled={list.isFetching || detail.isFetching || dismiss.isPending}
          onClick={() => {
            void list.refetch();
            if (selected) void detail.refetch({ cancelRefetch: false });
          }}
        >
          <IconoirSprite variant="iconoir" icon="RefreshDouble" aria-hidden />
        </button>
      </div>
      {list.isPending && <p role="status">Загрузка…</p>}
      {list.isError && (
        <p role="alert">Не удалось загрузить жалобы. {formatApiError(list.error)}</p>
      )}
      {!list.isPending && !list.isError && items.length === 0 && (
        <p className="reports-empty">Жалоб по выбранным условиям пока нет.</p>
      )}
      {items.map((listed) => {
        const item = selected === listed.id ? newestReport(listed, detail.data) : listed;
        const matchingDetail =
          selected === item.id && reportDetailsMatch(item, detail.data) ? detail.data : undefined;
        const remainingVotes = Math.max(0, item.threshold - item.votes);
        return (
          <article className="reports-journal__item" key={item.id} data-status={item.status}>
            <button
              type="button"
              className="reports-journal__summary"
              aria-expanded={selected === item.id}
              aria-controls={`report-${item.id}-detail`}
              onClick={() => {
                dismiss.reset();
                setSelected(selected === item.id ? null : item.id);
              }}
            >
              <span>
                <strong className="reports-status">{statuses[item.status]}</strong>
                <small>{dateLabel(item.createdAt)}</small>
              </span>
              <span className="reports-journal__votes">
                <b>
                  {item.votes}
                  <small>/{item.threshold}</small>
                </b>
                <small className="reports-journal__vote-label">голоса</small>
                <IconoirSprite variant="iconoir" icon="NavArrowDown" aria-hidden />
              </span>
            </button>
            {selected === item.id && (
              <div className="reports-journal__detail" id={`report-${item.id}-detail`}>
                <dl>
                  <dt>Автор</dt>
                  <dd>
                    {matchingDetail ? (
                      <ReportProfileLink
                        api={api}
                        chatId={chatId}
                        userId={item.authorId}
                        displayName={matchingDetail?.authorName}
                        profileUrl={matchingDetail?.authorProfileUrl}
                        profileHandoffUrl={matchingDetail.authorProfileHandoffUrl}
                      />
                    ) : (
                      'Загрузка имени…'
                    )}
                  </dd>
                  <dt>Сообщение</dt>
                  <dd className="reports-message-id">{item.messageId}</dd>
                  <dt>Удаление</dt>
                  <dd>{item.deleteMode === 'MESSAGE' ? 'Одно сообщение' : 'История за 24 часа'}</dd>
                  <dt>Ограничение</dt>
                  <dd>
                    {item.muteApplied
                      ? `Назначено на ${item.muteHours} ч`
                      : item.muteHours
                        ? `${item.muteHours} ч · не назначено`
                        : 'Выключено'}
                  </dd>
                </dl>
                <div className="reports-outcomes" aria-label="Результаты удаления">
                  <span>
                    <b>{item.deleted}</b>
                    <small>Удалено</small>
                  </span>
                  <span>
                    <b>{item.absent}</b>
                    <small>Уже отсутствуют</small>
                  </span>
                  <span data-failed={item.failed > 0}>
                    <b>{item.failed}</b>
                    <small>Не выполнено</small>
                  </span>
                </div>
                <div className="reports-execution-progress">
                  <div>
                    <strong>
                      {item.status === 'COLLECTING'
                        ? `Ожидаем ещё ${remainingVotes} ${remainingVotes === 1 ? 'голос' : remainingVotes < 5 ? 'голоса' : 'голосов'}`
                        : executionLabels[item.status]}
                    </strong>
                    <span>
                      {item.status === 'COLLECTING'
                        ? `${item.votes} / ${item.threshold}`
                        : `${item.candidates - item.pending} / ${item.candidates}`}
                    </span>
                  </div>
                  <progress
                    aria-label={item.status === 'COLLECTING' ? 'Собрано голосов' : 'Выполнение мер'}
                    max={
                      item.status === 'COLLECTING' ? item.threshold : Math.max(1, item.candidates)
                    }
                    value={
                      item.status === 'COLLECTING' ? item.votes : item.candidates - item.pending
                    }
                  />
                  <p className="reports-progress">
                    Проверено сообщений: {item.candidates}. В очереди: {item.pending}.
                  </p>
                </div>
                <ol className="reports-timeline" aria-label="Хронология жалобы">
                  <li>
                    <span>Сбор открыт</span>
                    <time dateTime={item.createdAt}>{dateLabel(item.createdAt)}</time>
                  </li>
                  {item.updatedAt && (
                    <li>
                      <span>Последнее изменение</span>
                      <time dateTime={item.updatedAt}>{dateLabel(item.updatedAt)}</time>
                    </li>
                  )}
                  <li>
                    <span>{item.status === 'COLLECTING' ? 'Сбор до' : 'Срок сбора'}</span>
                    <time dateTime={item.expiresAt}>{dateLabel(item.expiresAt)}</time>
                  </li>
                </ol>
                {item.lastError && (
                  <p className="reports-availability" role="status">
                    {item.lastError}
                  </p>
                )}
                {detail.isFetching && <p role="status">Обновление подробностей…</p>}
                {detail.isError && (
                  <p role="alert">
                    Не удалось загрузить подробности. {formatApiError(detail.error)}
                  </p>
                )}
                {item.detailsArchived ? (
                  <p role="status">
                    Подробности удалены по сроку хранения. Итоговые числа сохранены.
                  </p>
                ) : (
                  matchingDetail && (
                    <>
                      <h4>Участники</h4>
                      <ul className="reports-reporters">
                        {matchingDetail.reporters.map((reporter) => (
                          <li key={reporter.userId}>
                            <ReportProfileLink
                              api={api}
                              chatId={chatId}
                              userId={reporter.userId}
                              displayName={reporter.displayName}
                              profileUrl={reporter.profileUrl}
                              profileHandoffUrl={reporter.profileHandoffUrl}
                            />
                            <time dateTime={reporter.createdAt}>
                              {dateLabel(reporter.createdAt)}
                            </time>
                          </li>
                        ))}
                      </ul>
                    </>
                  )
                )}
                {!filters.authorId && (
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => onAuthorFilter(item.authorId)}
                  >
                    Все жалобы на этого автора
                  </button>
                )}
                {['COLLECTING', 'PENDING'].includes(item.status) && (
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={dismiss.isPending || detail.isError}
                    onClick={() => setConfirmDismiss(item.id)}
                  >
                    Отклонить жалобы
                  </button>
                )}
                {dismiss.isError && (
                  <p role="alert">Не удалось отклонить жалобы. {formatApiError(dismiss.error)}</p>
                )}
              </div>
            )}
          </article>
        );
      })}
      {nextCursor && (
        <button
          type="button"
          className="button button--ghost"
          disabled={loadOlder.isPending}
          onClick={() => loadOlder.mutate(nextCursor)}
        >
          {loadOlder.isPending ? 'Загрузка…' : 'Ещё'}
        </button>
      )}
      {loadOlder.isError && (
        <p role="alert">
          Не удалось загрузить следующую страницу. {formatApiError(loadOlder.error)}
        </p>
      )}
      <ActionConfirmSheet
        id="report-dismiss-confirm"
        open={Boolean(confirmDismiss)}
        title="Отклонить жалобы?"
        summary="Сбор по этому сообщению будет закрыт, а ожидающие меры отменены. Новые голоса не откроют его заново. Уже выполненные меры сохранятся."
        confirmLabel="Отклонить"
        confirmBusyLabel="Отклоняем…"
        role="alertdialog"
        isBusy={dismiss.isPending}
        confirmDisabled={!canDismiss}
        onClose={() => setConfirmDismiss(null)}
        onConfirm={() => {
          if (confirmDismiss && canDismiss) dismiss.mutate(confirmDismiss);
        }}
      />
    </>
  );
}
