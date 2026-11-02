import { AppIcon as IconoirSprite } from '../ui/app-icon';
import type {
  ChatParticipantDetails,
  ChatParticipantItem,
  ChatSanctionsPage,
} from '@maxim/contracts';

import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from 'react';
import { useNativeBackHandler } from '../../lib/native-back';
import { isTopmostModalDialog } from '../../lib/dialog-focus';
import { PersonAvatar } from '../ui/person-avatar';
import { SettingsDrilldownPanel } from '../ui/settings-drilldown-panel';
import { ActionConfirmSheet } from '../ui/action-confirm-sheet';
import { participantCapabilities, type ParticipantCardTarget } from '../../lib/participant-card';
import './chat-participant-sheet.css';
import './chat-participant-sheet-controls.css';
import './chat-participant-sheet-theme.css';
import './chat-participant-card.css';

type ParticipantView = ChatParticipantItem | ChatParticipantDetails;

const MUTE_DURATION_MIN_HOURS = 1;
const MUTE_DURATION_MAX_HOURS = 336;
const MUTE_DURATION_PRESETS = [1, 6, 24, 72, 168] as const;
const IMMUNITY_DURATION_MIN_DAYS = 1;
const IMMUNITY_DURATION_MAX_DAYS = 30;
const IMMUNITY_DAILY_LIMIT_MIN = 1;
const IMMUNITY_DAILY_LIMIT_MAX = 10;
const MUTE_COMPOSER_ID = 'participant-sheet-mute-composer';
const IMMUNITY_COMPOSER_ID = 'participant-sheet-immunity-composer';

type ImmunityMode = 'limited' | 'always';
type ParticipantHintKey = 'mute' | 'immunity' | 'duration' | 'limit';
type ChatParticipantImmunityView = Omit<
  NonNullable<ChatParticipantItem['immunity']>,
  'dailyViolationLimit' | 'expiresAt' | 'remainingViolatingMessagesToday'
> & {
  mode?: ImmunityMode | null;
  dailyViolationLimit?: number | null;
  expiresAt?: string | null;
  remainingViolatingMessagesToday?: number | null;
};
type SaveImmunityPayload =
  | {
      mode: 'limited';
      durationHours: number;
      dailyViolationLimit: number;
    }
  | {
      mode: 'always';
    };

type ChatParticipantSheetProps = {
  open: boolean;
  item: ParticipantView | null;
  chatTitle?: string;
  origin?: ParticipantCardTarget['origin'];
  detailsReady?: boolean;
  loadError?: string | null;
  onRetry?: () => void;
  sanctions?: ChatSanctionsPage | null;
  sanctionsError?: boolean;
  savedVersion?: number;
  rangeLabel: string;
  isSavingImmunity: boolean;
  isApplyingModeration: boolean;
  isOpeningProfile: boolean;
  onClose: () => void;
  onSaveImmunity: (payload: SaveImmunityPayload) => void;
  onClearImmunity: () => void;
  onProfileActivate: () => void;
  onSpammerDiagnostics: () => void;
  onSanctionsActivate?: () => void;
  onMute: (durationHours: number) => void;
  onBan: (banOnRejoin: boolean) => void;
};

function resolveDisplayName(item: ParticipantView): string {
  const name = item.userDisplayName.trim();
  if (name) {
    return name;
  }

  const username = item.username?.trim() ?? '';
  if (username) {
    return `@${username.replace(/^@+/u, '')}`;
  }

  return item.isBot ? 'Бот MAX' : 'Участник';
}

function resolveInitial(name: string): string {
  const matched = name.match(/[A-Za-zА-Яа-яЁё0-9]/u);
  return matched ? matched[0]!.toUpperCase() : '•';
}

function resolveRoleLabel(item: ParticipantView): string {
  if ('membershipStatus' in item && item.membershipStatus !== 'member') {
    return item.membershipStatus === 'left' ? 'Вне чата' : 'Статус в чате неизвестен';
  }
  if (item.isBot) {
    return 'Бот';
  }

  if (item.role === 'owner') {
    return 'Владелец';
  }

  if (item.role === 'admin') {
    return 'Админ';
  }

  return 'Участник';
}

