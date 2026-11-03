import { useState } from 'react';
import { ShopFailure, ShopLoading, useShopPages } from './runtime';

export default function ListingContent({
  listingId,
  enabled,
}: {
  listingId: string;
  enabled: boolean;
}) {
  const [kind, setKind] = useState<'product' | 'property'>('product');
  const query = useShopPages<'content'>(
    { operation: 'content', listingId, input: { kind, cursor: null, limit: 24 } },
    enabled,
  );
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="karavan-module__actions">
      <div className="karavan-shop__filters">
        <label>
          Раздел
          <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="product">Товары и услуги</option>
            <option value="property">Недвижимость</option>
          </select>
        </label>
      </div>
      {query.isPending ? (
        <ShopLoading />
      ) : query.isError && !query.data ? (
        <ShopFailure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          {items.length ? (
            items.map((item) => (
              <div className="karavan-shop__row" key={`${item.kind}:${item.id}`}>
                <div className="karavan-shop__identity">
                  {item.imageUrl ? <img src={item.imageUrl} alt="" loading="lazy" /> : null}
                  <strong>{item.title}</strong>
                </div>
                {!item.allowedCategory ? <p>Категория отключена</p> : null}
                {item.restriction?.active ? (
                  <p>Скрыто администратором: {item.restriction.reason}</p>
                ) : null}
              </div>
            ))
          ) : (
            <p>Объявлений пока нет</p>
          )}
          {query.isFetchNextPageError ? (
            <ShopFailure error={query.error} retry={() => void query.fetchNextPage()} />
          ) : null}
          {query.hasNextPage && !query.isFetchNextPageError ? (
            <div className="karavan-module__entry-actions">
              <button
                type="button"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
