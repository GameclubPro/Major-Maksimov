import { describeUserFacingError } from '../../lib/user-facing-error';
import { AppIcon } from '../../components/ui/app-icon';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  NetworkNavigationAllowlistIntent,
  NetworkSettingsReadResponse,
} from '@maxim/contracts/network-settings';
import { networkNavigationAllowlistIntentSchema } from '@maxim/contracts/network-settings-read';
import {
  normalizeStoredAllowlistEntry,
  parseStoredAllowlistEntry,
  type NavigationAllowlistKind,
} from '@maxim/contracts/settings';
import type { ApiTransport } from '../../lib/api/transport';
import { getReportAvailability } from '../../lib/api/report-availability-client';
import { getAdminContactLabel } from '../../lib/admin-contact-profile-url';
import {
  readNetworkAdminContacts,
  resolveNetworkAdminContact,
  readNetworkNavigationAllowlist,
} from '../../lib/api/network-settings-client';
import type { SharedChatSettingsContext } from '../../pages/settings/shared-chat-settings-section';
import type {
  ChatSettingsFieldAdapter,
  ChatScalarFieldPath,
  SettingsFieldState,
} from './field-model';
import { PersonAvatar } from '../../components/ui/person-avatar';
import { DateField } from '../../components/ui/date-field';
import { TimeField } from '../../components/ui/time-field';
import { AdminContactToggleField } from '../../components/admin-contact-toggle-field';
import { AdminContactPickerPanel } from '../../components/admin-contact-picker-panel';
import {
  NAVIGATION_ALLOWLIST_TARGET_OPTIONS,
  getNavigationAllowlistTargetOption,
} from '../../pages/settings/settings-link-allowlist';
import { canonicalNetworkValue } from './network-settings-controller';
const SubscriptionSources = lazy(() =>
  import('./network-subscription-sources').then((module) => ({
    default: module.NetworkSubscriptionSources,
  })),
);
export type Scope = {
  entityType: 'chat';
  target: NetworkSettingsReadResponse['target'];
  section: NetworkSettingsReadResponse['section'];
  compositionVersion: string;
  requestId: string;
};
type Props = {
  api: ApiTransport;
  scopeId: string;
  read: NetworkSettingsReadResponse;
  fields: ChatSettingsFieldAdapter;
  navigationAllowlist?: NetworkNavigationAllowlistIntent;
  onNavigationAllowlist: (intent: NetworkNavigationAllowlistIntent | undefined) => void;
  onOpenLegacySites?: () => void;
  children: (context: SharedChatSettingsContext) => ReactNode;
};
const message = (cause: unknown) =>
  describeUserFacingError(cause, 'Не удалось проверить данные. Повторите поиск.');
export function NetworkSettingsMetadataFields(props: Props) {
  const key = canonicalNetworkValue({
    scopeId: props.scopeId,
    type: props.read.entityType,
    section: props.read.section,
    target: props.read.target,
    version: props.read.compositionVersion,
  });
  const scope = useMemo<Scope>(
    () => ({
      entityType: 'chat',
      target: props.read.target,
      section: props.read.section,
      compositionVersion: props.read.compositionVersion,
      requestId: crypto.randomUUID(),
    }),
    [key],
  );
  const context: SharedChatSettingsContext = {
    mode: 'network',
    commercialAiModerationMode: props.read.commercialAiModerationMode,
    api: props.api,
    linkRules:
      props.read.section === 'links' && props.onOpenLegacySites
        ? {
            onPolicyAuthored: () => props.onNavigationAllowlist(undefined),
            legacySites: (
              <button
                type="button"
                className="button button--ghost"
                onClick={props.onOpenLegacySites}
              >
                <AppIcon icon="Book" />
                Ранее настроенные сайты
                <AppIcon icon="NavArrowRight" />
              </button>
            ),
          }
        : undefined,
    navigationAllowlist:
      props.read.section === 'links' ? <Allowlist key={key} {...props} scope={scope} /> : undefined,
    requiredSubscriptionSources:
      props.read.section === 'requiredSubscription' ? (
        <Suspense fallback={<p role="status">Загружаем источники...</p>}>
          <SubscriptionSources key={key} api={props.api} scope={scope} fields={props.fields} />
        </Suspense>
      ) : undefined,
    renderAdminContact: (input) => (
      <AdminContact
        key={key + input.urlPath}
        api={props.api}
        scope={scope}
        fields={props.fields}
        recipients={props.read.recipients}
        {...input}
      />
    ),
    invitationActivationAvailable: false,
  };
  if (props.read.section === 'reports')
    return (
      <NetworkReportsMetadata
        api={props.api}
        scopeId={props.scopeId}
        read={props.read}
        fields={props.fields}
      >
        {(reports) => props.children({ ...context, ...reports })}
      </NetworkReportsMetadata>
    );
  return <>{props.children(context)}</>;
}

