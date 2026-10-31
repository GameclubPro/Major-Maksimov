import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  MarketplaceManagementRequest,
  MarketplaceManagementResponse,
} from '@maxim/contracts/karavan-marketplace-management';
import type { ApiTransport } from '../../../lib/api/transport';
import {
  dispatchShopRequest,
  prepareShopRequest,
  type ShopCommand,
} from '../../../lib/api/karavan-shop-client';
import { describeUserFacingError } from '../../../lib/user-facing-error';
import { useStorefrontDirty, useStorefrontWorkspace } from '../storefront-workspace';
import {
  claimShopCommand,
  isShopWriteOperation,
  loadShopCommandJournal,
  releaseShopCommand,
  reserveShopCommand,
  restoreShopCommand,
  settleShopCommand,
  shopJournalKey,
  type ShopCommandJournal,
  type ShopCommandUi,
  type ShopJournalScope,
} from './command-journal';
import { isDefiniteFirstShopRejection } from './command-failure';

export class ShopCommandRunRejectedError extends Error {
  constructor(
    readonly outcome: 'not-started' | 'recovery-required',
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : 'Не удалось начать действие.', { cause });
    this.name = 'ShopCommandRunRejectedError';
  }
}

function useCommandState(api: ApiTransport, scope: ShopJournalScope, readOnly: boolean) {
  const key = shopJournalKey(scope);
  const client = useQueryClient();
  const [journal, setJournal] = useState<ShopCommandJournal | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [storageError, setStorageError] = useState(false);
  const active = useRef({ key, epoch: 0 });
  const mounted = useRef(true);
  const working = useRef(false);
  const writeBlocked = useRef(readOnly);
  writeBlocked.current = readOnly;
  const channel = useRef<BroadcastChannel | null>(null);
  if (active.current.key !== key) active.current = { key, epoch: active.current.epoch + 1 };
  const matches = (identity: { key: string; epoch: number }) =>
    mounted.current &&
    active.current.key === identity.key &&
    active.current.epoch === identity.epoch;
  const apply = (value: ShopCommandJournal | null, identity: { key: string; epoch: number }) => {
    if (matches(identity)) setJournal(value);
  };
  const announce = () => {
    if (channel.current) {
      channel.current.postMessage(scope);
      return;
    }
    if (typeof BroadcastChannel === 'undefined') return;
    const notification = new BroadcastChannel('major-shop-commands');
    notification.postMessage(scope);
    notification.close();
  };
  const reload = useCallback(async () => {
    if (working.current) return;
    const identity = { key, epoch: ++active.current.epoch };
    setLoading(true);
    setError(null);
    setStorageError(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        loadShopCommandJournal(scope),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Сохранённое действие не загрузилось. Повторите загрузку.')),
            8000,
          );
        }),
      ]);
      if (matches(identity)) setJournal(value);
    } catch (cause) {
      if (matches(identity)) {
        setStorageError(true);
        setError(cause);
      }
    } finally {
      clearTimeout(timer);
      if (matches(identity)) setLoading(false);
    }
    // FLAG: Exact verified scope owns the hydration lifecycle.
  }, [key]);
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
      active.current.epoch++;
    };
  }, [reload]);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const current = new BroadcastChannel('major-shop-commands');
    channel.current = current;
    current.onmessage = (event: MessageEvent<Partial<ShopJournalScope>>) => {
      const other = event.data;
      if (
        other?.actorMaxUserId === scope.actorMaxUserId &&
        (other.chatId === scope.chatId || other.marketplaceId === scope.marketplaceId)
      )
        void reload();
    };
    return () => {
      channel.current = null;
      current.close();
    };
  }, [key, reload, scope.actorMaxUserId, scope.chatId, scope.marketplaceId]);

  const stale = Boolean(journal && journal.key !== key);
  const blocked = readOnly || loading || busy || storageError || stale || Boolean(journal?.pending);
  const perform = async (
    saved: ShopCommandJournal,
    identity: { key: string; epoch: number },
  ): Promise<MarketplaceManagementResponse> => {
    let claimed: ShopCommandJournal | null = null;
    let dispatched = false;
    try {
      if (writeBlocked.current) throw new Error('Сначала повторите проверку подключения.');
      if (saved.key !== key || !matches(identity))
        throw new Error('Изменился магазин. Вернитесь к исходному чату.');
      claimed = await claimShopCommand(saved);
      apply(claimed, identity);
      const readback = await loadShopCommandJournal(scope);
      if (
        !readback?.pending ||
        readback.key !== key ||
        readback.revision !== claimed.revision ||
        readback.pending.id !== claimed.pending?.id ||
        readback.pending.hash !== claimed.pending.hash ||
        readback.pending.lease?.owner !== claimed.pending.lease?.owner
      )
        throw new Error('Сохранённое действие изменилось. Повторите загрузку.');
      const request = await restoreShopCommand(readback);
      if (!matches(identity)) throw new Error('Изменился магазин. Вернитесь к исходному чату.');
      // FLAG: Recovery can fail while journal reads are in flight. Keep the exact
      // pending command and block dispatch; already dispatched results still settle.
      if (writeBlocked.current) throw new Error('Сначала повторите проверку подключения.');
      dispatched = true;
      const response = await dispatchShopRequest(api, request);
      const confirmed = await settleShopCommand(readback, response);
      apply(confirmed, identity);
      announce();
      if (!matches(identity)) throw new Error('Результат сохранён в исходном чате.');
      try {
        await Promise.all([
          client.invalidateQueries({ queryKey: ['karavan-shop', scopeWithoutActor(scope)] }),
          client.invalidateQueries({ queryKey: ['karavan-marketplace', scope.chatId] }),
        ]);
      } catch {
        // FLAG: A refresh error cannot undo a durable successful command receipt.
      }
      if (!matches(identity)) throw new Error('Результат сохранён в исходном чате.');
      return response;
    } catch (cause) {
      if (claimed?.pending) {
        try {
          const retained =
            dispatched && isDefiniteFirstShopRejection(cause, claimed.pending.dispatchCount)
              ? await settleShopCommand(claimed, null)
              : await releaseShopCommand(claimed);
          apply(retained, identity);
          announce();
        } catch {
          if (matches(identity)) setStorageError(true);
        }
      }
      if (matches(identity)) setError(cause);
      throw cause;
    }
  };
  const run = async (command: ShopCommand, ui: ShopCommandUi) => {
    if (!mounted.current || working.current || writeBlocked.current || blocked)
      throw new ShopCommandRunRejectedError(
        'not-started',
        new Error('Сначала продолжите сохранённое действие.'),
      );
    if (!isShopWriteOperation(command.operation))
      throw new ShopCommandRunRejectedError(
        'not-started',
        new Error('Это действие не изменяет магазин.'),
      );
    const identity = { ...active.current };
    working.current = true;
    setBusy(true);
    setError(null);
    let reserved = false;
    let request: MarketplaceManagementRequest | undefined;
    try {
      request = prepareShopRequest(scopeWithoutActor(scope), command);
      const saved = await reserveShopCommand(scope, request, ui);
      reserved = true;
      apply(saved, identity);
      announce();
      if (!matches(identity))
        throw new Error(
          'Изменился магазин. Сохранённое действие можно продолжить в исходном чате.',
        );
      return (await perform(saved, identity)).data;
    } catch (cause) {
      if (matches(identity)) {
        setError(cause);
        if (!reserved) {
          const current = await reloadAfterReserveFailure(identity);
          const pendingRequest = current?.pending?.request as
            | MarketplaceManagementRequest
            | undefined;
          // FLAG: Reservation can commit before its readback fails; retain that pending action.
          const sameRequest =
            current?.key === key &&
            request &&
            pendingRequest?.commandId === request.commandId &&
            pendingRequest.command.operation === request.command.operation;
          throw new ShopCommandRunRejectedError(
            current === undefined || sameRequest ? 'recovery-required' : 'not-started',
            cause,
          );
        }
      }
      throw cause;
    } finally {
      working.current = false;
      if (matches(identity)) setBusy(false);
    }
  };
  const reloadAfterReserveFailure = async (
    identity: { key: string; epoch: number },
    requirePending = true,
  ) => {
    try {
      const current = await loadShopCommandJournal(scope);
      apply(current, identity);
      if (matches(identity) && requirePending && !current?.pending) setStorageError(true);
      return current;
    } catch {
      if (matches(identity)) setStorageError(true);
      return undefined;
    }
  };
  const resume = async () => {
    if (
      writeBlocked.current ||
      working.current ||
      loading ||
      storageError ||
      stale ||
      !journal?.pending
    )
      return;
    const identity = { ...active.current };
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await perform(journal, identity);
    } catch {
      // FLAG: A failed claim can mean another tab advanced the same immutable command.
      if (matches(identity)) await reloadAfterReserveFailure(identity, false);
    } finally {
      working.current = false;
      if (matches(identity)) setBusy(false);
    }
  };
  return {
    key,
    journal,
    loading,
    busy,
    blocked,
    readOnly,
    stale,
    storageError,
    error,
    reload,
    run,
    resume,
  };
}
function scopeWithoutActor({ chatId, marketplaceId, expectedBindingGeneration }: ShopJournalScope) {
  return { chatId, marketplaceId, expectedBindingGeneration };
}
const ShopCommandContext = createContext<ReturnType<typeof useCommandState> | null>(null);
type ProviderProps = {
  api: ApiTransport;
  scope: ShopJournalScope;
  readOnly?: boolean;
  children: ReactNode;
};
export function ShopCommandProvider(props: ProviderProps) {
  return <CommandScopeProvider key={shopJournalKey(props.scope)} {...props} />;
}
function CommandScopeProvider({ api, scope, readOnly = false, children }: ProviderProps) {
  const commands = useCommandState(api, scope, readOnly);
  useStorefrontDirty('shop-command', Boolean(commands.journal?.pending) || commands.busy);
  return <ShopCommandContext.Provider value={commands}>{children}</ShopCommandContext.Provider>;
}
export function useShopCommands() {
  const value = useContext(ShopCommandContext);
  if (!value) throw new Error('Missing shop commands');
  return value;
}
export function ShopCommandRecovery() {
  const commands = useShopCommands();
  const workspace = useStorefrontWorkspace();
  if (commands.loading) return <p role="status">Проверяем сохранённые действия…</p>;
  if (commands.storageError)
    return (
      <div className="karavan-module__notice" role="alert">
        <p>
          {describeUserFacingError(commands.error, 'Не удалось загрузить сохранённое действие.')}
        </p>
        <button type="button" disabled={commands.busy} onClick={() => void commands.reload()}>
          Повторить загрузку
        </button>
      </div>
    );
  if (commands.stale)
    return (
      <div className="karavan-module__notice" role="alert">
        <p>
          В другом чате этого магазина осталось незавершённое действие. Вернитесь к исходному чату,
          чтобы продолжить.
        </p>
        <button type="button" onClick={() => void commands.reload()}>
          Обновить сохранённое действие
        </button>
      </div>
    );
  const pending = commands.journal?.pending;
  if (!pending) return null;
  const command = pendingShopCommand(commands.journal, pending.ui.owner);
  const label = command ? commandLabel(command, pending.ui) : 'Изменить магазин';
  const reason =
    command && 'input' in command && 'reason' in command.input ? command.input.reason : null;
  return (
    <div className="karavan-module__notice" role="status">
      <p>Незавершённое действие: {label}.</p>
      {reason ? <p>Причина: {reason}</p> : null}
      {commands.error ? (
        <p>{describeUserFacingError(commands.error, 'Исход действия пока неизвестен.')}</p>
      ) : null}
      <button
        type="button"
        disabled={commands.busy || commands.readOnly}
        onClick={() => void commands.resume()}
      >
        {commands.busy ? 'Продолжаем…' : 'Продолжить сохранённое действие'}
      </button>
      {workspace && workspace.page !== pending.ui.page ? (
        <button type="button" onClick={() => workspace.navigate(pending.ui.page)}>
          Открыть действие
        </button>
      ) : null}
    </div>
  );
}

