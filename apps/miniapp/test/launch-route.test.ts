import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateHashRouterLegacyPathFromWindow } from '../src/lib/hash-router-legacy-path';
import { createLaunchRouteResolver, resolveLaunchRoute } from '../src/lib/launch-route';

type MutableWindow = Window &
  typeof globalThis & {
    WebApp?: {
      initDataUnsafe?: {
        start_param?: string;
      };
      startParam?: string;
    };
    MAX?: {
      WebApp?: {
        initDataUnsafe?: {
          start_param?: string;
        };
        startParam?: string;
      };
    };
    atob: typeof globalThis.atob;
  };

function assignWindow(url: string, overrides: Partial<MutableWindow> = {}): void {
  const location = new URL(url) as URL & { href: string };
  const windowLike = {
    location,
    history: {
      state: null,
      replaceState: (_state: unknown, _unused: string, nextUrl: string) => {
        location.href = new URL(nextUrl, location.href).href;
      },
    },
    atob: globalThis.atob,
    ...overrides,
  } as MutableWindow;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: windowLike,
  });
}

function encodeRouteStartParam(route: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      k: 'route',
      r: route,
    }),
    'utf8',
  ).toString('base64url');
  return `mr-${payload}`;
}

function encodeDialogStartParam(options: {
  kind: 'chat-dialog' | 'channel-dialog';
  chatId: string;
  mode?: 'comments' | 'suggest';
  token?: string;
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      k: options.kind,
      c: options.chatId,
      m: options.mode ?? 'comments',
      t: options.token ?? 'public-dialog-token-123456',
    }),
    'utf8',
  ).toString('base64url');
  return `cd-${payload}`;
}

test.afterEach(() => {
  delete (globalThis as { window?: Window }).window;
});

test('resolves chat activity route from startapp payload', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/chat/-68085832859751/events'),
    )}`,
  );

  assert.equal(resolveLaunchRoute(''), '/chat/-68085832859751/events');
});

test('returns to the exact chat storefront module without accepting external or channel targets', () => {
  const route = '/chat/-9007199254740993/settings?focus=storefront';
  assignWindow(`https://major-maksimov.ru/app/?startapp=${encodeRouteStartParam(route)}`);
  assert.equal(resolveLaunchRoute(''), route);
  for (const invalid of [
    'https://elsewhere.example/chat/-1/settings?focus=storefront',
    '/channel/-1/settings?focus=storefront',
    '/chat/-1/settings?focus=storefront&returnUrl=https://elsewhere.example',
    '/chat/-1/settings?focus=storefront&focus=rules',
  ]) {
    assignWindow(`https://major-maksimov.ru/app/?startapp=${encodeRouteStartParam(invalid)}`);
    assert.equal(resolveLaunchRoute(''), null);
  }
});

test('resolves the Publisher auto-replies workspace from a route startapp payload', () => {
  assignWindow(
    `https://major-maksimov.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/publisher/chat/-68085832859751/auto-replies'),
    )}`,
  );

  assert.equal(resolveLaunchRoute(''), '/publisher/chat/-68085832859751/auto-replies');
});

test('opens only the exact Publisher channel VK review workspace', () => {
  const route = '/publisher/channel/-68085832859751?focus=vk';
  assignWindow(
    `https://major-maksimov.ru/app/?startapp=${encodeURIComponent(encodeRouteStartParam(route))}`,
  );
  assert.equal(resolveLaunchRoute(''), route);
  for (const invalid of [
    '/publisher/chat/-1?focus=vk',
    '/publisher/channel/-1?focus=vk&admin=1',
    '/publisher/channel/-1?focus=other',
  ]) {
    assignWindow(
      `https://major-maksimov.ru/app/?startapp=${encodeURIComponent(encodeRouteStartParam(invalid))}`,
    );
    assert.equal(resolveLaunchRoute(''), null);
  }
});

