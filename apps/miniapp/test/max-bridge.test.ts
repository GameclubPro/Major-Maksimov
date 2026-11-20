import assert from 'node:assert/strict';
import test from 'node:test';
import { openKaravanStorefront } from '../src/lib/karavan-storefront-navigation';
import {
  isLegacyAndroidSettingsDrilldownUserAgent,
  openLink,
  openMaxBotLink,
  openMaxBotLinkAndClose,
  openPrivateBotHandoff,
  readyMaxMiniApp,
  syncMaxNativeEnvironment,
} from '../src/lib/max-bridge';

type MockBridge = {
  initData?: string | null;
  init_data?: string | null;
  initDataUnsafe?: Record<string, unknown>;
  init_data_unsafe?: Record<string, unknown>;
  colorScheme?: string;
  platform?: string;
  ready?: () => void;
  close?: () => void;
  openLink?: (url: string) => void;
  openMaxLink?: (url: string) => void;
};

type MockWindow = {
  __MAXIM_FORCE_NATIVE_VISUAL_MODE__?: boolean;
  __MAXIM_VISUAL_BRIDGE__?: MockBridge;
  addEventListener?: (type: string, listener: () => void, options?: unknown) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  innerHeight?: number;
  innerWidth?: number;
  visualViewport?: {
    width: number;
    height: number;
    offsetTop: number;
    offsetLeft: number;
    addEventListener: (type: string, listener: () => void) => void;
    removeEventListener: (type: string, listener: () => void) => void;
  };
  location: {
    href: string;
    assign: (url: string) => void;
  };
  open?: (url: string, target?: string, features?: string) => unknown;
  setTimeout: typeof setTimeout;
  MAX?: {
    WebApp?: MockBridge;
  };
  WebApp?: MockBridge;
};

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

function createMockStyle() {
  const values = new Map<string, string>();

  return {
    values,
    setProperty: (name: string, value: string) => {
      values.set(name, value);
    },
  };
}

function setMockWindow(bridge: MockBridge | null, assignedUrls: string[]): void {
  const location = {
    href: 'https://major-maksimov.ru/app/',
    assign: (url: string) => {
      assignedUrls.push(url);
    },
  };
  const nextWindow: MockWindow = bridge
    ? {
        location,
        setTimeout,
        MAX: {
          WebApp: bridge,
        },
      }
    : {
        location,
        setTimeout,
      };

  Object.assign(globalThis, {
    window: nextWindow,
  });
}

test.afterEach(() => {
  Object.assign(globalThis, {
    window: originalWindow,
    document: originalDocument,
  });
});

test('readyMaxMiniApp ignores browser bridge stubs without init data', () => {
  const assignedUrls: string[] = [];
  let readyCount = 0;
  setMockWindow(
    {
      initDataUnsafe: {},
      ready: () => {
        readyCount += 1;
      },
    },
    assignedUrls,
  );

  assert.equal(readyMaxMiniApp(), false);

  assert.equal(readyCount, 0);
});

test('readyMaxMiniApp keeps native ready when bridge init data exists', () => {
  const assignedUrls: string[] = [];
  let readyCount = 0;
  setMockWindow(
    {
      initData: 'query_id=abc&hash=def',
      initDataUnsafe: {},
      ready: () => {
        readyCount += 1;
      },
    },
    assignedUrls,
  );

  assert.equal(readyMaxMiniApp(), true);

  assert.equal(readyCount, 1);
});

test('readyMaxMiniApp skips forced visual mode without the visual bridge shim', () => {
  const assignedUrls: string[] = [];
  let readyCount = 0;
  setMockWindow(
    {
      initData: 'query_id=abc&hash=def',
      ready: () => {
        readyCount += 1;
      },
    },
    assignedUrls,
  );
  globalThis.window.__MAXIM_FORCE_NATIVE_VISUAL_MODE__ = true;

  assert.equal(readyMaxMiniApp(), false);

  assert.equal(readyCount, 0);
});

