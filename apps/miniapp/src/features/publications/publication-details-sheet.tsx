import { AppIcon as IconoirSprite } from '../../components/ui/app-icon';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  PublicationDelivery,
  PublicationDetails,
  PublicationOccurrenceSummary,
  PublicationOccurrenceStatus,
  PublicationSummary,
} from '@maxim/contracts/publication';

import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MaxMarkdownPreview } from '../../components/max-markdown-preview';
import { EntityAvatar } from '../../components/ui/entity-avatar';
import { StatusState } from '../../components/ui/status-state';
import { describeUserFacingError } from '../../lib/user-facing-error';
import { getPublication, listPublicationDeliveries } from '../../lib/api/publication-client';
import type { ApiTransport } from '../../lib/api/transport';
import { formatRussianCountLabel } from '../../lib/broadcast-audience';
import { cn } from '../../lib/cn';
import { isTopmostModalDialog, useDialogFocusTrap } from '../../lib/dialog-focus';
import { useNativeBackHandler } from '../../lib/native-back';
import { formatPublicationDeliveryError } from './publication-delivery-error';
import { PublicationDeliveryActions } from './publication-delivery-actions';
import { getPublicationDeliveryPresentation } from './publication-delivery-presentation';
import { getPublicationDeliveryResultPresentation } from './publication-delivery-result-presentation';
import {
  publicationPostActionLabels,
  publicationPostActionsPollingInterval,
  publicationPostPublishLabels,
} from './publication-post-actions-presentation';
import {
  getPublicationActionCapabilities,
  getPublicationActionableDelivery,
  getPublicationReviewCount,
  getPublicationDetailsPollingInterval,
  getPublicationDispatchIssuePresentation,
  getPublicationScheduleErrorPresentation,
  isPublicationOccurrenceContentStale,
  PUBLICATION_DISPATCH_ISSUE_POLL_INTERVAL_MS,
  resolvePublicationDetailsDispatchIssue,
  shouldPollPublicationDeliveries,
} from './publication-model';
import {
  isAmbiguousDeliveryPhaseComplete,
  mergePublicationDeliveryPages,
  mergePublicationPages,
  shouldPollPublicationDeliveryPages,
} from './publication-pagination';
import './publication-details-sheet.css';

type PublicationDetailsSheetProps = {
  api: ApiTransport;
  publication: PublicationSummary | null;
  allowEdit?: boolean;
  busy?: boolean;
  covered?: boolean;
  publisherAccessRecheckBusy?: boolean;
  publisherAccessRechecking?: boolean;
  onClose: () => void;
  onCancel: (publication: PublicationSummary) => void;
  onEdit: (publicationId: string) => void;
  onRecheckPublisherAccess?: (publicationId: string) => void;
  onRetry: (publication: PublicationDetails, occurrence: PublicationOccurrenceSummary) => void;
  onResolveAmbiguous: (
    publicationId: string,
    occurrenceId: string,
    deliveryId: string,
    resolution: 'mark_sent' | 'mark_failed',
  ) => void;
};

function formatDateTime(value: string, timezone = 'Europe/Moscow', seconds = false): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('ru-RU', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        ...(seconds ? { second: '2-digit' as const } : {}),
        timeZone: timezone,
      }).format(date)
    : value;
}

const OCCURRENCE_STATUS_LABELS: Record<PublicationOccurrenceStatus, string> = {
  SCHEDULED: 'Запланировано',
  IN_PROGRESS: 'В обработке',
  SENT: 'Опубликовано',
  PARTIAL: 'Частично',
  FAILED: 'Ошибка',
  AMBIGUOUS: 'Нужно проверить',
  CANCELED: 'Отменено',
};

const PUBLICATION_DELIVERY_PAGE_SIZE = 50;

function formatOccurrenceRevision(
  occurrence: PublicationOccurrenceSummary,
  latestContentRevision: number,
): string | null {
  if (occurrence.contentRevision === undefined && occurrence.usesLatestContent === undefined) {
    return null;
  }
  if (isPublicationOccurrenceContentStale(occurrence, latestContentRevision)) {
    return 'Есть новые правки';
  }
  return null;
}

