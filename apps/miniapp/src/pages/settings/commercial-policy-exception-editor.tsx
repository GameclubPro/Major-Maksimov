import { useRef, useState } from 'react';
import {
  COMMERCIAL_AD_CATEGORIES,
  commercialAdsExceptionSchema,
  type CommercialAdCategory,
  type CommercialAdsException,
} from '@maxim/contracts/settings';
import { COMMERCIAL_CATEGORY_LABELS } from '../../lib/commercial-ads-category-labels';
import type { CommercialAuthor, CommercialExceptionPrefill } from '../../lib/commercial-ads-policy';
import { AppIcon } from '../../components/ui/app-icon';
import { DateField } from '../../components/ui/date-field';
import { TimeField } from '../../components/ui/time-field';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { AuthorControl, CommercialAuthorPicker } from './commercial-policy-author-control';
import { categoryIcons, type CommercialSettingsScope } from './commercial-policy-model';
import './commercial-policy-sheets.css';

const datePart = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const timePart = (date: Date) =>
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

export function CommercialExceptionEditor({
  scope,
  entry,
  prefill,
  readOnly,
  onApply,
  onClose,
}: {
  scope: CommercialSettingsScope;
  entry: CommercialAdsException | null;
  prefill: CommercialExceptionPrefill | null;
  readOnly: boolean;
  onApply: (entry: CommercialAdsException) => void;
  onClose: () => void;
}) {
  const [author, setAuthor] = useState<CommercialAuthor | null>(
    entry ? { userId: entry.userId, userName: entry.userName } : prefill,
  );
  const [categories, setCategories] = useState<CommercialAdCategory[]>(
    entry?.categories ?? (prefill?.category ? [prefill.category] : []),
  );
  const [limited, setLimited] = useState(Boolean(entry?.expiresAt));
  const initialDate = new Date(entry?.expiresAt ?? Date.now() + 7 * 86400000);
  const [date, setDate] = useState(datePart(initialDate));
  const [time, setTime] = useState(timePart(initialDate));
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initial = useRef(JSON.stringify({ author, categories, limited, date, time }));
  const changed = JSON.stringify({ author, categories, limited, date, time }) !== initial.current;
  const apply = () => {
    const expires = limited ? new Date(`${date}T${time}`) : null;
    if (expires && (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now())) {
      setError('Выберите будущую дату и время.');
      return;
    }
    const parsed = commercialAdsExceptionSchema.safeParse({
      id: entry?.id ?? crypto.randomUUID(),
      userId: author?.userId,
      userName: author?.userName,
      categories,
      expiresAt: expires?.toISOString() ?? null,
    });
    if (!parsed.success) {
      setError(
        !author
          ? 'Выберите участника.'
          : !categories.length
            ? 'Выберите категорию.'
            : 'Проверьте данные исключения.',
      );
      return;
    }
    onApply(parsed.data);
  };
  return (
    <>
      <SettingsDrilldownPanel
        id="commercial-exception-editor"
        open
        title={entry ? 'Изменить исключение' : 'Новое исключение'}
        className="commercial-panel"
        onClose={onClose}
        confirmCloseWhen={changed}
        onDiscardChanges={onClose}
        keepFooterVisibleWhenKeyboardOpen
        footer={
          <button
            type="button"
            className="button button--accent commercial-policy__submit"
            disabled={readOnly || !author || !categories.length}
            onClick={apply}
          >
            {entry ? 'Готово' : 'Добавить'}
          </button>
        }
      >
        <div className="commercial-policy commercial-policy--sheet">
          <AuthorControl value={author} disabled={readOnly} onChoose={() => setPicker(true)} />
          <fieldset className="commercial-policy__fieldset">
            <legend>Что разрешить</legend>
            <div className="commercial-policy__choices">
              {COMMERCIAL_AD_CATEGORIES.map((category) => (
                <label key={category} className="commercial-policy__choice">
                  <input
                    type="checkbox"
                    checked={categories.includes(category)}
                    disabled={readOnly}
                    onChange={(event) => {
                      setError(null);
                      setCategories((previous) =>
                        event.target.checked
                          ? [...previous, category]
                          : previous.filter((item) => item !== category),
                      );
                    }}
                  />
                  <AppIcon icon={categoryIcons[category]} />
                  <span>{COMMERCIAL_CATEGORY_LABELS[category]}</span>
                  <span className="commercial-policy__choice-check">
                    <AppIcon icon="Check" />
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="commercial-policy__fieldset">
            <legend>Срок</legend>
            <div className="commercial-policy__duration" role="group" aria-label="Срок исключения">
              <button
                type="button"
                aria-pressed={!limited}
                disabled={readOnly}
                onClick={() => {
                  setLimited(false);
                  setError(null);
                }}
              >
                Без срока
              </button>
              <button
                type="button"
                aria-pressed={limited}
                disabled={readOnly}
                onClick={() => setLimited(true)}
              >
                До даты
              </button>
            </div>
            {limited ? (
              <div className="commercial-policy__date-time">
                <DateField
                  label="Дата"
                  value={date}
                  min={datePart(new Date())}
                  disabled={readOnly}
                  onChange={(value) => {
                    setDate(value);
                    setError(null);
                  }}
                />
                <TimeField
                  label="Время"
                  value={time}
                  disabled={readOnly}
                  onChange={(value) => {
                    setTime(value);
                    setError(null);
                  }}
                />
              </div>
            ) : null}
          </fieldset>
          {error ? (
            <p className="commercial-policy__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </SettingsDrilldownPanel>
      {picker ? (
        <CommercialAuthorPicker
          scope={scope}
          onClose={() => setPicker(false)}
          onSelect={(value) => {
            setAuthor(value);
            setPicker(false);
            setError(null);
          }}
        />
      ) : null}
    </>
  );
}