test('Birzhik return opens only the exact entity module in either bot profile', () => {
  for (const route of [
    '/chat/-100/settings?focus=birzhik',
    '/channel/-100/settings?focus=birzhik',
    '/publisher/chat/-100?focus=birzhik',
    '/publisher/channel/-100?focus=birzhik',
  ]) {
    assignWindow(
      `https://major-maksimov.ru/app/?startapp=${encodeURIComponent(encodeRouteStartParam(route))}`,
    );
    assert.equal(resolveLaunchRoute(''), route);
  }
  for (const route of [
    '/publisher/chat/-100?focus=birzhik&admin=1',
    '/chat/-100/settings?focus=birzhik&returnUrl=https://example.com',
    '/publisher/chat/-100?focus=birzhik&focus=vk',
  ]) {
    assignWindow(
      `https://major-maksimov.ru/app/?startapp=${encodeURIComponent(encodeRouteStartParam(route))}`,
    );
    assert.equal(resolveLaunchRoute(''), null);
  }
});

test('rejects widened Publisher auto-reply route payloads', () => {
  assignWindow(
    `https://major-maksimov.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/publisher/chat/-68085832859751/auto-replies?admin=1'),
    )}`,
  );
  assert.equal(resolveLaunchRoute(''), null);

  assignWindow(
    `https://major-maksimov.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/publisher/channel/-68085832859751/auto-replies'),
    )}`,
  );
  assert.equal(resolveLaunchRoute(''), null);
});

test('prefers signed initData start_param over bridge and URL fallbacks', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/chat/url/events'),
    )}`,
    {
      WebApp: {
        initDataUnsafe: {
          start_param: encodeRouteStartParam('/chat/bridge/events'),
        },
      },
    },
  );

  assert.equal(
    resolveLaunchRoute(
      `query_id=test&start_param=${encodeURIComponent(
        encodeRouteStartParam('/chat/signed/events'),
      )}&hash=ok`,
    ),
    '/chat/signed/events',
  );
});

test('prefers a fresh URL public dialog over stale managed launchers in a reused WebView', () => {
  const staleSettingsLauncher = encodeRouteStartParam('/chat/admin-chat-a/settings');
  const freshDialogLauncher = encodeDialogStartParam({
    kind: 'chat-dialog',
    chatId: 'public-chat-b',
    token: 'fresh-public-dialog-token-123456',
  });
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(freshDialogLauncher)}`,
    {
      MAX: {
        WebApp: {
          initDataUnsafe: {
            start_param: staleSettingsLauncher,
          },
        },
      },
    },
  );

  assert.equal(
    resolveLaunchRoute(
      `query_id=test&start_param=${encodeURIComponent(staleSettingsLauncher)}&hash=ok`,
    ),
    '/chat/public-chat-b/dialog/comments?token=fresh-public-dialog-token-123456',
  );
});