function formatDuration(hours: number): string {
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return [days ? `${days} д` : '', remainingHours ? `${remainingHours} ч` : '']
    .filter(Boolean)
    .join(' ');
}

function formatDays(days: number): string {
  return `${Math.max(1, Math.trunc(days))} д`;
}

function formatImmunityLeft(expiresAt: string): string {
  const expiresAtMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) {
    return 'Срок неизвестен';
  }

  const diffMs = expiresAtMs - Date.now();
  if (diffMs <= 0) return 'Истекла';
  const diffHours = Math.max(1, Math.ceil(diffMs / (60 * 60 * 1000)));
  return formatDuration(diffHours);
}

function formatViolationCount(count: number): string {
  if (count > 99) {
    return '99+';
  }

  return String(Math.max(0, Math.trunc(count)));
}

function resolveImmunity(item: ParticipantView): ChatParticipantImmunityView | null {
  return item.immunity ? (item.immunity as ChatParticipantImmunityView) : null;
}

function isAlwaysImmunity(immunity: ChatParticipantImmunityView | null): boolean {
  return immunity?.mode === 'always';
}

function parsePositiveInteger(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(1, Math.trunc(value));
}

function parseNonNegativeInteger(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.trunc(value));
}

function resolveInitialImmunityDurationDays(immunity: ChatParticipantImmunityView | null): number {
  if (!immunity || isAlwaysImmunity(immunity) || !immunity.expiresAt) {
    return 3;
  }

  const nextImmunityDurationDays = Math.min(
    IMMUNITY_DURATION_MAX_DAYS,
    Math.max(
      IMMUNITY_DURATION_MIN_DAYS,
      Math.ceil((new Date(immunity.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
    ),
  );

  return Number.isFinite(nextImmunityDurationDays) ? nextImmunityDurationDays : 3;
}

function resolveInitialDailyViolationLimit(immunity: ChatParticipantImmunityView | null): number {
  return parsePositiveInteger(immunity?.dailyViolationLimit) ?? 3;
}

function formatImmunityValue(immunity: ChatParticipantImmunityView | null): string {
  if (!immunity) {
    return 'Нет';
  }

  if (isAlwaysImmunity(immunity)) {
    return '∞';
  }

  const remaining = parseNonNegativeInteger(immunity.remainingViolatingMessagesToday);
  const limit = parsePositiveInteger(immunity.dailyViolationLimit);
  if (remaining !== null && limit !== null) {
    return `${formatViolationCount(remaining)}/${formatViolationCount(limit)}`;
  }

  if (limit !== null) {
    return `${formatViolationCount(limit)}/д`;
  }

  return 'Лимит';
}

function formatImmunityMeta(immunity: ChatParticipantImmunityView | null): string {
  if (!immunity) {
    return '—';
  }

  if (isAlwaysImmunity(immunity)) {
    return 'Всегда';
  }

  return immunity.expiresAt ? formatImmunityLeft(immunity.expiresAt) : '—';
}

function describeImmunity(immunity: ChatParticipantImmunityView | null): string | undefined {
  if (!immunity) {
    return undefined;
  }

  if (isAlwaysImmunity(immunity)) {
    return 'Защита всегда: без срока и дневного лимита';
  }

  const remaining = parseNonNegativeInteger(immunity.remainingViolatingMessagesToday);
  const limit = parsePositiveInteger(immunity.dailyViolationLimit);
  if (remaining !== null && limit !== null) {
    return `Защита: ${remaining} из ${limit} сообщений с нарушениями осталось на сегодня`;
  }

  if (limit !== null) {
    return `Защита: лимит ${limit} сообщений с нарушениями в день`;
  }

  return 'Защита с дневным лимитом';
}

function createAlwaysImmunityPayload(): SaveImmunityPayload {
  return { mode: 'always' };
}

function resolveNextImmunityMode(mode: ImmunityMode, key: string): ImmunityMode | null {
  if (key === 'Home') {
    return 'limited';
  }

  if (key === 'End') {
    return 'always';
  }

  if (key === 'ArrowLeft' || key === 'ArrowUp') {
    return mode === 'limited' ? 'always' : 'limited';
  }

  if (key === 'ArrowRight' || key === 'ArrowDown') {
    return mode === 'always' ? 'limited' : 'always';
  }

  return null;
}

function InfoButton({
  hintKey,
  label,
  openHintKey,
  onToggle,
}: {
  hintKey: ParticipantHintKey;
  label: string;
  openHintKey: ParticipantHintKey | null;
  onToggle: (hintKey: ParticipantHintKey) => void;
}) {
  const isOpen = openHintKey === hintKey;

  return (
    <button
      type="button"
      className={`settings-info-button participant-sheet__info-button ${isOpen ? 'is-open' : ''}`.trim()}
      aria-label={label}
      title={label}
      aria-controls={isOpen ? `participant-sheet-hint-${hintKey}` : undefined}
      aria-expanded={isOpen}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle(hintKey);
      }}
    >
      <IconoirSprite variant="iconoir" icon="InfoCircle" aria-hidden />
    </button>
  );
}

export function ChatParticipantSheet({
  open,
  item,
  chatTitle,
  origin,
  detailsReady = true,
  loadError,
  onRetry,
  sanctions,
  sanctionsError = false,
  savedVersion = 0,
  rangeLabel,
  isSavingImmunity,
  isApplyingModeration,
  isOpeningProfile,
  onClose,
  onSaveImmunity,
  onClearImmunity,
  onProfileActivate,
  onSpammerDiagnostics,
  onSanctionsActivate,
  onMute,
  onBan,
}: ChatParticipantSheetProps) {
  const [activeComposer, setActiveComposer] = useState<'mute' | 'immunity' | null>(null);
  const [muteDurationHours, setMuteDurationHours] = useState(24);
  const [immunityMode, setImmunityMode] = useState<ImmunityMode>('limited');
  const [immunityDurationDays, setImmunityDurationDays] = useState(3);
  const [dailyViolationLimit, setDailyViolationLimit] = useState(3);
  const [openHintKey, setOpenHintKey] = useState<ParticipantHintKey | null>(null);
  const [pendingImmunityAction, setPendingImmunityAction] = useState<'save' | 'clear' | null>(null);
  const immunityModeGroupRef = useRef<HTMLDivElement | null>(null);
  const immunityDraftStartedRef = useRef(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [discardEditorOpen, setDiscardEditorOpen] = useState(false);
  const editorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open || (!activeComposer && !editorTriggerRef.current)) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = document.querySelector<HTMLElement>('.participant-card[role="dialog"]');
      if (!panel || !isTopmostModalDialog(panel)) return;
      if (activeComposer) {
        editorRef.current?.focus();
        return;
      }
      const selector = editorTriggerRef.current?.classList.contains(
        'participant-sheet__action--mute',
      )
        ? '.participant-sheet__action--mute'
        : '.participant-sheet__action--immunity';
      panel.querySelector<HTMLButtonElement>(selector)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeComposer, open]);
  const backToOverview = () => {
    if (draftDirty) {
      setDiscardEditorOpen(true);
      return;
    }
    setActiveComposer(null);
  };

  useNativeBackHandler(
    () => {
      const panel = document.querySelector('.participant-card[role="dialog"]');
      if (panel && !isTopmostModalDialog(panel as HTMLElement)) return false;
      if (isSavingImmunity || isApplyingModeration || isOpeningProfile) {
        return true;
      }

      if (openHintKey !== null) {
        setOpenHintKey(null);
        return true;
      }

      if (activeComposer !== null) {
        backToOverview();
        return true;
      }

      onClose();
      return true;
    },
    { enabled: open, priority: 660 },
  );

  const resetParticipantDraft = useEffectEvent(() => {
    if (!item || !open) {
      return;
    }

    setActiveComposer(null);
    setDraftDirty(false);
    setOpenHintKey(null);
    setPendingImmunityAction(null);
    immunityDraftStartedRef.current = false;
    setMuteDurationHours(24);
    const immunity = resolveImmunity(item);
    setImmunityMode(isAlwaysImmunity(immunity) ? 'always' : 'limited');
    setImmunityDurationDays(resolveInitialImmunityDurationDays(immunity));
    setDailyViolationLimit(resolveInitialDailyViolationLimit(immunity));
  });
  useEffect(() => {
    resetParticipantDraft();
  }, [item?.userId, open, savedVersion]);

  useEffect(() => {
    if (
      openHintKey !== null &&
      (openHintKey === 'mute' ? activeComposer !== 'mute' : activeComposer !== 'immunity')
    ) {
      setOpenHintKey(null);
      return;
    }

    if (immunityMode === 'always' && (openHintKey === 'duration' || openHintKey === 'limit')) {
      setOpenHintKey(null);
    }
  }, [activeComposer, immunityMode, openHintKey]);

  if (!item) {
    return null;
  }

  const displayName = resolveDisplayName(item);
  const username = item.username?.replace(/^@+/u, '').trim() ?? '';
  const roleLabel = resolveRoleLabel(item);
  const violationCount = Number.isFinite(item.violationCount)
    ? Math.max(0, Math.trunc(item.violationCount))
    : 0;
  const {
    canManage: canManageParticipant,
    canMute,
    canBan,
  } = participantCapabilities(item, detailsReady);
  const isBusy = isSavingImmunity || isApplyingModeration || isOpeningProfile;
  const immunity = resolveImmunity(item);
  const immunityValue = formatImmunityValue(immunity);
  const immunityDescription = describeImmunity(immunity);
  const isMuteComposerOpen = activeComposer === 'mute';
  const isImmunityComposerOpen = activeComposer === 'immunity';
  const isAlwaysMode = immunityMode === 'always';
  const activeSanctions = sanctions?.items ?? [];
  const mute = activeSanctions.find((entry) => entry.action === 'MUTE');
  const protectionLabel = !detailsReady
    ? loadError
      ? 'Не загружена'
      : 'Загружаем'
    : !immunity
      ? 'Выключена'
      : isAlwaysImmunity(immunity)
        ? 'Всегда'
        : formatImmunityMeta(immunity);
  const sanctionsLabel = sanctionsError
    ? 'Не загружены'
    : !sanctions
      ? 'Загружаем'
      : activeSanctions.length
        ? `${activeSanctions.length}${sanctions.hasMore ? '+' : ''} активно`
        : 'Нет активных';
  const muteLabel = sanctionsError
    ? 'Не загружено'
    : !sanctions
      ? 'Загружаем'
      : mute
        ? mute.permanent
          ? 'Бессрочно'
          : mute.expiresAt
            ? `До ${new Date(mute.expiresAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
            : 'Срок неизвестен'
        : 'Нет ограничения';
  const toggleHint = (hintKey: ParticipantHintKey) => {
    setOpenHintKey((current) => (current === hintKey ? null : hintKey));
  };
  const handleImmunityModeKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    mode: ImmunityMode,
  ) => {
    const nextMode = resolveNextImmunityMode(mode, event.key);
    if (!nextMode) {
      return;
    }

    event.preventDefault();
    setImmunityMode(nextMode);
    setDraftDirty(true);
    immunityModeGroupRef.current
      ?.querySelector<HTMLButtonElement>(`[data-immunity-mode="${nextMode}"]`)
      ?.focus();
  };

  return (
    <>
      <SettingsDrilldownPanel
        id="participant-sheet"
        open={open}
        title={
          activeComposer === 'mute' ? 'Мут' : activeComposer === 'immunity' ? 'Защита' : 'Участник'
        }
        summary={activeComposer ? displayName : undefined}
        tone="sky"
        onClose={() => {
          if (!isBusy) onClose();
        }}
        className="participant-sheet participant-card"
        confirmCloseWhen={draftDirty && !isBusy}
        onDiscardChanges={() => setDraftDirty(false)}
        headerAction={
          activeComposer ? (
            <button
              type="button"
              className="participant-card__back"
              aria-label="К участнику"
              disabled={isBusy}
              onClick={backToOverview}
            >
              <IconoirSprite variant="iconoir" icon="NavArrowLeft" aria-hidden />
            </button>
          ) : undefined
        }
        footer={
          (isMuteComposerOpen ? canMute : isImmunityComposerOpen && canManageParticipant) ? (
            <div className="participant-sheet__row-actions">
              {isImmunityComposerOpen && item.immunity ? (
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={isBusy}
                  aria-busy={isSavingImmunity && pendingImmunityAction === 'clear'}
                  onClick={() => {
                    setPendingImmunityAction('clear');
                    onClearImmunity();
                  }}
                >
                  {isSavingImmunity && pendingImmunityAction === 'clear'
                    ? 'Снимаем...'
                    : 'Снять защиту'}
                </button>
              ) : null}
              <button
                type="button"
                className="button button--accent"
                disabled={isBusy}
                aria-busy={
                  isImmunityComposerOpen
                    ? isSavingImmunity && pendingImmunityAction === 'save'
                    : isApplyingModeration
                }
                onClick={() => {
                  if (isMuteComposerOpen) {
                    onMute(muteDurationHours);
                    return;
                  }
                  setPendingImmunityAction('save');
                  onSaveImmunity(
                    isAlwaysMode
                      ? createAlwaysImmunityPayload()
                      : {
                          mode: 'limited',
                          durationHours: immunityDurationDays * 24,
                          dailyViolationLimit,
                        },
                  );
                }}
              >
                {isMuteComposerOpen
                  ? isApplyingModeration
                    ? 'Применяем...'
                    : 'Назначить мут'
                  : isSavingImmunity && pendingImmunityAction === 'save'
                    ? 'Сохраняем...'
                    : 'Сохранить защиту'}
              </button>
            </div>
          ) : undefined
        }
      >
        {!activeComposer ? (
          <>
            <section className="participant-sheet__hero">
              <div className="participant-sheet__hero-top">
                <div className="participant-sheet__avatar-shell">
                  <PersonAvatar
                    avatarUrl={item.avatarUrl?.trim() || null}
                    fallback={resolveInitial(displayName)}
                    className="participant-sheet__avatar"
                  />
                </div>

                <div className="participant-sheet__hero-copy">
                  <div className="participant-sheet__identity">
                    <strong>{displayName}</strong>
                    {username ? <span>@{username}</span> : null}
                    {chatTitle ? <span>{chatTitle}</span> : null}
                  </div>

                  <div className="participant-sheet__chips">
                    <span className="participant-sheet__chip">
                      {detailsReady ? roleLabel : 'Загружаем'}
                    </span>
                    {item.immunity ? (
                      <span
                        className="participant-sheet__chip participant-sheet__chip--immune"
                        aria-label={immunityDescription}
                        title={immunityDescription}
                      >
                        <IconoirSprite variant="iconoir" icon="ShieldCheck" aria-hidden />
                        <span aria-hidden={Boolean(immunityDescription)}>{immunityValue}</span>
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>

              {detailsReady ? (
                <p className="participant-card__violations">
                  Нарушений {rangeLabel}: <strong>{formatViolationCount(violationCount)}</strong>
                </p>
              ) : null}
            </section>

            {origin ? (
              <div className="participant-card__origin">
                <div>
                  <strong>{origin.title}</strong>
                  {origin.date ? (
                    <time dateTime={origin.date}>
                      {new Date(origin.date).toLocaleString('ru-RU', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  ) : null}
                </div>
                {origin.reason ? <p>{origin.reason}</p> : null}
              </div>
            ) : null}
            {loadError ? (
              <div className="participant-card__notice" role="alert">
                <p>{loadError}</p>
                <button type="button" className="button button--ghost" onClick={onRetry}>
                  <IconoirSprite variant="iconoir" icon="Refresh" aria-hidden />
                  Повторить
                </button>
              </div>
            ) : !detailsReady ? (
              <div className="participant-card__loading" role="status">
                Загружаем настройки...
              </div>
            ) : null}
            {detailsReady && 'membershipStatus' in item && item.membershipStatus === 'unknown' ? (
              <div className="participant-card__notice">
                <p>
                  Не удалось проверить статус в чате. Персональные действия временно недоступны.
                </p>
                <button type="button" className="button button--ghost" onClick={onRetry}>
                  <IconoirSprite variant="iconoir" icon="Refresh" aria-hidden />
                  Обновить
                </button>
              </div>
            ) : null}

            <section className="participant-sheet__section">
              <div className="participant-sheet__dock">
                <h3 className="participant-card__section-title">Персональные настройки</h3>
                <div className="participant-sheet__action-grid">
                  <button
                    type="button"
                    aria-label="Защита"
                    className="participant-sheet__action participant-sheet__action--immunity"
                    disabled={isBusy || !canManageParticipant}
                    onClick={(event) => {
                      editorTriggerRef.current = event.currentTarget;
                      if (!immunityDraftStartedRef.current) {
                        setImmunityMode(isAlwaysImmunity(immunity) ? 'always' : 'limited');
                        setImmunityDurationDays(resolveInitialImmunityDurationDays(immunity));
                        setDailyViolationLimit(resolveInitialDailyViolationLimit(immunity));
                        immunityDraftStartedRef.current = true;
                      }
                      setActiveComposer('immunity');
                    }}
                  >
                    <IconoirSprite variant="iconoir" icon="ShieldCheck" aria-hidden />
                    <span>
                      Защита<small>{protectionLabel}</small>
                    </span>
                    <IconoirSprite variant="iconoir" icon="NavArrowRight" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label="Мут"
                    className="participant-sheet__action participant-sheet__action--mute"
                    disabled={isBusy || !canMute}
                    onClick={(event) => {
                      editorTriggerRef.current = event.currentTarget;
                      setActiveComposer('mute');
                    }}
                  >
                    <IconoirSprite variant="iconoir" icon="SoundOff" aria-hidden />
                    <span>
                      Мут<small>{muteLabel}</small>
                    </span>
                    <IconoirSprite variant="iconoir" icon="NavArrowRight" aria-hidden />
                  </button>
                  {onSanctionsActivate ? (
                    <button
                      type="button"
                      className="participant-sheet__action participant-sheet__action--neutral"
                      onClick={onSanctionsActivate}
                      disabled={isBusy}
                    >
                      <IconoirSprite variant="iconoir" icon="ShieldCheck" aria-hidden />
                      <span>
                        Ограничения<small>{sanctionsLabel}</small>
                      </span>
                      <IconoirSprite variant="iconoir" icon="NavArrowRight" aria-hidden />
                    </button>
                  ) : null}
                </div>
                <h3 className="participant-card__section-title">Дополнительно</h3>
                <div className="participant-sheet__action-grid">
                  <button
                    type="button"
                    className="participant-sheet__action participant-sheet__action--neutral"
                    onClick={onProfileActivate}
                    disabled={isBusy}
                  >
                    <IconoirSprite variant="iconoir" icon="UserCircle" aria-hidden />
                    <span>{isOpeningProfile ? 'Открываем...' : 'Профиль в MAX'}</span>
                    <IconoirSprite variant="iconoir" icon="OpenNewWindow" aria-hidden />
                  </button>

                  <button
                    type="button"
                    className="participant-sheet__action participant-sheet__action--registry"
                    onClick={onSpammerDiagnostics}
                    disabled={isBusy}
                    title="Проверить участника по базе спамеров"
                  >
                    <IconoirSprite variant="iconoir" icon="Search" aria-hidden />
                    <span>Проверка по базе спама</span>
                    <IconoirSprite variant="iconoir" icon="NavArrowRight" aria-hidden />
                  </button>

                  {canBan ? (
                    <button
                      type="button"
                      className="participant-sheet__action participant-sheet__action--ban"
                      onClick={() =>
                        onBan('membershipStatus' in item && item.membershipStatus === 'left')
                      }
                      disabled={isBusy}
                    >
                      <IconoirSprite variant="iconoir" icon="Prohibition" aria-hidden />
                      <span>Бан</span>
                    </button>
                  ) : null}
                </div>
              </div>
            </section>
          </>
        ) : null}

        {canMute && isMuteComposerOpen ? (
          <div
            id={MUTE_COMPOSER_ID}
            className="participant-sheet__composer"
            ref={editorRef}
            tabIndex={-1}
          >
            <div className="participant-sheet__composer-head">
              <div className="participant-sheet__label-with-info">
                <span className="participant-sheet__composer-title">Мут</span>
                <InfoButton
                  hintKey="mute"
                  label="Как работает мут"
                  openHintKey={openHintKey}
                  onToggle={toggleHint}
                />
              </div>
              <output aria-live="polite">{formatDuration(muteDurationHours)}</output>
            </div>
            {openHintKey === 'mute' ? (
              <p id="participant-sheet-hint-mute" className="participant-sheet__hint">
                Бот удаляет новые сообщения до конца срока мута, в том числе после возвращения
                участника в чат. Срок идёт с момента назначения.
              </p>
            ) : null}
            <div
              className="participant-sheet__duration-presets"
              role="group"
              aria-label="Срок ограничения сообщений"
            >
              {MUTE_DURATION_PRESETS.map((hours) => (
                <button
                  key={hours}
                  type="button"
                  aria-pressed={muteDurationHours === hours}
                  onClick={() => {
                    setMuteDurationHours(hours);
                    setDraftDirty(true);
                  }}
                  disabled={isBusy}
                >
                  {formatDuration(hours)}
                </button>
              ))}
            </div>
            <input
              className="settings-length-limit__slider"
              type="range"
              min={MUTE_DURATION_MIN_HOURS}
              max={MUTE_DURATION_MAX_HOURS}
              step={1}
              value={muteDurationHours}
              onChange={(event) => {
                setMuteDurationHours(Number(event.target.value));
                setDraftDirty(true);
              }}
              aria-label="Срок ограничения в часах"
              aria-valuetext={formatDuration(muteDurationHours)}
              aria-describedby={openHintKey === 'mute' ? 'participant-sheet-hint-mute' : undefined}
              disabled={isBusy}
            />
            <div className="participant-sheet__slider-labels" aria-hidden="true">
              <span>{formatDuration(MUTE_DURATION_MIN_HOURS)}</span>
              <span>{formatDuration(MUTE_DURATION_MAX_HOURS)}</span>
            </div>
          </div>
        ) : null}

        {canManageParticipant && isImmunityComposerOpen ? (
          <div
            id={IMMUNITY_COMPOSER_ID}
            className="participant-sheet__composer participant-sheet__composer--stack"
            ref={editorRef}
            tabIndex={-1}
          >
            <div className="participant-sheet__composer-head">
              <div className="participant-sheet__label-with-info">
                <span className="participant-sheet__composer-title">Защита</span>
                <InfoButton
                  hintKey="immunity"
                  label="Что делает защита"
                  openHintKey={openHintKey}
                  onToggle={toggleHint}
                />
              </div>
              <output
                aria-live="polite"
                aria-label={
                  isAlwaysMode
                    ? 'Защита всегда: без срока и дневного лимита'
                    : `Лимит ${dailyViolationLimit} сообщений с нарушениями в день`
                }
              >
                {isAlwaysMode ? 'Всегда' : `${dailyViolationLimit}/д`}
              </output>
            </div>
            {openHintKey === 'immunity' ? (
              <p id="participant-sheet-hint-immunity" className="participant-sheet__hint">
                Защита делает исключение из автоматической модерации для участника в этом чате.
                {isAlwaysMode
                  ? ' В режиме «Всегда» она действует без срока и лимита, пока вы её не снимете.'
                  : ' Она действует до выбранной даты, пока не исчерпан дневной лимит. Обычные сообщения лимит не тратят.'}{' '}
                Ручные ограничения и блокировку защита не отменяет.
              </p>
            ) : null}

            <div
              ref={immunityModeGroupRef}
              className="participant-sheet__mode-switch"
              role="radiogroup"
              aria-label="Режим защиты"
            >
              <button
                type="button"
                className={`participant-sheet__mode-option ${
                  immunityMode === 'limited' ? 'is-active' : ''
                }`}
                role="radio"
                aria-checked={immunityMode === 'limited'}
                tabIndex={immunityMode === 'limited' ? 0 : -1}
                data-immunity-mode="limited"
                onClick={() => {
                  setImmunityMode('limited');
                  setDraftDirty(true);
                }}
                onKeyDown={(event) => handleImmunityModeKeyDown(event, 'limited')}
                disabled={isBusy}
              >
                На срок
              </button>
              <button
                type="button"
                className={`participant-sheet__mode-option ${
                  immunityMode === 'always' ? 'is-active' : ''
                }`}
                role="radio"
                aria-checked={immunityMode === 'always'}
                tabIndex={immunityMode === 'always' ? 0 : -1}
                data-immunity-mode="always"
                onClick={() => {
                  setImmunityMode('always');
                  setDraftDirty(true);
                }}
                onKeyDown={(event) => handleImmunityModeKeyDown(event, 'always')}
                disabled={isBusy}
              >
                Всегда
              </button>
            </div>

            {!isAlwaysMode ? (
              <>
                <div className="participant-sheet__slider-block">
                  <div className="participant-sheet__slider-head">
                    <div className="participant-sheet__label-with-info">
                      <span>Срок</span>
                      <InfoButton
                        hintKey="duration"
                        label="Что значит срок защиты"
                        openHintKey={openHintKey}
                        onToggle={toggleHint}
                      />
                    </div>
                    <output aria-live="polite">{formatDays(immunityDurationDays)}</output>
                  </div>
                  {openHintKey === 'duration' ? (
                    <p id="participant-sheet-hint-duration" className="participant-sheet__hint">
                      Защита начнёт действовать после сохранения и отключится сама через выбранное
                      число дней. При повторном сохранении срок отсчитывается заново.
                    </p>
                  ) : null}
                  <input
                    className="settings-length-limit__slider"
                    type="range"
                    min={IMMUNITY_DURATION_MIN_DAYS}
                    max={IMMUNITY_DURATION_MAX_DAYS}
                    step={1}
                    value={immunityDurationDays}
                    onChange={(event) => {
                      setImmunityDurationDays(Number(event.target.value));
                      setDraftDirty(true);
                    }}
                    aria-label="Срок защиты в днях"
                    aria-valuetext={formatDays(immunityDurationDays)}
                    aria-describedby={
                      openHintKey === 'duration' ? 'participant-sheet-hint-duration' : undefined
                    }
                    disabled={isBusy}
                  />
                  <div className="participant-sheet__slider-labels" aria-hidden="true">
                    <span>{formatDays(IMMUNITY_DURATION_MIN_DAYS)}</span>
                    <span>{formatDays(IMMUNITY_DURATION_MAX_DAYS)}</span>
                  </div>
                </div>

                <div className="participant-sheet__slider-block">
                  <div className="participant-sheet__slider-head">
                    <div className="participant-sheet__label-with-info">
                      <span>Сообщений в день</span>
                      <InfoButton
                        hintKey="limit"
                        label="Что значит лимит защиты"
                        openHintKey={openHintKey}
                        onToggle={toggleHint}
                      />
                    </div>
                    <output aria-live="polite">{dailyViolationLimit}</output>
                  </div>
                  {openHintKey === 'limit' ? (
                    <p id="participant-sheet-hint-limit" className="participant-sheet__hint">
                      Столько сообщений с нарушениями бот пропустит за день. Следующее нарушение
                      будет обработано по обычным правилам. Лимит обновляется в полночь по времени
                      чата; при сохранении защиты он тоже начинается заново.
                    </p>
                  ) : null}
                  <input
                    className="settings-length-limit__slider"
                    type="range"
                    min={IMMUNITY_DAILY_LIMIT_MIN}
                    max={IMMUNITY_DAILY_LIMIT_MAX}
                    step={1}
                    value={dailyViolationLimit}
                    onChange={(event) => {
                      setDailyViolationLimit(Number(event.target.value));
                      setDraftDirty(true);
                    }}
                    aria-label="Лимит сообщений с нарушениями в день"
                    aria-describedby={
                      openHintKey === 'limit' ? 'participant-sheet-hint-limit' : undefined
                    }
                    disabled={isBusy}
                  />
                  <div className="participant-sheet__slider-labels" aria-hidden="true">
                    <span>{IMMUNITY_DAILY_LIMIT_MIN}</span>
                    <span>{IMMUNITY_DAILY_LIMIT_MAX}</span>
                  </div>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </SettingsDrilldownPanel>
      <ActionConfirmSheet
        id="participant-discard-editor"
        open={discardEditorOpen}
        title="Отменить изменения?"
        summary="Изменения ещё не сохранены."
        confirmLabel="Отменить изменения"
        cancelLabel="Продолжить редактирование"
        onClose={() => setDiscardEditorOpen(false)}
        onConfirm={() => {
          setDiscardEditorOpen(false);
          setDraftDirty(false);
          setMuteDurationHours(24);
          immunityDraftStartedRef.current = false;
          setActiveComposer(null);
        }}
      />
    </>
  );
}
