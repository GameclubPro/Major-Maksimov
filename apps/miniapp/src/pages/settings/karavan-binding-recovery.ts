import {
  karavanChatBindingInputSchema,
  type KaravanChatBindingInput,
} from '../../lib/api/karavan-marketplace-client';
import { readShopStorageCopies, type ShopRecoveryReaders } from './karavan-shop/storage-recovery';

export type KaravanBindingRecoveryState =
  | { status: 'loading' }
  | { status: 'ready'; request: KaravanChatBindingInput | null }
  | { status: 'error'; reason: 'corrupt' | 'unavailable' | 'conflicting' };

export async function readKaravanBindingRecovery(
  key: string,
  storage?: ShopRecoveryReaders,
  timeoutMs = 8_000,
): Promise<Exclude<KaravanBindingRecoveryState, { status: 'loading' }>> {
  const { local, native } = await readShopStorageCopies(key, storage, timeoutMs);
  if (local.status === 'error' || native.status === 'error')
    return { status: 'error', reason: 'unavailable' };

  const requests: KaravanChatBindingInput[] = [];
  for (const result of [local, native]) {
    if (result.status !== 'found') continue;
    try {
      requests.push(karavanChatBindingInputSchema.parse(JSON.parse(result.value)));
    } catch {
      return { status: 'error', reason: 'corrupt' };
    }
  }
  if (requests.length > 1 && JSON.stringify(requests[0]) !== JSON.stringify(requests[1]))
    return { status: 'error', reason: 'conflicting' };

  // FLAG: Reading recovery evidence must never overwrite either copy. A malformed or
  // conflicting command has no safe replay or generation fence until it is identified.
  return { status: 'ready', request: requests[0] ?? null };
}

export function karavanBindingRecoveryMessage(
  reason: Extract<KaravanBindingRecoveryState, { status: 'error' }>['reason'],
): string {
  return reason === 'unavailable'
    ? 'Не удалось проверить действия с подключением. Повторите проверку.'
    : 'Не удалось восстановить незавершённое действие с подключением чата. Если повторная проверка не поможет, обратитесь в поддержку.';
}
