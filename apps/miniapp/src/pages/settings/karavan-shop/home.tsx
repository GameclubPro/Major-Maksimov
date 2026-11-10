import { lazy, Suspense, useState, type ReactNode } from 'react';
import {
  SettingsSectionIcon,
  SettingsSectionToggle,
} from '../../../components/ui/settings-section-toggle';
import {
  StorefrontScreen,
  useStorefrontWorkspace,
  type StorefrontPage,
} from '../storefront-workspace';
import { MutationFailure, ShopLoading, useShopMutation, type ShopModule } from './runtime';
import { ShopCommandRecovery } from './command-runtime';
import { useAdministrationStorefrontLink } from './storefront-management';
import { SellerAccessAction } from './seller-access';
import { ShopShareLink } from './share-link';
import { ShopAvailabilityScope, shopAvailabilityScope } from './availability-scope';

const Catalog = lazy(() => import('./catalog'));
const Applications = lazy(() => import('./applications'));
const Categories = lazy(() => import('./categories'));
const Settings = lazy(() => import('./settings-simple'));
const SellerGrants = lazy(() => import('./seller-grants'));

export default function ShopHome({
  module,
  busy,
  open,
  chats,
  publications,
}: {
  module: ShopModule;
  busy: boolean;
  open: () => void;
  chats: ReactNode;
  publications?: ReactNode;
}) {
  const workspace = useStorefrontWorkspace();
  const market = module.marketplace!;
  const administration = market.format === 'storefront';
  const canManage = module.permissions.includes('manage_marketplace');
  const canReview = module.permissions.includes('review_listing');
  const active = market.status === 'active';
  const archived = market.status === 'archived';
  const availabilityScope = shopAvailabilityScope(module);
  const pauseLabel = availabilityScope.network ? 'Приостановить магазин сети' : 'Выключить магазин';
  const openLabel = availabilityScope.network ? 'Включить магазин сети' : 'Включить магазин';
  const count =
    module.administrationStoreCount ??
    module.administrationStores?.length ??
    (module.administrationStore ? 1 : 0);
  const policy = market.admissionMode ?? market.admissionPolicy;
  const store = useAdministrationStorefrontLink(administration);
  const [confirmClose, setConfirmClose] = useState<'active' | 'paused' | null>(null);
  const availability = useShopMutation({ owner: 'availability', page: 'settings' }, () =>
    setConfirmClose(null),
  );
  const changeStatus = (status: 'active' | 'paused') => {
    if (!availabilityScope.complete) return;
    availability.mutate({
      operation: 'status',
      input: {
        commandId: crypto.randomUUID(),
        expectedRevision: market.editRevision,
        status,
        allowEmpty: true,
      },
    });
  };
  const availabilityControl =
    canManage && !archived ? (
      <section className="karavan-shop__availability">
        {confirmClose ? (
          <>
            <p>
              {availabilityScope.network
                ? confirmClose === 'paused'
                  ? 'Магазин сети закроется для покупателей во всех подключённых чатах.'
                  : 'Магазин сети откроется для покупателей во всех подключённых чатах.'
                : 'Магазин этого чата закроется для покупателей.'}{' '}
              Витрины, товары и настройки сохранятся.
            </p>
            <ShopAvailabilityScope module={module} />
            <button
              type="button"
              disabled={busy || availability.blocked || !availabilityScope.complete}
              onClick={() => changeStatus(confirmClose)}
            >
              {confirmClose === 'paused' ? pauseLabel : openLabel}
            </button>
            <button
              type="button"
              disabled={availability.uncertain}
              onClick={() => setConfirmClose(null)}
            >
              Отмена
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy || availability.blocked}
            onClick={() =>
              active || availabilityScope.network
                ? setConfirmClose(active ? 'paused' : 'active')
                : changeStatus('active')
            }
          >
            {active ? pauseLabel : openLabel}
          </button>
        )}
        <MutationFailure mutation={availability} />
      </section>
    ) : null;
  const canView = active && Boolean(module.buyerUrl);
  const empty = (module.counts.approvedListings ?? module.counts.listings) === 0;
  const sellerEntry =
    canManage && !archived ? (
      policy === 'selected' ? (
        <button
          type="button"
          className="karavan-module__primary"
          onClick={() => workspace?.navigate('seller_access')}
        >
          Добавить продавца
        </button>
      ) : (
        <SellerAccessAction />
      )
    ) : null;
  const pages: StorefrontPage[] = [
    'settings',
    ...(!administration ? (['catalog', 'categories', 'seller_access'] as const) : []),
    ...(canReview ? (['applications'] as const) : []),
    ...(module.permissions.includes('bind_chat') ? (['chats'] as const) : []),
    ...(publications ? (['publications'] as const) : []),
  ];
  return (
    <>
      <ShopCommandRecovery />
      <StorefrontScreen page="home">
        <header className="karavan-shop-home__header">
          <div>
            <h3>{market.name}</h3>
            <p>{administration ? 'Продаёт администрация' : 'Магазин участников'}</p>
          </div>
          <button
            type="button"
            aria-label="Настройки"
            onClick={() => workspace?.navigate('settings')}
          >
            <SettingsSectionIcon name="tools" />
          </button>
        </header>
        {!active ? (
          <div className="karavan-shop-home__closed">
            <strong>{archived ? 'Магазин в архиве' : 'Магазин выключен'}</strong>
            {canManage && !archived ? (
              <button
                type="button"
                disabled={busy || availability.blocked}
                onClick={() => {
                  if (availabilityScope.network) {
                    setConfirmClose('active');
                    workspace?.navigate('settings');
                  } else changeStatus('active');
                }}
              >
                {openLabel}
              </button>
            ) : null}
            <MutationFailure mutation={availability} />
          </div>
        ) : null}
        {administration ? (
          <div className="karavan-shop-home__cards">
            {canManage && !archived ? (
              <button
                type="button"
                className="karavan-shop-home__card karavan-shop-home__card--manage"
                disabled={busy || store.disabled}
                onClick={() => void store.open()}
              >
                <SettingsSectionIcon name="spark" />
                <span>
                  <strong>
                    {store.opening
                      ? 'Открываем…'
                      : count === 0
                        ? 'Добавить витрину'
                        : count === 1
                          ? 'Управлять витриной'
                          : 'Управлять витринами'}
                  </strong>
                  <span>Товары, фотографии и описание</span>
                </span>
                <span aria-hidden="true">↗</span>
              </button>
            ) : null}
            <button
              type="button"
              className="karavan-shop-home__card"
              disabled={busy || !canView}
              onClick={open}
            >
              <SettingsSectionIcon name="storefront" />
              <span>
                <strong>{count === 1 ? 'Посмотреть витрину' : 'Посмотреть магазин'}</strong>
                <span>{count === 1 ? 'Так её видят покупатели' : 'Так его видят покупатели'}</span>
              </span>
              <span aria-hidden="true">↗</span>
            </button>
          </div>
        ) : (
          <>
            {canReview && module.counts.pendingApplications > 0 ? (
              <button
                type="button"
                className="karavan-shop-home__pending"
                onClick={() => workspace?.navigate('applications')}
              >
                <span>Заявки</span>
                <strong>{module.counts.pendingApplications}</strong>
                <span aria-hidden="true">›</span>
              </button>
            ) : null}
            {empty ? (
              <div className="karavan-shop-home__empty">
                <SettingsSectionIcon name="storefront" />
                <h3>Добавьте первых продавцов</h3>
                {sellerEntry}
              </div>
            ) : null}
            <button
              type="button"
              className={empty ? undefined : 'karavan-module__primary'}
              disabled={busy || !canView}
              onClick={open}
            >
              Посмотреть магазин
            </button>
            {!empty ? (
              <>
                <SettingsSectionToggle
                  title="Витрины"
                  icon="storefront"
                  tone="sky"
                  open={false}
                  controls="karavan-shop-catalog"
                  onClick={() => workspace?.navigate('catalog')}
                />
                {sellerEntry}
              </>
            ) : null}
          </>
        )}
        <ShopShareLink url={module.buyerUrl} disabled={busy || archived} />
        {store.error ? (
          <div className="karavan-module__notice" role="alert">
            <p>{store.error}</p>
            <button type="button" disabled={store.disabled} onClick={() => void store.open()}>
              Повторить переход
            </button>
          </div>
        ) : null}
        {publications ? (
          <details
            className="karavan-shop-home__bonus"
            onToggle={(event) => workspace?.setInlinePublications(event.currentTarget.open)}
          >
            <summary>
              <SettingsSectionIcon name="send" />
              <span>Кнопка магазина под объявлениями</span>
            </summary>
            <p>Начните объявление с $ — Майор ответит кнопкой магазина.</p>
            {workspace?.page === 'home' ? publications : null}
          </details>
        ) : null}
      </StorefrontScreen>
      {pages.map((page) => (
        <StorefrontScreen key={page} page={page}>
          <div id={`karavan-shop-${page}`} className="karavan-shop">
            <Suspense fallback={<ShopLoading />}>
              {page === 'settings' ? (
                <Settings
                  module={module}
                  availability={availabilityControl}
                  hasPublications={!!publications}
                />
              ) : null}
              {page === 'catalog' ? (
                <Catalog canArrange={module.permissions.includes('arrange_listings')} />
              ) : null}
              {page === 'applications' ? <Applications /> : null}
              {page === 'categories' ? <Categories /> : null}
              {page === 'seller_access' ? <SellerGrants /> : null}
              {page === 'chats' ? chats : null}
              {page === 'publications' && workspace?.page === 'publications' ? publications : null}
            </Suspense>
          </div>
        </StorefrontScreen>
      ))}
    </>
  );
}
