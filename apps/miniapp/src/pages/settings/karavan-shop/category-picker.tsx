import { useEffect, useState } from 'react';

export type ShopCategoryOption = {
  id: string;
  label: string;
  subcategories: { id: string; label: string }[];
};
export type ShopCategorySelection = { categories: string[]; subcategories: string[] };

export function allShopCategories(options: readonly ShopCategoryOption[]): ShopCategorySelection {
  return {
    categories: options.map((item) => item.id),
    subcategories: options.flatMap((item) => item.subcategories.map((sub) => sub.id)),
  };
}

export function areAllShopCategories(
  value: ShopCategorySelection,
  options: readonly ShopCategoryOption[],
) {
  return (
    options.length > 0 &&
    options.every(
      (item) =>
        value.categories.includes(item.id) &&
        item.subcategories.every((sub) => value.subcategories.includes(sub.id)),
    )
  );
}

export function ShopCategoryPicker({
  options,
  value,
  onChange,
  disabled = false,
  onEditingChange,
}: {
  options: readonly ShopCategoryOption[];
  value: ShopCategorySelection;
  onChange: (value: ShopCategorySelection) => void;
  disabled?: boolean;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [restricted, setRestricted] = useState(false);
  const all = areAllShopCategories(value, options);
  useEffect(() => () => onEditingChange?.(false), [onEditingChange]);
  const close = () => {
    setOpen(false);
    onEditingChange?.(false);
  };
  const begin = () => {
    setDraft(value);
    setRestricted(!all);
    setOpen(true);
    onEditingChange?.(true);
  };
  if (!open)
    return (
      <button
        className="karavan-shop__category-summary"
        type="button"
        disabled={disabled}
        onClick={begin}
      >
        <span>Категории: {all ? 'все' : `выбрано ${value.categories.length}`}</span>
        <span>Изменить</span>
      </button>
    );
  const updateCategory = (category: ShopCategoryOption, checked: boolean) => {
    setDraft((current) => ({
      categories: checked
        ? [...new Set([...current.categories, category.id])]
        : current.categories.filter((id) => id !== category.id),
      subcategories: checked
        ? [...new Set([...current.subcategories, ...category.subcategories.map((sub) => sub.id)])]
        : current.subcategories.filter(
            (id) => !category.subcategories.some((sub) => sub.id === id),
          ),
    }));
  };
  return (
    <fieldset className="karavan-shop__category-picker" disabled={disabled}>
      <legend>Категории</legend>
      <label className="karavan-shop__check">
        <input
          type="radio"
          name="shop-category-mode"
          checked={!restricted}
          onChange={() => setRestricted(false)}
        />
        Все категории
      </label>
      <label className="karavan-shop__check">
        <input
          type="radio"
          name="shop-category-mode"
          checked={restricted}
          onChange={() => setRestricted(true)}
        />
        Только выбранные
      </label>
      {restricted
        ? options.map((category) => (
            <details className="karavan-shop__category" key={category.id}>
              <summary>
                {category.label}
                <span>{draft.categories.includes(category.id) ? 'Выбрано' : 'Не выбрано'}</span>
              </summary>
              <label className="karavan-shop__check">
                <input
                  type="checkbox"
                  checked={
                    draft.categories.includes(category.id) &&
                    category.subcategories.every((sub) => draft.subcategories.includes(sub.id))
                  }
                  ref={(input) => {
                    if (input)
                      input.indeterminate =
                        draft.categories.includes(category.id) &&
                        category.subcategories.some((sub) => !draft.subcategories.includes(sub.id));
                  }}
                  onChange={(event) => updateCategory(category, event.target.checked)}
                />
                Вся категория
              </label>
              {category.subcategories.map((sub) => (
                <label className="karavan-shop__check" key={sub.id}>
                  <input
                    type="checkbox"
                    checked={draft.subcategories.includes(sub.id)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...new Set([...draft.subcategories, sub.id])]
                        : draft.subcategories.filter((id) => id !== sub.id);
                      const selected = category.subcategories.some((item) =>
                        next.includes(item.id),
                      );
                      setDraft({
                        categories: selected
                          ? [...new Set([...draft.categories, category.id])]
                          : draft.categories.filter((id) => id !== category.id),
                        subcategories: next,
                      });
                    }}
                  />
                  {sub.label}
                </label>
              ))}
            </details>
          ))
        : null}
      {restricted && !draft.categories.length ? (
        <p role="status">Выберите хотя бы одну категорию.</p>
      ) : null}
      <div className="karavan-module__actions">
        <button
          type="button"
          className="karavan-module__primary"
          disabled={restricted && !draft.categories.length}
          onClick={() => {
            onChange(restricted ? draft : allShopCategories(options));
            close();
          }}
        >
          Готово
        </button>
        <button type="button" onClick={close}>
          Отмена
        </button>
      </div>
    </fieldset>
  );
}
