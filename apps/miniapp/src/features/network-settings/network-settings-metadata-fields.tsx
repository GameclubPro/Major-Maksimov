import { describeUserFacingError } from '../../lib/user-facing-error';
import { AppIcon } from '../../components/ui/app-icon';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  NetworkNavigationAllowlistIntent,
  NetworkSettingsReadResponse,
} from '@maxim/contracts/network-settings';
import type { ApiTransport } from '../../lib/api/transport';
import { getReportAvailability } from '../../lib/api/report-availability-client';
import { getAdminContactLabel } from '../../lib/admin-contact-profile-url';
import {
  readNetworkAdminContacts,
  resolveNetworkAdminContact,
} from '../../lib/api/network-settings-client';
import type { SharedChatSettingsContext } from '../../pages/settings/shared-chat-settings-section';
import type {
  ChatSettingsFieldAdapter,
  ChatScalarFieldPath,
  SettingsFieldState,
} from './field-model';
import { PersonAvatar } from '../../components/ui/person-avatar';
import { AdminContactToggleField } from '../../components/admin-contact-toggle-field';
import { AdminContactPickerPanel } from '../../components/admin-contact-picker-panel';
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