test('prefers a fresh URL public dialog over a stale dialog launcher in reused initData', () => {
  const staleDialogLauncher = encodeDialogStartParam({
    kind: 'chat-dialog',
    chatId: 'public-chat-a',
    token: 'stale-public-dialog-token-123456',
  });
  const freshDialogLauncher = encodeDialogStartParam({
    kind: 'chat-dialog',
    chatId: 'public-chat-b',
    token: 'fresh-public-dialog-token-123456',
  });
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(freshDialogLauncher)}`,
  );

  assert.equal(
    resolveLaunchRoute(
      `query_id=test&start_param=${encodeURIComponent(staleDialogLauncher)}&hash=ok`,
    ),
    '/chat/public-chat-b/dialog/comments?token=fresh-public-dialog-token-123456',
  );
});

test('prefers a direct token-bound suggestion route over stale reused launchers', () => {
  const staleSignedLauncher = encodeDialogStartParam({
    kind: 'channel-dialog',
    chatId: 'stale-public-channel',
    mode: 'suggest',
    token: 'stale-public-dialog-token-123456',
  });
  const staleBridgeLauncher = encodeRouteStartParam('/chat/stale-admin-chat/settings');
  assignWindow(
    'https://major-maksimov.ru/app/channel/current-public-channel/dialog/suggest?token=current-public-dialog-token-123456',
    {
      MAX: {
        WebApp: {
          initDataUnsafe: {
            start_param: staleBridgeLauncher,
          },
        },
      },
    },
  );

  assert.equal(
    resolveLaunchRoute(
      `query_id=test&start_param=${encodeURIComponent(staleSignedLauncher)}&hash=stale`,
    ),
    '/channel/current-public-channel/dialog/suggest?token=current-public-dialog-token-123456',
  );
  assert.equal(
    resolveLaunchRoute('query_id=test&hash=ok'),
    '/channel/current-public-channel/dialog/suggest?token=current-public-dialog-token-123456',
  );
});

test('stateful resolver keeps a direct suggestion route until a newer launcher arrives', () => {
  const staleSignedLauncher = encodeRouteStartParam('/chat/stale-admin-chat/settings');
  const freshSignedLauncher = encodeDialogStartParam({
    kind: 'channel-dialog',
    chatId: 'fresh-public-channel',
    mode: 'suggest',
    token: 'fresh-public-dialog-token-123456',
  });
  assignWindow(
    'https://major-maksimov.ru/app/channel/current-public-channel/dialog/suggest?token=current-public-dialog-token-123456',
  );
  const resolver = createLaunchRouteResolver();

  assert.equal(
    resolver(`query_id=test&start_param=${encodeURIComponent(staleSignedLauncher)}&hash=stale`),
    '/channel/current-public-channel/dialog/suggest?token=current-public-dialog-token-123456',
  );
  assert.equal(
    resolver(`query_id=test&start_param=${encodeURIComponent(freshSignedLauncher)}&hash=fresh`),
    '/channel/fresh-public-channel/dialog/suggest?token=fresh-public-dialog-token-123456',
  );
});

test('lets a late signed launcher replace the initial URL dialog without pinning later URLs', () => {
  const firstUrlDialogLauncher = encodeDialogStartParam({
    kind: 'chat-dialog',
    chatId: 'url-public-chat-a',
    token: 'url-public-dialog-token-a-123456',
  });
  const staleSignedLauncher = encodeRouteStartParam('/chat/stale-admin-chat/settings');
  const freshSignedLauncher = encodeDialogStartParam({
    kind: 'chat-dialog',
    chatId: 'signed-public-chat-b',
    token: 'signed-public-dialog-token-b-123456',
  });
  const nextUrlDialogLauncher = encodeDialogStartParam({
    kind: 'channel-dialog',
    chatId: 'url-public-channel-c',
    token: 'url-public-dialog-token-c-123456',
  });
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(firstUrlDialogLauncher)}`,
  );
  const resolver = createLaunchRouteResolver();

  assert.equal(
    resolver(`query_id=test&start_param=${encodeURIComponent(staleSignedLauncher)}&hash=stale`),
    '/chat/url-public-chat-a/dialog/comments?token=url-public-dialog-token-a-123456',
  );
  assert.equal(
    resolver(`query_id=test&start_param=${encodeURIComponent(freshSignedLauncher)}&hash=fresh`),
    '/chat/signed-public-chat-b/dialog/comments?token=signed-public-dialog-token-b-123456',
  );

  window.location.href = `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(nextUrlDialogLauncher)}`;
  assert.equal(
    resolver(`query_id=test&start_param=${encodeURIComponent(freshSignedLauncher)}&hash=fresh`),
    '/channel/url-public-channel-c/dialog/comments?token=url-public-dialog-token-c-123456',
  );
});

