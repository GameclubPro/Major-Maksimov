import { SettingsSectionIcon } from '../../../components/ui/settings-section-toggle';

export type ShopFormat = 'storefront' | 'community';

export const shopFormatLabel = (format: ShopFormat) =>
  format === 'storefront' ? 'Витрина администрации' : 'Магазин участников';

export function ShopFormatPicker({
  value,
  onChange,
  disabled = false,
  storefrontDisabled = false,
  simple = false,
}: {
  value: ShopFormat | null;
  onChange: (format: ShopFormat) => void;
  disabled?: boolean;
  storefrontDisabled?: boolean;
  simple?: boolean;
}) {
  return (
    <div className="karavan-shop-format" role="group" aria-label="Формат магазина">
      {(
        [
          {
            id: 'storefront',
            icon: 'storefront',
            text: 'Одна общая витрина. Кнопка бота ведёт сразу к вашим товарам и услугам.',
            destination: 'Сразу в вашу витрину',
          },
          {
            id: 'community',
            icon: 'comments',
            text: 'Витрины участников в одном магазине. Размещение — после вашего одобрения.',
            destination: 'В магазин с витринами',
          },
        ] as const
      ).map((format) => (
        <button
          type="button"
          className="karavan-shop-format__option"
          key={format.id}
          aria-pressed={value === format.id}
          disabled={disabled || (format.id === 'storefront' && storefrontDisabled)}
          onClick={() => onChange(format.id)}
        >
          <span className="karavan-shop-format__icon" aria-hidden="true">
            <SettingsSectionIcon name={format.icon} />
          </span>
          <span className="karavan-shop-format__copy">
            <strong>
              {simple
                ? format.id === 'storefront'
                  ? 'Администрация'
                  : 'Участники'
                : shopFormatLabel(format.id)}
            </strong>
            <span>
              {simple
                ? format.id === 'storefront'
                  ? 'Витрины администрации чата'
                  : 'Продавцы размещаются на выбранных вами условиях'
                : format.text}
            </span>
            {!simple ? <small>{format.destination}</small> : null}
          </span>
          <span className="karavan-shop-format__radio" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
