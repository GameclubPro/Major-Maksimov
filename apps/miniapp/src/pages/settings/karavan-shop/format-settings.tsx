import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getKaravanMarketplaceSetupOptions } from '../../../lib/api/karavan-marketplace-client';
import { openMaxBotLink } from '../../../lib/max-bridge';
import { useStorefrontDirty } from '../storefront-workspace';
import { ShopFormatPicker, shopFormatLabel, type ShopFormat } from './format-picker';
import { MutationFailure, ShopFailure, useShop, useShopMutation, useShopQuery } from './runtime';

type FormatDraft = { format: ShopFormat; administrationStoreId: string | null };

export default function ShopFormatSettings({ readOnly = false }: { readOnly?: boolean }) {
  const { api, scope, module } = useShop();
  const market = module.marketplace!;
  const currentFormat = market.format ?? 'community';
  const [draft, setDraft] = useState<FormatDraft | null>(null);
  const mutation = useShopMutation({ owner: 'format', page: 'settings' }, () => setDraft(null));
  useEffect(() => {
    const pending = mutation.pendingCommand;
    if (pending?.operation === 'format_update')
      setDraft({
        format: pending.input.format,
        administrationStoreId: pending.input.administrationStoreId ?? null,
      });
  }, [mutation.pendingCommand]);
  const format = draft?.format ?? currentFormat;
  const storeId = draft?.administrationStoreId ?? null;
  const changed =
    Boolean(draft) &&
    (format !== currentFormat ||
      (format === 'storefront' && storeId !== market.administrationStoreId));
  const options = useQuery({
    queryKey: ['karavan-setup-options', module.actorMaxUserId, scope.chatId],
    queryFn: ({ signal }) => getKaravanMarketplaceSetupOptions(api, scope.chatId, signal),
    enabled: Boolean(draft && format === 'storefront'),
    retry: false,
  });
  const input = {
    expectedRevision: market.editRevision,
    format,
    ...(format === 'storefront' ? { administrationStoreId: storeId } : {}),
  };
  const administrationSupported =
    Array.isArray(options.data?.administrationStores) &&
    typeof options.data?.sellerTermsAccepted === 'boolean';
  const preview = useShopQuery<'format_preview'>(
    { operation: 'format_preview', input },
    changed && !mutation.uncertain && (format !== 'storefront' || administrationSupported),
  );
  const needsTerms =
    format === 'storefront' && !storeId && options.data?.sellerTermsAccepted === false;
  useStorefrontDirty('shop-format', changed || mutation.uncertain);
  return (
    <section className="karavan-shop-format-settings" aria-label="Формат магазина">
      <h3>Формат магазина</h3>
      {!draft ? (
        <>
          <p>{shopFormatLabel(currentFormat)}</p>
          <button
            type="button"
            disabled={readOnly || mutation.editingBlocked}
            onClick={() =>
              setDraft({
                format: currentFormat,
                administrationStoreId: market.administrationStoreId ?? null,
              })
            }
          >
            Изменить формат
          </button>
        </>
      ) : (
        <fieldset className="karavan-shop__form" disabled={readOnly || mutation.editingBlocked}>
          <ShopFormatPicker
            value={format}
            storefrontDisabled={Boolean(options.data && !administrationSupported)}
            onChange={(value) =>
              setDraft({
                format: value,
                administrationStoreId:
                  value === currentFormat ? (market.administrationStoreId ?? null) : null,
              })
            }
          />
          {format === 'storefront' ? (
            options.isPending ? (
              <p role="status">Проверяем доступные витрины…</p>
            ) : options.isError ? (
              <ShopFailure error={options.error} retry={() => void options.refetch()} />
            ) : !administrationSupported ? (
              <div role="status">
                <p>Настройка витрины пока недоступна.</p>
                <button type="button" onClick={() => void options.refetch()}>
                  Проверить снова
                </button>
              </div>
            ) : (
              <fieldset className="karavan-module__choices">
                <legend>Витрина администрации</legend>
                <label>
                  <input
                    type="radio"
                    name="shop-format-store"
                    checked={!storeId}
                    onChange={() => setDraft({ format, administrationStoreId: null })}
                  />
                  Создать новую витрину
                </label>
                {options.data?.administrationStores?.map((store) => (
                  <label key={store.id}>
                    <input
                      type="radio"
                      name="shop-format-store"
                      checked={storeId === store.id}
                      onChange={() => setDraft({ format, administrationStoreId: store.id })}
                    />
                    {store.name}
                  </label>
                ))}
              </fieldset>
            )
          ) : null}
          {needsTerms && options.data ? (
            <div className="karavan-module__notice" role="status">
              <p>Примите условия продавца в Караване, чтобы создать витрину.</p>
              {module.sellerBotUrl ? (
                <button type="button" onClick={() => openMaxBotLink(module.sellerBotUrl!)}>
                  Открыть Караван
                </button>
              ) : null}
              <button type="button" onClick={() => void options.refetch()}>
                Проверить снова
              </button>
            </div>
          ) : null}
          {changed && (format !== 'storefront' || administrationSupported) ? (
            preview.isPending || preview.isFetching ? (
              <p role="status">Проверяем смену формата…</p>
            ) : preview.isError ? (
              <ShopFailure error={preview.error} retry={() => void preview.refetch()} />
            ) : preview.data ? (
              <div className="karavan-shop__format-impact" role="status">
                <p>
                  {format === 'storefront'
                    ? 'Кнопка бота будет открывать только выбранную витрину.'
                    : 'Кнопка магазина будет открывать витрины участников.'}
                </p>
                <p>
                  Затронутые чаты: {preview.data.affectedChats}. Витрины:{' '}
                  {preview.data.affectedStores}. Заявки: {preview.data.pendingApplications}.
                </p>
                <p>Витрины, товары и заказы сохранятся.</p>
                {market.status === 'active' ? (
                  <p>
                    Просмотр покупателями приостановится. После проверки откройте магазин снова.
                  </p>
                ) : null}
                <button
                  type="button"
                  className="karavan-module__primary"
                  disabled={
                    mutation.blocked ||
                    needsTerms ||
                    (format === 'storefront' && !administrationSupported)
                  }
                  onClick={() =>
                    mutation.mutate({
                      operation: 'format_update',
                      input: {
                        ...input,
                        commandId: crypto.randomUUID(),
                        fingerprint: preview.data!.fingerprint,
                      },
                    })
                  }
                >
                  Подтвердить смену формата
                </button>
              </div>
            ) : null
          ) : null}
          <button type="button" disabled={mutation.uncertain} onClick={() => setDraft(null)}>
            Отмена
          </button>
        </fieldset>
      )}
      <MutationFailure mutation={mutation} />
    </section>
  );
}