test('readyMaxMiniApp allows forced visual mode when the visual bridge shim is installed', () => {
  const assignedUrls: string[] = [];
  let readyCount = 0;
  const bridge = {
    initData: 'query_id=abc&hash=def',
    ready: () => {
      readyCount += 1;
    },
  };
  setMockWindow(bridge, assignedUrls);
  globalThis.window.__MAXIM_FORCE_NATIVE_VISUAL_MODE__ = true;
  globalThis.window.__MAXIM_VISUAL_BRIDGE__ = bridge;

  assert.equal(readyMaxMiniApp(), true);

  assert.equal(readyCount, 1);
});

test('syncMaxNativeEnvironment avoids double bottom safe area when native viewport is already inset', () => {
  const assignedUrls: string[] = [];
  setMockWindow(
    {
      platform: 'ios',
      initData: 'query_id=abc&hash=def',
    },
    assignedUrls,
  );

  const style = createMockStyle();
  Object.assign(globalThis, {
    document: {
      documentElement: {
        dataset: {},
        style,
      },
    },
  });
  globalThis.window.innerWidth = 390;
  globalThis.window.innerHeight = 844;
  globalThis.window.addEventListener = () => undefined;
  globalThis.window.removeEventListener = () => undefined;
  globalThis.window.visualViewport = {
    width: 390,
    height: 810,
    offsetTop: 0,
    offsetLeft: 0,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };

  const cleanup = syncMaxNativeEnvironment();
  cleanup();

  assert.equal(style.values.get('--app-viewport-height'), '810px');
  assert.equal(style.values.get('--app-visual-viewport-bottom'), '34px');
  assert.equal(style.values.get('--app-keyboard-overlap'), '34px');
  assert.equal(
    (globalThis.document.documentElement.dataset as Record<string, string>).maxClient,
    'native',
  );
});

test('syncMaxNativeEnvironment can promote a late bridge from browser to native', () => {
  const assignedUrls: string[] = [];
  setMockWindow(null, assignedUrls);

  const style = createMockStyle();
  Object.assign(globalThis, {
    document: {
      documentElement: {
        dataset: {},
        style,
      },
    },
  });
  globalThis.window.innerWidth = 390;
  globalThis.window.innerHeight = 844;
  globalThis.window.addEventListener = () => undefined;
  globalThis.window.removeEventListener = () => undefined;

  const cleanupBrowser = syncMaxNativeEnvironment();
  cleanupBrowser();
  assert.equal(
    (globalThis.document.documentElement.dataset as Record<string, string>).maxClient,
    'browser',
  );

  globalThis.window.MAX = {
    WebApp: {
      platform: 'android',
      initData: 'query_id=abc&hash=def',
    },
  };

  const cleanupNative = syncMaxNativeEnvironment();
  cleanupNative();

  assert.equal(
    (globalThis.document.documentElement.dataset as Record<string, string>).maxClient,
    'native',
  );
  assert.equal(
    (globalThis.document.documentElement.dataset as Record<string, string>).maxPlatform,
    'android',
  );
});

test('native bottom inset measures the fixed viewport, updates on resize and cleans up', () => {
  setMockWindow({ platform: 'ios', initData: 'query_id=abc&hash=def' }, []);
  const style = createMockStyle();
  let fixedBottom = 810;
  let removed = false;
  let resize: (() => void) | undefined;
  const probe = {
    style: { cssText: '' },
    setAttribute: () => undefined,
    getBoundingClientRect: () => ({ bottom: fixedBottom }),
    remove: () => {
      removed = true;
    },
  };
  Object.assign(globalThis, {
    document: {
      documentElement: { dataset: {}, style },
      body: { appendChild: (element: unknown) => assert.equal(element, probe) },
      createElement: () => probe,
    },
  });
  globalThis.window.innerWidth = 390;
  globalThis.window.innerHeight = 844;
  globalThis.window.addEventListener = (_type, listener) => {
    resize = listener as () => void;
  };
  globalThis.window.removeEventListener = () => undefined;
  const cleanup = syncMaxNativeEnvironment();

  assert.equal(style.values.get('--app-visual-viewport-bottom'), '0px');
  assert.equal(style.values.get('--app-layout-viewport-bottom'), '34px');
  fixedBottom = 844;
  resize?.();
  assert.equal(style.values.get('--app-layout-viewport-bottom'), '0px');
  cleanup();
  assert.equal(removed, true);
});

