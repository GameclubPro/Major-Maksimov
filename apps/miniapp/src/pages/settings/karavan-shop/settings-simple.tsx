import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import type { KaravanMarketplaceModule } from '@maxim/contracts/karavan-marketplace';
import { SettingsSectionToggle } from '../../../components/ui/settings-section-toggle';
import {
  StorefrontActions,
  useStorefrontDirty,
  useStorefrontWorkspace,
} from '../storefront-workspace';
import { MutationFailure, ShopLoading, useShopMutation } from './runtime';
import { ShopAdmissionPicker, type ShopAdmissionMode } from './admission-picker';
const FormatSettings = lazy(() => import('./format-simple'));

export default function ShopSettingsSimple({
  module,
  availability,
  hasPublications,
}: {
  module: KaravanMarketplaceModule;
  availability: ReactNode;
  hasPublications: boolean;
}) {
  const workspace = useStorefrontWorkspace();
  const market = module.marketplace!;
  const canManage = module.permissions.includes('manage_marketplace');
  const administration = market.format === 'storefront';
  const current = market.admissionMode ?? market.admissionPolicy;
  const [draft, setDraft] = useState<ShopAdmissionMode | null>(null);
  const mutation = useShopMutation({ owner: 'settings', page: 'settings' }, () => setDraft(null));
  useEffect(() => {
    const pending = mutation.pendingCommand;
    if (
      pending?.operation === 'settings' &&
      pending.input.admissionPolicy &&
      pending.input.admissionPolicy !== 'invitation'
    )
      setDraft(pending.input.admissionPolicy);
  }, [mutation.pendingCommand]);
  const value = draft ?? (current === 'invitation' ? null : current);
  const changed = draft !== null && draft !== current;
  useStorefrontDirty('admission', changed || mutation.uncertain);
  return (
    <>
      {canManage && !administration ? (
        <>
          {current === 'invitation' ? <p>Сейчас продавцы подают заявки по приглашению.</p> : null}
          <ShopAdmissionPicker
            value={value}
            disabled={mutation.editingBlocked}
            onChange={setDraft}
          />
          {changed ? (
            <p>
              Новые условия применятся к новым подключениям. Витрины и ожидающие заявки сохранятся.
            </p>
          ) : null}
          <MutationFailure mutation={mutation} />
          {changed ? (
            <StorefrontActions page="settings">
              <button
                type="button"
                className="karavan-module__primary"
                disabled={mutation.blocked}
                onClick={() =>
                  mutation.mutate({
                    operation: 'settings',
                    input: {
                      commandId: crypto.randomUUID(),
                      expectedRevision: market.editRevision,
                      admissionPolicy: draft!,
                    },
                  })
                }
              >
                Сохранить
              </button>
              <button type="button" disabled={mutation.uncertain} onClick={() => setDraft(null)}>
                Отмена
              </button>
            </StorefrontActions>
          ) : null}
        </>
      ) : null}
      <div className="karavan-shop__menu">
        {canManage && !administration ? (
          <>
            <SettingsSectionToggle
              title="Категории и правила"
              icon="tools"
              tone="sky"
              open={false}
              controls="karavan-shop-categories"
              onClick={() => workspace?.navigate('categories')}
            />
            {current === 'selected' ? (
              <SettingsSectionToggle
                title="Доступ продавцов"
                icon="comments"
                tone="sky"
                open={false}
                controls="karavan-shop-seller_access"
                onClick={() => workspace?.navigate('seller_access')}
              />
            ) : null}
          </>
        ) : null}
        {module.permissions.includes('review_listing') ? (
          <SettingsSectionToggle
            title="Заявки и история"
            icon="comments"
            tone="sky"
            open={false}
            controls="karavan-shop-applications"
            onClick={() => workspace?.navigate('applications')}
          />
        ) : null}
        {hasPublications ? (
          <SettingsSectionToggle
            title="Кнопка магазина под объявлениями"
            icon="send"
            tone="sky"
            open={false}
            controls="karavan-shop-publications"
            onClick={() => workspace?.navigate('publications')}
          />
        ) : null}
      </div>
      {canManage ? (
        <Suspense fallback={<ShopLoading />}>
          <FormatSettings readOnly={changed || mutation.editingBlocked} />
        </Suspense>
      ) : null}
      {module.permissions.includes('bind_chat') ? (
        <details className="karavan-shop__advanced">
          <summary>Другие чаты и подключения</summary>
          <button type="button" onClick={() => workspace?.navigate('chats')}>
            Подключённые чаты
          </button>
          <button type="button" onClick={() => workspace?.navigate('chats')}>
            Отключить этот чат
          </button>
        </details>
      ) : null}
      {availability}
    </>
  );
}