test('lets a late bridge launcher replace the initial URL dialog', () => {
  const urlDialogLauncher = encodeDialogStartParam({
    kind: 'chat-dialog',
    chatId: 'url-public-chat',
    token: 'url-public-dialog-token-123456',
  });
  const staleBridgeLauncher = encodeRouteStartParam('/chat/stale-bridge-chat/settings');
  const freshBridgeLauncher = encodeDialogStartParam({
    kind: 'channel-dialog',
    chatId: 'bridge-public-channel',
    token: 'bridge-public-dialog-token-123456',
  });
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(urlDialogLauncher)}`,
    {
      MAX: {
        WebApp: {
          initDataUnsafe: {
            start_param: staleBridgeLauncher,
          },
        },
      },
    },
  );
  const resolver = createLaunchRouteResolver();

  assert.equal(
    resolver('query_id=test&hash=ok'),
    '/chat/url-public-chat/dialog/comments?token=url-public-dialog-token-123456',
  );

  const bridge = window.MAX?.WebApp?.initDataUnsafe;
  assert.ok(bridge);
  bridge.start_param = freshBridgeLauncher;
  assert.equal(
    resolver('query_id=test&hash=ok'),
    '/channel/bridge-public-channel/dialog/comments?token=bridge-public-dialog-token-123456',
  );
});

test('does not let an invalid URL dialog payload override signed managed initData', () => {
  const signedSettingsLauncher = encodeRouteStartParam('/chat/signed-chat/settings');
  const invalidDialogLauncher = encodeDialogStartParam({
    kind: 'chat-dialog',
    chatId: 'public-chat',
    token: 'too-short',
  });
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(invalidDialogLauncher)}`,
  );

  assert.equal(
    resolveLaunchRoute(
      `query_id=test&start_param=${encodeURIComponent(signedSettingsLauncher)}&hash=ok`,
    ),
    '/chat/signed-chat/settings',
  );
});

test('prefers bridge start_param over URL fallback when signed initData has no launcher', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/chat/url/events'),
    )}`,
    {
      WebApp: {
        initDataUnsafe: {
          start_param: encodeRouteStartParam('/chat/bridge/events'),
        },
      },
    },
  );

  assert.equal(resolveLaunchRoute('query_id=test&hash=ok'), '/chat/bridge/events');
});

test('prefers MAX bridge start_param over legacy WebApp fallback', () => {
  assignWindow('https://maxim.play-team.ru/app/', {
    WebApp: {
      initDataUnsafe: {
        start_param: encodeRouteStartParam('/chat/legacy/events'),
      },
    },
    MAX: {
      WebApp: {
        initDataUnsafe: {
          start_param: encodeRouteStartParam('/chat/max/events'),
        },
      },
    },
  });

  assert.equal(resolveLaunchRoute('query_id=test&hash=ok'), '/chat/max/events');
});

test('resolves channel stats route from startapp payload', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/channel/-68085832859751/stats'),
    )}`,
  );

  assert.equal(resolveLaunchRoute(''), '/channel/-68085832859751/stats');
});

test('resolves channel polls settings focus from startapp payload', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/channel/-68085832859751/settings?focus=polls'),
    )}`,
  );

  assert.equal(resolveLaunchRoute(''), '/channel/-68085832859751/settings?focus=polls');
});

test('resolves chat polls settings focus from startapp payload', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/chat/-68085832859751/settings?focus=polls'),
    )}`,
  );

  assert.equal(resolveLaunchRoute(''), '/chat/-68085832859751/settings?focus=polls');
});

test('rejects legacy Major VK settings focus routes', () => {
  for (const entityType of ['chat', 'channel']) {
    assignWindow(
      `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
        encodeRouteStartParam(`/${entityType}/-68085832859751/settings?focus=vkParsing`),
      )}`,
    );

    assert.equal(resolveLaunchRoute(''), null);
  }
});

test('resolves legacy autopost workspaces only inside broadcast settings', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/chat/-68085832859751/settings?focus=broadcast&workspace=autoposts'),
    )}`,
  );

  assert.equal(
    resolveLaunchRoute(''),
    '/chat/-68085832859751/settings?focus=broadcast&workspace=autoposts',
  );

  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/channel/-68085832859751/settings?focus=polls&workspace=autoposts'),
    )}`,
  );
  assert.equal(resolveLaunchRoute(''), null);
});

