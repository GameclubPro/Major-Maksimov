import { AppIcon as IconoirSprite } from '../components/ui/app-icon';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type SVGProps,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  ChatSummary,
  ManagedEntityFavoriteLabelsResponse,
  ManagedEntityFavoriteType,
} from '@maxim/contracts';

import { AppIcon } from '../components/ui/app-icon';
import {
  FilterGlyph,
  HOME_ENTITY_FAVORITE_ICONS,
  SendGlyph,
  SettingsGlyph,
  XmarkGlyph,
} from '../components/ui/compact-icons';
import { useToast } from '../components/ui/toast';
import { describeApiError } from '../lib/api-error';
import { getCachedBotDialogUrl, getMe } from '../lib/api/me-client';
import type { ApiTransport } from '../lib/api/transport';
import { createBotDialogHandoffCoordinator } from '../lib/bot-dialog-handoff';
import { cn } from '../lib/cn';
import { useDialogFocusTrap } from '../lib/dialog-focus';
import {
  HOME_ENTITY_FAVORITE_LABEL_MAX_LENGTH,
  HOME_ENTITY_FAVORITE_LABELS,
  HOME_ENTITY_FAVORITE_TYPES,
  resolveHomeEntityFavoriteLabels,
  sanitizeHomeEntityFavoriteLabels,
  type HomeEntityFavoriteLabelOverrides,
} from '../lib/home-entity-favorites';
import {
  FavoriteLabelConflictError,
  FavoriteLabelDuplicateError,
} from '../lib/home-entity-favorites-types';
import { useHomeEntityFavorites } from '../lib/home-entity-favorites-context';
import { openMaxBotLinkAndClose } from '../lib/max-bridge';
import { useNativeBackHandler } from '../lib/native-back';
import { useVisualViewportOverlayStyle } from '../lib/use-visual-viewport-overlay-style';

type ManagedTab = 'chat' | 'channel';
type SheetTarget = {
  entityType: ManagedTab;
  entity: ChatSummary;
};
type FavoriteLabelDraft = Record<ManagedEntityFavoriteType, string>;
type FavoriteFilter = ManagedEntityFavoriteType | 'all';

type HomeEntitySheetsProps = {
  api: ApiTransport;
  connectOpen: boolean;
  favoriteTarget: SheetTarget | null;
  filterPickerOpen: boolean;
  filterValue: FavoriteFilter;
  labelsEditorOpen: boolean;
  favoriteLabels: FavoriteLabelDraft;
  favoriteLabelOverrides: HomeEntityFavoriteLabelOverrides;
  favoriteStorageScope: string;
  favoriteCounts: Record<ManagedEntityFavoriteType, number>;
  selectedFavoriteType: ManagedEntityFavoriteType | null;
  favoriteSaving: boolean;
  membership: { from: ManagedEntityFavoriteType; target: ManagedEntityFavoriteType } | null;
  favoriteLabelsStatus: 'loading' | 'ready' | 'api' | 'chunk';
  onClose: () => void;
  onFilterChange: (filter: FavoriteFilter) => void;
  onStartCategoryEdit: () => void;
  onOpenLabelsEditor: () => void;
  onFavoriteChange: (favoriteType: ManagedEntityFavoriteType | null) => void;
  onFavoriteLabelsSaved: (response: ManagedEntityFavoriteLabelsResponse) => void;
};

function CheckGlyph(props: SVGProps<SVGSVGElement>) {
  return <AppIcon icon="Check" {...props} />;
}