test('syncMaxNativeEnvironment keeps browser chrome aligned with the MAX theme', () => {
  const assignedUrls: string[] = [];
  setMockWindow(
    {
      platform: 'android',
      initData: 'query_id=abc&hash=def',
      colorScheme: 'dark',
    },
    assignedUrls,
  );

  const style = createMockStyle();
  let themeColor = '#f3f6f8';
  Object.assign(globalThis, {
    document: {
      documentElement: {
        dataset: {},
        style,
      },
      querySelector: () => ({
        setAttribute: (name: string, value: string) => {
          if (name === 'content') {
            themeColor = value;
          }
        },
      }),
    },
  });
  globalThis.window.innerWidth = 390;
  globalThis.window.innerHeight = 844;
  globalThis.window.addEventListener = () => undefined;
  globalThis.window.removeEventListener = () => undefined;

  const cleanup = syncMaxNativeEnvironment();
  cleanup();

  assert.equal(
    (globalThis.document.documentElement.dataset as Record<string, string>).maxTheme,
    'dark',
  );
  assert.equal(themeColor, '#0d141b');
});

test('syncMaxNativeEnvironment lets the MAX light theme override a dark OS theme', () => {
  const assignedUrls: string[] = [];
  setMockWindow(
    {
      platform: 'android',
      initData: 'query_id=abc&hash=def',
      colorScheme: 'light',
    },
    assignedUrls,
  );

  globalThis.window.matchMedia = () =>
    ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList;

  const style = createMockStyle();
  let themeColor = '#0d141b';
  Object.assign(globalThis, {
    document: {
      documentElement: {
        dataset: {},
        style,
      },
      querySelector: () => ({
        setAttribute: (name: string, value: string) => {
          if (name === 'content') {
            themeColor = value;
          }
        },
      }),
    },
  });
  globalThis.window.innerWidth = 390;
  globalThis.window.innerHeight = 844;
  globalThis.window.addEventListener = () => undefined;
  globalThis.window.removeEventListener = () => undefined;

  const cleanup = syncMaxNativeEnvironment();
  cleanup();

  assert.equal(
    (globalThis.document.documentElement.dataset as Record<string, string>).maxTheme,
    'light',
  );
  assert.equal(themeColor, '#f3f6f8');
});

test('openMaxBotLink falls back to location assign when bridge is unavailable', () => {
  const assignedUrls: string[] = [];
  setMockWindow(null, assignedUrls);

  openMaxBotLink('https://max.ru/chats/chat-1/message/42');
  assert.deepEqual(assignedUrls, ['https://max.ru/chats/chat-1/message/42']);
});

test('openMaxBotLink opens MAX deep links inside bridge', () => {
  const assignedUrls: string[] = [];
  const opened: Array<{ kind: 'max' | 'external'; url: string }> = [];
  setMockWindow(
    {
      openMaxLink: (url) => opened.push({ kind: 'max', url }),
      openLink: (url) => opened.push({ kind: 'external', url }),
    },
    assignedUrls,
  );

  openMaxBotLink('https://max.ru/chats/chat-1/message/42');
  assert.deepEqual(opened, [{ kind: 'max', url: 'https://max.ru/chats/chat-1/message/42' }]);
  assert.deepEqual(assignedUrls, []);
});

