import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hydrateMirroredItem,
  isNativeDeviceStorageAvailable,
  readLocalMirrorItem,
  readNativeStorageItemState,
  removeLocalMirrorItem,
  removeNativeStorageItem,
  writeLocalMirrorItem,
  writeNativeStorageItem,
} from '../src/lib/native-storage';
import { waitForNativeStorageRuntime } from '../src/lib/native-storage-runtime';

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

function installWindow(localStorage: Storage): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage },
  });
}

function restoreWindow(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
}

function installDocument(script: EventTarget, dataset: Record<string, string>): void {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      documentElement: { dataset },
      querySelector: () => script,
    } as unknown as Document,
  });
}

function restoreDocument(): void {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: originalDocument,
  });
}

test('local mirror reads and writes through localStorage', () => {
  const values = new Map<string, string>();
  installWindow({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } as Storage);

  writeLocalMirrorItem('maxim:test', '1');

  assert.equal(readLocalMirrorItem('maxim:test'), '1');
  restoreWindow();
});

test('local mirror tolerates missing or restricted localStorage', () => {
  restoreWindow();
  assert.equal(readLocalMirrorItem('maxim:test'), null);

  installWindow({
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  } as unknown as Storage);

  assert.equal(readLocalMirrorItem('maxim:test'), null);
  assert.doesNotThrow(() => writeLocalMirrorItem('maxim:test', '1'));
  restoreWindow();
});

for (const bridgeLocation of ['MAX', 'WebApp'] as const) {
  for (const nativeFailure of ['reject', 'stall'] as const) {
    test(`MAX web skips unsupported ${nativeFailure} storage at ${bridgeLocation} and preserves its local mirror`, async () => {
      const key = 'maxim:web-mirror';
      const values = new Map([[key, 'original-local-value']]);
      const calls: string[] = [];
      installWindow({
        getItem: (scope: string) => values.get(scope) ?? null,
        setItem: (scope: string, value: string) => values.set(scope, value),
      } as Storage);
      installDocument(new EventTarget(), { maxClient: 'native' });
      const unsupported = (method: string): Promise<never> => {
        calls.push(method);
        return nativeFailure === 'reject'
          ? Promise.reject({ error: { code: 'unsupported' } })
          : new Promise(() => {});
      };
      const storage = {
        getItem: () => unsupported('getItem'),
        setItem: () => unsupported('setItem'),
        removeItem: () => unsupported('removeItem'),
      } satisfies NonNullable<NonNullable<Window['WebApp']>['DeviceStorage']>;
      const bridge = {
        platform: 'web',
        initData: 'auth_date=1&hash=test',
        DeviceStorage: storage,
        SecureStorage: storage,
      } satisfies NonNullable<Window['WebApp']>;
      if (bridgeLocation === 'MAX') window.MAX = { WebApp: bridge };
      else window.WebApp = bridge;

      try {
        assert.equal(isNativeDeviceStorageAvailable(), false);
        for (const area of ['device', 'secure'] as const) {
          assert.deepEqual(await readNativeStorageItemState(key, area), {
            status: 'unavailable',
          });
          assert.deepEqual(await readNativeStorageItemState('missing', area), {
            status: 'unavailable',
          });
          await writeNativeStorageItem(key, 'new-native-value', area);
          await removeNativeStorageItem(key, area);
        }
        assert.equal(await hydrateMirroredItem(key), 'original-local-value');
        assert.equal(await hydrateMirroredItem('missing'), null);
        assert.deepEqual([...values], [[key, 'original-local-value']]);
        assert.deepEqual(calls, []);
      } finally {
        restoreDocument();
        restoreWindow();
      }
    });
  }
}

for (const platform of ['ios', 'android', 'desktop'] as const) {
  test(`${platform} storage retains found, missing and ambiguous rejection results`, async () => {
    installWindow({ getItem: () => null } as unknown as Storage);
    installDocument(new EventTarget(), { maxClient: 'native' });
    const storage = (area: 'device' | 'secure') =>
      ({
        getItem: async (key: string) => {
          if (key === 'not-found-error')
            throw { error: { code: `client.${area}_storage_get_key.not_found` } };
          if (key === 'read-error') throw new Error('Native storage failed');
          return { key, value: key === 'existing' ? 'original-native-value' : null };
        },
      }) satisfies NonNullable<NonNullable<Window['WebApp']>['DeviceStorage']>;
    window.WebApp = {
      platform,
      initData: 'auth_date=1&hash=test',
      DeviceStorage: storage('device'),
      SecureStorage: storage('secure'),
    };

    try {
      assert.equal(isNativeDeviceStorageAvailable(), true);
      for (const area of ['device', 'secure'] as const) {
        assert.deepEqual(await readNativeStorageItemState('existing', area), {
          status: 'found',
          value: 'original-native-value',
        });
        assert.deepEqual(await readNativeStorageItemState('missing', area), {
          status: 'missing',
        });
        for (const key of ['not-found-error', 'read-error'])
          assert.deepEqual(await readNativeStorageItemState(key, area), { status: 'error' });
      }
    } finally {
      restoreDocument();
      restoreWindow();
    }
  });
}

