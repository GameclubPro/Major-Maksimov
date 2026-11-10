import '../../../styles/karavan-shop.css';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import type { ApiTransport } from '../../../lib/api/transport';
import {
  StorefrontScreen,
  useStorefrontWorkspace,
  type StorefrontPage,
} from '../storefront-workspace';
import {
  SettingsSectionToggle,
  type SettingsSectionIconName,
} from '../../../components/ui/settings-section-toggle';
import {
  ShopContext,
  ShopLoading,
  useShopMutation,
  useShopQuery,
  MutationFailure,
  type ShopModule,
} from './runtime';
import { SellerAccessAction, SellerAccessProvider } from './seller-access';
import { shopNextAction } from './shop-journey';
import { ShopCommandProvider, ShopCommandRecovery } from './command-runtime';
import { useAdministrationStorefrontLink } from './storefront-management';
import { shopFormatLabel } from './format-picker';
import { ShopAvailabilityScope, shopAvailabilityScope } from './availability-scope';
const Catalog = lazy(() => import('./catalog'));
const Applications = lazy(() => import('./applications'));
const Categories = lazy(() => import('./categories'));
const Settings = lazy(() => import('./settings'));
const ShopHome = lazy(() => import('./home'));
const entries: Array<{ id: StorefrontPage; label: string; icon: SettingsSectionIconName }> = [
  { id: 'catalog', label: 'Товары и услуги', icon: 'storefront' },
  { id: 'applications', label: 'Заявки', icon: 'comments' },
  { id: 'settings', label: 'Настройки', icon: 'tools' },
];
type Props = {
  api: ApiTransport;
  chatId: string;
  module: ShopModule;
  busy: boolean;
  readOnly?: boolean;
  open: () => void;
  chats: ReactNode;
  publications?: ReactNode;
};
function Workspace({ module, busy, open, chats, publications }: Props) {
  const workspace = useStorefrontWorkspace();
  const section = workspace?.page ?? 'home';
  const [statusConfirm, setStatusConfirm] = useState<'active' | 'paused' | null>(null);
  const mutation = useShopMutation({ owner: 'availability', page: 'home' }, () =>
    setStatusConfirm(null),
  );
  const market = module.marketplace!;
  const administration = market.format === 'storefront';
  const availabilityScope = shopAvailabilityScope(module);
  const pauseLabel = availabilityScope.network
    ? 'Приостановить магазин сети'
    : 'Приостановить магазин';
  const openLabel = availabilityScope.network ? 'Открыть магазин сети' : 'Открыть для покупателей';
  const storefront = useAdministrationStorefrontLink(administration);
  const canView = market.status === 'active' && Boolean(module.buyerUrl);
  const canManage = module.permissions.includes('manage_marketplace');
  const canReview = module.permissions.includes('review_listing');
  const closed = ['draft', 'paused'].includes(market.status);
  const needsReadiness =
    canManage &&
    closed &&
    (module.counts.readyListings === undefined || module.counts.approvedListings === undefined);
  const detail = useShopQuery<'detail'>({ operation: 'detail' }, needsReadiness);
  const readiness =
    needsReadiness && detail.isSuccess && !detail.isFetching ? detail.data.counts : module.counts;
  const readyListings = readiness.readyListings;
  const approvedListings = readiness.approvedListings;
  const administrationReady =
    !administration ||
    (storefront.knownStore &&
      module.administrationStore?.status === 'ACTIVE' &&
      (readyListings ?? 0) > 0);
  const readinessKnown =
    !closed ||
    (readyListings !== undefined && (readyListings > 0 || approvedListings !== undefined));
  const next = shopNextAction({
    status: market.status,
    ...module.counts,
    readyListings,
    approvedListings,
    canManage,
    canReview: !administration && canReview,
  });
  const menu = entries.filter((item) =>
    item.id === 'applications'
      ? !administration && module.permissions.includes('review_listing')
      : item.id === 'catalog'
        ? !administration && (canReview || module.permissions.includes('arrange_listings'))
        : canManage || module.permissions.includes('bind_chat') || !!publications,
  );
  const changeStatus = () => {
    const status = statusConfirm ?? (market.status === 'active' ? 'paused' : 'active');
    const opening = status === 'active';
    if (
      !canManage ||
      busy ||
      mutation.blocked ||
      !availabilityScope.complete ||
      (opening && (!readinessKnown || (readyListings === 0 && !statusConfirm))) ||
      (opening && !administrationReady)
    )
      return;
    void mutation
      .mutateAsync({
        operation: 'status',
        input: {
          commandId: crypto.randomUUID(),
          expectedRevision: market.editRevision,
          status,
          allowEmpty: readyListings === 0,
        },
      })
      .then(() => setStatusConfirm(null))
      .catch(() => {});
  };
  const readinessStatus = (
    <>
      {needsReadiness && (detail.isPending || detail.isFetching) ? (
        <p role="status">Проверяем товары и услуги…</p>
      ) : null}
      {needsReadiness && !detail.isPending && !detail.isFetching && !readinessKnown ? (
        <div className="karavan-module__notice" role="alert">
          <p>Не удалось проверить готовность товаров и услуг.</p>
          <button type="button" onClick={() => void detail.refetch()}>
            Повторить проверку товаров
          </button>
        </div>
      ) : null}
    </>
  );
  const availability = canManage ? (
    <section aria-label="Доступность магазина">
      <h3>Доступность магазина</h3>
      {readinessStatus}
      {administration && closed && !administrationReady && readinessKnown ? (
        <p>Опубликуйте витрину с доступными товарами и услугами в Караване.</p>
      ) : statusConfirm ? (
        <div className="karavan-shop__row">
          <p>
            {statusConfirm === 'paused'
              ? availabilityScope.network
                ? 'Магазин сети закроется для покупателей во всех подключённых чатах.'
                : 'Приостановить просмотр магазина покупателями?'
              : approvedListings === 0
                ? 'Открыть магазин без продавцов?'
                : 'Открыть магазин без доступных товаров и услуг?'}
          </p>
          <ShopAvailabilityScope module={module} />
          <button
            type="button"
            disabled={busy || mutation.blocked || !readinessKnown || !availabilityScope.complete}
            onClick={changeStatus}
          >
            {statusConfirm === 'paused' ? pauseLabel : openLabel}
          </button>
          <button
            type="button"
            disabled={mutation.uncertain}
            onClick={() => setStatusConfirm(null)}
          >
            Отмена
          </button>
        </div>
      ) : market.status === 'active' || closed ? (
        <button
          type="button"
          disabled={busy || mutation.blocked || !readinessKnown}
          onClick={() =>
            market.status === 'active' || readyListings === 0 || availabilityScope.network
              ? setStatusConfirm(market.status === 'active' ? 'paused' : 'active')
              : changeStatus()
          }
        >
          {market.status === 'active' ? pauseLabel : openLabel}
        </button>
      ) : null}
    </section>
  ) : null;
  return (
    <>
      <ShopCommandRecovery />
      <StorefrontScreen page="home">
        <div className="karavan-shop__hero">
          <div className="karavan-module__identity">
            <span className="karavan-shop__format-label">
              {shopFormatLabel(administration ? 'storefront' : 'community')}
            </span>
            <h3>
              {administration ? (module.administrationStore?.name ?? market.name) : market.name}
            </h3>
            <p>
              {market.status === 'active'
                ? administration && !canView
                  ? 'Витрина пока недоступна покупателям'
                  : 'Открыт для покупателей'
                : market.status === 'draft'
                  ? 'Закрыт для покупателей'
                  : market.status === 'paused'
                    ? 'Приостановлен'
                    : 'В архиве'}
              {module.counts.chats > 1 ? ` · Чаты: ${module.counts.chats}` : ''}
            </p>
          </div>
          {canView ? (
            <button
              type="button"
              className="karavan-module__primary"
              disabled={busy}
              onClick={open}
            >
              {administration ? 'Посмотреть витрину' : 'Посмотреть магазин чата'}
            </button>
          ) : null}
          {administration &&
          market.status !== 'archived' &&
          !canView &&
          (!administrationReady || next !== 'open') ? (
            <button
              type="button"
              className="karavan-module__primary"
              disabled={busy || storefront.disabled}
              onClick={() => void storefront.open()}
            >
              {storefront.opening ? 'Открываем витрину…' : 'Добавить товары и услуги'}
            </button>
          ) : null}
          {!administration && next === 'invite' ? (
            <>
              <button
                type="button"
                className={canView ? undefined : 'karavan-module__primary'}
                onClick={() => workspace?.navigate('catalog')}
              >
                Добавить первые товары
              </button>
              <SellerAccessAction />
            </>
          ) : null}
          {!administration && next === 'review' ? (
            <button
              type="button"
              className={canView ? undefined : 'karavan-module__primary'}
              onClick={() => workspace?.navigate('applications')}
            >
              Проверить заявки · {module.counts.pendingApplications}
            </button>
          ) : null}
          {!administration && next === 'sellers' ? (
            <button
              type="button"
              className={canView ? undefined : 'karavan-module__primary'}
              onClick={() => workspace?.navigate('catalog')}
            >
              Проверить товары и услуги
            </button>
          ) : null}
          {next === 'open' && administrationReady ? (
            <button
              type="button"
              className={canView ? undefined : 'karavan-module__primary'}
              disabled={busy || mutation.blocked || !readinessKnown}
              onClick={() => {
                if (availabilityScope.network) {
                  setStatusConfirm(market.status === 'active' ? 'paused' : 'active');
                  workspace?.navigate('settings');
                } else changeStatus();
              }}
            >
              {availabilityScope.network
                ? openLabel
                : market.status === 'paused'
                  ? 'Возобновить магазин'
                  : 'Открыть для покупателей'}
            </button>
          ) : null}
        </div>
        {readinessStatus}
        {administration ? (
          <div id="karavan-shop-storefront-management">
            {!storefront.knownStore ? (
              <p role="status">Витрина пока недоступна. Проверьте её в настройках.</p>
            ) : null}
            {storefront.error ? (
              <div className="karavan-module__notice" role="alert">
                <p>{storefront.error}</p>
                <button
                  type="button"
                  disabled={storefront.disabled}
                  onClick={() => void storefront.open()}
                >
                  Повторить переход
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="karavan-shop__menu">
          {administration && canManage ? (
            <fieldset
              className="karavan-shop__management-actions"
              aria-label="Управление витриной"
              disabled={busy || storefront.disabled}
            >
              <SettingsSectionToggle
                title="Товары и услуги"
                icon="storefront"
                tone="sky"
                open={false}
                controls="karavan-shop-storefront-management"
                onClick={() => {
                  if (!busy) void storefront.open();
                }}
              />
            </fieldset>
          ) : null}
          {menu.map((item) => (
            <SettingsSectionToggle
              key={item.id}
              title={item.label}
              icon={item.icon}
              tone="sky"
              open={section === item.id}
              controls={`karavan-shop-${item.id}`}
              onClick={() => workspace?.navigate(item.id)}
            />
          ))}
        </div>
      </StorefrontScreen>
      <MutationFailure mutation={mutation} />
      {[
        ...menu,
        ...(canManage && !administration ? [{ id: 'categories' as const }] : []),
        ...(module.permissions.includes('bind_chat') ? [{ id: 'chats' as const }] : []),
        ...(publications ? [{ id: 'publications' as const }] : []),
      ].map((entry) => (
        <StorefrontScreen key={entry.id} page={entry.id}>
          <div id={`karavan-shop-${entry.id}`} className="karavan-shop">
            {module.counts.chats > 1 && entry.id !== 'publications' && entry.id !== 'chats' ? (
              <p className="karavan-shop__scope">Общий магазин · Чаты: {module.counts.chats}</p>
            ) : null}
            <Suspense fallback={<ShopLoading />}>
              {entry.id === 'catalog' ? (
                <Catalog canArrange={module.permissions.includes('arrange_listings')} />
              ) : null}
              {entry.id === 'applications' ? <Applications /> : null}
              {entry.id === 'settings' ? (
                <Settings
                  module={module}
                  hasPublications={!!publications}
                  availability={availability}
                />
              ) : null}
              {entry.id === 'categories' ? <Categories /> : null}
              {entry.id === 'chats' ? chats : null}
              {entry.id === 'publications' ? publications : null}
            </Suspense>
          </div>
        </StorefrontScreen>
      ))}
    </>
  );
}
export default function KaravanShopManager(props: Props) {
  if (
    !props.module.marketplace ||
    props.module.binding?.chatId !== props.chatId ||
    props.module.binding.state !== 'verified' ||
    (props.module.access && props.module.access.reason !== 'allowed')
  )
    return null;
  return (
    <ShopContext.Provider
      value={{
        api: props.api,
        module: props.module,
        scope: {
          chatId: props.chatId,
          marketplaceId: props.module.marketplace.id,
          expectedBindingGeneration: props.module.binding.generation,
        },
      }}
    >
      <ShopCommandProvider
        api={props.api}
        readOnly={props.readOnly}
        scope={{
          actorMaxUserId: props.module.actorMaxUserId,
          chatId: props.chatId,
          marketplaceId: props.module.marketplace.id,
          expectedBindingGeneration: props.module.binding.generation,
        }}
      >
        <SellerAccessProvider>
          {(props.module.chatShopFlowVersion ?? 1) >= 2 ? (
            <Suspense fallback={<ShopLoading />}>
              <ShopHome {...props} />
            </Suspense>
          ) : (
            <Workspace {...props} />
          )}
        </SellerAccessProvider>
      </ShopCommandProvider>
    </ShopContext.Provider>
  );
}
