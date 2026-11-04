import { Suspense, type ComponentProps } from 'react';
import {
  COMMERCIAL_AD_CATEGORIES,
  createDefaultCommercialAdsPolicy,
  type CommercialAdsPolicy,
} from '@maxim/contracts/settings';
import type { ChatSettingsFieldAdapter } from '../../features/network-settings/field-model';
import { COMMERCIAL_CATEGORY_LABELS } from '../../lib/commercial-ads-category-labels';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import { AppIcon } from '../../components/ui/app-icon';
import { categoryIcons, type CommercialSettingsScope } from './commercial-policy-model';
import './commercial-policy.css';

const CommercialPolicyTools = recoverableLazyNamedComponent<
  ComponentProps<typeof import('./commercial-policy-tools').CommercialPolicyTools>
>(() => import('./commercial-policy-tools'), 'CommercialPolicyTools');

export function CommercialPolicyFields({
  fields,
  scope,
  aiActive,
}: {
  fields: ChatSettingsFieldAdapter;
  scope?: CommercialSettingsScope;
  aiActive: boolean;
}) {
  const state = fields.read('commercialAdsPolicy');
  const policy =
    state.kind === 'common' ? (state.value ?? createDefaultCommercialAdsPolicy()) : null;
  const error = fields.error('commercialAdsPolicy');
  const disabled = fields.readOnly || !policy;
  const write = (next: CommercialAdsPolicy) => {
    fields.setError('commercialAdsPolicy', null);
    fields.setScalar('commercialAdsPolicy', next);
  };

  return (
    <div className="commercial-policy">
      <section className="commercial-policy__rules" aria-label="Что разрешено">
        <h4>Что разрешено</h4>
        <div className="commercial-policy__categories">
          {COMMERCIAL_AD_CATEGORIES.map((category) => {
            const allowed = policy?.categories[category] === 'ALLOW';
            const aiRequired = category === 'PERSONAL_SALE' && !aiActive;
            const cannotBlock = aiRequired && allowed;
            return (
              <div className="commercial-policy__category" key={category}>
                <span className="commercial-policy__category-icon" aria-hidden>
                  <AppIcon icon={categoryIcons[category]} />
                </span>
                <span className="commercial-policy__category-name">
                  {COMMERCIAL_CATEGORY_LABELS[category]}
                  {aiRequired ? (
                    <small className="commercial-policy__category-note">
                      Запрет доступен при ИИ-проверке
                    </small>
                  ) : null}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={allowed}
                  aria-label={`Разрешить: ${COMMERCIAL_CATEGORY_LABELS[category]}`}
                  className="commercial-policy__permission"
                  disabled={disabled || cannotBlock}
                  onClick={() =>
                    policy &&
                    !cannotBlock &&
                    write({
                      ...policy,
                      categories: { ...policy.categories, [category]: allowed ? 'BLOCK' : 'ALLOW' },
                    })
                  }
                >
                  <AppIcon icon={allowed ? 'Check' : 'Minus'} />
                  <span>
                    {state.kind === 'loading'
                      ? 'Загрузка'
                      : !policy
                        ? 'Разные'
                        : allowed
                          ? 'Разрешено'
                          : 'Запрещено'}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        {state.kind === 'mixed' ? (
          <p className="commercial-policy__notice" role="status">
            Правила различаются. Откройте настройки нужного чата.
          </p>
        ) : null}
        {error ? (
          <p className="commercial-policy__error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
      {scope ? (
        <Suspense fallback={null}>
          <CommercialPolicyTools fields={fields} scope={scope} policy={policy} />
        </Suspense>
      ) : null}
    </div>
  );
}