function commandLabel(command: ShopCommand, ui: ShopCommandUi): string {
  switch (command.operation) {
    case 'image':
      return ui.imageTarget === 'coverImageUrl' ? 'Загрузить обложку' : 'Загрузить логотип';
    case 'appearance_apply':
    case 'appearance_save':
    case 'appearance_publish':
      return 'Сохранить оформление';
    case 'invitation_create':
      return 'Создать приглашение';
    case 'invitation_revoke':
      return 'Отозвать приглашение';
    case 'decide':
      return command.input.decision === 'approve'
        ? 'Одобрить продавца'
        : command.input.decision === 'reject'
          ? 'Отклонить заявку'
          : 'Отправить заявку на доработку';
    case 'moderate_listing':
      return command.input.action === 'resume' ? 'Снять ограничение продавца' : 'Скрыть продавца';
    case 'moderate_content':
      return command.input.active ? 'Скрыть объявление' : 'Снять ограничение объявления';
    case 'reorder_listings':
    case 'pins_save':
      return 'Изменить порядок';
    case 'rules_update':
    case 'rules_cancel':
      return 'Изменить категории и правила';
    case 'status':
      return command.input.status === 'active' ? 'Открыть магазин' : 'Приостановить магазин';
    case 'settings':
      return 'Сохранить настройки';
    default:
      return 'Изменить магазин';
  }
}

export function pendingShopCommand(
  journal: ShopCommandJournal | null,
  owner: string,
): ShopCommand | null {
  if (journal?.pending?.ui.owner !== owner) return null;
  const request = journal.pending.request as MarketplaceManagementRequest;
  return request.command;
}