test('late MAX Bridge discovery can recover a native-only mirrored value', async () => {
  const values = new Map<string, string>();
  const dataset: Record<string, string> = { maxClient: 'browser' };
  const bridgeScript = new EventTarget();
  installWindow({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } as Storage);
  installDocument(bridgeScript, dataset);

  try {
    const availability = waitForNativeStorageRuntime({ timeoutMs: 250, pollIntervalMs: 5 });
    setTimeout(() => {
      dataset.maxClient = 'native';
      window.MAX = {
        WebApp: {
          initData: 'auth_date=1&hash=test',
          DeviceStorage: {
            getItem: async (key: string) => ({
              key,
              value: key === 'maxim:late-labels' ? '{"important":"VIP"}' : null,
            }),
          },
        },
      };
      bridgeScript.dispatchEvent(new Event('load'));
    }, 10);

    assert.equal(await availability, true);
    assert.equal(await hydrateMirroredItem('maxim:late-labels'), '{"important":"VIP"}');
    assert.equal(values.get('maxim:late-labels'), '{"important":"VIP"}');
  } finally {
    restoreDocument();
    restoreWindow();
  }
});

test('late native reads cannot overwrite a newer local write even when its value stayed the same', async () => {
  const values = new Map<string, string>([['maxim:late-favorites', 'server-value']]);
  installWindow({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } as Storage);
  installDocument(new EventTarget(), { maxClient: 'native' });
  let release!: (value: { value: string }) => void;
  window.MAX = {
    WebApp: {
      initData: 'auth_date=1&hash=test',
      DeviceStorage: {
        getItem: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
    },
  };
  try {
    const hydrating = hydrateMirroredItem('maxim:late-favorites');
    writeLocalMirrorItem('maxim:late-favorites', 'server-value');
    release({ value: 'stale-native-value' });
    assert.equal(await hydrating, 'server-value');
    assert.equal(values.get('maxim:late-favorites'), 'server-value');
  } finally {
    restoreDocument();
    restoreWindow();
  }
});

for (const completionOrder of [
  [0, 1],
  [1, 0],
]) {
  test(
    'concurrent native-only hydrations survive blocked mirrors in order ' +
      completionOrder.join(','),
    async () => {
      installWindow({
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
        removeItem: () => {
          throw new Error('blocked');
        },
      } as unknown as Storage);
      installDocument(new EventTarget(), { maxClient: 'native' });
      const releases: Array<(value: { value: string }) => void> = [];
      window.MAX = {
        WebApp: {
          initData: 'auth_date=1&hash=test',
          DeviceStorage: {
            getItem: () =>
              new Promise((resolve) => {
                releases.push(resolve);
              }),
          },
        },
      };
      try {
        const key = 'maxim:concurrent-native-only-' + completionOrder.join('-');
        const reads = [hydrateMirroredItem(key), hydrateMirroredItem(key)];
        for (const index of completionOrder) {
          releases[index]({ value: '1' });
          assert.equal(await reads[index], '1');
        }
      } finally {
        restoreDocument();
        restoreWindow();
      }
    },
  );
}

for (const mutation of ['write', 'remove'] as const) {
  test(
    'explicit ' + mutation + ' fences both pending native reads when mirror is blocked',
    async () => {
      installWindow({
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
        removeItem: () => {
          throw new Error('blocked');
        },
      } as unknown as Storage);
      installDocument(new EventTarget(), { maxClient: 'native' });
      const releases: Array<(value: { value: string }) => void> = [];
      window.MAX = {
        WebApp: {
          initData: 'auth_date=1&hash=test',
          DeviceStorage: {
            getItem: () =>
              new Promise((resolve) => {
                releases.push(resolve);
              }),
          },
        },
      };
      try {
        const key = 'maxim:concurrent-explicit-' + mutation;
        const reads = [hydrateMirroredItem(key), hydrateMirroredItem(key)];
        if (mutation === 'write') writeLocalMirrorItem(key, 'new-value');
        else removeLocalMirrorItem(key);
        for (let index = 0; index < reads.length; index += 1) {
          releases[index]({ value: 'stale-native-value' });
          assert.equal(await reads[index], null);
        }
      } finally {
        restoreDocument();
        restoreWindow();
      }
    },
  );
}

test('explicit removal after one hydration fences the other native read', async () => {
  const values = new Map<string, string>();
  installWindow({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  } as Storage);
  installDocument(new EventTarget(), { maxClient: 'native' });
  const releases: Array<(value: { value: string }) => void> = [];
  window.MAX = {
    WebApp: {
      initData: 'auth_date=1&hash=test',
      DeviceStorage: {
        getItem: () =>
          new Promise((resolve) => {
            releases.push(resolve);
          }),
      },
    },
  };
  try {
    const key = 'maxim:remove-between-hydrations';
    const first = hydrateMirroredItem(key);
    const second = hydrateMirroredItem(key);
    releases[0]({ value: '1' });
    assert.equal(await first, '1');
    removeLocalMirrorItem(key);
    releases[1]({ value: '1' });
    assert.equal(await second, null);
    assert.equal(readLocalMirrorItem(key), null);
  } finally {
    restoreDocument();
    restoreWindow();
  }
});
