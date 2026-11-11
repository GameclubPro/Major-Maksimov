import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  ChatSettingsFieldAdapter,
  ChatSettingsFieldValues,
  SettingsFieldState,
} from '../../features/network-settings/field-model';
import './reports-settings-fields.css';

type ReportsFieldPath =
  | 'reportsEnabled'
  | 'reportsThreshold'
  | 'reportsDeleteMode'
  | 'reportsMuteEnabled'
  | 'reportsMuteDurationHours'
  | 'reportsAliases';
type ReportsSettingsFieldsProps = {
  fields: Pick<
    ChatSettingsFieldAdapter,
    'read' | 'setScalar' | 'replaceList' | 'error' | 'setError' | 'readOnly'
  >;
  activationAvailable?: boolean;
  availabilityNote?: ReactNode;
};

function ReportMark({ kind }: { kind: 'message' | 'history' | 'commands' }) {
  const paths = {
    message: 'M5 4h14v13H9l-4 4V4Zm4 5h6m-6 4h4',
    history: 'M4 8a9 9 0 1 1-1 7M4 3v5h5m3 0v5l3 2',
    commands: 'm8 6-5 6 5 6m8-12 5 6-5 6m-3-14-2 16',
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={paths[kind]}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ReportSwitch({
  state,
  label,
  disabled,
  error,
  onChange,
}: {
  state: SettingsFieldState<boolean>;
  label: string;
  disabled: boolean;
  error: ReturnType<typeof reportErrorProps>;
  onChange: (enabled: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = state.kind === 'mixed';
  }, [state.kind]);
  return (
    <span className="reports-switch">
      <input
        ref={input}
        type="checkbox"
        role={state.kind === 'mixed' ? 'checkbox' : 'switch'}
        aria-label={label}
        aria-checked={state.kind === 'mixed' ? 'mixed' : state.kind === 'common' && state.value}
        checked={state.kind === 'common' && state.value}
        {...error}
        disabled={disabled || state.kind === 'loading'}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="reports-switch__track" aria-hidden="true" />
    </span>
  );
}

function reportErrorProps(field: ReportsFieldPath, error: string | null) {
  return {
    'aria-invalid': Boolean(error) || undefined,
    'aria-describedby': error ? `${field}-error` : undefined,
  };
}

// FLAG: Common values are presentation only; mixed fields stay untouched until an explicit edit.
export function ReportsSettingsFields({
  fields,
  activationAvailable = true,
  availabilityNote,
}: ReportsSettingsFieldsProps) {
  const common = <K extends ReportsFieldPath>(path: K): ChatSettingsFieldValues[K] | undefined => {
    const state = fields.read(path);
    return state.kind === 'common' ? state.value : undefined;
  };
  const reportsEnabled = common('reportsEnabled');
  const reportsThreshold = common('reportsThreshold');
  const reportsDeleteMode = common('reportsDeleteMode');
  const reportsMuteEnabled = common('reportsMuteEnabled');
  const reportsMuteDurationHours = common('reportsMuteDurationHours');
  const aliases = fields.read('reportsAliases');
  const aliasesKey = aliases.kind === 'common' ? JSON.stringify(aliases.value) : aliases.kind;
  const [aliasesBuffer, setAliasesBuffer] = useState<string | null>(null);
  useEffect(() => {
    if (aliasesBuffer === null) return;
    const parsed = aliasesBuffer
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (aliases.kind !== 'common' || JSON.stringify(parsed) !== JSON.stringify(aliases.value))
      setAliasesBuffer(null);
  }, [aliasesKey]);
  const aliasesText = aliasesBuffer ?? (aliases.kind === 'common' ? aliases.value.join(', ') : '');
  type NumberPath = 'reportsThreshold' | 'reportsMuteDurationHours';
  const [numberBuffers, setNumberBuffers] = useState<Partial<Record<NumberPath, string>>>({});
  const clearNumberBuffer = (path: NumberPath) =>
    setNumberBuffers((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
  useEffect(() => clearNumberBuffer('reportsThreshold'), [reportsThreshold]);
  useEffect(() => clearNumberBuffer('reportsMuteDurationHours'), [reportsMuteDurationHours]);
  const setFieldValue = <K extends Exclude<ReportsFieldPath, 'reportsAliases'>>(
    path: K,
    value: ChatSettingsFieldValues[K],
  ) => {
    try {
      fields.setError(path, null);
      fields.setScalar(path, value);
      if (path === 'reportsThreshold' || path === 'reportsMuteDurationHours')
        clearNumberBuffer(path);
    } catch (cause) {
      fields.setError(path, cause instanceof Error ? cause.message : 'Проверьте значение.');
    }
  };
  const editNumber = (path: NumberPath, raw: string, min: number, max: number) => {
    setNumberBuffers((current) => ({ ...current, [path]: raw }));
    const value = Number(raw);
    if (!raw.trim() || !Number.isInteger(value) || value < min || value > max) {
      fields.setError(path, `Укажите целое число от ${min} до ${max}.`);
      return;
    }
    try {
      fields.setError(path, null);
      fields.setScalar(path, value);
    } catch (cause) {
      fields.setError(path, cause instanceof Error ? cause.message : 'Проверьте значение.');
    }
  };
  const errorProps = (field: ReportsFieldPath) => ({
    ...reportErrorProps(field, fields.error(field)),
    disabled: fields.readOnly || fields.read(field).kind === 'loading',
  });
  const fieldError = (field: ReportsFieldPath) =>
    fields.error(field) ? (
      <small id={`${field}-error`} className="reports-field__error" role="alert">
        {fields.error(field)}
      </small>
    ) : null;
  const mixedNotice = (field: ReportsFieldPath) =>
    fields.read(field).kind === 'mixed' ? (
      <small className="field__hint">
        {field === 'reportsAliases'
          ? 'В сообществах разные команды. Изменение заменит список у выбранных сообществ.'
          : 'Разные значения'}
      </small>
    ) : null;
  return (
    <div className="reports-settings">
      {availabilityNote}
      <div className="reports-intro">
        <label className="reports-toggle reports-toggle--activation">
          <span>
            Жалобы участников
            <small>
              {reportsEnabled === undefined
                ? 'Разные значения'
                : reportsEnabled
                  ? 'Включены'
                  : 'Включите после настройки мер'}
            </small>
          </span>
          <ReportSwitch
            state={fields.read('reportsEnabled')}
            label="Жалобы участников"
            disabled={fields.readOnly || !activationAvailable}
            error={errorProps('reportsEnabled')}
            onChange={(value) => setFieldValue('reportsEnabled', value)}
          />
        </label>
        {fieldError('reportsEnabled')}
        {mixedNotice('reportsEnabled')}
        <p>
          <b>/report</b> или <b>жалоба</b> ответом на сообщение.
        </p>
      </div>
      <section className="reports-group reports-group--threshold">
        <div className="reports-group__heading">
          <span className="reports-group__number">01</span>
          <h3>Порог жалоб</h3>
        </div>
        <div className="reports-field">
          <span id="reports-threshold-label" className="field__label">
            Порог жалоб
          </span>
          <div
            className="reports-threshold-buttons"
            role="radiogroup"
            aria-labelledby="reports-threshold-label"
            aria-describedby={
              fields.error('reportsThreshold') ? 'reportsThreshold-error' : undefined
            }
            onKeyDown={(event) => {
              if (fields.readOnly) return;
              if (
                !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(
                  event.key,
                )
              )
                return;
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 2
                  : event.key === 'End'
                    ? 6
                    : Math.min(
                        6,
                        Math.max(
                          2,
                          (reportsThreshold ?? 2) +
                            (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1),
                        ),
                      );
              setFieldValue('reportsThreshold', next);
              event.currentTarget
                .querySelectorAll<HTMLButtonElement>('button')
                .item(next - 2)
                ?.focus();
            }}
          >
            {[2, 3, 4, 5, 6].map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-label={`${value} ${value < 5 ? 'голоса' : 'голосов'}`}
                aria-checked={reportsThreshold === value}
                tabIndex={
                  reportsThreshold === value || (reportsThreshold === undefined && value === 2)
                    ? 0
                    : -1
                }
                disabled={fields.readOnly}
                onClick={() => setFieldValue('reportsThreshold', value)}
              >
                {value}
              </button>
            ))}
          </div>
          <input
            className="reports-threshold-input"
            aria-label="Порог жалоб"
            type="number"
            min={2}
            max={6}
            step={1}
            value={numberBuffers.reportsThreshold ?? reportsThreshold ?? ''}
            placeholder="Разные значения"
            {...errorProps('reportsThreshold')}
            onChange={(event) => editNumber('reportsThreshold', event.target.value, 2, 6)}
          />
          <small>Нужны голоса разных участников по одному сообщению.</small>
          {fieldError('reportsThreshold')}
          {mixedNotice('reportsThreshold')}
        </div>
      </section>
      <section className="reports-group reports-group--measures">
        <div className="reports-group__heading">
          <span className="reports-group__number">02</span>
          <h3>Что произойдёт</h3>
        </div>
        <p className="reports-group__caption reports-mobile-copy">
          {reportsThreshold === undefined
            ? 'Порог отличается в сообществах'
            : `Когда наберётся ${reportsThreshold} ${reportsThreshold < 5 ? 'голоса' : 'голосов'}`}
        </p>
        <div className="reports-field">
          <span id="reports-delete-label" className="field__label reports-desktop-copy">
            Удаление
          </span>
          <div className="reports-delete-options" role="radiogroup" aria-label="Удаление">
            {[
              {
                value: 'MESSAGE' as const,
                title: 'Одно сообщение',
                description: 'То, на которое пожаловались',
                icon: 'message' as const,
              },
              {
                value: 'HISTORY_24H' as const,
                title: 'История за 24 часа',
                description: 'Сообщения автора за последние сутки',
                icon: 'history' as const,
              },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-label={option.title}
                aria-checked={reportsDeleteMode === option.value}
                tabIndex={
                  reportsDeleteMode === option.value ||
                  (reportsDeleteMode === undefined && option.value === 'MESSAGE')
                    ? 0
                    : -1
                }
                {...errorProps('reportsDeleteMode')}
                onKeyDown={(event) => {
                  if (fields.readOnly) return;
                  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
                    event.preventDefault();
                    const next = option.value === 'MESSAGE' ? 'HISTORY_24H' : 'MESSAGE';
                    setFieldValue('reportsDeleteMode', next);
                    const buttons =
                      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                        'button',
                      );
                    buttons?.[next === 'MESSAGE' ? 0 : 1]?.focus();
                  }
                }}
                onClick={() => setFieldValue('reportsDeleteMode', option.value)}
              >
                <span className="reports-option__icon">
                  <ReportMark kind={option.icon} />
                </span>
                <span className="reports-option__copy">
                  <strong>{option.title}</strong>
                  <small>{option.description}</small>
                </span>
                <span className="reports-option__check" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none">
                    <path
                      d="m4 8 3 3 5-6"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </button>
            ))}
          </div>
          <select
            className="reports-delete-select"
            aria-labelledby="reports-delete-label"
            value={reportsDeleteMode ?? ''}
            {...errorProps('reportsDeleteMode')}
            onChange={(event) =>
              setFieldValue('reportsDeleteMode', event.target.value as 'MESSAGE' | 'HISTORY_24H')
            }
          >
            {reportsDeleteMode === undefined ? (
              <option value="" disabled>
                Разные значения
              </option>
            ) : null}
            <option value="MESSAGE">Одно сообщение</option>
            <option value="HISTORY_24H">История за 24 ч</option>
          </select>
          {fieldError('reportsDeleteMode')}
          {mixedNotice('reportsDeleteMode')}
          <small className="reports-history-note">
            История охватывает только сообщения, которые бот видел за последние сутки.
          </small>
        </div>
        <label className="reports-toggle reports-toggle--mute">
          <span>
            Ограничить участника<small>Новые сообщения будут удаляться ботом.</small>
          </span>
          <ReportSwitch
            state={fields.read('reportsMuteEnabled')}
            label="Ограничить участника"
            disabled={fields.readOnly}
            error={errorProps('reportsMuteEnabled')}
            onChange={(value) => setFieldValue('reportsMuteEnabled', value)}
          />
        </label>
        {fieldError('reportsMuteEnabled')}
        {mixedNotice('reportsMuteEnabled')}
        {reportsMuteEnabled !== false && (
          <div className="reports-field reports-duration">
            <label htmlFor="reports-mute-duration" className="field__label">
              Длительность ограничения, ч
            </label>
            <div className="reports-duration-control">
              <button
                type="button"
                aria-label="Уменьшить длительность ограничения"
                disabled={
                  fields.readOnly ||
                  reportsMuteDurationHours === undefined ||
                  reportsMuteDurationHours <= 1
                }
                onClick={() =>
                  setFieldValue(
                    'reportsMuteDurationHours',
                    Math.max(1, (reportsMuteDurationHours ?? 1) - 1),
                  )
                }
              >
                −
              </button>
              <input
                id="reports-mute-duration"
                type="number"
                inputMode="numeric"
                min={1}
                max={24}
                step={1}
                value={numberBuffers.reportsMuteDurationHours ?? reportsMuteDurationHours ?? ''}
                placeholder="Разные значения"
                {...errorProps('reportsMuteDurationHours')}
                onChange={(event) =>
                  editNumber('reportsMuteDurationHours', event.target.value, 1, 24)
                }
              />
              <button
                type="button"
                aria-label="Увеличить длительность ограничения"
                disabled={
                  fields.readOnly ||
                  reportsMuteDurationHours === undefined ||
                  reportsMuteDurationHours >= 24
                }
                onClick={() =>
                  setFieldValue(
                    'reportsMuteDurationHours',
                    Math.min(24, (reportsMuteDurationHours ?? 1) + 1),
                  )
                }
              >
                +
              </button>
            </div>
            <div
              className="reports-duration-presets"
              role="group"
              aria-label="Быстрая настройка длительности"
            >
              {[1, 6, 12, 24].map((hours) => (
                <button
                  type="button"
                  key={hours}
                  disabled={fields.readOnly}
                  aria-pressed={reportsMuteDurationHours === hours}
                  onClick={() => setFieldValue('reportsMuteDurationHours', hours)}
                >
                  {hours} ч
                </button>
              ))}
            </div>
            {fieldError('reportsMuteDurationHours')}
            {mixedNotice('reportsMuteDurationHours')}
          </div>
        )}
      </section>
      <section className="reports-group reports-group--commands">
        <div className="reports-group__heading">
          <span className="reports-group__number">03</span>
          <h3>Как отправить жалобу</h3>
          <ReportMark kind="commands" />
        </div>
        <div className="reports-field">
          <span className="field__label reports-desktop-copy">Основные команды</span>
          <div className="reports-command-chips">
            <span>/report</span>
            <span>жалоба</span>
          </div>
          <small className="reports-mobile-copy">Ответом на сообщение, без вложений</small>
        </div>
        <label className="reports-field">
          <span className="field__label">Дополнительные команды, до 5</span>
          <input
            type="text"
            value={aliasesText}
            maxLength={170}
            placeholder={aliases.kind === 'mixed' ? 'Разные значения' : 'спам, /alert'}
            autoCapitalize="none"
            autoCorrect="off"
            {...errorProps('reportsAliases')}
            onChange={(event) => {
              setAliasesBuffer(event.target.value);
              try {
                fields.setError('reportsAliases', null);
                fields.replaceList(
                  'reportsAliases',
                  event.target.value
                    .split(',')
                    .map((part) => part.trim())
                    .filter(Boolean),
                );
              } catch (cause) {
                fields.setError(
                  'reportsAliases',
                  cause instanceof Error ? cause.message : 'Проверьте команды жалобы.',
                );
              }
            }}
          />
          <small>Перечислите команды через запятую.</small>
        </label>
        {fieldError('reportsAliases')}
        {mixedNotice('reportsAliases')}
      </section>
      <details className="reports-rules">
        <summary>Правила приёма жалоб</summary>
        <ul>
          <li>Команда отправляется без вложений, ответом на сообщение младше суток.</li>
          <li>
            Участник должен состоять в чате не менее 24 часов. Один участник — один голос на
            сообщение.
          </li>
          <li>
            Лимит — 10 разных сообщений за час. На администраторов и защищённых участников жалобы не
            действуют.
          </li>
          <li>
            Порог — от 2 до 6 голосов. Изменение настроек отменяет прежние незавершённые решения.
          </li>
          <li>
            Удалённые сообщения не восстанавливаются. Ограничение можно снять вручную в карточке
            участника.
          </li>
        </ul>
      </details>
    </div>
  );
}
