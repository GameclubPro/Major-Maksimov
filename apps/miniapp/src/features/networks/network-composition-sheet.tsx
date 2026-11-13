import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ManagedEntityFavoriteType,
  ManagedEntityNetworkEntry,
  ManagedEntityType,
} from '@maxim/contracts';
import type { ApiTransport } from '../../lib/api/transport';
import { useHomeEntityFavorites } from '../../lib/home-entity-favorites-context';
import { useManagedEntityNetworkCompositionDraft } from '../../lib/use-managed-entity-network-composition-draft';
import { useManagedEntityLeaveGuard } from '../../lib/managed-entity-navigation';
import { useNativeBackHandler } from '../../lib/native-back';
import { useVisualViewportOverlayStyle } from '../../lib/use-visual-viewport-overlay-style';
import { isTopmostModalDialog, useDialogFocusTrap } from '../../lib/dialog-focus';
import { ActionConfirmSheet } from '../../components/ui/action-confirm-sheet';
import { AppIcon } from '../../components/ui/app-icon';
import { EntityAvatar } from '../../components/ui/entity-avatar';
import { SegmentedControl } from '../../components/ui/segmented-control';
import { SearchField } from '../../components/ui/search-field';
import {
  HOME_ENTITY_FAVORITE_TYPES,
  getHomeEntityFavoriteTypes,
} from '../../lib/home-entity-favorites';
import { NETWORK_ENTITY_SEARCH_MAX_LENGTH, useNetworkEntries } from './network-community-list';