test('openMaxBotLink opens www.max.ru deep links inside bridge', () => {
  const assignedUrls: string[] = [];
  const opened: Array<{ kind: 'max' | 'external'; url: string }> = [];
  setMockWindow(
    {
      openMaxLink: (url) => opened.push({ kind: 'max', url }),
      openLink: (url) => opened.push({ kind: 'external', url }),
    },
    assignedUrls,
  );

  openMaxBotLink('https://www.max.ru/chats/chat-1/message/42');
  assert.deepEqual(opened, [{ kind: 'max', url: 'https://www.max.ru/chats/chat-1/message/42' }]);
  assert.deepEqual(assignedUrls, []);
});

test('openMaxBotLink does not send non-HTTPS MAX links to openMaxLink', () => {
  const assignedUrls: string[] = [];
  const opened: Array<{ kind: 'max' | 'external'; url: string }> = [];
  setMockWindow(
    {
      openMaxLink: (url) => opened.push({ kind: 'max', url }),
      openLink: (url) => opened.push({ kind: 'external', url }),
    },
    assignedUrls,
  );

  assert.equal(openMaxBotLink('http://max.ru/chats/chat-1/message/42'), 'bridge-external');
  assert.deepEqual(opened, [{ kind: 'external', url: 'http://max.ru/chats/chat-1/message/42' }]);
  assert.deepEqual(assignedUrls, []);
});

test('openMaxBotLink ignores max user mentions instead of passing them to generic openLink', () => {
  const assignedUrls: string[] = [];
  const opened: Array<{ kind: 'max' | 'external'; url: string }> = [];
  setMockWindow(
    {
      openMaxLink: (url) => opened.push({ kind: 'max', url }),
      openLink: (url) => opened.push({ kind: 'external', url }),
    },
    assignedUrls,
  );

  assert.equal(openMaxBotLink('max://user/12345'), 'noop');
  assert.deepEqual(opened, []);
  assert.deepEqual(assignedUrls, []);
});

test('openMaxBotLink opens bot start handoff links through MAX bridge', () => {
  const assignedUrls: string[] = [];
  const opened: Array<{ kind: 'max' | 'external'; url: string }> = [];
  setMockWindow(
    {
      openMaxLink: (url) => opened.push({ kind: 'max', url }),
      openLink: (url) => opened.push({ kind: 'external', url }),
    },
    assignedUrls,
  );

  openMaxBotLink('https://max.ru/777000_bot?start=broadcast_handoff');

  assert.deepEqual(opened, [
    { kind: 'max', url: 'https://max.ru/777000_bot?start=broadcast_handoff' },
  ]);
  assert.deepEqual(assignedUrls, []);
});

test('openMaxBotLinkAndClose closes miniapp after bot start handoff bridge open', async () => {
  const assignedUrls: string[] = [];
  const opened: string[] = [];
  let closeCount = 0;
  setMockWindow(
    {
      close: () => {
        closeCount += 1;
      },
      openMaxLink: (url) => opened.push(url),
    },
    assignedUrls,
  );

  assert.equal(openMaxBotLinkAndClose('https://max.ru/777000_bot?start=broadcast_handoff'), true);

  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(opened, ['https://max.ru/777000_bot?start=broadcast_handoff']);
  assert.deepEqual(assignedUrls, []);
  assert.equal(closeCount, 1);
});

