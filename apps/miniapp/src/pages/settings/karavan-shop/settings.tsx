import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import type { KaravanMarketplaceModule } from '@maxim/contracts/karavan-marketplace';
import { SettingsSectionToggle } from '../../../components/ui/settings-section-toggle';
import {
  StorefrontActions,
  useStorefrontDirty,
  useStorefrontWorkspace,
} from '../storefront-workspace';
import { MutationFailure, ShopLoading, useShopMutation } from './runtime';
import { SellerAccessAction, useSellerAccess } from './seller-access';

const Invitations = lazy(() => import('./invitations'));
const FormatSettings = lazy(() => import('./format-settings'));

export default function ShopSettings({
  module,
  hasPublications,
  availability,
}: {
  module: KaravanMarketplaceModule;
  hasPublications: boolean;
  availability: ReactNode;
}) {
  const workspace = useStorefrontWorkspace();
  const marketplace = module.marketplace!;
  const administration = marketplace.format === 'storefront';
  const canManage = module.permissions.includes('manage_marketplace');
  const access = useSellerAccess();
  const [policy, setPolicy] = useState<'open' | 'applications' | 'selected' | 'invitation' | null>(
    null,
  );
  const mutation = useShopMutation({ owner: 'settings', page: 'settings' }, () => setPolicy(null));
  useEffect(() => {
    if (
      mutation.pendingCommand?.operation === 'settings' &&
      mutation.pendingCommand.input.admissionPolicy
    )
      setPolicy(mutation.pendingCommand.input.admissionPolicy);
  }, [mutation.pendingCommand]);
  const current = marketplace.admissionMode ?? marketplace.admissionPolicy;
  const value = policy ?? current;
  const dirty = value !== current;
  useStorefrontDirty('admission', dirty);
  return (
    <>
      <div className="karavan-shop__menu">
        {hasPublications ? (
          <SettingsSectionToggle
            title="Объявления в чате"
            icon="send"
            tone="sky"
            open={false}
            controls="karavan-shop-publications"
            onClick={() => workspace?.navigate('publications')}
          />
        ) : null}
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
          </>
        ) : null}
        {module.permissions.includes('bind_chat') ? (
          <SettingsSectionToggle
            title="Подключённые чаты"
            icon="links"
            tone="sky"
            open={false}
            controls="karavan-shop-chats"
            onClick={() => workspace?.navigate('chats')}
          />
        ) : null}
      </div>
      {canManage ? (
        <Suspense fallback={<ShopLoading />}>
          <FormatSettings
            readOnly={
              dirty || access.sharing || access.mutation.editingBlocked || mutation.editingBlocked
            }
          />
        </Suspense>
      ) : null}
      {canManage && !administration ? (
        <fieldset
          className="karavan-module__choices"
          disabled={mutation.editingBlocked || access.sharing || access.mutation.editingBlocked}
        >
          <legend>Как добавлять продавцов</legend>
          {(
            [
              ['open', 'Свободно'],
              ['applications', 'Все желающие'],
              ['selected', 'Выбранные продавцы'],
              ['invitation', 'По приглашению'],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              <input
                type="radio"
                name="shop-admission"
                checked={value === key}
                onChange={() => setPolicy(key)}
              />
              {label}
            </label>
          ))}
        </fieldset>
      ) : null}
      {canManage && !administration && ['applications', 'invitation'].includes(value) ? (
        <p>Витрины появляются после вашего одобрения.</p>
      ) : null}
      <MutationFailure mutation={mutation} />
      {canManage && !administration && !dirty ? <SellerAccessAction /> : null}
      {canManage && !administration && value === 'invitation' && current === 'invitation' ? (
        <Suspense fallback={<ShopLoading />}>
          <Invitations />
        </Suspense>
      ) : null}
      {canManage && !administration && dirty ? (
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
                  expectedRevision: marketplace.editRevision,
                  admissionPolicy: value,
                },
              })
            }
          >
            Сохранить
          </button>
        </StorefrontActions>
      ) : null}
      {availability}
    </>
  );
}
