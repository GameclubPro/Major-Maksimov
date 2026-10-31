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
import {
  type KaravanMarketplaceSetup,
  type KaravanMarketplaceOperation,
} from '@maxim/contracts/karavan-marketplace';
import type { ApiTransport } from '../../lib/api/transport';
import {
  getKaravanMarketplace,
  getKaravanMarketplaceOperation,
  setupKaravanMarketplace,
  saveKaravanPublicationChoice,
  cancelKaravanMarketplaceSetup,
} from '../../lib/api/karavan-marketplace-client';
import { saveMirroredItem, removeMirroredItem } from '../../lib/native-storage';
import { openKaravanStorefront } from '../../lib/karavan-storefront-navigation';
import { karavanAccessMessage } from '../../lib/karavan-storefront-access';
import { ApiRequestError } from '../../lib/api-request-error';
import { describeUserFacingError } from '../../lib/user-facing-error';
import KaravanMarketplaceWizard from './karavan-marketplace-wizard';
import { useKaravanMarketplaceBinding } from './use-karavan-marketplace-binding';
import { shopSetupDraftKey, type ShopSetupIntent } from './karavan-shop/setup-intent';
import {
  readShopSetupRecovery,
  shopSetupRecoveryMessage,
  type ShopSetupRecovery,
} from './karavan-shop/setup-recovery';
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
    retry: false,
  });
  const [setupIntent, setSetupIntent] = useState<ShopSetupIntent | null>(null);
  const [saved, setSaved] = useState<KaravanMarketplaceSetup | null>(null);
  const [operation, setOperation] = useState<KaravanMarketplaceOperation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const [retryOpen, setRetryOpen] = useState(false);
  const startingSetup = useRef(false);
  const [checkingShopCommand, setCheckingShopCommand] = useState(false);
  const returningFromShop = useRef(false);
  const renderedManagerScope = useRef<string | null>(null);
  const module = query.data?.enabled ? query.data : null;
  const storageKey = module ? `karavan-setup:v1:${module.actorMaxUserId}:${chatId}` : null;
  const liveStorageKey = useRef(storageKey);
  liveStorageKey.current = storageKey;
  const [setupRecovery, setSetupRecovery] = useState<{
    key: string | null;
    state: ShopSetupRecovery | { status: 'loading' };
  }>({ key: null, state: { status: 'loading' } });
  const [setupRecoveryAttempt, setSetupRecoveryAttempt] = useState(0);
  const setupHydration =
    setupRecovery.key === storageKey ? setupRecovery.state : { status: 'loading' as const };
  const hydrated = setupHydration.status === 'ready';
  const bind = useKaravanMarketplaceBinding(
    api,
    chatId,
    module?.actorMaxUserId,
    query.isSuccess && query.isFetchedAfterMount && !query.isFetching ? module?.binding : undefined,
  );
  const recoveryFailed =
    bind.hydrationState.status === 'error' || setupHydration.status === 'error';
  useLayoutEffect(() => {
    // FLAG: The parent owns the publication save footer. Leave this page before
    // paint when recovery fails, retaining its draft without an enabled save action.
    if (recoveryFailed && workspace?.page === 'publications') workspace.navigate('home');
  }, [recoveryFailed, workspace?.page, workspace?.navigate]);
  useEffect(() => {
    if (bind.hydrated && bind.request && !query.isFetchedAfterMount && !query.isFetching)
      void query.refetch();
  }, [bind.hydrated, bind.request, query.isFetchedAfterMount, query.isFetching, query.refetch]);
  const [pendingManagerOpen, setPendingManagerOpen] = useState(false);
  useStorefrontBack(
    () => setPendingManagerOpen(false),
    pendingManagerOpen && workspace?.page === 'home',
  );
  const publicationEntry = publications ? (
    <ShopPublicationsEntry>{publications}</ShopPublicationsEntry>
  ) : null;
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const chats = useQuery({
    queryKey: ['karavan-setup-chats'],
    enabled: !!saved,
    queryFn: async () => (await import('../../lib/api/root-client')).getChats(api),
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    if (!storageKey) return;
    let active = true;
    setSetupRecovery({ key: storageKey, state: { status: 'loading' } });
    setSaved(null);
    setOperation(module?.setupOperation ?? null);
    void readShopSetupRecovery(storageKey, chatId, module?.setupOperation ?? null, (operationId) =>
      getKaravanMarketplaceOperation(api, chatId, operationId),
    )
      .then((state) => {
        if (!active) return;
        setSetupRecovery({ key: storageKey, state });
        setOperation(state.operation);
        if (state.status === 'ready') {
          setSaved(state.request);
          if (state.operation?.state === 'complete' || state.operation?.state === 'cancelled') {
            removeMirroredItem(storageKey);
            setSaved(null);
            void queryClient.invalidateQueries({ queryKey });
          }
        } else if (state.operation) {
          setSaved(state.operation.request);
        }
      })
      .catch(() => {
        if (active)
          setSetupRecovery({
            key: storageKey,
            state: {
              status: 'error',
              reason: 'unavailable',
              operation: module?.setupOperation ?? null,
            },
          });
      });
    return () => {
      active = false;
    };
  }, [storageKey, api, chatId, module?.setupOperation, setupRecoveryAttempt]);

  const setup = useMutation({
    mutationFn: (input: KaravanMarketplaceSetup) => setupKaravanMarketplace(api, chatId, input),
    onSuccess: (state) => {
      setOperation(state);
      setSaved(state.request);
      if (storageKey) saveMirroredItem(storageKey, JSON.stringify(state.request));
      setNotice(null);
      if (
        state.state === 'partial' &&
        state.checkpoints.bindings.some(
          (binding) => binding.chatId === chatId && binding.state === 'connected',
        )
      )
        void queryClient.invalidateQueries({ queryKey });
      if (state.state === 'complete' || state.state === 'cancelled') {
        setCreated(state.state === 'complete' && !!state.request.create);
        if (storageKey) removeMirroredItem(storageKey);
        setSaved(null);
        setSetupIntent(null);
        void queryClient.invalidateQueries({ queryKey });
      }
    },
    onError: (error) => {
      setNotice(
        describeUserFacingError(
          error,
          'Результат пока не подтверждён. Повторите проверку подключения.',
        ),
      );
      if (error instanceof ApiRequestError && error.code === 'KARAVAN_SETUP_IN_PROGRESS')
        void queryClient.invalidateQueries({ queryKey });
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
    mutationFn: () => cancelKaravanMarketplaceSetup(api, chatId, saved!.operationId),
    onSuccess: () => {
      if (storageKey) removeMirroredItem(storageKey);
      setSaved(null);
      setOperation(null);
      setSetupIntent(null);
      setNotice('Подключение остановлено. Магазин и подключённые чаты сохранены.');
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) =>
      setNotice(
        describeUserFacingError(error, 'Не удалось остановить подключение. Повторите проверку.'),
      ),
  });
  const publicationChoice = useMutation({
    mutationFn: (input: { choiceId: string; storeId: string }) =>
      saveKaravanPublicationChoice(api, chatId, input),
    onSuccess: () => {
      setNotice('Выбор сохранён. Повторите $ в чате, когда захотите опубликовать ссылку.');
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) =>
      setNotice(describeUserFacingError(error, 'Не удалось сохранить выбор. Повторите попытку.')),
  });
  function start(input?: KaravanMarketplaceSetup) {
    const recoveredRequest = setupHydration.status === 'error' ? setupHydration.request : null;
    const continuingRecovered = !!input && input === recoveredRequest;
    if (
      !storageKey ||
      !module ||
      (!hydrated && !continuingRecovered) ||
      !bind.hydrated ||
      bind.request ||
      startingSetup.current ||
      setup.isPending
    )
      return;
    const request = input ?? saved;
    if (!request || (input && saved && input.operationId !== saved.operationId)) return;
    const originalKey = storageKey;
    startingSetup.current = true;
    setCheckingShopCommand(true);
    void (async () => {
      try {
        const { assertShopEntryWriteAvailable } = await import('./karavan-shop/command-journal');
        await assertShopEntryWriteAvailable(
          module.actorMaxUserId,
          chatId,
          request.existingMarketplaceId,
        );
        if (liveStorageKey.current !== originalKey) return;
        // FLAG: Every setup POST is an explicit continuation of this original request
        // and checks the daily-command fence, including a failed recovery read.
        if (continuingRecovered)
          setSetupRecovery({
            key: originalKey,
            state: { status: 'ready', request, operation: null },
          });
        saveMirroredItem(originalKey, JSON.stringify(request));
        setSaved(request);
        setCreated(false);
        setNotice(null);
        setup.mutate(request);
      } catch (cause) {
        if (liveStorageKey.current === originalKey)
          setNotice(
            describeUserFacingError(cause, 'Не удалось проверить сохранённое действие. Повторите.'),
          );
      } finally {
        startingSetup.current = false;
        if (liveStorageKey.current === originalKey) setCheckingShopCommand(false);
      }
    })();
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
  if (query.isError)
    return (
      <section className="karavan-module">
        <StorefrontScreen page="home">
          <p role="alert">Не удалось проверить магазин.</p>
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
  const canOpen = module.permissions.length > 0;
  const busy = bind.isPending || checkingShopCommand;
  const ready = hydrated && bind.hydrated;
  const canEnter =
    canOpen &&
    module.binding?.chatId === chatId &&
    module.binding?.state === 'verified' &&
    (!module.access || module.access.reason === 'allowed');
  // FLAG: Internal recovery may hide this same management scope without discarding
  // its edits. Actor/chat/marketplace/generation changes and recovery errors close it.
  const managerScope = `${module.actorMaxUserId}:${chatId}:${marketplace?.id}:${module.binding?.generation}`;
  if (!canEnter || bind.hydrationState.status === 'error' || setupHydration.status === 'error')
    renderedManagerScope.current = null;
  const retainManager = renderedManagerScope.current === managerScope;
  if (ready && canEnter) renderedManagerScope.current = managerScope;
  if (canEnter && recoveryFailed)
    return (
      <section className="karavan-module" aria-label="Магазин чата">
        <div className="karavan-module__notice" role="alert">
          <p>
            {bind.recoveryError ||
              (setupHydration.status === 'error'
                ? shopSetupRecoveryMessage(setupHydration.reason)
                : null)}
          </p>
          <p>Магазин доступен для просмотра. Для изменений повторите проверку.</p>
          <button
            type="button"
            disabled={query.isFetching}
            onClick={() => {
              if (bind.hydrationState.status === 'error') {
                bind.retryRecovery();
                setSetupRecoveryAttempt((attempt) => attempt + 1);
              } else {
                void query.refetch().then(() => setSetupRecoveryAttempt((attempt) => attempt + 1));
              }
            }}
          >
            Повторить проверку подключения
          </button>
        </div>
        <KaravanShopManager
          key={managerScope}
          api={api}
          chatId={chatId}
          module={module}
          busy={busy}
          readOnly
          open={openShop}
          chats={
            <ul className="karavan-module__progress">
              {module.bindings?.map((binding) => (
                <li key={binding.id}>{binding.chatTitle || 'Чат'}</li>
              ))}
            </ul>
          }
        />
      </section>
    );
  if (bind.hydrationState.status === 'error')
    return (
      <section className="karavan-module" aria-label="Магазин чата">
        {marketplace ? <h3>{marketplace.name}</h3> : null}
        <p role="alert">{bind.recoveryError}</p>
        <button type="button" onClick={bind.retryRecovery}>
          Повторить проверку подключения
        </button>
        {canEnter && active && module.buyerUrl ? (
          <button type="button" onClick={openShop}>
            Посмотреть магазин чата
          </button>
        ) : null}
      </section>
    );
  if (setupHydration.status === 'error')
    return (
      <section className="karavan-module" aria-label="Магазин чата">
        {marketplace ? <h3>{marketplace.name}</h3> : null}
        <p role="alert">{notice || shopSetupRecoveryMessage(setupHydration.reason)}</p>
        {setupHydration.request ? (
          <button
            type="button"
            className="karavan-module__primary"
            disabled={busy || !bind.hydrated || !!bind.request || setup.isPending}
            onClick={() => start(setupHydration.request)}
          >
            Продолжить подключение
          </button>
        ) : null}
        <button
          type="button"
          disabled={query.isFetching}
          onClick={() => {
            void query.refetch().then(() => setSetupRecoveryAttempt((attempt) => attempt + 1));
          }}
        >
          Повторить проверку подключения
        </button>
        {canEnter && active && module.buyerUrl ? (
          <button type="button" onClick={openShop}>
            Посмотреть магазин чата
          </button>
        ) : null}
      </section>
    );
  if (!ready && !retainManager)
    return (
      <div className="karavan-module" role="status">
        <Spinner size="sm" label="Проверяем сохранённое подключение" />
      </div>
    );
  const startBinding = (action: 'unbind_chat' | 'recover_chat') => {
    if (!marketplace || !module.binding || saved) return;
    setDisconnectConfirm(false);
    bind.start({
      marketplaceId: marketplace.id,
      action,
      expectedBindingGeneration: module.binding.generation,
    });
  };
  const managerVisible =
    ready && canEnter && !setupIntent && !bind.request && (pendingManagerOpen || !saved);
  return (
    <StorefrontPublicationPreviewContext.Provider value={module.publicationPreview ?? null}>
      <section className="karavan-module" aria-label="Магазин чата">
        {!ready ? (
          <div role="status">
            <Spinner size="sm" label="Проверяем сохранённое подключение" />
          </div>
        ) : null}
        {created && workspace?.page === 'home' ? <p role="status">Магазин создан.</p> : null}
        {notice || bind.error ? (
          <p className="karavan-module__notice" role="alert">
            {notice || bind.error}
          </p>
        ) : null}
        {ready && retryOpen ? (
          <button type="button" onClick={openShop}>
            Повторить переход
          </button>
        ) : null}
        <div hidden={!ready}>
          <StorefrontScreen page="publications">
            {module.publicationChoices.map((choice) => (
              <div key={choice.id} className="karavan-module__actions">
                <p>Выберите витрину для ответа бота на $ в этом чате.</p>
                {choice.stores.map((store) => (
                  <button
                    type="button"
                    key={store.id}
                    disabled={publicationChoice.isPending}
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
              readOnly={!ready}
              open={openShop}
              publications={publications}
              chats={
                <>
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
                    disabled={busy || !ready || !!saved}
                    onClick={() =>
                      setSetupIntent({ kind: 'add_chats', marketplaceId: marketplace.id })
                    }
                  >
                    Подключить чаты
                  </button>
                  <button
                    type="button"
                    disabled={busy || !ready || !!saved}
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
                        disabled={busy || !ready || !!saved}
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
                      disabled={busy || !ready || !!saved}
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
        <div hidden={!ready || workspace?.page === 'publications' || managerVisible}>
          {bind.request ? (
            <>
              <h3>
                {bind.request.action === 'unbind_chat' ? 'Отключение чата' : 'Подключение магазина'}
              </h3>
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
                onClick={bind.retry}
              >
                {bind.isPending ? 'Проверяем…' : 'Повторить проверку'}
              </button>
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
                    if (storageKey) removeMirroredItem(storageKey);
                    setSaved(null);
                    setOperation(null);
                    setNotice(null);
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
                      cancelSetup.mutate();
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
          ) : marketplace && !setupIntent ? (
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
                    Посмотреть магазин чата
                  </button>
                ) : null}
                <button type="button" onClick={() => void query.refetch()}>
                  Проверить снова
                </button>
              </>
            )
          ) : (
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
                intent={setupIntent ?? { kind: 'create' }}
                onCancel={setupIntent ? () => setSetupIntent(null) : undefined}
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
          )}
        </div>
        {ready && !(marketplace && canEnter) ? publicationEntry : null}
      </section>
    </StorefrontPublicationPreviewContext.Provider>
  );
}