export function NetworkCompositionSheet({
  api,
  entityType,
  favoriteType,
  onClose,
  initialMode = 'members',
}: {
  api: ApiTransport;
  entityType: ManagedEntityType;
  favoriteType: ManagedEntityFavoriteType;
  onClose: () => void;
  initialMode?: 'members' | 'add';
}) {
  const { snapshot, actions } = useHomeEntityFavorites();
  const draft = useManagedEntityNetworkCompositionDraft({ entityType, favoriteType });
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'members' | 'add'>(initialMode);
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [discardOpen, setDiscardOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewReady, setReviewReady] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const panel = useRef<HTMLElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const stagedTitles = useRef(new Map<string, string>());
  const saving = draft.phase === 'saving';
  const overlayStyle = useVisualViewportOverlayStyle(true);
  const labels = snapshot.labels.resolved;
  const entries = useNetworkEntries({
    api,
    scopeKey: snapshot.actor.scope,
    entityType,
    favoriteType: mode === 'members' ? favoriteType : undefined,
    search,
    compositionEpoch: snapshot.byType[entityType].compositionEpoch,
  });
  const changes = useMemo(
    () => new Map(draft.changes.map((change) => [change.entityId, change])),
    [draft.changes],
  );
  const stage = (
    item: ManagedEntityNetworkEntry,
    favoriteType: ManagedEntityFavoriteType | null,
  ) => {
    stagedTitles.current.set(item.id, item.title);
    setBatchNotice(null);
    draft.stage(item, favoriteType);
  };
  const visibleEntries = entries.items.filter(
    (item) => mode === 'members' || item.favoriteType !== favoriteType,
  );
  useEffect(() => {
    // Continue past pages containing only current members, stopping at the first candidates.
    if (
      mode === 'add' &&
      !visibleEntries.length &&
      entries.nextCursor &&
      !entries.loading &&
      !entries.error
    )
      entries.loadMore();
  }, [
    mode,
    visibleEntries.length,
    entries.nextCursor,
    entries.loading,
    entries.error,
    entries.loadMore,
  ]);
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);
  useDialogFocusTrap(true, panel, closeButton);
  const requestClose = () => {
    if (saving || reviewing) return;
    if (draft.dirty) setDiscardOpen(true);
    else onClose();
  };
  const closeRequest = useRef(requestClose);
  closeRequest.current = requestClose;
  useNativeBackHandler(
    () => {
      requestClose();
      return true;
    },
    { priority: 700 },
  );
  useManagedEntityLeaveGuard({
    dirty: draft.dirty,
    saving: saving || reviewing,
    discardOnly: true,
    save: async () => false,
    discard: draft.discard,
  });
  useEffect(() => {
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && panel.current && isTopmostModalDialog(panel.current)) {
        event.preventDefault();
        closeRequest.current();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = bodyOverflow;
      window.removeEventListener('keydown', keydown);
    };
  }, []);
  const save = async () => {
    setError(null);
    try {
      const result = await draft.save();
      if (result?.refresh === 'complete' && draft.count <= 500) onClose();
      else if (result && draft.count > 500) {
        setBatchNotice(`Сохранено 500 изменений. Осталось ${draft.count - 500}.`);
        entries.refresh();
      }
    } catch {
      setError('Не удалось подтвердить сохранение. Обновите состав и проверьте изменения.');
      setReviewReady(false);
    }
  };
  const review = async () => {
    setReviewing(true);
    setReviewReady(false);
    setError(null);
    try {
      await actions.refreshCatalogue(entityType);
      await actions.refreshAssignments(entityType);
      setReviewReady(true);
    } catch {
      setError('Не удалось обновить состав. Ваши изменения остались в черновике.');
    } finally {
      setReviewing(false);
    }
  };
  const requiresReview = draft.phase === 'review-required' || draft.compositionChanged;
  const readOnly =
    saving ||
    reviewing ||
    requiresReview ||
    entries.accessDenied ||
    draft.phase === 'saved-refresh-pending';
  useEffect(() => {
    if (requiresReview || error || draft.phase === 'saved-refresh-pending')
      body.current?.scrollTo({ top: 0 });
  }, [requiresReview, error, draft.phase]);
  return createPortal(
    <>
      <div className="network-composition-overlay" style={overlayStyle}>
        <button
          type="button"
          className="network-composition-backdrop"
          aria-label="Закрыть состав сетки"
          tabIndex={-1}
          disabled={saving}
          onClick={requestClose}
        />
        <section
          className="network-composition-sheet"
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby="network-composition-title"
          tabIndex={-1}
        >
          <header>
            <div>
              <small>{entityType === 'chat' ? 'Сетка чатов' : 'Сетка каналов'}</small>
              <h2 id="network-composition-title">{labels[favoriteType]}</h2>
            </div>
            <button
              ref={closeButton}
              type="button"
              className="networks-icon-button"
              aria-label="Закрыть"
              disabled={saving}
              onClick={requestClose}
            >
              <AppIcon icon="Xmark" />
            </button>
          </header>
          <div className="network-composition-sheet__body" ref={body}>
            <SegmentedControl
              value={mode}
              options={[
                { value: 'members', label: 'В сетке' },
                { value: 'add', label: 'Добавить' },
              ]}
              onChange={(value) => {
                setMode(value);
                setQuery('');
                setSearch('');
              }}
              ariaLabel="Редактирование состава"
            />
            <SearchField
              className="network-search-field"
              value={query}
              onChange={setQuery}
              placeholder="Найти сообщество"
              label="Поиск сообществ"
              inputProps={{ maxLength: NETWORK_ENTITY_SEARCH_MAX_LENGTH }}
            />
            {error ? (
              <p className="networks-notice" role="alert">
                {error}
              </p>
            ) : null}
            {batchNotice ? <p role="status">{batchNotice}</p> : null}
            {draft.count > 500 ? (
              <p>
                Изменения сохраняются пакетами по 500. Остальной выбор сохранится для следующего
                пакета.
              </p>
            ) : null}
            {draft.phase === 'saved-refresh-pending' ? (
              <div className="networks-notice" role="status">
                <p>Состав сохранён. Обновите список.</p>
                <button
                  type="button"
                  onClick={() =>
                    void actions
                      .refreshAssignments(entityType)
                      .then(() => actions.refreshCatalogue(entityType))
                      .then(() => {
                        if (!draft.count) onClose();
                        else entries.refresh();
                      })
                      .catch(() => setError('Состав сохранён, но список пока не обновился.'))
                  }
                >
                  Обновить
                </button>
              </div>
            ) : null}
            {requiresReview ? (
              <div className="networks-notice" role="alert">
                <strong>Состав изменился</strong>
                <p>Обновите состав и проверьте свои изменения перед сохранением.</p>
                <button type="button" disabled={reviewing || saving} onClick={() => void review()}>
                  {reviewing ? 'Обновляем…' : 'Обновить состав'}
                </button>
                {reviewReady ? (
                  <>
                    <ul className="network-composition-review">
                      {draft.changes.map((change) => (
                        <li key={change.entityId}>
                          <strong>
                            {entries.items.find((item) => item.id === change.entityId)?.title ??
                              stagedTitles.current.get(change.entityId) ??
                              'Сообщество'}
                          </strong>
                          <span>
                            Сейчас:{' '}
                            {(() => {
                              const current = getHomeEntityFavoriteTypes(
                                snapshot.assignments,
                                entityType,
                                change.entityId,
                              )[0];
                              return current ? labels[current] : 'Не в избранном';
                            })()}{' '}
                            → {change.favoriteType ? labels[change.favoriteType] : 'Не в избранном'}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      onClick={() => {
                        try {
                          draft.rebaseAfterReview();
                          setReviewReady(false);
                          setError(null);
                        } catch {
                          setReviewReady(false);
                          setError(
                            'Состав снова изменился. Обновите его и проверьте изменения ещё раз.',
                          );
                        }
                      }}
                    >
                      Подтвердить изменения
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
            {visibleEntries.map((item) => {
              const change = changes.get(item.id);
              const value = change ? change.favoriteType : item.favoriteType;
              return (
                <div className="network-community-row network-composition-row" key={item.id}>
                  <label className="network-composition-check">
                    <input
                      type="checkbox"
                      aria-label={`${mode === 'members' ? 'Оставить' : 'Добавить'} ${item.title}`}
                      checked={value === favoriteType}
                      disabled={readOnly}
                      onChange={(event) => {
                        setError(null);
                        stage(
                          item,
                          event.target.checked
                            ? favoriteType
                            : mode === 'add'
                              ? item.favoriteType
                              : null,
                        );
                      }}
                    />
                  </label>
                  <EntityAvatar
                    title={item.title}
                    entityId={item.id}
                    entityType={item.entityType}
                    avatarUrl={item.avatarUrl}
                  />
                  <span className="network-community-row__text">
                    <strong>{item.title}</strong>
                    {change || mode === 'add' ? (
                      <small>
                        {change
                          ? change.favoriteType === favoriteType
                            ? item.favoriteType
                              ? `Перенести из «${labels[item.favoriteType]}»`
                              : 'Добавить в сетку'
                            : change.favoriteType
                              ? `Перенести в «${labels[change.favoriteType]}»`
                              : 'Убрать из сетки'
                          : item.favoriteType
                            ? labels[item.favoriteType]
                            : 'Не в избранном'}
                      </small>
                    ) : null}
                    {mode === 'members' ? (
                      <select
                        aria-label={`Категория: ${item.title}`}
                        value={value && value !== favoriteType ? value : ''}
                        disabled={readOnly}
                        onChange={(event) => {
                          setError(null);
                          stage(
                            item,
                            (event.target.value || null) as ManagedEntityFavoriteType | null,
                          );
                        }}
                      >
                        <option value="" disabled>
                          Перенести в другую сетку
                        </option>
                        {HOME_ENTITY_FAVORITE_TYPES.filter((type) => type !== favoriteType).map(
                          (type) => (
                            <option key={type} value={type}>
                              {labels[type]}
                            </option>
                          ),
                        )}
                      </select>
                    ) : null}
                  </span>
                </div>
              );
            })}
            {entries.loading ? <p role="status">Загружаем…</p> : null}
            {!entries.loading &&
            !entries.error &&
            !entries.nextCursor &&
            visibleEntries.length === 0 ? (
              <p className="networks-caption">
                {entries.items.length
                  ? 'Все найденные сообщества уже в этой сетке.'
                  : 'Сообщества не найдены.'}
              </p>
            ) : null}
            {entries.error ? (
              <div role="alert" className="networks-notice">
                <p>{entries.error}</p>
                <button type="button" onClick={entries.refresh}>
                  Обновить список
                </button>
              </div>
            ) : null}
            {entries.nextCursor && !entries.loading && !entries.error ? (
              <button type="button" className="networks-more" onClick={entries.loadMore}>
                Показать ещё
              </button>
            ) : null}
          </div>
          <footer>
            <span aria-live="polite">
              {draft.count
                ? [
                    [
                      'Добавить',
                      draft.changes.filter(
                        (change) =>
                          !change.expectedFavoriteType && change.favoriteType === favoriteType,
                      ).length,
                    ],
                    [
                      'Убрать',
                      draft.changes.filter((change) => change.favoriteType === null).length,
                    ],
                    [
                      'Перенести',
                      draft.changes.filter(
                        (change) =>
                          change.expectedFavoriteType &&
                          change.favoriteType &&
                          change.expectedFavoriteType !== change.favoriteType,
                      ).length,
                    ],
                  ]
                    .filter(([, count]) => count)
                    .map(([label, count]) => `${label} ${count}`)
                    .join(' · ')
                : null}
            </span>
            <button
              type="button"
              className="networks-primary"
              disabled={
                !draft.dirty ||
                saving ||
                reviewing ||
                requiresReview ||
                draft.phase === 'saved-refresh-pending' ||
                entries.accessDenied
              }
              onClick={() => void save()}
            >
              {saving
                ? 'Сохраняем…'
                : draft.count > 500
                  ? 'Сохранить первые 500'
                  : 'Сохранить состав'}
            </button>
          </footer>
        </section>
      </div>
      <ActionConfirmSheet
        id="network-composition-discard"
        open={discardOpen}
        title="Сбросить изменения состава?"
        summary="Сохранённый состав останется прежним."
        confirmLabel="Сбросить и закрыть"
        cancelLabel="Продолжить редактирование"
        onClose={() => setDiscardOpen(false)}
        onConfirm={() => {
          draft.discard();
          onClose();
        }}
      />
    </>,
    document.querySelector('.design-preview__device-screen') ?? document.body,
  );
}
