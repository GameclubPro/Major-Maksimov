import { Suspense, useState, type ComponentProps } from 'react';
import type { CommercialAdsPolicy } from '@maxim/contracts/settings';
import type { ChatSettingsFieldAdapter } from '../../features/network-settings/field-model';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import { AppIcon } from '../../components/ui/app-icon';
import type { CommercialSettingsScope } from './commercial-policy-model';
import './commercial-policy-tools.css';

const CommercialExceptionsSheets = recoverableLazyNamedComponent<
  ComponentProps<typeof import('./commercial-policy-exceptions').CommercialExceptionsSheets>
>(() => import('./commercial-policy-exceptions'), 'CommercialExceptionsSheets');
const CommercialPreviewSheet = recoverableLazyNamedComponent<
  ComponentProps<typeof import('./commercial-policy-preview').CommercialPreviewSheet>
>(() => import('./commercial-policy-preview'), 'CommercialPreviewSheet');

export function CommercialPolicyTools({
  fields,
  scope,
  policy,
}: {
  fields: ChatSettingsFieldAdapter;
  scope: CommercialSettingsScope;
  policy: CommercialAdsPolicy | null;
}) {
  const [view, setView] = useState<'exceptions' | 'preview' | null>(null);
  const [prefill, setPrefill] = useState(scope.prefill ?? null);
  const disabled = fields.readOnly || !policy;
  const enabled = fields.read('commercialAdsFilterEnabled');
  const policyState = fields.read('commercialAdsPolicy');
  const sensitivity = fields.read('commercialAdsSensitivity');
  const warn = fields.read('commercialAdsWarnThreshold');
  const deletion = fields.read('commercialAdsDeleteThreshold');
  const classification =
    sensitivity.kind === 'common' && warn.kind === 'common' && deletion.kind === 'common'
      ? {
          commercialAdsSensitivity: sensitivity.value,
          commercialAdsWarnThreshold: warn.value,
          commercialAdsDeleteThreshold: deletion.value,
        }
      : null;
  return (
    <>
      <nav className="commercial-policy__tools" aria-label="Инструменты рекламы">
        <button type="button" disabled={disabled} onClick={() => setView('exceptions')}>
          <span className="commercial-policy__tool-icon">
            <AppIcon icon="UserPlus" />
          </span>
          <span>Исключения</span>
          <AppIcon icon="NavArrowRight" />
        </button>
        <button
          type="button"
          disabled={disabled || enabled.kind !== 'common' || !classification}
          onClick={() => setView('preview')}
        >
          <span className="commercial-policy__tool-icon">
            <AppIcon icon="Flask" />
          </span>
          <span>Проверить сообщение</span>
          <AppIcon icon="NavArrowRight" />
        </button>
        <button type="button" onClick={scope.onOpenJournal}>
          <span className="commercial-policy__tool-icon">
            <AppIcon icon="Book" />
          </span>
          <span>Журнал</span>
          <AppIcon icon="NavArrowRight" />
        </button>
      </nav>
      <Suspense fallback={null}>
        {policy && (view === 'exceptions' || prefill) ? (
          <CommercialExceptionsSheets
            scope={scope}
            policy={policy}
            readOnly={disabled}
            open={view === 'exceptions'}
            prefill={prefill}
            onPrefillHandled={() => setPrefill(null)}
            onOpen={() => setView('exceptions')}
            onClose={() => setView(null)}
            onChange={(next) => {
              fields.setError('commercialAdsPolicy', null);
              fields.setScalar('commercialAdsPolicy', next);
            }}
          />
        ) : null}
        {policy && view === 'preview' && enabled.kind === 'common' && classification ? (
          <CommercialPreviewSheet
            scope={scope}
            policy={policyState.kind === 'common' ? policyState.value : null}
            enabled={enabled.value}
            classification={classification}
            dirty={
              fields.isDirty('commercialAdsPolicy') ||
              fields.isDirty('commercialAdsFilterEnabled') ||
              fields.isDirty('commercialAdsSensitivity') ||
              fields.isDirty('commercialAdsWarnThreshold') ||
              fields.isDirty('commercialAdsDeleteThreshold')
            }
            onClose={() => setView(null)}
          />
        ) : null}
      </Suspense>
    </>
  );
}
