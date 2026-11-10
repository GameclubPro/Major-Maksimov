import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { ChatParticipantItem } from '@maxim/contracts';
import type { MarketplaceSellerGrant } from '@maxim/contracts/karavan-marketplace-management';
import { useStorefrontDirty } from '../storefront-workspace';
import {
  MutationFailure,
  ShopFailure,
  ShopLoading,
  useShop,
  useShopMutation,
  useShopPages,
  useShopQuery,
} from './runtime';
import { ShopShareLink } from './share-link';

type Target = { maxUserId: string; name: string; username: string | null; fromChat: boolean };
function GrantRow({ grant }: { grant: MarketplaceSellerGrant }) {
  const { module } = useShop();
  const mutation = useShopMutation({ owner: `seller-grant:${grant.id}`, page: 'seller_access' });
  const expired = !grant.claimedAt && Date.parse(grant.expiresAt) <= Date.now();
  return (
    <article className="karavan-shop__row">
      <strong>
        {grant.targetName ?? grant.storeName ?? `Аккаунт MAX ${grant.targetMaxUserId}`}
      </strong>
      {grant.targetName && grant.storeName ? <p>{grant.storeName}</p> : null}
      <p>
        {grant.revokedAt
          ? 'Доступ отозван'
          : grant.claimedAt || grant.storeId
            ? 'Размещение разрешено'
            : expired
              ? 'Срок приглашения истёк'
              : `Ожидает продавца до ${new Date(grant.expiresAt).toLocaleDateString('ru-RU')}`}
      </p>
      {!grant.revokedAt && !grant.claimedAt && !expired ? (
        <button
          type="button"
          disabled={mutation.blocked || !module.permissions.includes('manage_marketplace')}
          onClick={() =>
            mutation.mutate({
              operation: 'seller_grant_revoke',
              input: {
                commandId: crypto.randomUUID(),
                grantId: grant.id,
                expectedRevision: grant.revision,
              },
            })
          }
        >
          Отозвать доступ
        </button>
      ) : null}
      {!grant.revokedAt && !grant.claimedAt && !expired && grant.url ? (
        <ShopShareLink
          url={grant.url}
          disabled={mutation.blocked || !module.permissions.includes('manage_marketplace')}
          label="Отправить приглашение снова"
        />
      ) : null}
      <MutationFailure mutation={mutation} />
    </article>
  );
}

