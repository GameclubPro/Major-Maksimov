import { AppIcon as IconoirSprite } from '../components/ui/app-icon';
import type { UpdatePublisherEntityModuleSettingsRequest } from '@maxim/contracts/publisher';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { lazy, Suspense, useEffect, useRef, useState, type ReactElement } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { useToast } from '../components/ui/toast';
import { cn } from '../lib/cn';
import { useSmartphoneLayout } from '../lib/use-smartphone-layout';
import {
  getPublisherEntity,
  refreshPublisherEntity,
  updatePublisherModules,
} from '../lib/api/publisher-client';
import type { ApiTransport } from '../lib/api/transport';
import type { BotPermissionBlocker } from '../lib/bot-permission-error';
import {
  canPreparePublisherPublicationTarget,
  getPublisherReadinessPollingInterval,
  getPublisherReadinessPresentation,
} from '../lib/publisher-readiness';
import { describeUserFacingError } from '../lib/user-facing-error';
import {
  buildPublisherCreateRoute,
  pollPublisherEntityRefresh,
  PUBLISHER_ENTITY_REFRESH_POLL_DELAYS_MS,
  shouldOfferPublisherRecheck,
  waitForPublisherRefresh,
} from './publisher-entities-page-model';
import {
  buildPublisherAutoRepliesRoute,
  buildPublisherEntityListRoute,
} from './publisher-entity-modules-page-model';
import './publisher-entity-modules-page.css';
import '../styles/publisher-modules-workspace.css';
import { PublisherPolicyCard } from '../components/publisher-policy-card';
import { MarketplaceProfileCard } from '../components/marketplace-profile-card';
const MarketplaceModuleToggle = lazy(() => import('../components/marketplace-module-toggle'));
import { PublisherCommentsModule } from '../components/publisher-comments-module';

const PUBLISHER_ENTITY_QUERY_ROOT = ['publisher-entity'] as const;
const PUBLISHER_CATALOG_QUERY_ROOT = ['publications', 'sources', 'publisher'] as const;

type PublisherEntityRecheckPhase = 'enqueueing' | 'polling';

let botPermissionErrorModulePromise: Promise<typeof import('../lib/bot-permission-error')> | null =
  null;

function loadBotPermissionErrorModule() {
  botPermissionErrorModulePromise ??= import('../lib/bot-permission-error');
  return botPermissionErrorModulePromise;
}

const LazyBotPermissionRequiredDialog = lazy(() =>
  import('../components/bot-permission-required-dialog').then((module) => ({
    default: module.BotPermissionRequiredDialog,
  })),
);

const LazyVkParsingCard = lazy(async () => {
  const module = await import('../components/vk-parsing-card');
  return { default: module.VkParsingCard };
});
const LazyVkWorkspaceShell = lazy(() =>
  import('../components/vk-parsing/workspace-shell').then((module) => ({
    default: module.VkWorkspaceShell,
  })),
);
const LazyPublisherSuggestionsPanel = lazy(
  () => import('../components/publisher-suggestions-panel'),
);

function ModuleNavigationContent({
  title,
  icon,
  variant,
}: {
  title: string;
  icon: ReactElement;
  variant: 'posting' | 'auto-replies' | 'suggestions' | 'vk';
}) {
  return (
    <>
      <span className={`publisher-entity-module__icon is-${variant}`} aria-hidden>
        {icon}
      </span>
      <strong>{title}</strong>
      <IconoirSprite variant="iconoir" icon="NavArrowRight" aria-hidden />
    </>
  );
}

function ModuleSwitch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="publisher-module-switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="publisher-module-switch__track" aria-hidden>
        <span className="publisher-module-switch__thumb" />
      </span>
    </label>
  );
}