function getStaleDeliveryContentRevision(
  delivery: PublicationDelivery,
  latestContentRevision: number,
): number | null {
  const contentRevision = delivery.contentRevision;
  return contentRevision !== undefined && contentRevision !== latestContentRevision
    ? contentRevision
    : null;
}

function resolvePublicationDetailsPortalTarget(): Element | null {
  if (typeof document === 'undefined') {
    return null;
  }
  return document.querySelector('.design-preview__device-screen') ?? document.body;
}

export function PublicationDetailsSheet({
  api,
  publication,
  allowEdit = true,
  busy = false,
  covered = false,
  publisherAccessRecheckBusy = false,
  publisherAccessRechecking = false,
  onClose,
  onCancel,
  onEdit,
  onRecheckPublisherAccess,
  onRetry,
  onResolveAmbiguous,
}: PublicationDetailsSheetProps) {
  const open = publication !== null;
  const panelRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  useDialogFocusTrap(open && !covered, panelRef, closeButtonRef);
  const detailsQuery = useQuery({
    queryKey: ['publications', 'details', publication?.id],
    queryFn: () => getPublication(api, publication?.id ?? ''),
    enabled: open,
    refetchInterval: (query) => {
      const details = query.state.data;
      const delivery = details ? getPublicationActionableDelivery(details) : null;
      if (!details || !delivery) {
        return false;
      }
      return getPublicationDetailsPollingInterval(details, delivery);
    },
  });
  const actionableDelivery = detailsQuery.data
    ? getPublicationActionableDelivery(detailsQuery.data)
    : publication
      ? getPublicationActionableDelivery(publication)
      : null;
  const shouldPollDeliveries = Boolean(
    detailsQuery.data &&
    actionableDelivery &&
    shouldPollPublicationDeliveries(detailsQuery.data, actionableDelivery),
  );
  const reviewSource = detailsQuery.data ?? publication;
  const ambiguousCount = reviewSource ? getPublicationReviewCount(reviewSource) : 0;
  const hasAmbiguous = ambiguousCount > 0;
  const ambiguousDeliveriesQuery = useInfiniteQuery({
    queryKey: ['publications', 'deliveries', publication?.id, 'ambiguous'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listPublicationDeliveries(api, publication?.id ?? '', {
        status: 'AMBIGUOUS',
        limit: PUBLICATION_DELIVERY_PAGE_SIZE,
        cursor: pageParam ?? undefined,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: open && hasAmbiguous,
    refetchInterval: (query) =>
      shouldPollPublicationDeliveryPages(shouldPollDeliveries, query.state.data?.pages)
        ? detailsQuery.data?.dispatchIssue
          ? PUBLICATION_DISPATCH_ISSUE_POLL_INTERVAL_MS
          : 5_000
        : false,
  });
  const {
    fetchNextPage: fetchNextAmbiguousPage,
    hasNextPage: hasNextAmbiguousPage,
    isFetchingNextPage: isFetchingNextAmbiguousPage,
    isSuccess: ambiguousDeliveriesLoaded,
  } = ambiguousDeliveriesQuery;
  const hasAmbiguousDeliveryData = Boolean(ambiguousDeliveriesQuery.data);
  const ambiguousInitialError =
    hasAmbiguous && ambiguousDeliveriesQuery.isError && !hasAmbiguousDeliveryData;
  const ambiguousPhaseComplete = isAmbiguousDeliveryPhaseComplete({
    hasAmbiguous,
    hasData: hasAmbiguousDeliveryData,
    hasNextPage: hasNextAmbiguousPage,
    isError: ambiguousDeliveriesQuery.isError,
    isFetchingNextPage: isFetchingNextAmbiguousPage,
    isSuccess: ambiguousDeliveriesLoaded,
  });
  const deliveriesQuery = useInfiniteQuery({
    queryKey: [
      'publications',
      'deliveries',
      publication?.id,
      'all',
      { excludeStatus: hasAmbiguous ? 'AMBIGUOUS' : null },
    ],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listPublicationDeliveries(api, publication?.id ?? '', {
        excludeStatus: hasAmbiguous ? 'AMBIGUOUS' : undefined,
        limit: PUBLICATION_DELIVERY_PAGE_SIZE,
        cursor: pageParam ?? undefined,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: open && ambiguousPhaseComplete,
    refetchInterval: (query) => {
      if (shouldPollPublicationDeliveryPages(shouldPollDeliveries, query.state.data?.pages)) {
        return detailsQuery.data?.dispatchIssue
          ? PUBLICATION_DISPATCH_ISSUE_POLL_INTERVAL_MS
          : 5_000;
      }
      const intervals =
        query.state.data?.pages.flatMap((page) =>
          page.items
            .map((item) => publicationPostActionsPollingInterval(item.postActions))
            .filter((interval): interval is number => interval !== false),
        ) ?? [];
      return intervals.length > 0 ? Math.min(...intervals) : false;
    },
  });

  useEffect(() => {
    if (
      !open ||
      !hasAmbiguous ||
      !ambiguousDeliveriesLoaded ||
      !hasNextAmbiguousPage ||
      isFetchingNextAmbiguousPage
    ) {
      return;
    }
    void fetchNextAmbiguousPage();
  }, [
    ambiguousDeliveriesLoaded,
    fetchNextAmbiguousPage,
    hasAmbiguous,
    hasNextAmbiguousPage,
    isFetchingNextAmbiguousPage,
    open,
  ]);

  const ambiguousDeliveries = useMemo(
    () => (hasAmbiguous ? mergePublicationPages(ambiguousDeliveriesQuery.data?.pages) : []),
    [ambiguousDeliveriesQuery.data?.pages, hasAmbiguous],
  );
  const deliveries = useMemo(
    () =>
      mergePublicationDeliveryPages(
        hasAmbiguous,
        ambiguousDeliveriesQuery.data?.pages,
        ambiguousPhaseComplete ? deliveriesQuery.data?.pages : undefined,
      ),
    [
      ambiguousDeliveriesQuery.data?.pages,
      ambiguousPhaseComplete,
      deliveriesQuery.data?.pages,
      hasAmbiguous,
    ],
  );

  useNativeBackHandler(
    () => {
      if (busy) {
        return false;
      }
      onClose();
      return true;
    },
    { enabled: open && !covered, priority: 720 },
  );

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (event.key !== 'Escape' || !panel || !isTopmostModalDialog(panel)) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!busy) {
        onClose();
      }
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [busy, onClose, open]);

  const portalTarget = open ? resolvePublicationDetailsPortalTarget() : null;
  if (!open || !portalTarget) {
    return null;
  }

  const details = detailsQuery.data;
  const dispatchIssue = resolvePublicationDetailsDispatchIssue(details, publication);
  const issuePresentation = getPublicationDispatchIssuePresentation(
    dispatchIssue,
    false,
    Boolean((details ?? publication).schedule?.nextOccurrenceAt),
  );
  const dispatchIssuePresentation =
    dispatchIssue === 'decision_required'
      ? issuePresentation
      : (getPublicationScheduleErrorPresentation(details ?? publication) ?? issuePresentation);
  const actionCapabilities = getPublicationActionCapabilities(details ?? publication);
  const resultPresentation = getPublicationDeliveryResultPresentation(details ?? publication);
  const editLabel =
    actionCapabilities.editScope === 'future'
      ? 'Изменить будущие отправки'
      : actionCapabilities.editScope === 'retry'
        ? 'Изменить версию для повтора'
        : 'Изменить расписание';

  return createPortal(
    <div className="publication-details-sheet" aria-hidden={covered || undefined} inert={covered}>
      <button
        type="button"
        className="publication-details-sheet__backdrop"
        onClick={onClose}
        aria-label="Закрыть детали"
        disabled={busy}
      />
      <section
        ref={panelRef}
        className="publication-details-sheet__panel"
        role="dialog"
        aria-modal={covered ? undefined : true}
        aria-labelledby="publication-details-title"
        tabIndex={-1}
      >
        <div className="publication-details-sheet__grabber" aria-hidden />
        <header className="publication-details-sheet__header">
          <span>
            <strong id="publication-details-title">{publication.title || 'Публикация'}</strong>
            <small>
              {formatRussianCountLabel(
                publication.targetCount,
                'получатель',
                'получателя',
                'получателей',
              )}
            </small>
          </span>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            disabled={busy}
          >
            <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
          </button>
        </header>

        <div className="publication-details-sheet__body">
          {detailsQuery.isLoading ? (
            <StatusState tone="neutral" title="Загружаю детали" />
          ) : detailsQuery.isError && !details ? (
            <StatusState
              tone="danger"
              title="Не удалось открыть"
              description={describeUserFacingError(detailsQuery.error, 'Повторите ещё раз.')}
            />
          ) : details ? (
            <>
              <section
                className={cn(
                  'publication-details-result',
                  resultPresentation.needsAttention && 'needs-attention',
                )}
                aria-label="Результат доставки"
              >
                <span>Доставка · За всё время</span>
                <strong>{resultPresentation.headline}</strong>
                {resultPresentation.currentFacts.length > 0 ? (
                  <div className="publication-details-result__current">
                    <span>Сейчас</span>
                    {resultPresentation.currentFacts.map((fact) => (
                      <small key={fact}>{fact}</small>
                    ))}
                  </div>
                ) : null}
                {details.delivery.canceled > 0 ? (
                  <small>Отменено: {details.delivery.canceled}</small>
                ) : null}
              </section>
              {dispatchIssuePresentation ? (
                <div
                  className="publication-details-dispatch-notice"
                  role="status"
                  aria-atomic="true"
                >
                  <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
                  <span>
                    <strong>
                      {publisherAccessRechecking
                        ? 'Проверяю подключения'
                        : dispatchIssuePresentation.title}
                    </strong>
                    <small>{dispatchIssuePresentation.description}</small>
                  </span>
                  {dispatchIssuePresentation.canRecheck && onRecheckPublisherAccess ? (
                    <button
                      type="button"
                      className={cn(publisherAccessRechecking && 'is-refreshing')}
                      onClick={() => onRecheckPublisherAccess(publication.id)}
                      disabled={busy || publisherAccessRecheckBusy || publisherAccessRechecking}
                      aria-label={
                        publisherAccessRechecking
                          ? 'Проверяются подключения'
                          : publisherAccessRecheckBusy
                            ? 'Проверка уже выполняется'
                            : 'Проверить подключения'
                      }
                      title={
                        publisherAccessRechecking
                          ? 'Проверяются подключения'
                          : publisherAccessRecheckBusy
                            ? 'Проверка уже выполняется'
                            : 'Проверить подключения'
                      }
                    >
                      <IconoirSprite variant="iconoir" icon="Refresh" aria-hidden />
                    </button>
                  ) : null}
                </div>
              ) : null}

              <div className="publication-details-sheet__message">
                {details.content.media.length > 0 ? (
                  <span className="publication-details-sheet__media">
                    {details.hasVideo ? 'Видео' : `${details.mediaCount} фото`}
                  </span>
                ) : null}
                <MaxMarkdownPreview
                  value={details.content.text}
                  sourceFormat={details.content.textFormat}
                  normalizeWhitespace
                  fallback={details.hasVideo ? 'Видео без текста' : null}
                />
              </div>

              <section className="publication-details-section">
                <strong>Получатели</strong>
                <div className="publication-details-targets">
                  {details.targets.map((target) => (
                    <div key={`${target.entityType}:${target.chatId}`}>
                      <EntityAvatar
                        title={target.title}
                        entityType={target.entityType}
                        avatarUrl={target.avatarUrl}
                      />
                      <span className="publication-details-targets__copy">
                        <strong>{target.title}</strong>
                        <small>{target.entityType === 'channel' ? 'Канал' : 'Чат'}</small>
                      </span>
                    </div>
                  ))}
                </div>
              </section>

              {publicationPostPublishLabels(details.content.postPublish).length > 0 ? (
                <section className="publication-details-section">
                  <strong>После публикации</strong>
                  {publicationPostPublishLabels(details.content.postPublish).map((label) => (
                    <span key={label}>{label}</span>
                  ))}
                </section>
              ) : null}

              <section className="publication-details-section">
                <strong>Отправки</strong>
                <div className="publication-occurrences">
                  {details.occurrences.length > 0 ? (
                    details.occurrences.map((occurrence) => {
                      const revisionLabel = formatOccurrenceRevision(
                        occurrence,
                        details.content.revision,
                      );
                      const staleContent = isPublicationOccurrenceContentStale(
                        occurrence,
                        details.content.revision,
                      );
                      return (
                        <div
                          key={occurrence.id}
                          data-occurrence-id={occurrence.id}
                          className={cn(
                            `is-${occurrence.status.toLowerCase()}`,
                            occurrence.dispatchIssue && 'has-dispatch-issue',
                            occurrence.canRetry && 'has-retry-action',
                          )}
                        >
                          <span className="publication-deliveries__copy">
                            <strong>
                              {formatDateTime(occurrence.scheduledAt, details.schedule?.timezone)}
                            </strong>
                            {occurrence.delivery.total > 0 ? (
                              <small>
                                Отправлено {occurrence.delivery.sent}/{occurrence.delivery.total}
                              </small>
                            ) : null}
                            {revisionLabel ? (
                              <small
                                className={cn(
                                  'publication-occurrences__revision',
                                  staleContent && 'is-stale',
                                )}
                              >
                                {revisionLabel}
                              </small>
                            ) : null}
                            {occurrence.dispatchIssue && occurrence.dispatchBlockedSince ? (
                              <small>
                                {['SCHEDULED', 'IN_PROGRESS'].includes(occurrence.status)
                                  ? 'Ожидает с'
                                  : 'Причина отмечена'}{' '}
                                {formatDateTime(
                                  occurrence.dispatchBlockedSince,
                                  details.schedule?.timezone,
                                )}
                              </small>
                            ) : null}
                            {occurrence.dispatchIssue && occurrence.dispatchCheckedAt ? (
                              <small>
                                Проверено{' '}
                                {formatDateTime(
                                  occurrence.dispatchCheckedAt,
                                  details.schedule?.timezone,
                                )}
                              </small>
                            ) : null}
                          </span>
                          <span className="publication-occurrences__actions">
                            <span className="publication-occurrences__status">
                              {getPublicationDispatchIssuePresentation(
                                occurrence.dispatchIssue,
                                occurrence.requiresScheduleDecision,
                              )?.label ?? OCCURRENCE_STATUS_LABELS[occurrence.status]}
                            </span>
                            {occurrence.canRetry ? (
                              <button
                                type="button"
                                onClick={() => onRetry(details, occurrence)}
                                disabled={busy}
                                aria-label={`${occurrence.requiresScheduleDecision ? 'Отправить пропущенный запуск' : 'Повторить запуск'}: ${formatDateTime(occurrence.scheduledAt, details.schedule?.timezone)}`}
                              >
                                <IconoirSprite variant="iconoir" icon="RefreshDouble" aria-hidden />
                                <span className="publication-occurrences__retry-label">
                                  <span>
                                    {occurrence.requiresScheduleDecision
                                      ? 'Отправить пропущенный запуск'
                                      : 'Повторить запуск'}
                                  </span>
                                  <small>
                                    {formatDateTime(
                                      occurrence.scheduledAt,
                                      details.schedule?.timezone,
                                    )}
                                  </small>
                                </span>
                              </button>
                            ) : null}
                          </span>
                        </div>
                      );
                    })
                  ) : (
                    <span className="publication-details-empty">Отправок пока нет</span>
                  )}
                </div>
              </section>

              <section className="publication-details-section">
                <div className="publication-details-section__head">
                  <strong>Доставка</strong>
                  {details.delivery.total > 0 ? (
                    <span
                      className={cn(
                        'publication-details-section__total',
                        ambiguousDeliveries.length > 0 && 'is-danger',
                      )}
                    >
                      Отправлено {details.delivery.sent}/{details.delivery.total}
                      {ambiguousDeliveries.length > 0
                        ? ` · проверить ${Math.max(ambiguousCount, ambiguousDeliveries.length)}`
                        : ''}
                    </span>
                  ) : null}
                </div>
                {deliveries.length > 0 ? (
                  <div className="publication-deliveries">
                    {deliveries.map((delivery) => {
                      const staleContentRevision = getStaleDeliveryContentRevision(
                        delivery,
                        details.content.revision,
                      );
                      const deliveryError = formatPublicationDeliveryError(delivery.lastError);
                      const deliveryPresentation = getPublicationDeliveryPresentation(delivery);
                      return (
                        <div key={delivery.id}>
                          <EntityAvatar
                            title={delivery.target.title}
                            entityType={delivery.target.entityType}
                            avatarUrl={delivery.target.avatarUrl}
                          />
                          <span className="publication-deliveries__copy">
                            <strong>{delivery.target.title}</strong>
                            <small
                              className={cn(
                                'publication-deliveries__status',
                                `is-${delivery.status.toLowerCase()}`,
                              )}
                            >
                              {deliveryPresentation.label}
                            </small>
                            {deliveryPresentation.stopNotice ? (
                              <small>{deliveryPresentation.stopNotice}</small>
                            ) : null}
                            {deliveryPresentation.showPendingTiming && delivery.waitReason ? (
                              <small>
                                {delivery.waitReason === 'max_rate_limit'
                                  ? 'MAX ограничил частоту. Пост остаётся в очереди.'
                                  : delivery.waitReason === 'circuit_open'
                                    ? 'Ожидаем восстановления MAX. Пост остаётся в очереди.'
                                    : 'Ожидаем доступного времени отправки.'}
                              </small>
                            ) : null}
                            {deliveryPresentation.showPendingTiming && delivery.nextAttemptAt ? (
                              <small>
                                Следующая попытка не раньше{' '}
                                {formatDateTime(
                                  delivery.nextAttemptAt,
                                  details.schedule?.timezone,
                                  true,
                                )}
                              </small>
                            ) : null}
                            {deliveryPresentation.showPendingTiming && delivery.deadlineAt ? (
                              <small>
                                При задержке пост актуален до{' '}
                                {formatDateTime(delivery.deadlineAt, details.schedule?.timezone)}
                              </small>
                            ) : null}
                            {delivery.sentAt ? (
                              <small>
                                Отправлено{' '}
                                {formatDateTime(delivery.sentAt, details.schedule?.timezone)}
                              </small>
                            ) : null}
                            {publicationPostActionLabels(
                              delivery.postActions,
                              details.schedule?.timezone,
                            ).map((label) => (
                              <small key={label}>{label}</small>
                            ))}
                            {delivery.postActions?.pinError ? (
                              <small className="publication-deliveries__error">
                                {delivery.postActions.pinError}
                              </small>
                            ) : null}
                            {delivery.postActions?.deleteError ? (
                              <small className="publication-deliveries__error">
                                {delivery.postActions.deleteError}
                              </small>
                            ) : null}
                            <PublicationDeliveryActions
                              api={api}
                              publicationId={details.id}
                              delivery={delivery}
                              timezone={details.schedule?.timezone}
                              disabled={busy}
                            />
                            {staleContentRevision ? (
                              <small className="publication-deliveries__revision">
                                Прежний вариант поста
                              </small>
                            ) : null}
                            {deliveryError ? (
                              <small className="publication-deliveries__error">
                                {deliveryError}
                              </small>
                            ) : null}
                          </span>
                          {delivery.status === 'AMBIGUOUS' ? (
                            <span className="publication-delivery-resolution">
                              <button
                                type="button"
                                aria-label={`Подтвердить публикацию в ${delivery.target.title}`}
                                onClick={() =>
                                  onResolveAmbiguous(
                                    details.id,
                                    delivery.occurrenceId,
                                    delivery.id,
                                    'mark_sent',
                                  )
                                }
                                disabled={busy}
                              >
                                Опубликовано
                              </button>
                              <button
                                type="button"
                                className="is-danger"
                                aria-label={`Отметить неотправленной для ${delivery.target.title}`}
                                onClick={() =>
                                  onResolveAmbiguous(
                                    details.id,
                                    delivery.occurrenceId,
                                    delivery.id,
                                    'mark_failed',
                                  )
                                }
                                disabled={busy}
                              >
                                Не отправлено
                              </button>
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : ambiguousInitialError ? (
                  <span className="publication-details-empty">Не удалось загрузить проверку</span>
                ) : ambiguousDeliveriesQuery.isLoading ||
                  !ambiguousPhaseComplete ||
                  deliveriesQuery.isLoading ? (
                  <span className="publication-details-empty">Загрузка...</span>
                ) : ambiguousDeliveriesQuery.isError || deliveriesQuery.isError ? (
                  <span className="publication-details-empty">Детали доставки недоступны</span>
                ) : (
                  <span className="publication-details-empty">Доставок пока нет</span>
                )}
                {deliveries.length > 0 && (!ambiguousPhaseComplete || deliveriesQuery.isLoading) ? (
                  <span className="publication-details-pagination-state">Загрузка...</span>
                ) : null}
                {ambiguousInitialError ? (
                  <button
                    type="button"
                    className="publication-details-load-more"
                    onClick={() => void ambiguousDeliveriesQuery.refetch()}
                    disabled={ambiguousDeliveriesQuery.isFetching}
                  >
                    Повторить
                  </button>
                ) : ambiguousDeliveriesQuery.isFetchNextPageError ? (
                  <button
                    type="button"
                    className="publication-details-load-more"
                    onClick={() => void ambiguousDeliveriesQuery.fetchNextPage()}
                    disabled={ambiguousDeliveriesQuery.isFetchingNextPage}
                  >
                    Повторить
                  </button>
                ) : null}
                {ambiguousPhaseComplete && deliveriesQuery.hasNextPage ? (
                  <button
                    type="button"
                    className="publication-details-load-more"
                    onClick={() => void deliveriesQuery.fetchNextPage()}
                    disabled={deliveriesQuery.isFetchingNextPage}
                  >
                    {deliveriesQuery.isFetchingNextPage
                      ? 'Загрузка...'
                      : deliveriesQuery.isFetchNextPageError
                        ? 'Повторить'
                        : 'Показать ещё'}
                  </button>
                ) : ambiguousPhaseComplete && deliveriesQuery.isError && !deliveriesQuery.data ? (
                  <button
                    type="button"
                    className="publication-details-load-more"
                    onClick={() => void deliveriesQuery.refetch()}
                  >
                    Повторить
                  </button>
                ) : null}
              </section>
            </>
          ) : null}
        </div>

        <footer className="publication-details-sheet__footer">
          {allowEdit && actionCapabilities.canEdit ? (
            <button
              type="button"
              className="publications-primary"
              onClick={() => onEdit(publication.id)}
              disabled={busy}
            >
              <IconoirSprite variant="iconoir" icon="EditPencil" aria-hidden />
              <span>{editLabel}</span>
            </button>
          ) : null}
          {actionCapabilities.canCancel ? (
            <button
              type="button"
              className="publication-details-sheet__cancel"
              onClick={() => onCancel(details ?? publication)}
              disabled={busy}
            >
              <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
              <span>
                {publication.access?.canManageAllTargets === false
                  ? 'Отменить отправки'
                  : actionCapabilities.hasFutureSends
                    ? 'Отменить будущие отправки'
                    : 'Отменить публикацию'}
              </span>
            </button>
          ) : null}
          <button type="button" onClick={onClose} disabled={busy}>
            Закрыть
          </button>
        </footer>
      </section>
    </div>,
    portalTarget,
  );
}
