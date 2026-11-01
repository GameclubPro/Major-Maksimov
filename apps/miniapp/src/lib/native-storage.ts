type NativeStorageArea = 'device' | 'secure';
const localWriteVersions = new Map<string, number>();

export type StorageItemReadResult =
  | { status: 'found'; value: string }
  | { status: 'missing' | 'unavailable' | 'error' };

type NativeStorageResult = {
  key?: string;
  value?: string | null;
  status?: string;
};

type NativeStorageBridge = {
  getItem?: (key: string) => Promise<NativeStorageResult> | NativeStorageResult;
  setItem?: (key: string, value: string) => Promise<NativeStorageResult> | NativeStorageResult;
  removeItem?: (key: string) => Promise<NativeStorageResult> | NativeStorageResult;
};

function resolveBridge() {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return window.MAX?.WebApp ?? window.WebApp;
}

function hasNativeStorageRuntime(): boolean {
  if (window.__MAXIM_FORCE_NATIVE_VISUAL_MODE__ === true && !window.__MAXIM_VISUAL_BRIDGE__) {
    return false;
  }

  const bridge = resolveBridge();
  // FLAG: MAX web exposes these SDK methods without native storage support.
  if (!bridge || bridge.platform === 'web') {
    return false;
  }

  if (typeof document !== 'undefined') {
    const client = document.documentElement.dataset.maxClient;
    if (client === 'preview' || client === 'browser') {
      return false;
    }
  }

  return Boolean(
    bridge.initData || bridge.init_data || bridge.initDataUnsafe || bridge.init_data_unsafe,
  );
}

function resolveNativeStorage(area: NativeStorageArea): NativeStorageBridge | undefined {
  if (!hasNativeStorageRuntime()) {
    return undefined;
  }

  const bridge = resolveBridge();
  return area === 'secure' ? bridge?.SecureStorage : bridge?.DeviceStorage;
}

export function isNativeDeviceStorageAvailable(): boolean {
  return (
    typeof window !== 'undefined' && typeof resolveNativeStorage('device')?.getItem === 'function'
  );
}

export function readLocalMirrorItem(key: string): string | null {
  const result = readLocalMirrorItemState(key);
  return result.status === 'found' ? result.value : null;
}

export function readLocalMirrorItemState(key: string): StorageItemReadResult {
  if (typeof window === 'undefined') {
    return { status: 'unavailable' };
  }

  try {
    const storage = window.localStorage;
    if (!storage || typeof storage.getItem !== 'function') {
      return { status: 'unavailable' };
    }
    const value = storage.getItem(key);
    return value === null ? { status: 'missing' } : { status: 'found', value };
  } catch {
    return { status: 'error' };
  }
}

function persistLocalMirrorItem(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures in restrictive WebView environments.
  }
}

export function writeLocalMirrorItem(key: string, value: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  localWriteVersions.set(key, (localWriteVersions.get(key) ?? 0) + 1);
  persistLocalMirrorItem(key, value);
}

export function removeLocalMirrorItem(key: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  localWriteVersions.set(key, (localWriteVersions.get(key) ?? 0) + 1);

  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures in restrictive WebView environments.
  }
}

export async function readNativeStorageItem(
  key: string,
  area: NativeStorageArea = 'device',
): Promise<string | null> {
  const result = await readNativeStorageItemState(key, area);
  return result.status === 'found' ? result.value : null;
}

export async function readNativeStorageItemState(
  key: string,
  area: NativeStorageArea = 'device',
): Promise<StorageItemReadResult> {
  if (typeof window === 'undefined') {
    return { status: 'unavailable' };
  }

  try {
    const storage = resolveNativeStorage(area);
    if (typeof storage?.getItem !== 'function') {
      return { status: 'unavailable' };
    }
    const result = await storage.getItem(key);
    return typeof result?.value === 'string'
      ? { status: 'found', value: result.value }
      : { status: 'missing' };
  } catch {
    return { status: 'error' };
  }
}

export async function writeNativeStorageItem(
  key: string,
  value: string,
  area: NativeStorageArea = 'device',
): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    await resolveNativeStorage(area)?.setItem?.(key, value);
  } catch {
    // Native storage is an enhancement; local mirror remains the fallback.
  }
}

export async function removeNativeStorageItem(
  key: string,
  area: NativeStorageArea = 'device',
): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    await resolveNativeStorage(area)?.removeItem?.(key);
  } catch {
    // Native storage is an enhancement; local mirror remains the fallback.
  }
}

export function saveMirroredItem(key: string, value: string): void {
  writeLocalMirrorItem(key, value);
  void writeNativeStorageItem(key, value);
}

export function removeMirroredItem(key: string): void {
  removeLocalMirrorItem(key);
  void removeNativeStorageItem(key);
}

export async function hydrateMirroredItem(key: string): Promise<string | null> {
  const version = localWriteVersions.get(key) ?? 0;
  const nativeValue = await readNativeStorageItem(key);
  if ((localWriteVersions.get(key) ?? 0) !== version) return readLocalMirrorItem(key);
  if (nativeValue === null) {
    return readLocalMirrorItem(key);
  }

  persistLocalMirrorItem(key, nativeValue);
  return nativeValue;
}