export function PublisherEntityModulesPage({ api }: { api: ApiTransport }) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const params = useParams<{ entityType: string; entityId: string }>();
  const entityType =
    params.entityType === 'chat' || params.entityType === 'channel' ? params.entityType : null;
  const entityId = params.entityId?.trim() ?? '';
  const location = useLocation();
  const focusVk = new URLSearchParams(location.search).get('focus') === 'vk';
  const smartphoneLayout = useSmartphoneLayout();
  const [vkOpen, setVkOpen] = useState(focusVk);
  const [permissionBlocker, setPermissionBlocker] = useState<BotPermissionBlocker | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [entityRecheckPhase, setEntityRecheckPhase] = useState<PublisherEntityRecheckPhase | null>(
    null,
  );
  const entityRecheckAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const queryKey = [...PUBLISHER_ENTITY_QUERY_ROOT, entityType, entityId] as const;
  const entityQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => getPublisherEntity(api, entityType!, entityId, { signal }),
    enabled: entityType !== null && entityId.length > 0,
    staleTime: 10_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchInterval: (query) => getPublisherReadinessPollingInterval(query.state.data?.readiness),
  });
  const vkCapabilityQuery = useQuery({
    queryKey: ['publisher-vk-capability', entityType, entityId],
    queryFn: async () => {
      const { getVkParsingCapability } = await import('../lib/api/vk-parsing-client');
      return getVkParsingCapability(api, entityType!, entityId);
    },
    enabled: vkOpen && entityType !== null && entityId.length > 0 && Boolean(entityQuery.data),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const mutation = useMutation({
    mutationFn: (change: Omit<UpdatePublisherEntityModuleSettingsRequest, 'expectedRevision'>) => {
      const entity = entityQuery.data;
      if (!entity || !entityType) {
        throw new Error('Publisher entity is unavailable');
      }
      return updatePublisherModules(api, entityType, entity.id, {
        expectedRevision: entity.moduleSettings.revision,
        ...change,
      });
    },
    onSuccess: async () => {
      setPermissionBlocker(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: PUBLISHER_CATALOG_QUERY_ROOT }),
      ]);
    },
    onError: async (error) => {
      void queryClient.invalidateQueries({ queryKey });
      const { parseBotPermissionBlocker } = await loadBotPermissionErrorModule();
      const blocker = parseBotPermissionBlocker(error);
      if (blocker) {
        setPermissionBlocker(blocker);
        return;
      }
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось сохранить'),
      });
    },
  });

  useEffect(() => {
    setSuggestionsOpen(false);
    entityRecheckAbortRef.current?.abort();
    entityRecheckAbortRef.current = null;
    setEntityRecheckPhase(null);
    setPermissionBlocker(null);
  }, [entityId, entityType]);

  useEffect(() => {
    setVkOpen(focusVk);
  }, [entityId, entityType, focusVk]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      entityRecheckAbortRef.current?.abort();
    };
  }, []);

  async function handleEntityRecheck(): Promise<void> {
    const initialEntity = entityQuery.data;
    if (!initialEntity || !entityType || entityRecheckAbortRef.current) {
      return;
    }
    const abortController = new AbortController();
    entityRecheckAbortRef.current = abortController;
    setEntityRecheckPhase('enqueueing');

    try {
      await refreshPublisherEntity(api, entityType, initialEntity.id);
      if (abortController.signal.aborted) {
        return;
      }
      setEntityRecheckPhase('polling');

      const result = await pollPublisherEntityRefresh({
        initialEntity,
        delaysMs: PUBLISHER_ENTITY_REFRESH_POLL_DELAYS_MS,
        wait: (delayMs) => waitForPublisherRefresh(delayMs, abortController.signal),
        readEntity: () =>
          getPublisherEntity(api, entityType, initialEntity.id, {
            signal: abortController.signal,
          }),
        isCancelled: () => abortController.signal.aborted,
      });
      if (result.status === 'cancelled') {
        return;
      }
      if (result.status === 'updated') {
        queryClient.setQueryData(queryKey, result.entity);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: PUBLISHER_CATALOG_QUERY_ROOT }),
          vkCapabilityQuery.refetch(),
        ]);
        if (abortController.signal.aborted) return;
        const nextReadiness = getPublisherReadinessPresentation(result.entity.readiness);
        pushToast({
          tone: result.entity.readiness.canPublish ? 'success' : 'info',
          title: result.entity.readiness.canPublish ? 'Подключение готово' : 'Проверка завершена',
          description: result.entity.readiness.canPublish ? undefined : nextReadiness.detail,
        });
        return;
      }
      if (result.status === 'read_failed') {
        pushToast({
          tone: 'danger',
          title: 'Не удалось обновить статус',
          description: describeUserFacingError(result.error, 'Повторите позже.'),
        });
        return;
      }
      pushToast({
        tone: 'info',
        title: 'Проверка продолжается',
        description: 'Обновите статус через минуту.',
      });
    } catch (error: unknown) {
      if (!abortController.signal.aborted) {
        pushToast({
          tone: 'danger',
          title: 'Не удалось проверить подключение',
          description: describeUserFacingError(error, 'Повторите позже.'),
        });
      }
    } finally {
      if (entityRecheckAbortRef.current === abortController) {
        entityRecheckAbortRef.current = null;
        if (mountedRef.current) setEntityRecheckPhase(null);
      }
    }
  }

  if (!entityType || !entityId) {
    return (
      <section className="publisher-entity-modules-page">
        <div className="publisher-entity-modules-page__state has-error" role="alert">
          <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
          <strong>Чат или канал не найден</strong>
          <Link to="/">Вернуться</Link>
        </div>
      </section>
    );
  }

  if (entityQuery.isLoading) {
    return (
      <section className="publisher-entity-modules-page" aria-busy="true">
        <div className="publisher-entity-modules-page__state" role="status">
          <IconoirSprite variant="iconoir" icon="Refresh" className="is-refreshing" aria-hidden />
          <strong>Загружаю разделы</strong>
        </div>
      </section>
    );
  }

  const entity = entityQuery.data;
  if (!entity || entityQuery.error) {
    return (
      <section className="publisher-entity-modules-page">
        <div className="publisher-entity-modules-page__state has-error" role="alert">
          <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
          <strong>Не удалось загрузить разделы</strong>
          <button type="button" onClick={() => void entityQuery.refetch()}>
            <IconoirSprite variant="iconoir" icon="Refresh" aria-hidden />
            <span>Повторить</span>
          </button>
          <Link to={buildPublisherEntityListRoute(entityType)}>Вернуться к списку</Link>
        </div>
      </section>
    );
  }

  const readiness = getPublisherReadinessPresentation(entity.readiness);
  const canRecheckEntity = shouldOfferPublisherRecheck(entity);
  const chatComments = entity.moduleSettings.chatComments;
  const vkCapability = vkCapabilityQuery.data;
  const vkAvailable = vkCapability?.canUse === true;
  const refreshing = entityQuery.isFetching || (vkOpen && vkCapabilityQuery.isFetching);
  const busy = mutation.isPending || refreshing || entityRecheckPhase !== null;

  return (
    <section className="publisher-entity-modules-page" aria-busy={busy || undefined}>
      {entityQuery.isFetching && !entityQuery.isFetchedAfterMount ? (
        <p role="status">Проверяем права. Сохранённые настройки уже доступны для просмотра.</p>
      ) : null}
      <header className="publisher-entity-modules-page__header">
        <Link
          to={buildPublisherEntityListRoute(entity.entityType)}
          className="publisher-entity-modules-page__back"
          aria-label="Вернуться к списку"
          title="Назад"
        >
          <IconoirSprite variant="iconoir" icon="NavArrowLeft" aria-hidden />
        </Link>
        <EntityAvatar
          title={entity.title}
          entityType={entity.entityType}
          avatarUrl={entity.avatarUrl}
          className="publisher-entity-modules-page__avatar"
        />
        <span className="publisher-entity-modules-page__identity">
          <strong>
            {entity.title.trim() || (entity.entityType === 'channel' ? 'Канал' : 'Чат')}
          </strong>
          {!smartphoneLayout ? (
            <small>{entity.entityType === 'channel' ? 'Канал' : 'Чат'}</small>
          ) : null}
        </span>
        <button
          type="button"
          className={cn('publisher-entity-modules-page__refresh', refreshing && 'is-refreshing')}
          aria-label="Обновить данные"
          title="Перезагрузить данные"
          disabled={busy}
          onClick={() =>
            void Promise.all([
              entityQuery.refetch(),
              ...(vkOpen ? [vkCapabilityQuery.refetch()] : []),
            ])
          }
        >
          <IconoirSprite variant="iconoir" icon="Refresh" aria-hidden />
        </button>
      </header>

      <PublisherPolicyCard api={api} entityType={entity.entityType} entityId={entity.id} />
      {!smartphoneLayout ? (
        <MarketplaceProfileCard
          api={api}
          entityTitle={entity.title}
          entityAvatarUrl={entity.avatarUrl}
          entityType={entity.entityType}
          entityId={entity.id}
          profile="publisher"
        />
      ) : null}

      {!entity.readiness.canPublish || entityRecheckPhase ? (
        <div
          className={cn('publisher-entity-modules-page__readiness', `is-${readiness.tone}`)}
          aria-live={entityRecheckPhase ? 'polite' : undefined}
        >
          {entity.readiness.canPublish ? (
            <IconoirSprite variant="iconoir" icon="CheckCircle" aria-hidden />
          ) : (
            <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
          )}
          <span className="publisher-entity-modules-page__readiness-copy">
            <strong>{readiness.label}</strong>
            {!entity.readiness.canPublish ? <small>{readiness.detail}</small> : null}
          </span>
          {canRecheckEntity ? (
            <button
              type="button"
              className={cn(
                'publisher-entity-modules-page__recheck',
                entityRecheckPhase && 'is-refreshing',
              )}
              disabled={busy}
              onClick={() => void handleEntityRecheck()}
            >
              <IconoirSprite variant="iconoir" icon="Refresh" aria-hidden />
              <span>
                {entityRecheckPhase === 'enqueueing'
                  ? 'Запускаю'
                  : entityRecheckPhase === 'polling'
                    ? 'Проверяю'
                    : 'Проверить'}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="publisher-entity-modules-page__modules">
        {smartphoneLayout ? (
          canPreparePublisherPublicationTarget(entity) ? (
            <Link
              to={buildPublisherCreateRoute(entity)}
              className="publisher-module-entry"
              data-settings-navigation-entry="true"
            >
              <ModuleNavigationContent
                title="Посты"
                icon={<IconoirSprite variant="iconoir" icon="Post" />}
                variant="posting"
              />
            </Link>
          ) : (
            <button
              type="button"
              className="publisher-module-entry"
              data-settings-navigation-entry="true"
              disabled
            >
              <ModuleNavigationContent
                title="Посты"
                icon={<IconoirSprite variant="iconoir" icon="Post" />}
                variant="posting"
              />
            </button>
          )
        ) : (
          <article className="publisher-entity-module">
            <span className="publisher-entity-module__icon is-posting" aria-hidden>
              <IconoirSprite variant="iconoir" icon="Post" />
            </span>
            <span className="publisher-entity-module__copy">
              <strong>Посты</strong>
            </span>
            {canPreparePublisherPublicationTarget(entity) ? (
              <Link
                to={buildPublisherCreateRoute(entity)}
                className="publisher-entity-module__action"
                aria-label={`Создать пост для ${entity.title || entity.id}`}
                title="Создать пост"
              >
                <span>Создать</span>
                <IconoirSprite variant="iconoir" icon="NavArrowRight" aria-hidden />
              </Link>
            ) : null}
          </article>
        )}

        <PublisherCommentsModule
          key={`${entity.entityType}:${entity.id}`}
          chatComments={chatComments}
          entityTitle={entity.title}
          channelEnabled={entity.moduleSettings.channelCommentsEnabled === true}
          pending={mutation.isPending}
          onChange={(change) => mutation.mutate(change)}
        />

        {entity.entityType === 'chat' ? (
          smartphoneLayout ? (
            <Link
              to={buildPublisherAutoRepliesRoute(entity.id)}
              state={{ chatTitle: entity.title }}
              className="publisher-module-entry"
              data-settings-navigation-entry="true"
            >
              <ModuleNavigationContent
                title="Автоответы"
                icon={<IconoirSprite variant="iconoir" icon="Reply" />}
                variant="auto-replies"
              />
            </Link>
          ) : (
            <article className="publisher-entity-module">
              <span className="publisher-entity-module__icon is-auto-replies" aria-hidden>
                <IconoirSprite variant="iconoir" icon="Key" />
              </span>
              <span className="publisher-entity-module__copy">
                <strong>Автоответы</strong>
              </span>
              <Link
                to={buildPublisherAutoRepliesRoute(entity.id)}
                state={{ chatTitle: entity.title }}
                className="publisher-entity-module__action"
                aria-label={`Открыть автоответы для ${entity.title || entity.id}`}
                title="Открыть автоответы"
              >
                <span>Открыть</span>
                <IconoirSprite variant="iconoir" icon="NavArrowRight" aria-hidden />
              </Link>
            </article>
          )
        ) : null}

        {entity.entityType === 'channel' && smartphoneLayout ? (
          <button
            type="button"
            className="publisher-module-entry"
            data-settings-navigation-entry="true"
            aria-haspopup="dialog"
            aria-expanded={suggestionsOpen}
            aria-controls="publisher-suggestions-workspace"
            onClick={() => setSuggestionsOpen(true)}
          >
            <ModuleNavigationContent
              title="Предложения"
              icon={<IconoirSprite variant="iconoir" icon="MailIn" />}
              variant="suggestions"
            />
          </button>
        ) : null}

        {entity.entityType === 'channel' && !smartphoneLayout ? (
          <article className="publisher-entity-module">
            <span className="publisher-entity-module__icon is-suggestions" aria-hidden>
              <IconoirSprite variant="iconoir" icon="ChatBubble" />
            </span>
            <span className="publisher-entity-module__copy">
              <strong>Предложения</strong>
            </span>
            <ModuleSwitch
              checked={entity.moduleSettings.channelSuggestionsEnabled === true}
              disabled={mutation.isPending}
              label={`${entity.moduleSettings.channelSuggestionsEnabled ? 'Выключить' : 'Включить'} предложения`}
              onChange={(channelSuggestionsEnabled) =>
                mutation.mutate({ channelSuggestionsEnabled })
              }
            />
          </article>
        ) : null}

        {entity.entityType === 'channel' && !smartphoneLayout && (
          <Suspense fallback={null}>
            <MarketplaceModuleToggle
              api={api}
              entityId={entity.id}
              entityType={entity.entityType}
              profile="publisher"
              module="APPROVED_SUGGESTION"
            />
          </Suspense>
        )}
        {entity.entityType === 'channel' &&
        !smartphoneLayout &&
        entity.moduleSettings.channelSuggestionsEnabled ? (
          <>
            <div className="publisher-entity-module publisher-entity-module--subscription">
              <span className="publisher-entity-module__icon" aria-hidden>
                <IconoirSprite variant="iconoir" icon="CheckCircle" />
              </span>
              <span className="publisher-entity-module__copy">
                <strong>Требовать подписку</strong>
              </span>
              <ModuleSwitch
                checked={entity.moduleSettings.channelSuggestionsRequireSubscription === true}
                disabled={mutation.isPending}
                label="Требовать подписку"
                onChange={(channelSuggestionsRequireSubscription) =>
                  mutation.mutate({ channelSuggestionsRequireSubscription })
                }
              />
            </div>
            <div className="publisher-entity-module publisher-entity-module--subscription">
              <span className="publisher-entity-module__icon" aria-hidden>
                <IconoirSprite variant="iconoir" icon="WarningCircle" />
              </span>
              <span className="publisher-entity-module__copy">
                <strong>Удалять посты после отписки</strong>
              </span>
              <ModuleSwitch
                checked={entity.moduleSettings.channelSuggestionsDeleteOnUnsubscribe === true}
                disabled={mutation.isPending}
                label="Удалять посты после отписки"
                onChange={(channelSuggestionsDeleteOnUnsubscribe) =>
                  mutation.mutate({ channelSuggestionsDeleteOnUnsubscribe })
                }
              />
            </div>
          </>
        ) : null}

        <section className="publisher-entity-vk-module" data-publisher-module="vk">
          {smartphoneLayout ? (
            <button
              type="button"
              className="publisher-module-entry"
              data-settings-navigation-entry="true"
              aria-haspopup="dialog"
              aria-expanded={vkOpen}
              aria-controls="publisher-vk-workspace"
              onClick={() => setVkOpen(true)}
            >
              <ModuleNavigationContent
                title="Посты из VK"
                icon={<IconoirSprite variant="iconoir" icon="Download" />}
                variant="vk"
              />
            </button>
          ) : (
            <div className="publisher-entity-module">
              <span className="publisher-entity-module__icon is-vk" aria-hidden>
                <IconoirSprite variant="iconoir" icon="Download" />
              </span>
              <span className="publisher-entity-module__copy">
                <strong>Посты из VK</strong>
              </span>
              <button
                type="button"
                className={cn('publisher-entity-module__action', vkOpen && 'is-open')}
                aria-label={vkOpen ? 'Закрыть посты из VK' : 'Открыть посты из VK'}
                title={vkOpen ? 'Закрыть посты из VK' : 'Открыть посты из VK'}
                aria-expanded={vkOpen}
                aria-controls="publisher-vk-workspace"
                onClick={() => setVkOpen((current) => !current)}
              >
                <span>{vkOpen ? 'Закрыть' : 'Открыть'}</span>
                <IconoirSprite variant="iconoir" icon="NavArrowRight" aria-hidden />
              </button>
            </div>
          )}
          {vkOpen ? (
            <Suspense fallback={<span role="status">Открываем посты из VK...</span>}>
              <LazyVkWorkspaceShell title={entity.title} onClose={() => setVkOpen(false)}>
                {vkCapabilityQuery.isPending ? (
                  <div className="publisher-entity-vk-module__state" role="status">
                    <IconoirSprite
                      variant="iconoir"
                      icon="Refresh"
                      className="is-refreshing"
                      aria-hidden
                    />
                    <span>Проверяю доступ к VK</span>
                  </div>
                ) : vkCapabilityQuery.isError ? (
                  <div className="publisher-entity-vk-module__state has-error" role="alert">
                    <span>Не удалось проверить VK</span>
                    <button type="button" onClick={() => void vkCapabilityQuery.refetch()}>
                      Повторить
                    </button>
                  </div>
                ) : !vkAvailable ? (
                  <div className="publisher-entity-vk-module__state" role="status">
                    <span>
                      {vkCapability?.reasonCode === 'NOT_CONFIGURED'
                        ? 'Подключение VK временно недоступно. Попробуйте позже.'
                        : vkCapability?.reasonCode === 'ACCESS_DENIED'
                          ? 'Не удалось подтвердить доступ к этому чату или каналу.'
                          : 'Посты из VK пока недоступны.'}
                    </span>
                  </div>
                ) : (
                  <Suspense
                    fallback={
                      <div className="publisher-entity-vk-module__state" role="status">
                        <IconoirSprite
                          variant="iconoir"
                          icon="Refresh"
                          className="is-refreshing"
                          aria-hidden
                        />
                        <span>Открываю VK</span>
                      </div>
                    }
                  >
                    <>
                      <MarketplaceModuleToggle
                        api={api}
                        entityId={entity.id}
                        entityType={entity.entityType}
                        profile="publisher"
                        module="VK_IMPORT"
                      />
                      <LazyVkParsingCard
                        key={`${entity.entityType}:${entity.id}`}
                        api={api}
                        chatId={entity.id}
                        entityType={entity.entityType}
                        active
                        channelLinkUrl={entity.entityUrl ?? undefined}
                      />
                    </>
                  </Suspense>
                )}
              </LazyVkWorkspaceShell>
            </Suspense>
          ) : null}
        </section>
        {smartphoneLayout ? (
          <MarketplaceProfileCard
            api={api}
            entityTitle={entity.title}
            entityAvatarUrl={entity.avatarUrl}
            entityType={entity.entityType}
            entityId={entity.id}
            profile="publisher"
          />
        ) : null}
      </div>

      {smartphoneLayout && suggestionsOpen && entity.entityType === 'channel' ? (
        <Suspense fallback={null}>
          <LazyPublisherSuggestionsPanel
            advertising={
              <MarketplaceModuleToggle
                api={api}
                entityId={entity.id}
                entityType={entity.entityType}
                profile="publisher"
                module="APPROVED_SUGGESTION"
              />
            }
            entityTitle={entity.title}
            enabled={entity.moduleSettings.channelSuggestionsEnabled === true}
            requireSubscription={
              entity.moduleSettings.channelSuggestionsRequireSubscription === true
            }
            deleteOnUnsubscribe={
              entity.moduleSettings.channelSuggestionsDeleteOnUnsubscribe === true
            }
            pending={mutation.isPending}
            onChange={(change) => mutation.mutate(change)}
            onClose={() => setSuggestionsOpen(false)}
          />
        </Suspense>
      ) : null}

      <Suspense fallback={null}>
        <LazyBotPermissionRequiredDialog
          id="publisher-module-permission"
          blocker={permissionBlocker}
          isRechecking={entityRecheckPhase !== null}
          onClose={() => setPermissionBlocker(null)}
          onRecheck={() => {
            setPermissionBlocker(null);
            void handleEntityRecheck();
          }}
        />
      </Suspense>
    </section>
  );
}