export default function SellerGrants() {
  const { api, scope, module } = useShop();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState<Target | null>(null);
  const [storeId, setStoreId] = useState<string | null>(null);
  const [intentCommandId, setIntentCommandId] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const people = useInfiniteQuery({
    queryKey: ['karavan-seller-people', module.actorMaxUserId, scope.chatId, term],
    enabled: !selected && term.length >= 2,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const { getChatParticipantsPage } = await import('../../../lib/api/events-client');
      return getChatParticipantsPage(
        api,
        scope.chatId,
        { search: term, cursor: pageParam, limit: 12 },
        { signal },
      );
    },
    getNextPageParam: (page) => (page.hasMore ? (page.nextCursor ?? undefined) : undefined),
    retry: false,
  });
  const target = useShopQuery<'seller_grant_target'>(
    {
      operation: 'seller_grant_target',
      input: { targetMaxUserId: selected?.maxUserId ?? '1' },
    },
    selected !== null,
  );
  const grants = useShopPages<'seller_grants'>({
    operation: 'seller_grants',
    input: { cursor: null, limit: 24 },
  });
  const mutation = useShopMutation({ owner: 'seller-grant-create', page: 'seller_access' });
  useEffect(() => {
    const pending = mutation.pendingCommand;
    if (pending?.operation === 'seller_grant_create') {
      setIntentCommandId(pending.input.commandId);
      setSelected((current) =>
        current?.maxUserId === pending.input.targetMaxUserId
          ? current
          : {
              maxUserId: pending.input.targetMaxUserId,
              name: `Аккаунт MAX ${pending.input.targetMaxUserId}`,
              username: null,
              fromChat: false,
            },
      );
      setStoreId(pending.input.storeId);
    }
  }, [mutation.pendingCommand]);
  useStorefrontDirty('seller-grant', mutation.uncertain);
  const choose = (person: ChatParticipantItem) => {
    setSelected({
      maxUserId: person.userId,
      name: person.userDisplayName,
      username: person.username,
      fromChat: true,
    });
    setStoreId(null);
    setIntentCommandId(null);
    mutation.reset();
  };
  const identity = target.data?.target ?? selected;
  const receipt = mutation.receipt?.response;
  // FLAG: Historical receipts cannot satisfy a new selection. Pending recovery
  // restores the exact original command id before its confirmation is shown.
  const confirmation =
    receipt?.operation === 'seller_grant_create' &&
    mutation.receipt?.request.commandId === intentCommandId &&
    receipt.data.grant.targetMaxUserId === selected?.maxUserId
      ? receipt.data
      : null;
  const latestGrant =
    confirmation &&
    grants.data?.pages
      .flatMap((page) => page.grants)
      .find((grant) => grant.id === confirmation.grant.id);
  const grantState = latestGrant ?? confirmation?.grant;
  const created =
    grantState?.revokedAt ||
    (grantState && !grantState.claimedAt && Date.parse(grantState.expiresAt) <= Date.now())
      ? null
      : confirmation;
  const verified = Boolean(
    created ||
    (selected &&
      target.isSuccess &&
      !target.isFetching &&
      (target.data.target || selected.fromChat)),
  );
  const canManage = module.permissions.includes('manage_marketplace');
  return (
    <>
      {!selected ? (
        <>
          <label className="karavan-module__field">
            Продавец
            <input
              type="search"
              value={search}
              placeholder="Имя участника или ID в MAX"
              maxLength={100}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {term.length >= 2 ? (
            people.isPending ? (
              <ShopLoading />
            ) : people.isError && !people.data ? (
              <ShopFailure error={people.error} retry={() => void people.refetch()} />
            ) : (
              <>
                {(people.data?.pages.flatMap((page) => page.items) ?? [])
                  .filter((person) => !person.isBot)
                  .map((person) => (
                    <button
                      type="button"
                      className="karavan-shop__person"
                      key={person.userId}
                      onClick={() => choose(person)}
                    >
                      <strong>{person.userDisplayName}</strong>
                      {person.username ? <span>@{person.username.replace(/^@/u, '')}</span> : null}
                    </button>
                  ))}
                {people.hasNextPage ? (
                  <button
                    type="button"
                    disabled={people.isFetchingNextPage}
                    onClick={() => void people.fetchNextPage()}
                  >
                    Показать ещё
                  </button>
                ) : null}
                {people.data?.pages.every((page) => page.items.length === 0) ? (
                  <p>В этом чате никого не найдено.</p>
                ) : null}
              </>
            )
          ) : null}
          {/^[0-9]{1,24}$/u.test(search.trim()) ? (
            <button
              type="button"
              onClick={() => {
                setSelected({
                  maxUserId: search.trim(),
                  name: '',
                  username: null,
                  fromChat: false,
                });
                setStoreId(null);
                setIntentCommandId(null);
                mutation.reset();
              }}
            >
              Проверить аккаунт MAX
            </button>
          ) : null}
        </>
      ) : (
        <section className="karavan-shop__grant-target">
          {!created && (target.isPending || target.isFetching) ? (
            <ShopLoading />
          ) : !created && target.isError ? (
            <ShopFailure error={target.error} retry={() => void target.refetch()} />
          ) : verified ? (
            <>
              <strong>{identity?.name || `Аккаунт MAX ${selected.maxUserId}`}</strong>
              {identity?.username ? <span>@{identity.username.replace(/^@/u, '')}</span> : null}
              <small>MAX ID {selected.maxUserId}</small>
              {created ? (
                <>
                  <p role="status">Доступ разрешён</p>
                  <ShopShareLink url={created.url} label="Отправить приглашение" />
                </>
              ) : (
                <>
                  {target.data?.stores.length ? (
                    <fieldset
                      className="karavan-module__choices"
                      disabled={mutation.editingBlocked}
                    >
                      <legend>Витрина</legend>
                      {target.data.stores.map((store) => (
                        <label key={store.id}>
                          <input
                            type="radio"
                            name="grant-store"
                            checked={storeId === store.id}
                            onChange={() => setStoreId(store.id)}
                          />
                          {store.name}
                        </label>
                      ))}
                      <label>
                        <input
                          type="radio"
                          name="grant-store"
                          checked={storeId === null}
                          onChange={() => setStoreId(null)}
                        />
                        Выберет или создаст витрину
                      </label>
                    </fieldset>
                  ) : (
                    <p>Продавец сможет подготовить одну витрину.</p>
                  )}
                  <p>Приглашение действует 7 дней и доступно только этому человеку.</p>
                  <button
                    type="button"
                    className="karavan-module__primary"
                    disabled={!canManage || mutation.blocked}
                    onClick={() => {
                      const commandId = crypto.randomUUID();
                      setIntentCommandId(commandId);
                      mutation.mutate({
                        operation: 'seller_grant_create',
                        input: {
                          commandId,
                          expectedPolicyRevision: module.marketplace!.policyRevision,
                          targetMaxUserId: selected.maxUserId,
                          storeId,
                          expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
                        },
                      });
                    }}
                  >
                    Разрешить размещение
                  </button>
                </>
              )}
            </>
          ) : (
            <p role="status">Аккаунт не найден. Выберите человека из участников чата.</p>
          )}
          <MutationFailure mutation={mutation} />
          <button
            type="button"
            disabled={mutation.uncertain}
            onClick={() => {
              setSelected(null);
              setSearch('');
              setStoreId(null);
              setIntentCommandId(null);
            }}
          >
            Другой продавец
          </button>
        </section>
      )}
      <details className="karavan-shop__advanced">
        <summary>Предоставленный доступ</summary>
        {grants.isPending ? (
          <ShopLoading />
        ) : !grants.data ? (
          <ShopFailure error={grants.error} retry={() => void grants.refetch()} />
        ) : (
          grants.data.pages
            .flatMap((page) => page.grants)
            .map((grant) => <GrantRow key={grant.id} grant={grant} />)
        )}
        {grants.data?.pages.every((page) => page.grants.length === 0) ? (
          <p>Персональных разрешений пока нет.</p>
        ) : null}
        {grants.hasNextPage ? (
          <button
            type="button"
            disabled={grants.isFetchingNextPage}
            onClick={() => void grants.fetchNextPage()}
          >
            Показать ещё
          </button>
        ) : null}
      </details>
    </>
  );
}
