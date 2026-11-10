import { StorefrontPublicationPreviewContext } from './storefront-publication-preview';
import {
  StorefrontScreen,
  useStorefrontBack,
  useStorefrontWorkspace,
} from './storefront-workspace';
import ShopPublicationsEntry from './karavan-shop/publications-entry';
import KaravanShopManager from './karavan-shop/manager';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  KaravanMarketplaceSetup,
  KaravanMarketplaceOperation,
} from '@maxim/contracts/karavan-marketplace';
import type { ApiTransport } from '../../lib/api/transport';
import {
  getKaravanMarketplace,
  getKaravanMarketplaceOperation,
  setupKaravanMarketplace,
  saveKaravanPublicationChoice,
  cancelKaravanMarketplaceSetup,
  getKaravanConnection,
} from '../../lib/api/karavan-marketplace-client';
import { describeUserFacingError } from '../../lib/user-facing-error';
import { openKaravanStorefront } from '../../lib/karavan-storefront-navigation';
import { karavanAccessMessage } from '../../lib/karavan-storefront-access';
import KaravanMarketplaceWizard from './karavan-marketplace-wizard';
import { useKaravanMarketplaceBinding } from './use-karavan-marketplace-binding';
import { shopSetupDraftKey, type ShopSetupIntent } from './karavan-shop/setup-intent';
import { readShopSetupRecovery, type ShopSetupRecovery } from './karavan-shop/setup-recovery';
import ConnectionRecovery from './karavan-connection-recovery';
import { continueShopSetup } from './karavan-shop/setup-continuation';
import { Spinner } from '../../components/ui/spinner';
import '../../styles/karavan-marketplace.css';