test('private bot handoff validates the destination and keeps the current screen for retry', async () => {
  const opened: string[] = [];
  const assigned: string[] = [];
  let closeCount = 0;
  setMockWindow({ openMaxLink: (url) => opened.push(url), close: () => closeCount++ }, assigned);
  const url = 'https://max.ru/major_bot?start=ka2-example';

  assert.equal(openPrivateBotHandoff('https://max.ru@invalid.example/major_bot'), false);
  assert.equal(openPrivateBotHandoff('https://user@max.ru/major_bot'), false);
  assert.equal(openPrivateBotHandoff('https://max.ru'), false);
  assert.equal(openPrivateBotHandoff('max://user/123'), false);
  assert.equal(openPrivateBotHandoff(url), true);
  assert.equal(openPrivateBotHandoff(url), true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(opened, [url, url]);
  assert.deepEqual(assigned, []);
  assert.equal(closeCount, 0);

  setMockWindow(
    {
      openMaxLink: () => {
        throw new Error('Bridge unavailable');
      },
    },
    assigned,
  );
  assert.equal(openPrivateBotHandoff(url), false);
  setMockWindow(null, assigned);
  assert.equal(openPrivateBotHandoff(url), true);
  assert.deepEqual(assigned, [url]);
});

test('storefront launch never closes Major when MAX does not acknowledge navigation', async () => {
  let closeCount = 0;
  const opened: string[] = [];
  setMockWindow({ openMaxLink: (url) => opened.push(url), close: () => closeCount++ }, []);
  const url = 'https://max.ru/synthetic_buyer_bot?startapp=mh_example';
  assert.equal(openKaravanStorefront(url), true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(opened, [url]);
  assert.equal(closeCount, 0);
});

test('storefront launch keeps the caller available after bridge failure or an invalid target', () => {
  let closeCount = 0;
  setMockWindow(
    {
      openMaxLink: () => {
        throw new Error('Bridge unavailable');
      },
      close: () => closeCount++,
    },
    [],
  );
  assert.equal(
    openKaravanStorefront('https://max.ru/synthetic_buyer_bot?startapp=mh_example'),
    false,
  );
  assert.equal(openKaravanStorefront('https://example.com/store'), false);
  assert.equal(openKaravanStorefront('max://user/123'), false);
  assert.equal(closeCount, 0);
});

test('openLink opens external links through bridge browser API', () => {
  const assignedUrls: string[] = [];
  const opened: Array<{ kind: 'max' | 'external'; url: string }> = [];
  setMockWindow(
    {
      openMaxLink: (url) => opened.push({ kind: 'max', url }),
      openLink: (url) => opened.push({ kind: 'external', url }),
    },
    assignedUrls,
  );

  openLink('https://example.com/path');
  assert.deepEqual(opened, [{ kind: 'external', url: 'https://example.com/path' }]);
  assert.deepEqual(assignedUrls, []);
});

test('generic navigation rejects URLs outside the web scheme allowlist', () => {
  const assigned: string[] = [];
  const opened: string[] = [];
  setMockWindow(
    { openLink: (url) => opened.push(url), openMaxLink: (url) => opened.push(url) },
    assigned,
  );
  for (const url of [
    'data:image/webp;base64,YQ==',
    'blob:https://major-maksimov.ru/preview',
    'file:///preview.txt',
    'about:blank',
    'https://user@example.com/path',
    'https://[',
  ]) {
    assert.equal(openLink(url), 'noop');
    assert.equal(openMaxBotLinkAndClose(url), false);
  }
  assert.deepEqual(opened, []);
  assert.deepEqual(assigned, []);
});

test('browser fallback uses the parsed HTTP address, including relative paths', () => {
  const assigned: string[] = [];
  setMockWindow(null, assigned);

  assert.equal(openLink('https://EXAMPLE.COM/a b'), 'location');
  assert.equal(openLink('/app/participants'), 'location');
  assert.deepEqual(assigned, [
    'https://example.com/a%20b',
    'https://major-maksimov.ru/app/participants',
  ]);
});

test('isLegacyAndroidSettingsDrilldownUserAgent gates old Android and WebView versions', () => {
  assert.equal(
    isLegacyAndroidSettingsDrilldownUserAgent(
      'Mozilla/5.0 (Linux; Android 8.1.0; Pixel Build/OPM1) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/83.0.4103.106 Mobile Safari/537.36 wv',
    ),
    true,
  );
  assert.equal(
    isLegacyAndroidSettingsDrilldownUserAgent(
      'Mozilla/5.0 (Linux; Android 10; Pixel Build/QP1A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/99.0.4844.88 Mobile Safari/537.36 wv',
    ),
    true,
  );
  assert.equal(
    isLegacyAndroidSettingsDrilldownUserAgent(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    ),
    false,
  );
  assert.equal(
    isLegacyAndroidSettingsDrilldownUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    ),
    false,
  );
});
