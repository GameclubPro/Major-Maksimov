export type ShopAdmissionMode = 'open' | 'applications' | 'selected';

export const shopAdmissionChoices = [
  { value: 'open', title: 'Свободно', description: 'Продавцы размещаются без вашего одобрения' },
  { value: 'applications', title: 'По заявкам', description: 'Вы решаете, какую витрину добавить' },
  { value: 'selected', title: 'Выбранные продавцы', description: 'Вы сами предоставляете доступ' },
] as const;

export function ShopAdmissionPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: ShopAdmissionMode | null;
  onChange: (value: ShopAdmissionMode) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="karavan-shop__admission" disabled={disabled}>
      <legend>Как добавлять продавцов?</legend>
      {shopAdmissionChoices.map((choice) => (
        <label className="karavan-shop__admission-choice" key={choice.value}>
          <input
            type="radio"
            name="shop-admission-mode"
            value={choice.value}
            checked={value === choice.value}
            onChange={() => onChange(choice.value)}
          />
          <span>
            <strong>{choice.title}</strong>
            <span>{choice.description}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
