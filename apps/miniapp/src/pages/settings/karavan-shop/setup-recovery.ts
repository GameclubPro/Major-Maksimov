import {
  karavanMarketplaceSetupSchema,
  type KaravanMarketplaceOperation,
  type KaravanMarketplaceSetup,
} from '@maxim/contracts/karavan-marketplace';
import {
  legacyShopSetupDraftKey,
  restoreShopSetupDraft,
  shopSetupDraftKey,
  type ShopSetupDraft,
  type ShopSetupIntent,
} from './setup-intent';
import {
  boundShopRecoveryRead,
  readShopStorageCopies,
  type ShopRecoveryReaders,
} from './storage-recovery';

type RecoveryReason = 'corrupt' | 'unavailable' | 'conflicting';

export type ShopSetupRecovery =
  | {
      status: 'ready';
      request: KaravanMarketplaceSetup | null;
      operation: KaravanMarketplaceOperation | null;
    }
  | {
      status: 'error';
      reason: RecoveryReason;
      operation: KaravanMarketplaceOperation | null;
      request?: KaravanMarketplaceSetup;
    };

export async function readShopSetupRecovery(
  key: string,
  chatId: string,
  serverOperation: KaravanMarketplaceOperation | null,
  readOperation: (operationId: string) => Promise<KaravanMarketplaceOperation>,
  storage?: ShopRecoveryReaders,
  timeoutMs = 8_000,
): Promise<ShopSetupRecovery> {
  const copies = await readShopStorageCopies(key, storage, timeoutMs);
  const error = (reason: RecoveryReason): Extract<ShopSetupRecovery, { status: 'error' }> => ({
    status: 'error',
    reason,
    operation: serverOperation,
  });
  if (copies.local.status === 'error' || copies.native.status === 'error')
    return error('unavailable');
  const requests: KaravanMarketplaceSetup[] = [];
  for (const copy of [copies.local, copies.native]) {
    if (copy.status !== 'found') continue;
    try {
      const request = karavanMarketplaceSetupSchema.parse(JSON.parse(copy.value));
      if (request.chatIds[0] !== chatId) return error('corrupt');
      requests.push(request);
    } catch {
      return error('corrupt');
    }
  }
  if (serverOperation) {
    if (
      serverOperation.request.chatIds[0] !== chatId ||
      serverOperation.request.operationId !== serverOperation.operationId
    )
      return error('corrupt');
    requests.push(serverOperation.request);
  }
  if (requests.some((request) => JSON.stringify(request) !== JSON.stringify(requests[0])))
    return error('conflicting');
  const request = requests[0] ?? null;
  if (!request) return { status: 'ready', request: null, operation: null };
  try {
    const operation =
      serverOperation ??
      (await boundShopRecoveryRead(() => readOperation(request.operationId), timeoutMs));
    if (
      operation.operationId !== request.operationId ||
      JSON.stringify(operation.request) !== JSON.stringify(request)
    )
      return error('conflicting');
    // FLAG: The original submitted request is immutable recovery evidence. Reading
    // activeSetup or a journal never overwrites either stored copy with another request.
    return { status: 'ready', request, operation };
  } catch {
    // FLAG: A validated original command may have been saved before its first POST
    // reached the server. Only this identity can be offered for an explicit retry.
    return { ...error('unavailable'), request };
  }
}

export type ShopDraftRecovery =
  | { status: 'ready'; draft: ShopSetupDraft | null }
  | { status: 'error'; reason: RecoveryReason };

export async function readShopDraftRecovery(
  actorId: string,
  chatId: string,
  intent: ShopSetupIntent,
  storage?: ShopRecoveryReaders,
  timeoutMs = 8_000,
): Promise<ShopDraftRecovery> {
  for (const legacy of [false, true]) {
    const key = legacy
      ? legacyShopSetupDraftKey(actorId, chatId, intent)
      : shopSetupDraftKey(actorId, chatId, intent);
    const copies = await readShopStorageCopies(key, storage, timeoutMs);
    if (copies.local.status === 'error' || copies.native.status === 'error')
      return { status: 'error', reason: 'unavailable' };
    const found = [copies.local, copies.native].filter((copy) => copy.status === 'found');
    if (!found.length) continue;
    const drafts = found.map((copy) => restoreShopSetupDraft(copy.value, chatId, intent));
    if (drafts.some((draft) => !draft))
      return legacy ? { status: 'ready', draft: null } : { status: 'error', reason: 'corrupt' };
    if (drafts.some((draft) => JSON.stringify(draft) !== JSON.stringify(drafts[0])))
      return legacy ? { status: 'ready', draft: null } : { status: 'error', reason: 'conflicting' };
    return { status: 'ready', draft: drafts[0]! };
  }
  return { status: 'ready', draft: null };
}

export function shopSetupRecoveryMessage(reason: RecoveryReason): string {
  return reason === 'unavailable'
    ? 'Не удалось проверить действия с подключением. Повторите проверку.'
    : 'Не удалось восстановить незавершённое действие с подключением. Если повторная проверка не поможет, обратитесь в поддержку.';
}
