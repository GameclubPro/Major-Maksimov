import { isMaxMemberRestoreAvailable } from '@maxim/contracts/max-capabilities';
import type {
  LogsDashboardViolation as ViolationItem,
  ManualModerationAction,
  ManualModerationActionRequest,
  ManualModerationScope,
} from '@maxim/contracts';
import { useMutation } from '@tanstack/react-query';
import { Suspense, useRef, useState, type ComponentProps } from 'react';
import { applyManualModerationAction } from '../lib/api/events-client';
import type { ApiTransport } from '../lib/api/transport';
import {
  clampMuteDurationHours,
  describeManualModerationFeedback,
  describeManualModerationReleaseError,
  MAX_UNBAN_CHECK_GUIDANCE,
  MAX_UNBAN_CHECK_LABEL,
  MUTE_DURATION_MAX_HOURS,
  MUTE_DURATION_MIN_HOURS,
} from '../lib/manual-moderation-feedback';
import { recoverableLazyNamedComponent } from '../lib/recoverable-lazy';
import type { ActionConfirmSheet as ActionConfirmSheetComponent } from './ui/action-confirm-sheet';

const ActionConfirmSheet = recoverableLazyNamedComponent<
  ComponentProps<typeof ActionConfirmSheetComponent>
>(() => import('./ui/action-confirm-sheet'), 'ActionConfirmSheet');

type ManualModerationScopeChoice = Extract<ManualModerationScope, 'current_chat' | 'all_chats'>;

function ClockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 7.75v4.8l3.45 1.95" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function formatMuteDurationCompact(hours: number): string {
  return hours >= 24 && hours % 24 === 0 ? `${hours / 24}д` : `${hours}ч`;
}

function resolveApplyActionLabel(
  action: ManualModerationAction,
  muteDurationHours: number,
): string {
  if (action === 'MUTE') {
    return `Мут на ${formatMuteDurationCompact(muteDurationHours)}`;
  }

  if (action === 'UNMUTE') {
    return 'Снять мут';
  }

  if (action === 'UNBAN') {
    return 'Снять бан';
  }

  return 'Бан';
}

function resolveConfirmMessage(
  action: ManualModerationAction,
  muteDurationHours: number,
  violation?: ViolationItem,
): string {
  if (action === 'MUTE') {
    return `Назначить мут на ${muteDurationHours} ч? Новые сообщения будут удаляться до конца срока.`;
  }

  if (action === 'UNMUTE') {
    return 'Снять мут?';
  }

  if (action === 'UNBAN') {
    if (violation?.metadata?.mode === 'LOCAL_REJOIN') return 'Снять бан?';
    if (violation && isBanActiveFromViolation(violation)) {
      return 'Снять бан и вернуть участника в чат?';
    }

    if (
      violation?.ruleCode === 'GLOBAL_SPAMMER_BAN' ||
      violation?.ruleCode === 'GLOBAL_SPAMMER_KICK'
    ) {
      return 'Вернуть участника в чат и отключить удаление по базе спама?';
    }

    return 'Вернуть участника в чат?';
  }

  return 'Назначить бан участнику?';
}

function isMuteActiveFromViolation(violation: ViolationItem): boolean {
  const metadata =
    violation.metadata &&
    typeof violation.metadata === 'object' &&
    !Array.isArray(violation.metadata)
      ? violation.metadata
      : null;
  const now = Date.now();

  const readFutureIso = (key: string): boolean => {
    if (!metadata || !(key in metadata) || typeof metadata[key] !== 'string') {
      return false;
    }
    const timestamp = new Date(metadata[key] as string).getTime();
    return Number.isFinite(timestamp) && timestamp > now;
  };

  if (
    readFutureIso('muteExpiresAt') ||
    readFutureIso('banExpiresAt') ||
    readFutureIso('unbanScheduledAt')
  ) {
    return true;
  }

  if (violation.action !== 'MUTE') {
    return false;
  }

  const createdAtMs = new Date(violation.createdAt).getTime();
  if (!Number.isFinite(createdAtMs)) {
    return false;
  }

  const muteDurationHours =
    metadata && 'muteDurationHours' in metadata && typeof metadata.muteDurationHours === 'number'
      ? metadata.muteDurationHours
      : null;
  if (muteDurationHours === null || !Number.isFinite(muteDurationHours) || muteDurationHours <= 0) {
    return false;
  }

  return createdAtMs + muteDurationHours * 60 * 60 * 1000 > now;
}