function NetworkReportsMetadata({
  api,
  scopeId,
  read,
  fields,
  children,
}: {
  api: ApiTransport;
  scopeId: string;
  read: NetworkSettingsReadResponse;
  fields: ChatSettingsFieldAdapter;
  children: (
    context: Pick<SharedChatSettingsContext, 'reportsActivationAvailable' | 'runtimeNotes'>,
  ) => ReactNode;
}) {
  const queryClient = useQueryClient();
  const recipientIds = read.recipients.map((recipient) => recipient.entityId);
  const availability = useQuery({
    queryKey: ['network-report-availability', scopeId, read.compositionVersion, recipientIds],
    queryFn: async ({ signal }) => {
      // FLAG: Canary availability belongs to each exact recipient; one chat cannot authorize the network.
      for (const chatId of recipientIds) {
        signal.throwIfAborted();
        const value = await queryClient.fetchQuery({
          queryKey: ['report-availability', chatId],
          queryFn: () => getReportAvailability(api, chatId, signal),
          staleTime: 0,
          retry: false,
        });
        signal.throwIfAborted();
        if (!value.reportsAvailable) return false;
      }
      return recipientIds.length > 0;
    },
    enabled: recipientIds.length > 0,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
  const enabled = fields.read('reportsEnabled');
  const persistedEnabled = read.fields.reportsEnabled;
  const available = !availability.isError && availability.data === true;
  return children({
    reportsActivationAvailable:
      available || (persistedEnabled?.kind === 'common' && persistedEnabled.value === true),
    runtimeNotes: {
      reports: available ? null : (
        <div className="reports-availability" role="status">
          <p>
            {availability.isPending
              ? 'Проверяем приём жалоб…'
              : availability.isError
                ? 'Не удалось проверить доступность жалоб.'
                : 'Приём жалоб доступен не во всех чатах сетки.'}
          </p>
          {enabled.kind === 'mixed' ? (
            <button
              type="button"
              className="button button--ghost"
              disabled={fields.readOnly}
              onClick={() => fields.setScalar('reportsEnabled', false)}
            >
              Выключить во всей сетке
            </button>
          ) : null}
        </div>
      ),
    },
  });
}

type Contact = Awaited<ReturnType<typeof readNetworkAdminContacts>>['items'][number];
function AdminContact({
  api,
  scope,
  fields,
  recipients,
  enabledPath,
  urlPath,
  label,
  ariaLabel = label,
  presentation,
}: {
  api: ApiTransport;
  scope: Scope;
  fields: ChatSettingsFieldAdapter;
  recipients: NetworkSettingsReadResponse['recipients'];
  enabledPath: ChatScalarFieldPath;
  urlPath: ChatScalarFieldPath;
  label: string;
  ariaLabel?: string;
  presentation?: 'rules';
}) {
  const latestFields = useRef(fields);
  latestFields.current = fields;
  const enabled = fields.read(enabledPath) as SettingsFieldState<boolean>;
  const url = fields.read(urlPath) as SettingsFieldState<string>;
  const [selectedContact, setSelectedContact] = useState<{ url: string; name: string } | null>(
    null,
  );
  const contactLabel =
    url.kind === 'mixed'
      ? 'Разные администраторы'
      : url.kind === 'loading'
        ? 'Загрузка…'
        : url.value
          ? selectedContact?.url === url.value
            ? selectedContact.name
            : getAdminContactLabel(url.value)
          : 'Администратор не выбран';
  const enabledSummary =
    enabled.kind === 'mixed'
      ? 'Разные значения'
      : enabled.kind === 'loading'
        ? 'Загрузка…'
        : enabled.value
          ? 'Включено'
          : 'Выключено';
  const urlKey = canonicalNetworkValue(url);
  const latestUrlKey = useRef(urlKey);
  const urlVersion = useRef(0);
  if (latestUrlKey.current !== urlKey) urlVersion.current++;
  latestUrlKey.current = urlKey;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<Contact[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    scanned: number;
    total: number;
    incomplete: number;
    unavailable: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const close = useCallback(() => {
    generation.current++;
    setBusy(false);
    setOpen(false);
  }, []);
  const load = async () => {
    if (fields.readOnly || busy) return;
    const revision = ++generation.current;
    setBusy(true);
    setError(null);
    setOpen(true);
    try {
      const result = await readNetworkAdminContacts(api, {
        ...scope,
        ...(cursor ? { cursor } : {}),
      });
      if (generation.current !== revision) return;
      if (
        result.requestId !== scope.requestId ||
        result.compositionVersion !== scope.compositionVersion
      )
        throw new Error('Состав изменился. Откройте выбор заново.');
      setItems((old) => [
        ...new Map([...old, ...result.items].map((item) => [item.userId, item])).values(),
      ]);
      setSessionId(result.sessionId);
      setCursor(result.nextCursor);
      setProgress({
        scanned: result.scannedSources,
        total: result.totalSources,
        incomplete: result.incompleteSources.length,
        unavailable: result.unavailableSources.length,
      });
    } catch (cause) {
      if (generation.current === revision) setError(message(cause));
    } finally {
      if (generation.current === revision) setBusy(false);
    }
  };
  const choose = async (contact: Contact, sourceEntityId: string) => {
    if (!sessionId || busy || fields.readOnly) return;
    const revision = ++generation.current;
    const originalUrlVersion = urlVersion.current;
    setBusy(true);
    setError(null);
    try {
      const result = await resolveNetworkAdminContact(api, {
        ...scope,
        cursor: sessionId,
        sourceEntityId,
        userId: contact.userId,
      });
      if (generation.current !== revision) return;
      if (
        result.requestId !== scope.requestId ||
        result.compositionVersion !== scope.compositionVersion ||
        result.contact.userId !== contact.userId
      )
        throw new Error('Выбор изменился. Откройте его заново.');
      const current = latestFields.current;
      if (current.readOnly) return;
      if (urlVersion.current !== originalUrlVersion)
        throw new Error('Ссылка изменена. Выберите администратора заново.');
      current.transact([
        { op: 'set', path: urlPath, value: result.contact.url },
        { op: 'set', path: enabledPath, value: true },
      ]);
      setSelectedContact({
        url: result.contact.url,
        name: result.contact.displayName || 'Администратор',
      });
      setOpen(false);
    } catch (cause) {
      if (generation.current === revision) setError(message(cause));
    } finally {
      if (generation.current === revision) setBusy(false);
    }
  };
  const visibleItems = items.filter((item) =>
    (item.displayName ?? item.userId)
      .toLocaleLowerCase('ru-RU')
      .includes(search.trim().toLocaleLowerCase('ru-RU')),
  );
  return (
    <AdminContactToggleField
      title={label}
      ariaLabel={ariaLabel}
      checked={enabled.kind === 'mixed' ? 'mixed' : enabled.kind === 'common' && enabled.value}
      selectedName={contactLabel}
      disabled={fields.readOnly || busy || enabled.kind === 'loading' || url.kind === 'loading'}
      meta={presentation === 'rules' ? enabledSummary : undefined}
      className={presentation === 'rules' ? 'rules-native-card' : undefined}
      onChange={(next) => {
        if (next) void load();
        else fields.setScalar(enabledPath, false as never);
      }}
      onOpen={() => void load()}
    >
      {open ? (
        <AdminContactPickerPanel
          title="Администраторы чатов"
          search={search}
          onSearch={setSearch}
          onClose={close}
        >
          <div className="admin-contact-picker__list" aria-busy={busy}>
            <p className="field__hint">
              Показываем подтверждённых администраторов выбранных чатов. Список может быть неполным.
            </p>
            {progress ? (
              <p className="field__hint">
                Проверено чатов: {progress.scanned} из {progress.total}. Неполные ответы:{' '}
                {progress.incomplete}; недоступно: {progress.unavailable}.
              </p>
            ) : null}
            {busy ? <p role="status">Загрузка администраторов...</p> : null}
            {error ? (
              <div className="admin-contact-picker__status" role="alert">
                <p>{error}</p>
                <button
                  type="button"
                  disabled={busy || fields.readOnly}
                  onClick={() => void load()}
                >
                  <AppIcon
                    icon="RefreshDouble"
                    width="1.5em"
                    height="1.5em"
                    style={{ strokeWidth: 1.5 }}
                    aria-hidden
                  />
                  Повторить
                </button>
              </div>
            ) : null}
            {!busy && !error && !visibleItems.length ? (
              <p role="status">
                {search.trim()
                  ? 'Ничего не найдено.'
                  : cursor
                    ? 'Поиск администраторов...'
                    : 'Администраторы не найдены.'}
              </p>
            ) : null}
            {visibleItems.map((item) => (
              <button
                key={item.userId}
                type="button"
                className="admin-contact-picker__option"
                disabled={busy || fields.readOnly || !item.sources.length}
                aria-pressed={
                  enabled.kind === 'common' &&
                  enabled.value &&
                  url.kind === 'common' &&
                  url.value === item.url
                }
                onClick={() => {
                  if (item.sources[0]) void choose(item, item.sources[0]);
                }}
              >
                <PersonAvatar
                  avatarUrl={null}
                  fallback={(item.displayName ?? 'Администратор').slice(0, 1)}
                  className="admin-contact-picker__avatar"
                />
                <span className="admin-contact-picker__copy">
                  <span>{item.displayName ?? 'Администратор'}</span>
                  <small>
                    {item.sources
                      .map(
                        (source) =>
                          recipients.find((recipient) => recipient.entityId === source)?.title ||
                          'Подтверждённый чат',
                      )
                      .join(', ')}
                  </small>
                </span>
                {enabled.kind === 'common' &&
                enabled.value &&
                url.kind === 'common' &&
                url.value === item.url ? (
                  <AppIcon
                    icon="Check"
                    width="1.5em"
                    height="1.5em"
                    style={{ strokeWidth: 1.5 }}
                    aria-hidden
                  />
                ) : null}
              </button>
            ))}
            {cursor ? (
              <button
                type="button"
                className="admin-contact-picker__more"
                disabled={fields.readOnly || busy}
                onClick={() => void load()}
              >
                {busy ? 'Загрузка...' : 'Показать ещё'}
              </button>
            ) : null}
          </div>
        </AdminContactPickerPanel>
      ) : null}
      {!open && error ? (
        <small className="field__hint" role="alert">
          {error}
        </small>
      ) : null}
      {fields.error(urlPath) ? (
        <small className="field__hint" role="alert">
          {fields.error(urlPath)}
        </small>
      ) : null}
    </AdminContactToggleField>
  );
}

type AllowlistEntry = Awaited<ReturnType<typeof readNetworkNavigationAllowlist>>['entries'][number];
function entryTargetLabel(entry: AllowlistEntry) {
  if (entry.kind === 'MAX_PROFILE' && entry.value.startsWith('user-id:'))
    return `max://user/${entry.value.slice(8)}`;
  if (entry.kind === 'MAX_PROFILE' && entry.value.startsWith('username:'))
    return `@${entry.value.slice(9)}`;
  if (entry.value.startsWith('url:')) return entry.value.slice(4);
  if (entry.kind === 'MAX_ENTITY' && entry.value.startsWith('chat-id:'))
    return `Прежний номер чата: ${entry.value.slice(8)}`;
  if (entry.kind === 'MINI_APP' && entry.value.startsWith('bot:'))
    return `Бот MAX: ${entry.value.slice(4)}`;
  if (entry.kind === 'MINI_APP' && entry.value.startsWith('contact-id:'))
    return `Приложение MAX: ${entry.value.slice(11)}`;
  return entry.value;
}
function localDate(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
function Allowlist({
  api,
  read,
  fields,
  scope,
  navigationAllowlist,
  onNavigationAllowlist,
}: Props & { scope: Scope }) {
  const [entityId, setEntityId] = useState(read.recipients[0]?.entityId ?? '');
  const selectedEntityId = useId();
  const errorId = useId();
  const selectedEntity = read.recipients.find((recipient) => recipient.entityId === entityId);
  const [entries, setEntries] = useState<AllowlistEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [kind, setKind] = useState<NavigationAllowlistKind>('WEB_DOMAIN');
  const [scheduleTarget, setScheduleTarget] = useState<AllowlistEntry | null>(null);
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleTime, setScheduleTime] = useState('');
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const load = async () => {
    if (busy || !entityId) return;
    const revision = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const result = await readNetworkNavigationAllowlist(api, {
        ...scope,
        entityId,
        ...(cursor ? { cursor } : {}),
      });
      if (generation.current !== revision) return;
      if (result.entityId !== entityId || result.compositionVersion !== scope.compositionVersion)
        throw new Error('Состав изменился. Загрузите список заново.');
      setEntries((old) =>
        cursor
          ? [
              ...new Map(
                [...old, ...result.entries].map((entry) => [entry.kind + entry.value, entry]),
              ).values(),
            ]
          : result.entries,
      );
      setCursor(result.nextCursor);
      setTotal(result.totalEntries);
      setLoaded(true);
    } catch (cause) {
      if (generation.current === revision) setError(message(cause));
    } finally {
      if (generation.current === revision) setBusy(false);
    }
  };
  const authorEntry = (
    op: 'add' | 'remove' | 'setExpiry' | 'replace',
    target: { value: string; kind: NavigationAllowlistKind },
    removeAfterAt: string | null = null,
  ) => {
    if (fields.readOnly) return false;
    try {
      if (
        removeAfterAt &&
        (!Number.isFinite(Date.parse(removeAfterAt)) ||
          Date.parse(removeAfterAt) <= Date.now() + 30_000)
      )
        throw new Error('Выберите время удаления хотя бы на 30 секунд позже текущего.');
      const next =
        op === 'replace'
          ? {
              mode: 'replace',
              entries: [
                ...(navigationAllowlist?.mode === 'replace' ? navigationAllowlist.entries : []),
                { ...target, removeAfterAt },
              ],
            }
          : {
              mode: 'edit',
              actions: [
                ...(navigationAllowlist?.mode === 'edit' ? navigationAllowlist.actions : []),
                op === 'remove' ? { op, target } : { op, target, removeAfterAt },
              ],
            };
      onNavigationAllowlist(networkNavigationAllowlistIntentSchema.parse(next));
      setError(null);
      return true;
    } catch (cause) {
      setError(message(cause));
      return false;
    }
  };
  const scheduledAt = () => {
    if (!scheduleDate && !scheduleTime) return null;
    if (!scheduleDate || !scheduleTime) throw new Error('Укажите день и время удаления.');
    return new Date(`${scheduleDate}T${scheduleTime}`).toISOString();
  };
  const author = (op: 'add' | 'remove' | 'setExpiry' | 'replace') => {
    try {
      const stored = normalizeStoredAllowlistEntry(value, kind);
      const normalized = stored ? parseStoredAllowlistEntry(stored) : null;
      if (!normalized) throw new Error(getNavigationAllowlistTargetOption(kind).invalidMessage);
      if (
        authorEntry(op, { value: normalized.target, kind }, op === 'remove' ? null : scheduledAt())
      ) {
        setValue('');
        setScheduleDate('');
        setScheduleTime('');
      }
    } catch (cause) {
      setError(message(cause));
    }
  };
  const scheduleFields = (
    <div className="allowlist-item__schedule-fields">
      <DateField
        className="allowlist-item__schedule-field"
        label="День удаления"
        value={scheduleDate}
        min={localDate(new Date())}
        disabled={fields.readOnly}
        onChange={(next) => {
          setScheduleDate(next);
          setError(null);
        }}
      />
      <div className="field allowlist-item__schedule-field">
        <TimeField
          className="allowlist-item__schedule-time"
          label="Время удаления"
          variant="embedded"
          value={scheduleTime}
          disabled={fields.readOnly}
          allowEmpty
          clearable
          onChange={(next) => {
            setScheduleTime(next);
            setError(null);
          }}
        />
      </div>
    </div>
  );
  return (
    <div className="allowlist-workspace" aria-label="Разрешённые ссылки">
      <div className={`field allowlist-panel${error ? ' allowlist-panel--error' : ''}`}>
        <div className="allowlist-panel__head">
          <span className="field__label">Разрешённые ссылки</span>
        </div>
        <div className="allowlist-composer">
          <label className="allowlist-composer__head">
            <span className="field__label allowlist-composer__label">Что разрешить</span>
            <select
              className="button button--ghost"
              value={kind}
              disabled={fields.readOnly}
              onChange={(event) => {
                setKind(event.target.value as NavigationAllowlistKind);
                setError(null);
              }}
              aria-label="Что разрешить"
            >
              {NAVIGATION_ALLOWLIST_TARGET_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="allowlist-add-row">
            <input
              type="text"
              inputMode={getNavigationAllowlistTargetOption(kind).inputMode}
              value={value}
              disabled={fields.readOnly}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (value.trim()) author('add');
                }
              }}
              placeholder={getNavigationAllowlistTargetOption(kind).placeholder}
              aria-label={getNavigationAllowlistTargetOption(kind).ariaLabel}
            />
            {value.trim() ? (
              <button
                type="button"
                className="button button--accent allowlist-add-row__button"
                disabled={fields.readOnly}
                onClick={() => author('add')}
              >
                Добавить
              </button>
            ) : null}
          </div>
        </div>
        {error ? (
          <small id={errorId} className="field__hint" role="alert">
            {error}
          </small>
        ) : null}
        <p className="settings-native-toggle__hint">
          Добавление и удаление сохраняют остальные записи каждого чата. Полная замена задаёт
          одинаковый список всем получателям.
        </p>
        <label className="field">
          <span>Просмотреть сохранённый список</span>
          <select
            value={entityId}
            aria-describedby={selectedEntityId}
            disabled={busy}
            onChange={(event) => {
              generation.current++;
              setBusy(false);
              setEntityId(event.target.value);
              setEntries([]);
              setCursor(null);
              setLoaded(false);
              setError(null);
              setScheduleTarget(null);
            }}
          >
            {read.recipients.map((row) => (
              <option key={row.entityId} value={row.entityId}>
                {row.title}
              </option>
            ))}
          </select>
        </label>
        <p id={selectedEntityId} className="field__hint">
          Выбранный чат: <strong>{selectedEntity?.title || 'Чат'}</strong>
        </p>
        <div className="managed-giveaway__section-actions">
          <button
            type="button"
            className="button button--ghost"
            disabled={busy || !entityId}
            onClick={() => void load()}
          >
            {cursor ? 'Загрузить следующие записи' : loaded ? 'Обновить список' : 'Показать список'}
          </button>
        </div>
        {busy ? (
          <p className="allowlist-empty" role="status">
            Загрузка...
          </p>
        ) : null}
        {loaded ? (
          <>
            <p className="field__hint">
              Записей: {total}. Загружено: {entries.length}.
            </p>
            {entries.length ? (
              <div className="allowlist-results">
                <ul className="allowlist-list" aria-label="Разрешённые ссылки">
                  {entries.map((entry) => {
                    const targetLabel = entryTargetLabel(entry);
                    const isScheduleOpen =
                      scheduleTarget?.kind === entry.kind && scheduleTarget.value === entry.value;
                    const scheduledAtLabel = entry.removeAfterAt
                      ? new Date(entry.removeAfterAt).toLocaleString('ru-RU')
                      : '';
                    return (
                      <li
                        key={entry.kind + entry.value}
                        className="allowlist-item allowlist-item--domain"
                      >
                        <div className="allowlist-item__stack">
                          <div className="allowlist-item__header">
                            <div className="allowlist-item__lead">
                              <span className="allowlist-item__domain" title={targetLabel}>
                                {targetLabel}
                              </span>
                              <small className="allowlist-item__type">
                                {getNavigationAllowlistTargetOption(entry.kind).label} ·{' '}
                                {scheduledAtLabel ? `до ${scheduledAtLabel}` : 'без срока'}
                              </small>
                            </div>
                            <div className="allowlist-item__actions">
                              <button
                                type="button"
                                className={`allowlist-item__action allowlist-item__action--schedule${isScheduleOpen ? ' is-open' : ''}`}
                                disabled={fields.readOnly}
                                aria-label={
                                  isScheduleOpen
                                    ? `Закрыть выбор срока для ${targetLabel}`
                                    : scheduledAtLabel
                                      ? `Изменить срок для ${targetLabel}`
                                      : `Задать срок для ${targetLabel}`
                                }
                                title={
                                  isScheduleOpen
                                    ? 'Закрыть'
                                    : scheduledAtLabel
                                      ? 'Изменить срок'
                                      : 'Задать срок'
                                }
                                onClick={() => {
                                  if (isScheduleOpen) {
                                    setScheduleTarget(null);
                                    return;
                                  }
                                  const when = new Date(
                                    entry.removeAfterAt || Date.now() + 3_600_000,
                                  );
                                  setScheduleTarget(entry);
                                  setScheduleDate(localDate(when));
                                  setScheduleTime(
                                    `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`,
                                  );
                                  setError(null);
                                }}
                              >
                                <AppIcon
                                  icon="Calendar"
                                  width="1.5em"
                                  height="1.5em"
                                  style={{ strokeWidth: 1.5 }}
                                  aria-hidden
                                />
                              </button>
                              <button
                                type="button"
                                className="allowlist-item__action allowlist-item__action--remove"
                                disabled={fields.readOnly}
                                aria-label={`Удалить ${targetLabel}`}
                                title="Удалить"
                                onClick={() =>
                                  authorEntry('remove', { kind: entry.kind, value: entry.value })
                                }
                              >
                                <AppIcon
                                  icon="Trash"
                                  width="1.5em"
                                  height="1.5em"
                                  style={{ strokeWidth: 1.5 }}
                                  aria-hidden
                                />
                              </button>
                            </div>
                          </div>
                          {isScheduleOpen ? (
                            <div
                              className="allowlist-item__schedule-editor"
                              role="group"
                              aria-label={`План удаления ${targetLabel}`}
                            >
                              {scheduleFields}
                              <div className="allowlist-item__schedule-actions">
                                <button
                                  type="button"
                                  className="button button--accent"
                                  disabled={fields.readOnly}
                                  onClick={() => {
                                    try {
                                      const when = scheduledAt();
                                      if (!when) throw new Error('Укажите день и время удаления.');
                                      if (
                                        authorEntry(
                                          'setExpiry',
                                          { kind: entry.kind, value: entry.value },
                                          when,
                                        )
                                      ) {
                                        setScheduleTarget(null);
                                        setScheduleDate('');
                                        setScheduleTime('');
                                      }
                                    } catch (cause) {
                                      setError(message(cause));
                                    }
                                  }}
                                >
                                  Сохранить
                                </button>
                                {entry.removeAfterAt ? (
                                  <button
                                    type="button"
                                    className="button button--ghost"
                                    disabled={fields.readOnly}
                                    onClick={() => {
                                      if (
                                        authorEntry(
                                          'setExpiry',
                                          { kind: entry.kind, value: entry.value },
                                          null,
                                        )
                                      ) {
                                        setScheduleTarget(null);
                                        setScheduleDate('');
                                        setScheduleTime('');
                                      }
                                    }}
                                  >
                                    Убрать таймер
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <p className="allowlist-empty">Пока пусто</p>
            )}
          </>
        ) : null}
        <details className="allowlist-panel">
          <summary>Действия со списками всей сетки</summary>
          <p className="field__hint">
            Используется значение из поля «Что разрешить». Изменения сначала появятся в
            предпросмотре.
          </p>
          {!scheduleTarget ? scheduleFields : null}
          <div className="managed-giveaway__section-actions">
            {(['remove', 'setExpiry', 'replace'] as const).map((op) => (
              <button
                type="button"
                className="button button--ghost"
                key={op}
                disabled={fields.readOnly || !value.trim()}
                onClick={() => author(op)}
              >
                {op === 'remove'
                  ? 'Удалить из всех списков'
                  : op === 'setExpiry'
                    ? 'Изменить срок во всех списках'
                    : 'Добавить в список для полной замены'}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="button button--ghost"
            disabled={fields.readOnly}
            onClick={() => onNavigationAllowlist({ mode: 'replace', entries: [] })}
          >
            Заменить все списки пустым
          </button>
        </details>
        {navigationAllowlist ? (
          <div className="allowlist-panel">
            <p className="field__hint">
              {navigationAllowlist.mode === 'replace'
                ? 'Полная замена · записей: ' + navigationAllowlist.entries.length
                : 'Выбрано действий: ' + navigationAllowlist.actions.length}
            </p>
            <button
              type="button"
              className="button button--ghost"
              disabled={fields.readOnly}
              onClick={() => onNavigationAllowlist(undefined)}
            >
              Отменить все изменения разрешённых ссылок
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