export default function KaravanMarketplacePanel({
  api,
  chatId,
  publications,
}: {
  api: ApiTransport;
  chatId: string;
  publications?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const workspace = useStorefrontWorkspace();
  const queryKey = ['karavan-marketplace', chatId] as const;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getKaravanMarketplace(api, chatId, signal),
    staleTime: 15_000,
    refetchOnMount: 'always',
    retry: false,
  });
  // FLAG: The owned journal remains readable when the provider's current module
  // is unavailable. Reading this fallback never resumes a connection.
  const fallback = useQuery({
    queryKey: ['karavan-connection-fallback', chatId],
    queryFn: () => getKaravanConnection(api, chatId),
    enabled: query.isError,
    retry: false,
  });
  const module = query.data?.enabled ? query.data : null;
  const storageKey = module ? `${module.actorMaxUserId}:${chatId}` : null;
  const liveStorageKey = useRef(storageKey);
  liveStorageKey.current = storageKey;
  useEffect(
    () => () => {
      liveStorageKey.current = null;
    },
    [],
  );
  const [setupIntent, setSetupIntent] = useState<ShopSetupIntent | null>(null);
  const [saved, setSaved] = useState<KaravanMarketplaceSetup | null>(null);
  const [operation, setOperation] = useState<KaravanMarketplaceOperation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const [retryOpen, setRetryOpen] = useState(false);
  const [checkingShopCommand, setCheckingShopCommand] = useState(false);
  const [legacySetup, setLegacySetup] = useState<ShopSetupRecovery | null>(null);
  const [legacyBusy, setLegacyBusy] = useState(false);
  const observedSetup = useRef<KaravanMarketplaceOperation | null>(null);
  const observedSetupRevision = useRef<number | null>(null);
  const dismissedSetup = useRef<string | null>(null);
  const startingSetup = useRef(false);
  const submittedSetup = useRef<{ key: string; operationId: string } | null>(null);
  const returningFromShop = useRef(false);
  const supported = module?.connection?.version === 2;
  const localOnlyRecovery = true;
  const bind = useKaravanMarketplaceBinding(
    api,
    chatId,
    module?.actorMaxUserId,
    module?.binding,
    false,
    module?.connection,
  );
  const canEnter = Boolean(
    module?.marketplace &&
    module.permissions.length > 0 &&
    module.binding?.chatId === chatId &&
    module.binding.state === 'verified' &&
    (!module.access || module.access.reason === 'allowed'),
  );
  useLayoutEffect(() => {
    if (!canEnter && workspace?.page === 'publications') workspace.navigate('home');
  }, [canEnter, workspace?.page, workspace?.navigate]);
  useEffect(() => {
    startingSetup.current = false;
    submittedSetup.current = null;
    observedSetup.current = null;
    observedSetupRevision.current = null;
    dismissedSetup.current = null;
    setSaved(null);
    setOperation(null);
    setSetupIntent(null);
    setNotice(null);
    setCreated(false);
    setRetryOpen(false);
    returningFromShop.current = false;
    setLegacySetup(null);
    setLegacyBusy(false);
    setCheckingShopCommand(false);
    setPendingManagerOpen(false);
    setDisconnectConfirm(false);
  }, [storageKey]);
  const serverSetup =
    module?.connection?.operation?.kind === 'setup' ? module.connection.operation.operation : null;
  useEffect(() => {
    const snapshot = module?.connection;
    if (!storageKey || !snapshot) return;
    const revision = observedSetupRevision.current;
    if (revision !== null && snapshot.revision < revision) return;
    if (!serverSetup) {
      // FLAG: A newer authoritative scope can retire a restored recovery view.
      // A locally submitted request still retains its lost-response identity.
      if (revision !== null && snapshot.revision > revision && !submittedSetup.current) {
        observedSetup.current = null;
        observedSetupRevision.current = snapshot.revision;
        setSaved(null);
        setOperation(null);
      }
      return;
    }
    if (dismissedSetup.current === serverSetup.operationId) return;
    const observed = observedSetup.current;
    // FLAG: A stale module response cannot undo a receipt observed by explicit
    // status, including completed steps of a partially connected operation.
    if (
      observed?.operationId === serverSetup.operationId &&
      (['complete', 'cancelled', 'rejected'].includes(observed.state) ||
        (observed.checkpoints.marketplaceId && !serverSetup.checkpoints.marketplaceId) ||
        observed.checkpoints.bindings.some(
          (item) =>
            item.state === 'connected' &&
            serverSetup.checkpoints.bindings.find((other) => other.chatId === item.chatId)
              ?.state !== 'connected',
        ))
    )
      return;
    const submitted = submittedSetup.current;
    if (submitted?.key === storageKey && submitted.operationId !== serverSetup.operationId) return;
    observedSetup.current = serverSetup;
    observedSetupRevision.current = snapshot.revision;
    setOperation(serverSetup);
    setSaved(['complete', 'cancelled'].includes(serverSetup.state) ? null : serverSetup.request);
  }, [storageKey, serverSetup, module?.connection]);
  const [pendingManagerOpen, setPendingManagerOpen] = useState(false);
  useStorefrontBack(
    () => setPendingManagerOpen(false),
    pendingManagerOpen && workspace?.page === 'home',
  );
  const publicationEntry =
    publications && canEnter ? <ShopPublicationsEntry>{publications}</ShopPublicationsEntry> : null;
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const chats = useQuery({
    queryKey: ['karavan-setup-chats'],
    enabled: !!saved,
    queryFn: async () => (await import('../../lib/api/root-client')).getChats(api),
    staleTime: 30_000,
    retry: false,
  });
  const acceptSetup = (state: KaravanMarketplaceOperation) => {
    observedSetup.current = state;
    setOperation(state);
    setSaved(state.request);
    setNotice(null);
    if (state.state === 'complete' || state.state === 'cancelled') {
      setCreated(state.state === 'complete' && !!state.request.create);
      setSaved(null);
      setSetupIntent(null);
      startingSetup.current = false;
      submittedSetup.current = null;
      void queryClient.invalidateQueries({ queryKey });
    } else if (
      state.checkpoints.bindings.some(
        (item) => item.chatId === chatId && item.state === 'connected',
      )
    ) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };
  const setup = useMutation({
    mutationFn: (input: KaravanMarketplaceSetup) =>
      continueShopSetup(
        input,
        (request) => setupKaravanMarketplace(api, chatId, request),
        () =>
          liveStorageKey.current === storageKey &&
          submittedSetup.current?.operationId === input.operationId,
      ),
    onSuccess: (state) => {
      // FLAG: Late responses cannot replace another actor/chat or a newer intent.
      if (
        liveStorageKey.current !== storageKey ||
        submittedSetup.current?.key !== storageKey ||
        submittedSetup.current.operationId !== state.operationId
      )
        return;
      acceptSetup(state);
    },
    onError: (cause, request) => {
      if (
        liveStorageKey.current !== storageKey ||
        submittedSetup.current?.key !== storageKey ||
        submittedSetup.current.operationId !== request.operationId
      )
        return;
      setNotice(
        describeUserFacingError(cause, 'Результат пока не подтверждён. Проверьте подключение.'),
      );
      void queryClient.invalidateQueries({ queryKey });
    },
    onSettled: (_data, _error, input) => {
      if (
        submittedSetup.current?.key === storageKey &&
        submittedSetup.current.operationId === input.operationId
      )
        startingSetup.current = false;
    },
  });
  useEffect(() => {
    const refresh = () => {
      if (!returningFromShop.current || document.visibilityState === 'hidden') return;
      returningFromShop.current = false;
      setRetryOpen(false);
      setNotice(null);
      void queryClient.invalidateQueries({ queryKey: ['karavan-marketplace', chatId] });
      void queryClient.invalidateQueries({ queryKey: ['karavan-shop', { chatId }] });
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [chatId, queryClient]);
  const viewLabel =
    module?.marketplace?.format === 'storefront' ? 'Посмотреть витрину' : 'Посмотреть магазин чата';
  const openShop = () => {
    if (module?.marketplace?.status !== 'active' || !module.buyerUrl) return;
    if (!openKaravanStorefront(module.buyerUrl)) {
      setRetryOpen(true);
      setNotice('Не удалось открыть магазин. Повторите переход.');
      return;
    }
    returningFromShop.current = true;
    setRetryOpen(false);
    setNotice(null);
  };
  const cancelSetup = useMutation({
    mutationFn: (original: { key: string; id: string }) =>
      cancelKaravanMarketplaceSetup(api, chatId, original.id),
    onSuccess: (state, original) => {
      if (liveStorageKey.current !== original.key || saved?.operationId !== original.id) return;
      acceptSetup(state);
      setNotice('Подключение остановлено. Магазин и подключённые чаты сохранены.');
    },
    onError: (cause, original) => {
      if (liveStorageKey.current !== original.key || saved?.operationId !== original.id) return;
      setNotice(
        describeUserFacingError(cause, 'Не удалось остановить подключение. Проверьте результат.'),
      );
    },
  });
  const publicationChoice = useMutation({
    mutationFn: (input: { choiceId: string; storeId: string }) =>
      saveKaravanPublicationChoice(api, chatId, input),
    onSuccess: () => {
      setNotice('Выбор сохранён. Повторите $ в чате, когда захотите опубликовать ссылку.');
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (cause) =>
      setNotice(describeUserFacingError(cause, 'Не удалось сохранить выбор. Повторите попытку.')),
  });
  function start(input?: KaravanMarketplaceSetup, legacy = false) {
    if (
      !storageKey ||
      !module?.connection ||
      query.isError ||
      module.connection.blocked ||
      bind.isPending ||
      bind.request ||
      startingSetup.current ||
      setup.isPending
    )
      return;
    const original = input ?? saved;
    if (!original || (input && saved && input.operationId !== saved.operationId)) return;
    if (
      serverSetup &&
      ['pending', 'partial', 'unknown'].includes(serverSetup.state) &&
      serverSetup.operationId !== original.operationId
    )
      return;
    // FLAG: Registration owns durability before provider effects. Freeze the
    // admission revision once; explicit continuations retain the original request.
    const request =
      saved || legacy
        ? original
        : { ...original, expectedConnectionRevision: module.connection.revision };
    startingSetup.current = true;
    submittedSetup.current = { key: storageKey, operationId: request.operationId };
    setSaved(request);
    setCreated(false);
    setNotice(null);
    setup.mutate(request);
  }
  async function refreshSetup() {
    if (!saved || !storageKey || checkingShopCommand) return;
    const key = storageKey;
    const id = saved.operationId;
    setCheckingShopCommand(true);
    setNotice(null);
    try {
      const state = await getKaravanMarketplaceOperation(api, chatId, id);
      if (
        liveStorageKey.current === key &&
        state.operationId === id &&
        (!submittedSetup.current || submittedSetup.current.operationId === id)
      )
        acceptSetup(state);
    } catch (cause) {
      if (liveStorageKey.current === key)
        setNotice(
          describeUserFacingError(cause, 'Не удалось проверить результат. Повторите позже.'),
        );
    } finally {
      if (liveStorageKey.current === key) setCheckingShopCommand(false);
    }
  }
  async function inspectLegacy() {
    if (!module || legacyBusy) return;
    const key = storageKey;
    setLegacyBusy(true);
    void bind.inspectLegacy();
    const state = await readShopSetupRecovery(
      `karavan-setup:v1:${module.actorMaxUserId}:${chatId}`,
      chatId,
      null,
      (id) => getKaravanMarketplaceOperation(api, chatId, id),
    );
    if (liveStorageKey.current === key) {
      setLegacySetup(state);
      setLegacyBusy(false);
    }
  }
  if (query.isPending)
    return (
      <div className="karavan-module" role="status">
        <StorefrontScreen page="home">
          <Spinner size="sm" label="Проверяем магазин" />
        </StorefrontScreen>
        {publicationEntry}
      </div>
    );
  if (query.isError && !module)
    return (
      <section className="karavan-module">
        <StorefrontScreen page="home">
          <p role="alert">Не удалось обновить магазин.</p>
          {fallback.data ? (
            <ConnectionRecovery
              key={`${chatId}:${fallback.data.operation?.operation.operationId ?? 'none'}`}
              api={api}
              chatId={chatId}
              snapshot={fallback.data}
              onRefresh={() => void query.refetch()}
            />
          ) : null}
          <button type="button" onClick={() => void query.refetch()}>
            Повторить
          </button>
        </StorefrontScreen>
        {publicationEntry}
      </section>
    );
  if (!module)
    return (
      <div className="karavan-module" role="status">
        <StorefrontScreen page="home">
          <p>Магазин чата пока недоступен.</p>
          <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
            Проверить снова
          </button>
        </StorefrontScreen>
        {publicationEntry}
      </div>
    );
  const marketplace = module.marketplace;
  const active = marketplace?.status === 'active';
  const busy = bind.isPending || setup.isPending || checkingShopCommand;
  const ready = supported && !query.isError;
  const holdsScope = module.connection?.blocked || !!bind.request || !!saved;
  const managerScope = `${module.actorMaxUserId}:${chatId}:${marketplace?.id}:${module.binding?.generation}`;
  const connectionState = !supported ? (
    <p role="status">Обновите приложение, чтобы изменить подключение.</p>
  ) : module.connection?.blocked ? (
    <div>
      <p role="status">Выполняется другое изменение магазина.</p>
      <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
        Проверить результат
      </button>
    </div>
  ) : null;
  const startBinding = (action: 'unbind_chat' | 'recover_chat') => {
    if (!ready || !marketplace || !module.binding || saved || module.connection?.blocked) return;
    setDisconnectConfirm(false);
    bind.start({
      marketplaceId: marketplace.id,
      action,
      expectedBindingGeneration: module.binding.generation,
    });
  };
  const submittedHere =
    saved &&
    submittedSetup.current?.key === storageKey &&
    submittedSetup.current.operationId === saved.operationId;
  // FLAG: A restored partial setup cannot hide the verified current shop.
  // Keep its reads and local drafts available while server writes remain fenced.
  const managerVisible =
    canEnter &&
    !setupIntent &&
    (!saved || !submittedHere || pendingManagerOpen || workspace?.page === 'chats');
  const connectionProgress = bind.request ? (
    <>
      <h3>{bind.request.action === 'unbind_chat' ? 'Отключение чата' : 'Подключение магазина'}</h3>
      <p>
        {bind.isPending
          ? 'Проверяем результат…'
          : bind.rejected
            ? 'Изменение не выполнено.'
            : 'Результат изменения ещё не подтверждён.'}
      </p>
      <button
        type="button"
        className="karavan-module__primary"
        disabled={bind.isPending}
        onClick={() => void bind.refresh()}
      >
        {bind.isPending ? 'Проверяем…' : 'Проверить результат'}
      </button>
      {!bind.rejected ? (
        <button
          type="button"
          disabled={bind.isPending || !ready}
          onClick={() => void bind.resume()}
        >
          Продолжить подключение
        </button>
      ) : null}
      {bind.rejected ? (
        <button
          type="button"
          onClick={() => {
            bind.resetRejected();
            setSetupIntent(null);
          }}
        >
          Обновить состояние
        </button>
      ) : null}
    </>
  ) : saved || setup.isPending ? (
    <>
      <h3>Подключение магазина</h3>
      <p>
        {setup.isPending
          ? 'Проверяем права и подключаем выбранные чаты…'
          : operation?.state === 'rejected'
            ? 'Подключение не выполнено.'
            : operation?.state === 'unknown'
              ? 'Результат создания ещё не подтверждён.'
              : 'Часть подключения требует проверки.'}
      </p>
      {operation ? (
        <ul className="karavan-module__progress">
          {operation.checkpoints.bindings.map((item) => (
            <li key={item.chatId}>
              <span>
                {chats.data?.find((chat) => chat.id === item.chatId)?.title ??
                  (item.chatId === chatId ? 'Этот чат' : 'Выбранный чат')}
              </span>
              <strong>
                {
                  {
                    pending: 'Ожидает',
                    connected: 'Подключён',
                    unknown: 'Проверяется',
                    failed: 'Нужна проверка',
                  }[item.state]
                }
              </strong>
            </li>
          ))}
        </ul>
      ) : null}
      <button type="button" disabled={busy} onClick={() => void refreshSetup()}>
        Проверить результат
      </button>
      {operation?.state !== 'rejected' ? (
        <button
          type="button"
          className="karavan-module__primary"
          disabled={setup.isPending || busy || !ready}
          onClick={() => start()}
        >
          {setup.isPending ? 'Подключаем…' : 'Продолжить подключение'}
        </button>
      ) : null}
      {operation?.state === 'rejected' && !operation.checkpoints.marketplaceId && saved ? (
        <button
          type="button"
          onClick={() => {
            setSaved(null);
            setOperation(null);
            setNotice(null);
            dismissedSetup.current = saved.operationId;
            submittedSetup.current = null;
            setSetupIntent({ kind: 'create' });
          }}
        >
          Изменить настройки
        </button>
      ) : null}
      {operation?.state === 'partial' &&
      !operation.checkpoints.bindings.some((item) => item.state === 'unknown') ? (
        <button
          type="button"
          disabled={setup.isPending || cancelSetup.isPending}
          onClick={() => {
            if (
              window.confirm(
                'Остановить оставшиеся подключения? Магазин и подключённые чаты сохранятся.',
              )
            )
              cancelSetup.mutate({ key: storageKey!, id: saved!.operationId });
          }}
        >
          Остановить оставшиеся подключения
        </button>
      ) : null}
      {canEnter && operation?.checkpoints.marketplaceId === marketplace?.id ? (
        <button type="button" disabled={busy} onClick={() => setPendingManagerOpen(true)}>
          Настроить черновик
        </button>
      ) : null}
    </>
  ) : null;
  return (
    <StorefrontPublicationPreviewContext.Provider value={module.publicationPreview ?? null}>
      <section className="karavan-module" aria-label="Магазин чата">
        {created && (module.chatShopFlowVersion ?? 1) < 2 && workspace?.page === 'home' ? (
          <p role="status">Магазин создан.</p>
        ) : null}
        {notice || bind.error || bind.notice ? (
          <p className="karavan-module__notice" role="alert">
            {notice || bind.error || bind.notice}
          </p>
        ) : null}
        {ready && retryOpen ? (
          <button type="button" onClick={openShop}>
            Повторить переход
          </button>
        ) : null}
        <div>
          <StorefrontScreen page="publications">
            {marketplace?.format !== 'storefront' &&
              module.publicationChoices.map((choice) => (
                <div key={choice.id} className="karavan-module__actions">
                  <p>Выберите витрину для ответа бота на $ в этом чате.</p>
                  {choice.stores.map((store) => (
                    <button
                      type="button"
                      key={store.id}
                      disabled={publicationChoice.isPending || !ready || !!holdsScope}
                      onClick={() =>
                        publicationChoice.mutate({ choiceId: choice.id, storeId: store.id })
                      }
                    >
                      {store.name}
                    </button>
                  ))}
                </div>
              ))}
          </StorefrontScreen>
        </div>
        {connectionState ? (
          <StorefrontScreen page="home">{connectionState}</StorefrontScreen>
        ) : null}
        {query.isError ? (
          <div>
            <p role="alert">Не удалось обновить магазин. Проверьте состояние перед изменениями.</p>
            <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
              Повторить
            </button>
          </div>
        ) : null}
        {marketplace && canEnter ? (
          <div hidden={!managerVisible}>
            {pendingManagerOpen && saved ? (
              <StorefrontScreen page="home">
                <button type="button" onClick={() => setPendingManagerOpen(false)}>
                  Вернуться к подключению
                </button>
              </StorefrontScreen>
            ) : null}
            <KaravanShopManager
              key={managerScope}
              api={api}
              chatId={chatId}
              module={module}
              busy={busy}
              readOnly={!ready || holdsScope}
              open={openShop}
              publications={publications}
              chats={
                <>
                  {connectionState}
                  {connectionProgress}
                  <ul className="karavan-module__progress">
                    {module.bindings?.map((binding) => (
                      <li key={binding.id}>
                        <span>{binding.chatTitle || 'Чат'}</span>
                        <strong>
                          {binding.state === 'verified'
                            ? 'Подключён'
                            : binding.state === 'disconnected'
                              ? 'Отключён'
                              : 'Нужна проверка'}
                        </strong>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    disabled={busy || !ready || !!saved || !!holdsScope}
                    onClick={() =>
                      setSetupIntent({ kind: 'add_chats', marketplaceId: marketplace.id })
                    }
                  >
                    Подключить чаты
                  </button>
                  <button
                    type="button"
                    disabled={busy || !ready || !!saved || !!holdsScope}
                    onClick={() =>
                      setSetupIntent({ kind: 'replace', previousMarketplaceId: marketplace.id })
                    }
                  >
                    Выбрать другой магазин
                  </button>
                  {disconnectConfirm ? (
                    <div className="karavan-module__actions">
                      <p>
                        Этот чат перестанет открывать магазин. Если он последний, просмотр
                        приостановится. Витрины и заказы сохранятся.
                      </p>
                      <button
                        type="button"
                        disabled={busy || !ready || !!saved || !!holdsScope}
                        onClick={() => startBinding('unbind_chat')}
                      >
                        Подтвердить отключение
                      </button>
                      <button type="button" onClick={() => setDisconnectConfirm(false)}>
                        Отмена
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={busy || !ready || !!saved || !!holdsScope}
                      onClick={() => setDisconnectConfirm(true)}
                    >
                      Отключить этот чат
                    </button>
                  )}
                </>
              }
            />
          </div>
        ) : null}
        <div hidden={workspace?.page === 'publications' || managerVisible}>
          {connectionProgress ??
            (marketplace && !setupIntent ? (
              canEnter ? null : (
                <>
                  <h3>{marketplace.name}</h3>
                  <p role="status">{karavanAccessMessage(module)}</p>
                  {module.access?.canRecover === true && marketplace.status !== 'archived' ? (
                    <button
                      type="button"
                      className="karavan-module__primary"
                      disabled={busy || !ready}
                      onClick={() => startBinding('recover_chat')}
                    >
                      Восстановить подключение
                    </button>
                  ) : null}
                  {active && module.buyerUrl ? (
                    <button type="button" onClick={openShop}>
                      {viewLabel}
                    </button>
                  ) : null}
                  <button type="button" onClick={() => void query.refetch()}>
                    Проверить снова
                  </button>
                </>
              )
            ) : ready && !module.connection?.blocked ? (
              <>
                <KaravanMarketplaceWizard
                  key={shopSetupDraftKey(
                    module.actorMaxUserId,
                    chatId,
                    setupIntent ?? { kind: 'create' },
                  )}
                  api={api}
                  chatId={chatId}
                  chatTitle={module.currentChatTitle ?? ''}
                  actorId={module.actorMaxUserId}
                  sellerBotUrl={module.sellerBotUrl}
                  flowVersion={module.chatShopFlowVersion}
                  intent={setupIntent ?? { kind: 'create' }}
                  onCancel={setupIntent ? () => setSetupIntent(null) : undefined}
                  localOnlyRecovery={localOnlyRecovery}
                  optionalDraftRecovery
                  onSubmit={start}
                />
                {!marketplace && (!setupIntent || setupIntent.kind === 'create') ? (
                  <details>
                    <summary>Другие варианты</summary>
                    <button
                      type="button"
                      onClick={() => setSetupIntent({ kind: 'connect_existing' })}
                    >
                      Подключить существующий магазин
                    </button>
                  </details>
                ) : null}
              </>
            ) : null)}
        </div>
        <StorefrontScreen page={canEnter ? 'chats' : 'home'}>
          <details>
            <summary>Ранее начатые действия</summary>
            <button
              type="button"
              disabled={legacyBusy || bind.isPending}
              onClick={() => void inspectLegacy()}
            >
              {legacyBusy ? 'Проверяем…' : 'Проверить прежние действия'}
            </button>
            {legacySetup?.status === 'error' ? (
              <p role="status">Не удалось восстановить прежнее подключение. Попробуйте позже.</p>
            ) : null}
            {legacySetup?.status === 'ready' && legacySetup.request ? (
              <button
                type="button"
                disabled={busy || !ready || !!holdsScope}
                onClick={() => start(legacySetup.request!, true)}
              >
                Продолжить прежнее подключение
              </button>
            ) : null}
            {bind.legacyRecovery?.status === 'error' ? (
              <p role="status">Не удалось восстановить прежнее действие. Попробуйте позже.</p>
            ) : null}
            {bind.legacyRecovery?.status === 'ready' && bind.legacyRecovery.request ? (
              <button
                type="button"
                disabled={busy || !ready || !!holdsScope}
                onClick={() => void bind.importLegacy()}
              >
                Восстановить прежнее действие
              </button>
            ) : null}
          </details>
        </StorefrontScreen>
        {ready && (module.chatShopFlowVersion ?? 1) < 2 && !(marketplace && canEnter)
          ? publicationEntry
          : null}
      </section>
    </StorefrontPublicationPreviewContext.Provider>
  );
}
