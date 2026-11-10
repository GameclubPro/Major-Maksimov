import { useEffect, useState } from 'react';
import { useStorefrontDirty } from '../storefront-workspace';
import { ShopFormatPicker, shopFormatLabel, type ShopFormat } from './format-picker';
import { MutationFailure, ShopFailure, useShop, useShopMutation, useShopQuery } from './runtime';

export default function ShopFormatSimple({ readOnly = false }: { readOnly?: boolean }) {
  const { module } = useShop();
  const market = module.marketplace!;
  const current = market.format ?? 'community';
  const [draft, setDraft] = useState<ShopFormat | null>(null);
  const mutation = useShopMutation({ owner: 'format', page: 'settings' }, () => setDraft(null));
  useEffect(() => {
    if (mutation.pendingCommand?.operation === 'format_update')
      setDraft(mutation.pendingCommand.input.format);
  }, [mutation.pendingCommand]);
  const input = {
    expectedRevision: market.editRevision,
    format: draft ?? current,
    setupVersion: 2 as const,
  };
  const changed = draft !== null && draft !== current;
  const preview = useShopQuery<'format_preview'>(
    { operation: 'format_preview', input },
    changed && !mutation.uncertain,
  );
  useStorefrontDirty('shop-format', changed || mutation.uncertain);
  return (
    <section className="karavan-shop-format-settings" aria-label="Формат магазина">
      <h3>Кто продаёт</h3>
      {!draft ? (
        <>
          <p>{shopFormatLabel(current)}</p>
          <button
            type="button"
            disabled={readOnly || mutation.editingBlocked}
            onClick={() => setDraft(current)}
          >
            Изменить формат
          </button>
        </>
      ) : (
        <>
          <ShopFormatPicker
            simple
            value={draft}
            disabled={readOnly || mutation.editingBlocked}
            onChange={setDraft}
          />
          {changed ? (
            preview.isPending || preview.isFetching ? (
              <p role="status">Проверяем состав магазина…</p>
            ) : preview.isError ? (
              <ShopFailure error={preview.error} retry={() => void preview.refetch()} />
            ) : preview.data ? (
              <div className="karavan-shop__format-impact">
                <p>
                  {draft === 'storefront'
                    ? 'Покупатели увидят подключённые витрины администрации.'
                    : 'Покупатели увидят допущенные витрины участников.'}
                </p>
                <p>
                  Затронутые чаты: {preview.data.affectedChats}. Витрины:{' '}
                  {preview.data.affectedStores}. Ожидающие заявки:{' '}
                  {preview.data.pendingApplications}.
                </p>
                <p>Витрины, товары и история сохранятся.</p>
                <button
                  type="button"
                  className="karavan-module__primary"
                  disabled={mutation.blocked || readOnly}
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
                  Применить формат
                </button>
              </div>
            ) : null
          ) : null}
          <button type="button" disabled={mutation.uncertain} onClick={() => setDraft(null)}>
            Отмена
          </button>
        </>
      )}
      <MutationFailure mutation={mutation} />
    </section>
  );
}