function isBanActiveFromViolation(violation: ViolationItem): boolean {
  const metadata =
    violation.metadata &&
    typeof violation.metadata === 'object' &&
    !Array.isArray(violation.metadata)
      ? violation.metadata
      : null;

  if (violation.action !== 'BAN') {
    return false;
  }

  return !metadata || !('muteDurationHours' in metadata);
}

function resolveReleaseAction(
  violation: ViolationItem,
): Extract<ManualModerationAction, 'UNMUTE' | 'UNBAN'> | null {
  if (isMuteActiveFromViolation(violation)) {
    return 'UNMUTE';
  }

  if (isBanActiveFromViolation(violation)) {
    return 'UNBAN';
  }

  return null;
}

function resolveReleaseLabel(
  action: Extract<ManualModerationAction, 'UNMUTE' | 'UNBAN'>,
  banOnRejoin: boolean,
): string {
  return action === 'UNMUTE'
    ? 'Снять мут'
    : banOnRejoin || isMaxMemberRestoreAvailable()
      ? 'Снять бан'
      : MAX_UNBAN_CHECK_LABEL;
}

export function ViolationModerationControls({
  api,
  chatId,
  violation,
  displayName,
  onOpenDiagnostics,
  onApplied,
}: {
  api: ApiTransport;
  chatId: string;
  violation: ViolationItem;
  displayName: string;
  onOpenDiagnostics: () => void;
  onApplied: () => void;
}) {
  const releaseAction = resolveReleaseAction(violation);
  const [muteDurationHours, setMuteDurationHours] = useState(6);
  const [muteDurationInput, setMuteDurationInput] = useState('6');
  const parsedMuteDuration = Number(muteDurationInput);
  const isMuteDurationValid =
    muteDurationInput.trim() !== '' &&
    Number.isInteger(parsedMuteDuration) &&
    parsedMuteDuration >= MUTE_DURATION_MIN_HOURS &&
    parsedMuteDuration <= MUTE_DURATION_MAX_HOURS;
  const updateMuteDuration = (hours: number) => {
    const normalized = clampMuteDurationHours(hours);
    setMuteDurationHours(normalized);
    setMuteDurationInput(String(normalized));
  };
  const [muteExpanded, setMuteExpanded] = useState(false);
  const [pendingScopeChoice, setPendingScopeChoice] = useState<ManualModerationScopeChoice | null>(
    null,
  );
  const [pendingScopeAction, setPendingScopeAction] = useState<{
    action: Extract<ManualModerationAction, 'MUTE' | 'BAN'>;
    muteDurationHours?: number;
  } | null>(null);
  const [pendingAction, setPendingAction] = useState<Extract<
    ManualModerationAction,
    'UNMUTE' | 'UNBAN'
  > | null>(null);
  const pendingMaxUnbanCheck =
    pendingAction === 'UNBAN' &&
    violation.metadata?.mode !== 'LOCAL_REJOIN' &&
    !isMaxMemberRestoreAvailable();
  const [status, setStatus] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const mutePresets = [1, 6, 24, 168];
  const applyLock = useRef(false);

  const applyMutation = useMutation({
    retry: false,
    mutationFn: async (payload: ManualModerationActionRequest) =>
      applyManualModerationAction(api, chatId, violation.userId, payload),
    onSuccess: (result) => {
      setStatus({ tone: 'success', text: describeManualModerationFeedback(result) });
      setMuteExpanded(false);
      setPendingAction(null);
      setPendingScopeAction(null);
      onApplied();
    },
    onError: (error: unknown) => {
      const message = describeManualModerationReleaseError(
        error,
        'Не удалось выполнить действие. Проверьте права бота и повторите.',
      );
      setStatus({ tone: 'danger', text: message });
    },
    onSettled: () => {
      applyLock.current = false;
      setPendingScopeChoice(null);
    },
  });

  const applyAction = (
    action: ManualModerationAction,
    hours?: number,
    scope?: ManualModerationScopeChoice,
  ) => {
    if (applyLock.current || applyMutation.isPending) return;
    applyLock.current = true;
    const normalizedHours =
      action === 'MUTE' ? clampMuteDurationHours(hours ?? muteDurationHours) : null;
    setStatus(null);
    setPendingScopeChoice(scope ?? null);
    applyMutation.mutate({
      action,
      ...(action === 'UNBAN' || action === 'UNMUTE'
        ? { expectedSanctionEventId: violation.id }
        : {}),
      ...(scope ? { scope } : {}),
      ...(action === 'MUTE' ? { muteDurationHours: normalizedHours ?? muteDurationHours } : {}),
    });
  };
  const openScopeAction = (
    action: Extract<ManualModerationAction, 'MUTE' | 'BAN'>,
    hours?: number,
  ) => {
    setStatus(null);
    setPendingAction(null);
    setPendingScopeAction({
      action,
      ...(action === 'MUTE'
        ? { muteDurationHours: clampMuteDurationHours(hours ?? muteDurationHours) }
        : {}),
    });
  };
  const closeScopeAction = () => {
    if (applyLock.current || applyMutation.isPending) {
      return;
    }
    setPendingScopeAction(null);
  };
  const confirmScopeAction = (scope: ManualModerationScopeChoice) => {
    if (!pendingScopeAction) {
      return;
    }
    applyAction(pendingScopeAction.action, pendingScopeAction.muteDurationHours, scope);
  };

  return (
    <section className="logs-violation-item__moderation" aria-label="Действия модератора">
      <div
        className={`logs-violation-item__quick-actions ${
          releaseAction ? 'logs-violation-item__quick-actions--single' : ''
        }`}
      >
        <button
          type="button"
          className="logs-violation-item__quick-button logs-violation-item__quick-button--neutral"
          disabled={applyMutation.isPending}
          onClick={() => {
            setStatus(null);
            setMuteExpanded(false);
            setPendingScopeAction(null);
            setPendingAction(null);
            onOpenDiagnostics();
          }}
        >
          Проверить
        </button>
        {!releaseAction ? (
          <button
            type="button"
            className={`logs-violation-item__quick-button logs-violation-item__quick-button--warning ${
              muteExpanded ? 'is-active' : ''
            }`}
            disabled={applyMutation.isPending}
            onClick={() => {
              setStatus(null);
              setPendingAction(null);
              setPendingScopeAction(null);
              setMuteExpanded((current) => !current);
            }}
          >
            Мут
          </button>
        ) : null}
        {!releaseAction ? (
          <button
            type="button"
            className="logs-violation-item__quick-button logs-violation-item__quick-button--danger"
            disabled={applyMutation.isPending}
            onClick={() => {
              setStatus(null);
              setMuteExpanded(false);
              setPendingScopeAction((current) =>
                current?.action === 'BAN'
                  ? null
                  : {
                      action: 'BAN',
                    },
              );
              setPendingAction(null);
            }}
          >
            Бан
          </button>
        ) : null}
        {releaseAction ? (
          <button
            type="button"
            className="logs-violation-item__quick-button logs-violation-item__quick-button--success"
            disabled={applyMutation.isPending}
            onClick={() => {
              setStatus(null);
              setMuteExpanded(false);
              setPendingScopeAction(null);
              setPendingAction((current) => (current === releaseAction ? null : releaseAction));
            }}
          >
            {resolveReleaseLabel(releaseAction, violation.metadata?.mode === 'LOCAL_REJOIN')}
          </button>
        ) : null}
      </div>

      {!releaseAction && muteExpanded ? (
        <div className="logs-violation-item__ban-config">
          <div className="logs-violation-item__duration-summary">
            <div className="logs-violation-item__duration-label">
              <ClockIcon />
              <span>Срок ограничения</span>
            </div>
            <output className="logs-violation-item__duration-output" aria-live="polite">
              {formatMuteDurationCompact(muteDurationHours)}
            </output>
          </div>

          <div className="logs-violation-item__ban-presets">
            {mutePresets.map((hours) => (
              <button
                key={hours}
                type="button"
                className={`logs-violation-item__ban-preset ${
                  muteDurationHours === hours ? 'is-active' : ''
                }`}
                disabled={applyMutation.isPending}
                aria-pressed={muteDurationHours === hours}
                onClick={() => updateMuteDuration(hours)}
              >
                {formatMuteDurationCompact(hours)}
              </button>
            ))}
          </div>

          <div className="logs-violation-item__ban-config-controls">
            <div className="ban-duration-stepper">
              <button
                type="button"
                className="ban-duration-stepper__button"
                onClick={() => updateMuteDuration(muteDurationHours - 1)}
                disabled={applyMutation.isPending || muteDurationHours <= MUTE_DURATION_MIN_HOURS}
                aria-label="Уменьшить срок ограничения"
              >
                -
              </button>
              <div className="ban-duration-stepper__value">
                {formatMuteDurationCompact(muteDurationHours)}
              </div>
              <button
                type="button"
                className="ban-duration-stepper__button"
                onClick={() => updateMuteDuration(muteDurationHours + 1)}
                disabled={applyMutation.isPending || muteDurationHours >= MUTE_DURATION_MAX_HOURS}
                aria-label="Увеличить срок ограничения"
              >
                +
              </button>
            </div>

            <label className="logs-violation-item__hours-input">
              <span>Часы</span>
              <input
                type="number"
                min={MUTE_DURATION_MIN_HOURS}
                max={MUTE_DURATION_MAX_HOURS}
                step={1}
                value={muteDurationInput}
                disabled={applyMutation.isPending}
                aria-invalid={muteDurationInput !== '' && !isMuteDurationValid}
                aria-describedby={`violation-mute-range-${violation.id}`}
                onChange={(event) => {
                  const input = event.target.value;
                  setMuteDurationInput(input);
                  const hours = Number(input);
                  if (
                    input.trim() !== '' &&
                    Number.isInteger(hours) &&
                    hours >= MUTE_DURATION_MIN_HOURS &&
                    hours <= MUTE_DURATION_MAX_HOURS
                  ) {
                    setMuteDurationHours(hours);
                  }
                }}
                onBlur={() =>
                  updateMuteDuration(
                    muteDurationInput.trim() === '' ? muteDurationHours : parsedMuteDuration,
                  )
                }
              />
              <small id={`violation-mute-range-${violation.id}`}>1–336ч</small>
            </label>
          </div>

          <button
            type="button"
            className="button button--accent logs-violation-item__apply-button"
            disabled={applyMutation.isPending || !isMuteDurationValid}
            onClick={() => openScopeAction('MUTE', muteDurationHours)}
          >
            {applyMutation.isPending
              ? 'Применяем…'
              : resolveApplyActionLabel('MUTE', muteDurationHours)}
          </button>
        </div>
      ) : null}

      {pendingAction ? (
        <div className="logs-violation-item__ban-config">
          <p className="settings-native-toggle__hint settings-native-toggle__hint--inline">
            {pendingMaxUnbanCheck
              ? MAX_UNBAN_CHECK_GUIDANCE
              : resolveConfirmMessage(pendingAction, muteDurationHours, violation)}
          </p>
          <div className="logs-violation-item__confirm-actions">
            <button
              type="button"
              className="button button--ghost"
              disabled={applyMutation.isPending}
              onClick={() => setPendingAction(null)}
            >
              Отмена
            </button>
            <button
              type="button"
              className="button button--accent"
              disabled={applyMutation.isPending}
              onClick={() => applyAction(pendingAction)}
            >
              {applyMutation.isPending
                ? pendingMaxUnbanCheck
                  ? 'Проверяем…'
                  : 'Применяем…'
                : pendingMaxUnbanCheck
                  ? 'Проверить'
                  : resolveApplyActionLabel(pendingAction, muteDurationHours)}
            </button>
          </div>
        </div>
      ) : null}

      {pendingScopeAction ? (
        <Suspense fallback={null}>
          <ActionConfirmSheet
            id={`violation-scope-${violation.id}`}
            open
            title={pendingScopeAction.action === 'BAN' ? 'Бан участника' : 'Мут участника'}
            summary={displayName}
            previewTitle={resolveConfirmMessage(
              pendingScopeAction.action,
              pendingScopeAction.muteDurationHours ?? muteDurationHours,
            )}
            previewMeta={
              status?.tone === 'danger' ? <span role="alert">{status.text}</span> : undefined
            }
            confirmLabel="В этом чате"
            confirmBusyLabel="Применяем..."
            cancelLabel="Отмена"
            tone={pendingScopeAction.action === 'BAN' ? 'danger' : 'accent'}
            isBusy={applyMutation.isPending}
            confirmBusy={applyMutation.isPending && pendingScopeChoice === 'current_chat'}
            extraActionLabel="Во всех чатах"
            extraActionBusyLabel="Применяем..."
            extraActionBusy={applyMutation.isPending && pendingScopeChoice === 'all_chats'}
            extraActionTone={pendingScopeAction.action === 'BAN' ? 'danger' : 'accent'}
            actionOrder="confirm-extra-cancel"
            onExtraAction={() => confirmScopeAction('all_chats')}
            onClose={closeScopeAction}
            onConfirm={() => confirmScopeAction('current_chat')}
          />
        </Suspense>
      ) : null}

      {status ? (
        <p className={`logs-violation-item__action-status is-${status.tone}`}>{status.text}</p>
      ) : null}
    </section>
  );
}
