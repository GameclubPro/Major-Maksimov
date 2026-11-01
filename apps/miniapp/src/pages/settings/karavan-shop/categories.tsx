import { useEffect, useState } from 'react';
import { StorefrontActions, useStorefrontDirty } from '../storefront-workspace';
import { useQuery } from '@tanstack/react-query';
import type { MarketplaceManagementOperation } from '@maxim/contracts/karavan-marketplace-management';
import { getKaravanMarketplaceSetupOptions } from '../../../lib/api/karavan-marketplace-client';
import { manageKaravanShop, type ShopResponse } from '../../../lib/api/karavan-shop-client';
import {
  MutationFailure,
  ShopFailure,
  ShopLoading,
  useShop,
  useShopMutation,
  useShopQuery,
} from './runtime';
import {
  sameShopRules,
  orderedShopCategories,
  shopRulesRequireAcceptance,
  shopRulesNeedConfirmation,
} from './category-changes';
type Rules = Extract<
  MarketplaceManagementOperation,
  { operation: 'rules_preview' }
>['input']['rules'];
type PreviewInput = Extract<
  MarketplaceManagementOperation,
  { operation: 'rules_preview' }
>['input'];
export default function ShopCategories() {
  const { api, scope } = useShop();
  const query = useShopQuery<'detail'>({ operation: 'detail' });
  const options = useQuery({
    queryKey: ['karavan-category-options', scope.chatId],
    queryFn: ({ signal }) => getKaravanMarketplaceSetupOptions(api, scope.chatId, signal),
    retry: false,
  });
  const [draft, setDraft] = useState<Rules | null>(null),
    [preview, setPreview] = useState<{
      input: PreviewInput;
      impact: ShopResponse<'rules_preview'>;
    } | null>(null);
  const mutation = useShopMutation({ owner: 'rules', page: 'categories' }, (command) => {
    if (command.operation === 'rules_update') {
      setDraft(null);
      setPreview(null);
    }
  });
  useEffect(() => {
    if (mutation.pendingCommand?.operation === 'rules_update')
      setDraft(mutation.pendingCommand.input.rules);
  }, [mutation.pendingCommand]);
  const [checking, setChecking] = useState(false),
    [error, setError] = useState<unknown>(null);
  const [arranging, setArranging] = useState(false);
  const value = draft ?? query.data?.rules;
  const categoryOrder = value ? orderedShopCategories(value) : [];
  const changed = !!draft && !!query.data && !sameShopRules(draft, query.data.rules);
  useStorefrontDirty('categories', changed || checking || mutation.uncertain);
  if (query.isPending || options.isPending) return <ShopLoading />;
  if (query.isError || options.isError || !value)
    return (
      <ShopFailure
        error={query.error ?? options.error}
        retry={() => {
          void query.refetch();
          void options.refetch();
        }}
      />
    );
  const change = (next: Rules) => {
    setDraft({
      text: next.text,
      allowedCategoryIds: next.allowedCategoryIds,
      allowedSubcategoryIds: next.allowedSubcategoryIds,
      categoryOrder: next.categoryOrder,
    });
    setPreview(null);
    setError(null);
  };
  const calculate = async () => {
    if (checking || mutation.blocked || !changed) return;
    const original = query.data.rules;
    const requiresAcceptance = shopRulesRequireAcceptance(original, value);
    const delayed = requiresAcceptance && (query.data.counts.approvedListings ?? 1) > 0;
    const input: PreviewInput = {
      expectedPolicyRevision: query.data.marketplace.policyRevision,
      rules: {
        text: value.text,
        allowedCategoryIds: value.allowedCategoryIds,
        allowedSubcategoryIds: value.allowedSubcategoryIds,
        categoryOrder: value.categoryOrder,
      },
      requiresAcceptance,
      effectiveAt: new Date(Date.now() + (delayed ? 14 * 86400000 + 120000 : 0)).toISOString(),
    };
    setChecking(true);
    setError(null);
    try {
      const impact = await manageKaravanShop<'rules_preview'>(api, scope, {
        operation: 'rules_preview',
        input,
      });
      if (shopRulesNeedConfirmation(impact, delayed)) setPreview({ input, impact });
      else
        await mutation
          .mutateAsync({
            operation: 'rules_update',
            input: { ...input, commandId: crypto.randomUUID(), fingerprint: impact.fingerprint },
          })
          .catch(() => {});
    } catch (err) {
      setError(err);
    } finally {
      setChecking(false);
    }
  };
  const scheduled = query.data.scheduledRules;
  return (
    <>
      <MutationFailure mutation={mutation} onRefresh={() => setPreview(null)} />
      {scheduled ? (
        <div className="karavan-shop__row">
          <p>
            Изменения вступят в силу {new Date(scheduled.effectiveAt).toLocaleDateString('ru-RU')}
          </p>
          <button
            type="button"
            disabled={mutation.blocked}
            onClick={() =>
              mutation.mutate({
                operation: 'rules_cancel',
                input: {
                  commandId: crypto.randomUUID(),
                  expectedPolicyRevision: query.data.marketplace.policyRevision,
                  rulesVersionId: scheduled.id,
                },
              })
            }
          >
            Отменить изменения
          </button>
        </div>
      ) : null}
      <fieldset
        className="karavan-shop__form"
        disabled={mutation.editingBlocked || checking || !!scheduled}
      >
        {options.data.categories.map((category) => {
          const enabled = value.allowedCategoryIds.includes(category.id);
          const subcategories = category.id === 'real_estate' ? [] : category.subcategories;
          return (
            <details key={category.id} className="karavan-shop__category">
              <summary>
                <span>{category.label}</span>
                <span>{enabled ? 'Выбрано' : 'Не выбрано'}</span>
              </summary>
              <label className="karavan-shop__check">
                <input
                  type="checkbox"
                  checked={
                    enabled &&
                    subcategories.every((row) => value.allowedSubcategoryIds.includes(row.id))
                  }
                  ref={(input) => {
                    if (input)
                      input.indeterminate =
                        enabled &&
                        subcategories.some((row) => !value.allowedSubcategoryIds.includes(row.id));
                  }}
                  onChange={(event) => {
                    const next = event.target.checked;
                    change({
                      ...value,
                      allowedCategoryIds: next
                        ? [...new Set([...value.allowedCategoryIds, category.id])]
                        : value.allowedCategoryIds.filter((id) => id !== category.id),
                      allowedSubcategoryIds: next
                        ? [
                            ...new Set([
                              ...value.allowedSubcategoryIds,
                              ...category.subcategories.map((row) => row.id),
                            ]),
                          ]
                        : value.allowedSubcategoryIds.filter(
                            (id) => !category.subcategories.some((row) => row.id === id),
                          ),
                      categoryOrder: next
                        ? [...value.categoryOrder, category.id].filter(
                            (id, index, all) => all.indexOf(id) === index,
                          )
                        : value.categoryOrder.filter((id) => id !== category.id),
                    });
                  }}
                />
                Вся категория
              </label>
              {subcategories.map((subcategory) => (
                <label className="karavan-shop__check" key={subcategory.id}>
                  <input
                    type="checkbox"
                    checked={value.allowedSubcategoryIds.includes(subcategory.id)}
                    onChange={(event) => {
                      const subs = event.target.checked
                        ? [...value.allowedSubcategoryIds, subcategory.id]
                        : value.allowedSubcategoryIds.filter((id) => id !== subcategory.id);
                      const hasAny = category.subcategories.some((row) => subs.includes(row.id));
                      change({
                        ...value,
                        allowedSubcategoryIds: subs,
                        allowedCategoryIds: hasAny
                          ? [...new Set([...value.allowedCategoryIds, category.id])]
                          : value.allowedCategoryIds.filter((id) => id !== category.id),
                        categoryOrder: hasAny
                          ? [...new Set([...value.categoryOrder, category.id])]
                          : value.categoryOrder.filter((id) => id !== category.id),
                      });
                    }}
                  />
                  {subcategory.label}
                </label>
              ))}
            </details>
          );
        })}
        {categoryOrder.length > 1 ? (
          <div>
            <button type="button" aria-pressed={arranging} onClick={() => setArranging(!arranging)}>
              {arranging ? 'Готово' : 'Изменить порядок категорий'}
            </button>
            {arranging
              ? categoryOrder.map((id, index) => {
                  const label = options.data.categories.find((item) => item.id === id)?.label ?? id;
                  const move = (offset: number) => {
                    const next = [...categoryOrder];
                    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
                    change({ ...value, categoryOrder: next });
                  };
                  return (
                    <div className="karavan-shop__block" key={id}>
                      <span>{label}</span>
                      <button
                        type="button"
                        aria-label={`Выше: ${label}`}
                        disabled={index === 0}
                        onClick={() => move(-1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={`Ниже: ${label}`}
                        disabled={index === categoryOrder.length - 1}
                        onClick={() => move(1)}
                      >
                        ↓
                      </button>
                    </div>
                  );
                })
              : null}
          </div>
        ) : null}
        <details>
          <summary>Правила размещения</summary>
          <label className="karavan-module__field">
            <textarea
              aria-label="Правила размещения"
              value={value.text}
              maxLength={12000}
              rows={5}
              onChange={(event) => change({ ...value, text: event.target.value })}
            />
          </label>
        </details>
      </fieldset>
      {error ? <ShopFailure error={error} retry={() => void calculate()} /> : null}
      <StorefrontActions page="categories">
        {changed && !preview ? (
          <button
            type="button"
            className="karavan-module__primary"
            disabled={
              checking || mutation.blocked || !value.allowedCategoryIds.length || !value.text.trim()
            }
            onClick={() => void calculate()}
          >
            {checking ? 'Проверяем…' : 'Сохранить'}
          </button>
        ) : null}
      </StorefrontActions>
      {preview ? (
        <div className="karavan-shop__row">
          <strong>Изменения категорий</strong>
          <p>
            Скроются объявления: {preview.impact.hiddenOffers}. Продавцы:{' '}
            {preview.impact.affectedStores}.
          </p>
          {preview.impact.emptiedStores ? (
            <p>Без доступных объявлений: {preview.impact.emptiedStores}.</p>
          ) : null}
          <p>
            Начнут действовать {new Date(preview.input.effectiveAt).toLocaleDateString('ru-RU')}
          </p>
          {preview.input.requiresAcceptance ? (
            <p>Продавцам потребуется принять новые правила.</p>
          ) : null}
          <StorefrontActions page="categories">
            <button
              type="button"
              className="karavan-module__primary"
              disabled={mutation.blocked}
              onClick={() =>
                void mutation
                  .mutateAsync({
                    operation: 'rules_update',
                    input: {
                      ...preview.input,
                      commandId: crypto.randomUUID(),
                      fingerprint: preview.impact.fingerprint,
                    },
                  })
                  .then(() => {
                    setDraft(null);
                    setPreview(null);
                  })
                  .catch(() => {})
              }
            >
              Применить категории и правила
            </button>
          </StorefrontActions>
        </div>
      ) : null}
    </>
  );
}
