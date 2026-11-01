import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { openKaravanMarketplace } from '../../../lib/api/karavan-marketplace-client';
import { openKaravanStorefront } from '../../../lib/karavan-storefront-navigation';
import { describeUserFacingError } from '../../../lib/user-facing-error';
import { useShopCommands } from './command-runtime';
import { useShop } from './runtime';

export function useAdministrationStorefrontLink(enabled: boolean) {
  const { api, scope, module } = useShop();
  const commands = useShopCommands();
  const client = useQueryClient();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef({ identity: '', epoch: 0 });
  const identity = `${module.actorMaxUserId}:${scope.chatId}:${scope.marketplaceId}:${scope.expectedBindingGeneration}:${module.marketplace?.format}:${module.marketplace?.formatRevision}:${module.marketplace?.administrationStoreId}`;
  const returning = useRef(false);
  if (active.current.identity !== identity)
    active.current = { identity, epoch: active.current.epoch + 1 };
  const knownStore = Boolean(
    module.administrationStore &&
    module.administrationStore.id === module.marketplace?.administrationStoreId &&
    !['ARCHIVED', 'BLOCKED'].includes(module.administrationStore.status),
  );
  const disabled =
    !enabled ||
    !knownStore ||
    !module.permissions.includes('manage_marketplace') ||
    commands.blocked ||
    opening;
  useEffect(() => {
    setOpening(false);
    setError(null);
    returning.current = false;
    const refresh = () => {
      if (!returning.current || document.visibilityState === 'hidden') return;
      returning.current = false;
      void client.invalidateQueries({ queryKey: ['karavan-marketplace', scope.chatId] });
      void client.invalidateQueries({ queryKey: ['karavan-shop', scope] });
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active.current.epoch++;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [identity, client]);
  const open = async () => {
    if (disabled) return;
    const request = { ...active.current };
    const current = () =>
      request.identity === active.current.identity && request.epoch === active.current.epoch;
    setOpening(true);
    setError(null);
    try {
      // FLAG: The server derives the fixed administrative store from the verified
      // marketplace binding. Never launch a personal seller profile or a supplied store id.
      const handoff = await openKaravanMarketplace(
        api,
        scope.chatId,
        scope.marketplaceId,
        'storefront',
      );
      if (!current()) return;
      if (!openKaravanStorefront(handoff.url))
        throw new Error('Не удалось открыть витрину. Повторите переход.');
      returning.current = true;
    } catch (cause) {
      if (current())
        setError(describeUserFacingError(cause, 'Не удалось открыть управление витриной.'));
    } finally {
      if (current()) setOpening(false);
    }
  };
  return { open, opening, error, disabled, knownStore };
}
