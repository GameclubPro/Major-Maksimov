import { Suspense, useEffect, useState, type ComponentProps } from 'react';
import {
  COMMERCIAL_ADS_EXCEPTIONS_MAX,
  type CommercialAdsException,
  type CommercialAdsPolicy,
} from '@maxim/contracts/settings';
import { COMMERCIAL_CATEGORY_LABELS } from '../../lib/commercial-ads-category-labels';
import {
  commercialExceptionExpired,
  formatCommercialExpiry,
  type CommercialExceptionPrefill,
} from '../../lib/commercial-ads-policy';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import { AppIcon } from '../../components/ui/app-icon';
import { PersonAvatar } from '../../components/ui/person-avatar';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { ActionConfirmSheet } from '../../components/ui/action-confirm-sheet';
import type { CommercialSettingsScope } from './commercial-policy-model';
import './commercial-policy-sheets.css';

const CommercialExceptionEditor = recoverableLazyNamedComponent<
  ComponentProps<typeof import('./commercial-policy-exception-editor').CommercialExceptionEditor>
>(() => import('./commercial-policy-exception-editor'), 'CommercialExceptionEditor');

export function CommercialExceptionsSheets({
  scope,
  policy,
  readOnly,
  open,
  prefill,
  onPrefillHandled,
  onOpen,
  onClose,
  onChange,
}: {
  scope: CommercialSettingsScope;
  policy: CommercialAdsPolicy;
  readOnly: boolean;
  open: boolean;
  prefill: CommercialExceptionPrefill | null;
  onPrefillHandled: () => void;
  onOpen: () => void;
  onClose: () => void;
  onChange: (policy: CommercialAdsPolicy) => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const nextExpiry = Math.min(
      ...(policy?.exceptions ?? [])
        .map((entry) => (entry.expiresAt ? Date.parse(entry.expiresAt) : Infinity))
        .filter((expiry) => expiry > now),
    );
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(nextExpiry - Date.now() + 1, 2147483647),
    );
    return () => window.clearTimeout(timer);
  }, [policy, now]);
  const [editing, setEditing] = useState<CommercialAdsException | 'new' | null>(
    prefill ? 'new' : null,
  );
  const [remove, setRemove] = useState<CommercialAdsException | null>(null);
  const closeEditor = () => {
    setEditing(null);
    onPrefillHandled();
  };
  return (
    <>
      <SettingsDrilldownPanel
        id="commercial-exceptions"
        open={open}
        title="Исключения"
        className="commercial-panel"
        onClose={onClose}
        footer={
          <button
            type="button"
            className="button button--accent commercial-policy__submit"
            onClick={onClose}
          >
            Готово
          </button>
        }
        headerAction={
          <button
            type="button"
            className="commercial-policy__header-action"
            disabled={readOnly || policy.exceptions.length >= COMMERCIAL_ADS_EXCEPTIONS_MAX}
            onClick={() => setEditing('new')}
          >
            <AppIcon icon="Plus" />
            <span>Добавить</span>
          </button>
        }
      >
        <div className="commercial-policy commercial-policy--sheet">
          {policy.exceptions.length ? (
            <ul className="commercial-policy__exceptions" aria-label="Разрешения участникам">
              {policy.exceptions.map((entry) => (
                <li key={entry.id} data-expired={commercialExceptionExpired(entry, now)}>
                  <button
                    type="button"
                    className="commercial-policy__exception"
                    disabled={readOnly}
                    onClick={() => setEditing(entry)}
                  >
                    <PersonAvatar
                      avatarUrl={null}
                      fallback={entry.userName.slice(0, 1)}
                      className="commercial-policy__avatar"
                    />
                    <span className="commercial-policy__exception-body">
                      <strong>{entry.userName}</strong>
                      <span>
                        {entry.categories
                          .map((category) => COMMERCIAL_CATEGORY_LABELS[category])
                          .join(', ')}
                      </span>
                      <small>{formatCommercialExpiry(entry.expiresAt, now)}</small>
                    </span>
                    <AppIcon icon="EditPencil" />
                  </button>
                  <button
                    type="button"
                    className="commercial-policy__remove"
                    aria-label={`Удалить исключение: ${entry.userName}`}
                    disabled={readOnly}
                    onClick={() => setRemove(entry)}
                  >
                    <AppIcon icon="Trash" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="commercial-policy__empty">
              <AppIcon icon="UserPlus" />
              <p>Исключений нет</p>
              <button
                type="button"
                className="button button--accent"
                disabled={readOnly}
                onClick={() => setEditing('new')}
              >
                Добавить
              </button>
            </div>
          )}
          {policy.exceptions.length >= COMMERCIAL_ADS_EXCEPTIONS_MAX ? (
            <p className="commercial-policy__notice" role="status">
              Можно добавить до {COMMERCIAL_ADS_EXCEPTIONS_MAX} исключений.
            </p>
          ) : null}
        </div>
      </SettingsDrilldownPanel>
      {editing ? (
        <Suspense fallback={null}>
          <CommercialExceptionEditor
            key={editing === 'new' ? 'new' : editing.id}
            scope={scope}
            entry={editing === 'new' ? null : editing}
            prefill={editing === 'new' ? prefill : null}
            readOnly={readOnly}
            onClose={closeEditor}
            onApply={(entry) => {
              const next = [...policy.exceptions];
              const index = next.findIndex((item) => item.id === entry.id);
              if (index < 0) next.push(entry);
              else next[index] = entry;
              onChange({ ...policy, exceptions: next });
              closeEditor();
              onOpen();
            }}
          />
        </Suspense>
      ) : null}
      <ActionConfirmSheet
        id="commercial-exception-remove"
        open={Boolean(remove)}
        title="Удалить исключение?"
        summary={remove?.userName}
        confirmLabel="Удалить"
        onClose={() => setRemove(null)}
        onConfirm={() => {
          onChange({
            ...policy,
            exceptions: policy.exceptions.filter((entry) => entry.id !== remove?.id),
          });
          setRemove(null);
        }}
      />
    </>
  );
}
