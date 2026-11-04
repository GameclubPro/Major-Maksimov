import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { KaravanMarketplaceModule } from '@maxim/contracts/karavan-marketplace';
import type { ApiTransport } from '../../../lib/api/transport';
import {
  manageKaravanShop,
  type ShopScope,
  type ShopCommand,
  type ShopResponse,
} from '../../../lib/api/karavan-shop-client';
import { describeUserFacingError } from '../../../lib/user-facing-error';
import {
  pendingShopCommand,
  ShopCommandRunRejectedError,
  useShopCommands,
} from './command-runtime';
import type { ShopCommandUi } from './command-journal';
import { shopMutationFailureKind } from './command-failure';
export { shopMutationFailureKind } from './command-failure';
export type ShopModule = KaravanMarketplaceModule & {
  actorMaxUserId: string;
  sellerBotUrl?: string;
};
export const ShopContext = createContext<{
  api: ApiTransport;
  scope: ShopScope;
  module: ShopModule;
} | null>(null);
export function useShop() {
  const value = useContext(ShopContext);
  if (!value) throw new Error('Missing shop');
  return value;
}
export function useShopPages<
  K extends 'listings' | 'applications' | 'catalog' | 'invitations' | 'content' | 'seller_grants',
>(
  command: Extract<
    ShopCommand,
    {
      operation:
        | 'listings'
        | 'applications'
        | 'catalog'
        | 'invitations'
        | 'content'
        | 'seller_grants';
    }
  > & { operation: K },
  enabled = true,
) {
  const { api, scope } = useShop();
  return useInfiniteQuery({
    queryKey: ['karavan-shop', scope, 'pages', command],
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      manageKaravanShop<K>(
        api,
        scope,
        { ...command, input: { ...command.input, cursor: pageParam } } as Extract<
          ShopCommand,
          { operation: K }
        >,
        signal,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
    staleTime: 10_000,
  });
}
export function useShopQuery<K extends ShopCommand['operation']>(
  command: Extract<ShopCommand, { operation: K }>,
  enabled = true,
) {
  const { api, scope } = useShop();
  return useQuery({
    queryKey: ['karavan-shop', scope, command],
    enabled,
    queryFn: ({ signal }) => manageKaravanShop<K>(api, scope, command, signal),
    retry: false,
    staleTime: 10_000,
  });
}
export function useShopMutation(
  ui: Pick<ShopCommandUi, 'owner' | 'page'>,
  onSuccess?: (command: ShopCommand, data: ShopResponse<ShopCommand['operation']>) => void,
) {
  const commands = useShopCommands();
  const [error, setError] = useState<unknown>(null);
  const [lastCommand, setLastCommand] = useState<ShopCommand | null>(null);
  const callback = useRef(onSuccess);
  callback.current = onSuccess;
  const seen = useRef(new Set<string>());
  const identity = `${commands.key}:${ui.owner}`;
  const active = useRef({ identity, epoch: 0 });
  if (active.current.identity !== identity)
    active.current = { identity, epoch: active.current.epoch + 1 };
  useEffect(() => {
    return () => {
      active.current.epoch++;
    };
  }, [identity]);
  const journal = commands.journal?.key === commands.key ? commands.journal : null;
  const pending = pendingShopCommand(journal, ui.owner);
  const receipt = journal?.results[ui.owner] ?? null;
  useEffect(() => {
    if (!receipt || pending || commands.loading || commands.busy || commands.stale) return;
    const id = receipt.request.commandId;
    const expected =
      lastCommand && 'input' in lastCommand && 'commandId' in lastCommand.input
        ? lastCommand.input.commandId
        : null;
    if (expected && expected !== id) return;
    setError(null);
    if (seen.current.has(id)) return;
    seen.current.add(id);
    callback.current?.(receipt.request.command, receipt.response.data);
  }, [commands.loading, commands.busy, commands.stale, lastCommand, pending, receipt]);
  const mutateAsync = async (
    command: ShopCommand,
    extra: Omit<Partial<ShopCommandUi>, 'owner' | 'page'> = {},
  ) => {
    if (commands.blocked)
      throw new ShopCommandRunRejectedError(
        'not-started',
        new Error('Сначала продолжите сохранённое действие.'),
      );
    const requestIdentity = { ...active.current };
    setError(null);
    setLastCommand(command);
    try {
      return await commands.run(command, { ...ui, ...extra });
    } catch (cause) {
      if (
        !(cause instanceof ShopCommandRunRejectedError) &&
        active.current.identity === requestIdentity.identity &&
        active.current.epoch === requestIdentity.epoch
      )
        setError(cause);
      throw cause;
    }
  };
  const failure = error ? shopMutationFailureKind(error) : null;
  return {
    mutateAsync,
    mutate: (command: ShopCommand, extra?: Omit<Partial<ShopCommandUi>, 'owner' | 'page'>) => {
      void mutateAsync(command, extra).catch(() => undefined);
    },
    reset: () => setError(null),
    variables: pending ?? lastCommand ?? receipt?.request.command ?? undefined,
    data: !pending ? receipt?.response.data : undefined,
    receipt,
    pendingCommand: pending,
    error,
    isPending: commands.busy && Boolean(pending),
    isError: Boolean(error),
    isSuccess: Boolean(receipt) && !pending && !commands.busy && !error,
    failure,
    blocked: commands.blocked || Boolean(error && failure !== 'validation'),
    editingBlocked: commands.blocked || failure === 'unknown' || failure === 'forbidden',
    uncertain: commands.busy || Boolean(commands.journal?.pending),
    sharedRecovery: commands.storageError || Boolean(commands.journal?.pending),
  };
}

export function ShopFailure({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="karavan-module__notice" role="alert">
      <p>{describeUserFacingError(error, 'Не удалось загрузить магазин.')}</p>
      <button type="button" onClick={retry}>
        Повторить
      </button>
    </div>
  );
}
export function MutationFailure({
  mutation,
  onRefresh,
}: {
  mutation: ReturnType<typeof useShopMutation>;
  onRefresh?: () => void;
}) {
  const { scope } = useShop();
  const client = useQueryClient();
  if (!mutation.isError || mutation.sharedRecovery) return null;
  const kind = shopMutationFailureKind(mutation.error);
  return (
    <div className="karavan-module__notice" role="alert">
      <p>{describeUserFacingError(mutation.error, 'Не удалось выполнить действие.')}</p>
      {kind === 'validation' ? (
        <button type="button" onClick={() => mutation.reset()}>
          Исправить
        </button>
      ) : kind === 'refresh' ? (
        <button
          type="button"
          onClick={() => {
            onRefresh?.();
            void Promise.all([
              client.invalidateQueries({ queryKey: ['karavan-shop', scope] }),
              client.invalidateQueries({ queryKey: ['karavan-marketplace', scope.chatId] }),
            ]).then(() => mutation.reset());
          }}
        >
          Обновить данные
        </button>
      ) : null}
    </div>
  );
}
export function ShopLoading() {
  return <p role="status">Загружаем…</p>;
}
