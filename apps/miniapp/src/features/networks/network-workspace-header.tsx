import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { ManagedEntityFavoriteType, ManagedEntityType } from '@maxim/contracts';
import { CompactStickyHeader } from '../../components/ui/compact-sticky-header';
import { useHomeEntityFavorites } from '../../lib/home-entity-favorites-context';
import {
  HOME_ENTITY_FAVORITE_LABEL_MAX_LENGTH,
  HOME_ENTITY_FAVORITE_TYPES,
} from '../../lib/home-entity-favorites';
import { useNativeBackHandler } from '../../lib/native-back';
import { useAutoHideHeader } from '../../lib/use-auto-hide-header';
import { formatNetworkEntityCount, NetworkCategoryIcon } from './network-identity';
import '../../components/ui/managed-entity-workspace-tokens.css';
import '../../components/ui/managed-entity-settings-header.css';
import './network-workspace.css';

export type NetworkWorkspaceTab = 'overview' | 'settings' | 'communities';
export function NetworkWorkspaceTabs({
  value,
  onChange,
  settingsDisabled = false,
}: {
  value: NetworkWorkspaceTab;
  onChange: (tab: NetworkWorkspaceTab) => void;
  settingsDisabled?: boolean;
}) {
  return (
    <nav className="network-workspace-tabs" aria-label="Раздел сетки">
      {(
        [
          ['overview', 'Статистика'],
          ['settings', 'Настройки'],
          ['communities', 'Состав'],
        ] as const
      ).map(([tab, label]) => (
        <button
          type="button"
          key={tab}
          aria-current={value === tab ? 'page' : undefined}
          disabled={tab === 'settings' && settingsDisabled}
          onClick={() => onChange(tab)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
type NetworkWorkspaceHeaderProps = {
  entityType: ManagedEntityType;
  favoriteType?: ManagedEntityFavoriteType;
  count?: number;
  title: string;
  onBack: () => void;
  onPick: (type: ManagedEntityType, category: ManagedEntityFavoriteType) => void;
  backLabel?: string;
};

export function NetworkWorkspaceHeader(props: NetworkWorkspaceHeaderProps) {
  return (
    <NetworkWorkspaceIdentity
      key={`${props.entityType}:${props.favoriteType ?? 'selected'}`}
      {...props}
    />
  );
}

function NetworkWorkspaceIdentity({
  entityType,
  favoriteType,
  count,
  title,
  onBack,
  onPick,
  backLabel = 'Все сетки',
}: NetworkWorkspaceHeaderProps) {
  const navigate = useNavigate();
  const { snapshot, actions } = useHomeEntityFavorites();
  const [rename, setRename] = useState<{
    favoriteType: ManagedEntityFavoriteType;
    value: string;
    base: typeof snapshot.labels.overrides;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const menuButton = useRef<HTMLElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const renaming = rename !== null;
  useEffect(() => {
    if (renaming) renameInput.current?.focus();
  }, [renaming]);
  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setMenuOpen(false);
      menuButton.current?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);
  const { isCompact } = useAutoHideHeader();
  useNativeBackHandler(
    () => {
      if (!busy) setRename(null);
      return true;
    },
    { enabled: rename !== null, priority: 150 },
  );
  useNativeBackHandler(
    () => {
      setMenuOpen(false);
      return true;
    },
    { enabled: menuOpen, priority: 140 },
  );
  const label = favoriteType ? snapshot.labels.resolved[favoriteType] : title;
  const saveName = async () => {
    if (!rename || busy || !rename.value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await actions.saveLabels({
        baseLabels: rename.base,
        draftLabels: { ...rename.base, [rename.favoriteType]: rename.value.trim() },
      });
      setRename(null);
    } catch {
      setError('Название не сохранено. Проверьте актуальное имя и повторите.');
    } finally {
      setBusy(false);
    }
  };
  const pick = (type: ManagedEntityType, category: ManagedEntityFavoriteType) => {
    setMenuOpen(false);
    setRename(null);
    setError(null);
    onPick(type, category);
  };
  return (
    <div
      className={`network-workspace-identity${rename ? ' network-workspace-identity--renaming' : ''}`}
    >
      <CompactStickyHeader
        backTo={`/networks?type=${entityType}`}
        backLabel={backLabel}
        onBack={onBack}
        title={label}
        subtitle={
          count === undefined
            ? entityType === 'chat'
              ? 'Сетка чатов'
              : 'Сетка каналов'
            : formatNetworkEntityCount(count, entityType)
        }
        avatar={
          <span
            className="network-workspace-icon compact-page-header__entity-avatar"
            data-network-category={favoriteType}
            aria-hidden
          >
            <NetworkCategoryIcon favoriteType={favoriteType} />
          </span>
        }
        compact={isCompact}
        className="managed-entity-workspace-header managed-entity-workspace-header--settings network-workspace-heading"
        aside={
          favoriteType ? (
            <details
              ref={menu}
              className="network-workspace-menu"
              open={menuOpen}
              onToggle={(event) => setMenuOpen(event.currentTarget.open)}
            >
              <summary
                ref={menuButton}
                aria-label="Выбрать сетку и действия"
                aria-expanded={menuOpen}
                aria-disabled={busy || undefined}
                onClick={(event) => {
                  event.preventDefault();
                  if (!busy) setMenuOpen((open) => !open);
                }}
              >
                <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden focusable="false">
                  <circle cx="5" cy="12" r="1.8" fill="currentColor" />
                  <circle cx="12" cy="12" r="1.8" fill="currentColor" />
                  <circle cx="19" cy="12" r="1.8" fill="currentColor" />
                </svg>
              </summary>
              <div>
                <label>
                  Тип{' '}
                  <select
                    aria-label="Тип сетки"
                    value={entityType}
                    onChange={(event) =>
                      pick(event.target.value as ManagedEntityType, favoriteType)
                    }
                  >
                    <option value="chat">Чаты</option>
                    <option value="channel">Каналы</option>
                  </select>
                </label>
                <label>
                  Сетка{' '}
                  <select
                    aria-label="Переключить сетку"
                    value={favoriteType}
                    onChange={(event) =>
                      pick(entityType, event.target.value as ManagedEntityFavoriteType)
                    }
                  >
                    {HOME_ENTITY_FAVORITE_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {snapshot.labels.resolved[type]}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setError(null);
                    setRename({
                      favoriteType,
                      value: label,
                      base: { ...snapshot.labels.overrides },
                    });
                  }}
                >
                  Переименовать
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    navigate(`/networks?type=${entityType}&history=1`);
                  }}
                >
                  Последние изменения
                </button>
              </div>
            </details>
          ) : null
        }
      />
      {rename ? (
        <form
          className="network-rename"
          onSubmit={(event) => {
            event.preventDefault();
            void saveName();
          }}
        >
          <label>
            Название сетки
            <input
              aria-label="Название сетки"
              ref={renameInput}
              maxLength={HOME_ENTITY_FAVORITE_LABEL_MAX_LENGTH}
              disabled={busy}
              value={rename.value}
              onChange={(event) => setRename({ ...rename, value: event.target.value })}
            />
          </label>
          <p>Название изменится и у чатов, и у каналов.</p>
          {error ? <p role="alert">{error}</p> : null}
          <div>
            <button type="submit" disabled={busy || !rename.value.trim()}>
              {busy ? 'Сохраняем…' : 'Сохранить название'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setRename(null);
                menuButton.current?.focus();
              }}
            >
              Отмена
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
