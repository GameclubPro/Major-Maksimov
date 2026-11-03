import {
  readLocalMirrorItemState,
  readNativeStorageItemState,
  type StorageItemReadResult,
} from '../../../lib/native-storage';

export type ShopRecoveryReaders = {
  local: (key: string) => StorageItemReadResult;
  native: (key: string) => Promise<StorageItemReadResult>;
};

export type ShopStorageCopies = {
  local: StorageItemReadResult;
  native: StorageItemReadResult;
};

const readers: ShopRecoveryReaders = {
  local: readLocalMirrorItemState,
  native: readNativeStorageItemState,
};

export const localShopRecoveryReaders: ShopRecoveryReaders = {
  local: readLocalMirrorItemState,
  native: async () => ({ status: 'unavailable' }),
};

export async function boundShopRecoveryRead<T>(
  read: () => Promise<T>,
  timeoutMs = 8_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Shop recovery read timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function readShopStorageCopies(
  key: string,
  storage: ShopRecoveryReaders = readers,
  timeoutMs = 8_000,
): Promise<ShopStorageCopies> {
  let local: StorageItemReadResult;
  try {
    local = storage.local(key);
  } catch {
    local = { status: 'error' };
  }
  let native: StorageItemReadResult;
  try {
    native = await boundShopRecoveryRead(() => storage.native(key), timeoutMs);
  } catch {
    native = { status: 'error' };
  }
  // FLAG: These readers never hydrate or write a mirror. A native read may finish
  // after its deadline, but cannot replace evidence or an editable draft.
  return { local, native };
}