test('resolves explicit legacy editors only inside broadcast settings', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam(
        '/channel/-68085832859751/settings?focus=broadcast&legacyKind=broadcast&legacyId=legacy-1',
      ),
    )}`,
  );

  assert.equal(
    resolveLaunchRoute(''),
    '/channel/-68085832859751/settings?focus=broadcast&legacyKind=broadcast&legacyId=legacy-1',
  );

  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam(
        '/chat/-68085832859751/settings?focus=rules&legacyKind=autopost&legacyId=legacy-2',
      ),
    )}`,
  );
  assert.equal(resolveLaunchRoute(''), null);

  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/chat/-68085832859751/settings?focus=broadcast&legacyKind=autopost'),
    )}`,
  );
  assert.equal(resolveLaunchRoute(''), null);

  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam(
        '/chat/-68085832859751/settings?focus=broadcast&handoff=1&legacyKind=autopost&legacyId=legacy-2',
      ),
    )}`,
  );
  assert.equal(resolveLaunchRoute(''), null);
});

test('resolves startapp from hash-route query parameters', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/#/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/chat/-68085832859751/settings'),
    )}`,
  );

  assert.equal(resolveLaunchRoute(''), '/chat/-68085832859751/settings');
});

test('hash router builds keep direct legacy deep path visible through the hash route', async () => {
  const previousMode = globalThis.__MAXIM_ROUTER_MODE__;

  Object.defineProperty(globalThis, '__MAXIM_ROUTER_MODE__', {
    configurable: true,
    value: 'hash',
  });
  assignWindow('https://app2.major-maksimov.ru/app/chat/-68085832859751/settings?focus=rules');

  migrateHashRouterLegacyPathFromWindow();

  assert.equal(
    window.location.href,
    'https://app2.major-maksimov.ru/app/#/chat/-68085832859751/settings?focus=rules',
  );

  Object.defineProperty(globalThis, '__MAXIM_ROUTER_MODE__', {
    configurable: true,
    value: previousMode,
  });
});

test('normalizes legacy /chats launcher route to root', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/chats'),
    )}`,
  );

  assert.equal(resolveLaunchRoute(''), '/');
});

test('resolves the publications workspace with compose target parameters', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/publications?compose=1&entityType=channel&entityId=-68085832859751'),
    )}`,
  );

  assert.equal(
    resolveLaunchRoute(''),
    '/publications?compose=1&entityType=channel&entityId=-68085832859751',
  );
});

test('resolves a bounded Publik forwarded-post return payload', () => {
  assignWindow('https://maxim.play-team.ru/app/?startapp=pi_import_token_1234567890');

  assert.equal(resolveLaunchRoute(''), '/publications?import=import_token_1234567890');
});

test('rejects an oversized Publik import payload', () => {
  assignWindow(`https://maxim.play-team.ru/app/?startapp=pi_${'a'.repeat(257)}`);
  assert.equal(resolveLaunchRoute(''), null);
});

test('resolves the legacy publications workspace only for the supported flag', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/publications?legacy=1'),
    )}`,
  );
  assert.equal(resolveLaunchRoute(''), '/publications?legacy=1');

  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/publications?legacy=0'),
    )}`,
  );
  assert.equal(resolveLaunchRoute(''), null);

  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/publications?legacy=1&compose=1'),
    )}`,
  );
  assert.equal(resolveLaunchRoute(''), null);
});

test('normalizes legacy autopost launcher routes to publications', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/autoposts?view=history'),
    )}`,
  );

  assert.equal(resolveLaunchRoute(''), '/publications?view=history');
});

test('rejects unsupported publications launcher parameters', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/publications?admin=1'),
    )}`,
  );

  assert.equal(resolveLaunchRoute(''), null);
});

test('opens only exact suggestion review routes without injected query state', () => {
  for (const mode of ['edit', 'publish', 'reject']) {
    const route = `/suggestions/suggestion-42/${mode}`;
    assignWindow(`https://major-maksimov.ru/app/?startapp=${encodeRouteStartParam(route)}`);
    assert.equal(resolveLaunchRoute(''), route);
  }
  for (const route of [
    '/suggestions/suggestion-42/delete',
    '/suggestions/suggestion-42/edit?author=999',
    '/suggestions/../publish',
  ]) {
    assignWindow(`https://major-maksimov.ru/app/?startapp=${encodeRouteStartParam(route)}`);
    assert.equal(resolveLaunchRoute(''), null);
  }
});