function HomeSheet({
  sheetKey,
  title,
  subtitle,
  panelClassName,
  overlayStyle,
  onClose,
  children,
}: {
  sheetKey: string;
  title: string;
  subtitle?: string;
  panelClassName?: string;
  overlayStyle: CSSProperties | undefined;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  useDialogFocusTrap(true, panelRef, panelRef);
  const titleId = `home-sheet-${sheetKey}-title`;
  const subtitleId = subtitle ? `home-sheet-${sheetKey}-subtitle` : undefined;
  const sheet = (
    <div className={cn('favorite-picker', `home-sheet--${sheetKey}`)} style={overlayStyle}>
      <button
        type="button"
        className="favorite-picker__backdrop"
        aria-label="Закрыть"
        onClick={onClose}
        tabIndex={-1}
      />
      <section
        ref={panelRef}
        id={`home-sheet-${sheetKey}`}
        className={cn('favorite-picker__panel', panelClassName)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        tabIndex={-1}
      >
        <div className="favorite-picker__header">
          <div>
            <strong id={titleId}>{title}</strong>
            {subtitle ? <span id={subtitleId}>{subtitle}</span> : null}
          </div>
          <button
            type="button"
            className="favorite-picker__close"
            aria-label="Закрыть"
            title="Закрыть"
            onClick={onClose}
          >
            <XmarkGlyph aria-hidden />
          </button>
        </div>
        {children}
      </section>
    </div>
  );

  if (typeof document === 'undefined') {
    return sheet;
  }
  return createPortal(
    sheet,
    document.querySelector('.design-preview__device-screen') ?? document.body,
  );
}

function HomeConnectSheet({
  api,
  overlayStyle,
  onClose,
}: {
  api: ApiTransport;
  overlayStyle: CSSProperties | undefined;
  onClose: () => void;
}) {
  const { pushToast } = useToast();
  const [coordinator] = useState(createBotDialogHandoffCoordinator);
  const [pending, setPending] = useState(false);
  const botDialogUrlRef = useRef(getCachedBotDialogUrl(api));

  useEffect(() => {
    const cachedUrl = getCachedBotDialogUrl(api);
    if (cachedUrl) {
      botDialogUrlRef.current = cachedUrl;
      return undefined;
    }

    const controller = new AbortController();

    void getMe(api, { signal: controller.signal })
      .then((me) => {
        if (!controller.signal.aborted) {
          botDialogUrlRef.current = me.botDialogUrl;
        }
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, [api]);

  useEffect(
    () => () => {
      coordinator.cancel();
    },
    [coordinator],
  );

  function closeSheet() {
    coordinator.cancel();
    setPending(false);
    onClose();
  }

  async function returnToBot() {
    setPending(true);
    const outcome = await coordinator.run(async (signal) => {
      const cachedUrl = botDialogUrlRef.current ?? getCachedBotDialogUrl(api);
      if (cachedUrl) {
        botDialogUrlRef.current = cachedUrl;
        return cachedUrl;
      }
      const me = await getMe(api, { signal });
      if (signal.aborted) {
        return null;
      }
      botDialogUrlRef.current = me.botDialogUrl;
      return me.botDialogUrl;
    }, openMaxBotLinkAndClose);

    if (outcome === 'busy' || outcome === 'opened') {
      return;
    }

    setPending(false);
    if (outcome === 'failed') {
      pushToast({
        title: 'Не удалось открыть диалог',
        description: 'Попробуйте ещё раз.',
        tone: 'danger',
      });
    }
  }

  return (
    <HomeSheet
      sheetKey="connect"
      title="Подключить чат или канал"
      panelClassName="home-connect__panel"
      overlayStyle={overlayStyle}
      onClose={closeSheet}
    >
      <ol className="home-connect__steps" role="list">
        <li>
          <span aria-label="Шаг 1">1</span>
          <div>
            <strong>Добавьте бота в администраторы</strong>
            <small>Включите доступ ко всем сообщениям.</small>
          </div>
        </li>
        <li>
          <span aria-label="Шаг 2">2</span>
          <div>
            <strong>Перешлите боту любое сообщение или пост</strong>
            <small>Из нужного чата или канала в личный диалог с ботом.</small>
          </div>
        </li>
      </ol>
      <div className="home-connect__handoff">
        <p>Бот проверит права и добавит чат или канал.</p>
        <button
          type="button"
          className="button button--accent"
          onClick={() => void returnToBot()}
          disabled={pending}
        >
          <SendGlyph aria-hidden focusable="false" />
          {pending ? 'Открываем...' : 'Открыть диалог с ботом'}
        </button>
      </div>
    </HomeSheet>
  );
}

function createFavoriteLabelDraft(labels: HomeEntityFavoriteLabelOverrides): FavoriteLabelDraft {
  return resolveHomeEntityFavoriteLabels(labels);
}

function limitFavoriteLabelInput(value: string): string {
  return Array.from(value.split('\u0000').join(''))
    .slice(0, HOME_ENTITY_FAVORITE_LABEL_MAX_LENGTH)
    .join('');
}

function HomeFavoriteLabelsEditor({
  favoriteLabelOverrides,
  overlayStyle,
  onClose,
  onSaved,
}: {
  favoriteLabelOverrides: HomeEntityFavoriteLabelOverrides;
  overlayStyle: CSSProperties | undefined;
  onClose: () => void;
  onSaved: (response: ManagedEntityFavoriteLabelsResponse) => void;
}) {
  const { actions } = useHomeEntityFavorites();
  const { pushToast } = useToast();
  const baseLabelsRef = useRef(sanitizeHomeEntityFavoriteLabels(favoriteLabelOverrides));
  const saveControllerRef = useRef<AbortController | null>(null);
  const [draft, setDraft] = useState<FavoriteLabelDraft>(() =>
    createFavoriteLabelDraft(baseLabelsRef.current),
  );
  const [saving, setSaving] = useState(false);
  const sanitizedDraft = sanitizeHomeEntityFavoriteLabels(draft);
  const canSave = JSON.stringify(sanitizedDraft) !== JSON.stringify(baseLabelsRef.current);

  useEffect(
    () => () => {
      saveControllerRef.current?.abort();
      saveControllerRef.current = null;
    },
    [],
  );

  useNativeBackHandler(
    () => {
      if (!saving) {
        onClose();
      }
      return true;
    },
    { priority: 660 },
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!saving) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, saving]);

  function updateDraft(favoriteType: ManagedEntityFavoriteType, value: string) {
    setDraft((current) => ({
      ...current,
      [favoriteType]: limitFavoriteLabelInput(value),
    }));
  }

  function resetDraft(favoriteType: ManagedEntityFavoriteType) {
    setDraft((current) => ({
      ...current,
      [favoriteType]: HOME_ENTITY_FAVORITE_LABELS[favoriteType],
    }));
  }

  async function saveDraft() {
    if (saving || !canSave) {
      return;
    }

    const controller = new AbortController();
    saveControllerRef.current?.abort();
    saveControllerRef.current = controller;
    setSaving(true);

    try {
      const saved = await actions.saveLabels({
        baseLabels: baseLabelsRef.current,
        draftLabels: sanitizedDraft,
      });
      if (!controller.signal.aborted && saveControllerRef.current === controller) {
        onSaved(saved);
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted && saveControllerRef.current === controller) {
        pushToast({
          title: 'Не удалось сохранить названия',
          description:
            error instanceof FavoriteLabelDuplicateError ||
            error instanceof FavoriteLabelConflictError
              ? error.message
              : describeApiError(error, 'Проверьте соединение и попробуйте ещё раз.'),
          tone: 'danger',
        });
      }
    } finally {
      if (saveControllerRef.current === controller) {
        saveControllerRef.current = null;
        setSaving(false);
      }
    }
  }

  return (
    <HomeSheet
      sheetKey="labels"
      title="Названия категорий"
      panelClassName="favorite-label-editor__panel"
      overlayStyle={overlayStyle}
      onClose={saving ? () => undefined : onClose}
    >
      <div className="favorite-label-editor__list">
        {HOME_ENTITY_FAVORITE_TYPES.map((favoriteType) => {
          const FavoriteIcon = HOME_ENTITY_FAVORITE_ICONS[favoriteType];
          const defaultLabel = HOME_ENTITY_FAVORITE_LABELS[favoriteType];
          const canReset = draft[favoriteType] !== defaultLabel;
          return (
            <div
              key={favoriteType}
              className={cn('favorite-label-editor__row', canReset && 'has-reset')}
            >
              <span className={cn('favorite-label-editor__icon', `is-${favoriteType}`)}>
                <FavoriteIcon aria-hidden />
              </span>
              <label className="favorite-label-editor__field">
                <span className="favorite-picker__sr">Название категории: {defaultLabel}</span>
                <IconoirSprite variant="iconoir" icon="EditPencil" aria-hidden />
                <input
                  type="text"
                  inputMode="text"
                  value={draft[favoriteType]}
                  aria-label={`Название категории: ${defaultLabel}`}
                  disabled={saving}
                  onChange={(event) => updateDraft(favoriteType, event.currentTarget.value)}
                />
              </label>
              <button
                type="button"
                className="favorite-label-editor__reset"
                aria-label={`Вернуть стандартное название: ${defaultLabel}`}
                title="Вернуть стандартное название"
                disabled={saving || !canReset}
                onClick={() => resetDraft(favoriteType)}
              >
                <IconoirSprite variant="iconoir" icon="Undo" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
      <div className="favorite-label-editor__actions">
        <button type="button" className="button button--ghost" onClick={onClose} disabled={saving}>
          Отмена
        </button>
        <button
          type="button"
          className="button button--accent"
          onClick={() => void saveDraft()}
          disabled={saving || !canSave}
          aria-busy={saving || undefined}
        >
          {saving ? 'Сохраняем...' : 'Сохранить'}
        </button>
      </div>
    </HomeSheet>
  );
}

export default function HomeEntitySheets(props: HomeEntitySheetsProps) {
  const overlayStyle = useVisualViewportOverlayStyle(true);

  if (props.connectOpen) {
    return (
      <HomeConnectSheet
        key="connect"
        api={props.api}
        overlayStyle={overlayStyle}
        onClose={props.onClose}
      />
    );
  }

  if (props.labelsEditorOpen) {
    return (
      <HomeFavoriteLabelsEditor
        key={`${props.favoriteStorageScope}:labels`}
        favoriteLabelOverrides={props.favoriteLabelOverrides}
        overlayStyle={overlayStyle}
        onClose={props.onClose}
        onSaved={props.onFavoriteLabelsSaved}
      />
    );
  }

  if (props.favoriteTarget && props.membership) {
    const { from, target } = props.membership;
    const remove = from === target;
    return (
      <HomeSheet
        sheetKey="membership"
        title={
          remove
            ? `Убрать из «${props.favoriteLabels[target]}»?`
            : `Перенести в «${props.favoriteLabels[target]}»?`
        }
        subtitle={
          remove
            ? props.favoriteTarget.entity.title
            : `${props.favoriteTarget.entity.title} · сейчас в «${props.favoriteLabels[from]}»`
        }
        overlayStyle={overlayStyle}
        onClose={props.onClose}
      >
        <div className="favorite-label-editor__actions">
          <button
            type="button"
            className="button button--ghost"
            disabled={props.favoriteSaving}
            onClick={props.onClose}
          >
            Отмена
          </button>
          <button
            type="button"
            className="button button--accent"
            disabled={props.favoriteSaving}
            aria-busy={props.favoriteSaving}
            onClick={() => props.onFavoriteChange(remove ? null : target)}
          >
            {props.favoriteSaving ? 'Сохраняем…' : remove ? 'Убрать' : 'Перенести'}
          </button>
        </div>
      </HomeSheet>
    );
  }

  if (props.favoriteTarget) {
    return (
      <HomeSheet
        key="favorite"
        sheetKey="favorite"
        title={props.selectedFavoriteType ? 'Избранное' : 'Добавить в избранное'}
        subtitle={props.favoriteTarget.entity.title}
        overlayStyle={overlayStyle}
        onClose={props.onClose}
      >
        {props.favoriteSaving ? (
          <p className="favorite-picker__saving" role="status">
            Сохраняем категорию… Подождите перед следующим изменением.
          </p>
        ) : null}
        <fieldset className="favorite-picker__fieldset" disabled={props.favoriteSaving}>
          <legend className="favorite-picker__sr">Выберите категорию избранного</legend>
          <div className="favorite-picker__grid" aria-busy={props.favoriteSaving || undefined}>
            {HOME_ENTITY_FAVORITE_TYPES.map((favoriteType) => {
              const FavoriteIcon = HOME_ENTITY_FAVORITE_ICONS[favoriteType];
              const active = props.selectedFavoriteType === favoriteType;
              return (
                <label
                  key={favoriteType}
                  className={cn(
                    'favorite-picker__option',
                    `is-${favoriteType}`,
                    active && 'is-active',
                  )}
                >
                  <input
                    className="favorite-picker__radio"
                    type="radio"
                    name="home-entity-category"
                    value={favoriteType}
                    checked={active}
                    onChange={() => props.onFavoriteChange(favoriteType)}
                  />
                  <span className="favorite-picker__icon">
                    <FavoriteIcon aria-hidden />
                  </span>
                  <strong>{props.favoriteLabels[favoriteType]}</strong>
                  {active ? <CheckGlyph aria-hidden className="favorite-picker__check" /> : null}
                </label>
              );
            })}
            {props.selectedFavoriteType ? (
              <button
                type="button"
                className="favorite-picker__option favorite-picker__remove"
                onClick={() => props.onFavoriteChange(null)}
              >
                <span className="favorite-picker__icon">
                  <XmarkGlyph aria-hidden />
                </span>
                <strong>Убрать из избранного</strong>
              </button>
            ) : null}
          </div>
        </fieldset>
      </HomeSheet>
    );
  }

  if (props.filterPickerOpen) {
    return (
      <HomeSheet
        key="filter"
        sheetKey="filter"
        title="Фильтр категорий"
        panelClassName="home-filter__panel"
        overlayStyle={overlayStyle}
        onClose={props.onClose}
      >
        <fieldset className="favorite-picker__fieldset">
          <legend className="favorite-picker__sr">Категория</legend>
          <div className="favorite-picker__grid home-filter__grid">
            <label
              className={cn(
                'favorite-picker__option home-filter__item',
                props.filterValue === 'all' && 'is-active',
              )}
            >
              <input
                className="favorite-picker__radio"
                type="radio"
                name="home-category-filter"
                value="all"
                checked={props.filterValue === 'all'}
                onChange={() => props.onFilterChange('all')}
              />
              <span className="favorite-picker__icon">
                <FilterGlyph aria-hidden focusable="false" />
              </span>
              <strong>Все</strong>
              {props.filterValue === 'all' ? (
                <CheckGlyph aria-hidden className="favorite-picker__check" />
              ) : null}
            </label>
            {HOME_ENTITY_FAVORITE_TYPES.filter(
              (favoriteType) =>
                props.favoriteCounts[favoriteType] > 0 || props.filterValue === favoriteType,
            ).map((favoriteType) => {
              const FavoriteIcon = HOME_ENTITY_FAVORITE_ICONS[favoriteType];
              const count = props.favoriteCounts[favoriteType];
              const active = props.filterValue === favoriteType;
              return (
                <label
                  key={favoriteType}
                  className={cn(
                    'favorite-picker__option',
                    'home-filter__item',
                    `is-${favoriteType}`,
                    active && 'is-active',
                  )}
                >
                  <input
                    className="favorite-picker__radio"
                    type="radio"
                    name="home-category-filter"
                    value={favoriteType}
                    checked={active}
                    onChange={() => props.onFilterChange(favoriteType)}
                  />
                  <span className="favorite-picker__icon">
                    <FavoriteIcon aria-hidden />
                  </span>
                  <strong>{props.favoriteLabels[favoriteType]}</strong>
                  <small>{count}</small>
                  {active ? <CheckGlyph aria-hidden className="favorite-picker__check" /> : null}
                </label>
              );
            })}
          </div>
        </fieldset>
        <section className="home-filter__management" aria-labelledby="home-filter-management-title">
          <p id="home-filter-management-title" className="home-filter__management-title">
            Управление
          </p>
          <div className="home-filter__commands" role="group">
            <button
              type="button"
              className="favorite-picker__option home-filter__manage"
              onClick={props.onStartCategoryEdit}
            >
              <span className="favorite-picker__icon">
                <FilterGlyph aria-hidden focusable="false" />
              </span>
              <strong>Распределить по категориям</strong>
            </button>
            <button
              type="button"
              className="favorite-picker__option home-filter__manage"
              onClick={props.onOpenLabelsEditor}
              disabled={props.favoriteLabelsStatus === 'loading'}
            >
              <span className="favorite-picker__icon">
                <SettingsGlyph aria-hidden focusable="false" />
              </span>
              <strong>
                {props.favoriteLabelsStatus === 'api' || props.favoriteLabelsStatus === 'chunk'
                  ? 'Повторить загрузку названий'
                  : 'Настроить названия'}
              </strong>
            </button>
          </div>
        </section>
      </HomeSheet>
    );
  }

  return null;
}
