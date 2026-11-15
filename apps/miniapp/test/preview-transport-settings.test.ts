import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelPostSignatureSettings } from '@maxim/contracts/channel-post-signature';
import type { ManagedEntityAccessDiagnostics } from '@maxim/contracts/managed-entities';
import type { VkParsingFeed } from '@maxim/contracts/vk-parsing';
import type { DomainAllowlistEntry } from '@maxim/contracts/settings';
import { ApiRequestError } from '../src/lib/api-request-error';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import { publishRules, updateBotSpeechStyle } from '../src/lib/api/chat-settings-client';
import {
  getChannelPostSignature,
  getChannelSettings,
  updateChannelPostSignature,
  updateChannelSettings,
} from '../src/lib/api/channel-settings-client';
import {
  stopWordsPolicySchema,
  type ChatSettings,
  type ChatSettingsScreenResponse,
} from '@maxim/contracts/settings';
import { getStopWords, updateStopWords } from '../src/lib/api/stop-words-client';

test('preview stop-word receipts share full-screen revision, preserve modes and retry without another revision', async () => {
  const api = createPreviewApiTransport();
  const before = await getStopWords(api, 'preview-chat');
  const screen = (await api.request(
    '/chats/preview-chat/settings-screen',
  )) as ChatSettingsScreenResponse;
  assert.equal(screen.stopWordsStorageStatus, 'valid');
  assert.equal(before.storageStatus, 'valid');
  assert.equal(before.settingsRevision, screen.settings.settingsRevision);
  const policy = stopWordsPolicySchema.parse({
    enabled: true,
    rules: [
      { id: 'exact', value: 'казино', kind: 'WORD', enabled: true, matchMode: 'EXACT' },
      { id: 'masked', value: 'реклама', kind: 'WORD', enabled: true, matchMode: 'MASKED' },
    ],
  });
  const saved = await updateStopWords(api, 'preview-chat', policy, before.revision);
  assert.equal(saved.revision, before.revision + 1);
  assert.ok(Date.parse(saved.settingsRevision!) > Date.parse(before.settingsRevision!));
  assert.deepEqual(await updateStopWords(api, 'preview-chat', policy, before.revision), saved);
  assert.deepEqual(
    (await getStopWords(api, 'preview-chat')).policy.rules.map((rule) => rule.matchMode),
    ['EXACT', 'MASKED'],
  );
  await assert.rejects(
    updateStopWords(api, 'preview-chat', { ...policy, enabled: false }, before.revision),
    (error: unknown) =>
      error instanceof ApiRequestError && error.code === 'STOP_WORDS_REVISION_CONFLICT',
  );
  assert.deepEqual(await getStopWords(api, 'preview-chat'), saved);
});

test('preview invalid storage requires literal explicit standalone replacement and blocks copying', async () => {
  const api = createPreviewApiTransport({ search: '?stopWordsStorage=invalid' });
  const before = await getStopWords(api, 'preview-chat');
  const screen = (await api.request(
    '/chats/preview-chat/settings-screen',
  )) as ChatSettingsScreenResponse;
  assert.equal(screen.stopWordsStorageStatus, 'invalid');
  assert.equal(before.storageStatus, 'invalid');
  assert.equal(before.policy.enabled, false);
  for (const replaceInvalidStorage of [undefined, false]) {
    await assert.rejects(
      api.request('/chats/preview-chat/stop-words', {
        method: 'PUT',
        body: JSON.stringify({
          policy: before.policy,
          expectedRevision: before.revision,
          ...(replaceInvalidStorage === undefined ? {} : { replaceInvalidStorage }),
        }),
      }),
      (error: unknown) =>
        error instanceof ApiRequestError && error.code === 'STOP_WORDS_POLICY_REVIEW_REQUIRED',
    );
    assert.deepEqual(await getStopWords(api, 'preview-chat'), before);
  }
  await assert.rejects(
    api.request('/chats/preview-chat/settings/apply-section-to-all', {
      method: 'POST',
      body: JSON.stringify({ section: 'stopWords', expectedSourceRevision: before.revision }),
    }),
    (error: unknown) =>
      error instanceof ApiRequestError && error.code === 'STOP_WORDS_POLICY_REVIEW_REQUIRED',
  );
  const saved = await updateStopWords(api, 'preview-chat', before.policy, before.revision, {
    replaceInvalidStorage: true,
  });
  assert.equal(saved.storageStatus, 'valid');
  assert.equal(saved.revision, before.revision + 1);
});

test('preview cached-valid review transition preserves the policy until explicit replacement', async () => {
  const api = createPreviewApiTransport({ search: '?stopWordsWriteError=review' });
  const before = await getStopWords(api, 'preview-chat');
  assert.equal(before.storageStatus, 'valid');
  const policy = { ...before.policy, domains: ['new.example'] };
  await assert.rejects(
    updateStopWords(api, 'preview-chat', policy, before.revision),
    (error: unknown) =>
      error instanceof ApiRequestError && error.code === 'STOP_WORDS_POLICY_REVIEW_REQUIRED',
  );
  const invalid = await getStopWords(api, 'preview-chat');
  assert.equal(invalid.storageStatus, 'invalid');
  assert.equal(invalid.revision, before.revision);
  await assert.rejects(
    updateStopWords(api, 'preview-chat', policy, before.revision),
    (error: unknown) =>
      error instanceof ApiRequestError && error.code === 'STOP_WORDS_POLICY_REVIEW_REQUIRED',
  );
  assert.equal((await getStopWords(api, 'preview-chat')).revision, before.revision);
  const saved = await updateStopWords(api, 'preview-chat', policy, before.revision, {
    replaceInvalidStorage: true,
  });
  assert.deepEqual(saved.policy, policy);
  assert.equal(saved.storageStatus, 'valid');
});

test('preview style writes preserve current custom text and media without accepting unrelated data', async () => {
  const api = createPreviewApiTransport();
  const path = '/chats/preview-chat/settings';
  const initial = (await api.request(path)) as ChatSettings;
  const current = (await api.request(path, {
    method: 'PUT',
    body: JSON.stringify({
      ...initial,
      greetingBotMessageText: '  **Свой текст** {user}\r\n ',
      linkWarnMessageText: '   ',
      botSpeechMedia: { greetingBotMessageText: { base64: 'aGVsbG8=', mimeType: 'image/png' } },
    }),
  })) as ChatSettings;
  const saved = await updateBotSpeechStyle(api, 'preview-chat', 'IRONIC');
  assert.deepEqual(await api.request(path), { ...current, ...saved });
  assert.ok(Date.parse(saved.settingsRevision) > Date.parse(current.settingsRevision!));
  await assert.rejects(
    api.request(`${path}/speech-style`, {
      method: 'PATCH',
      body: JSON.stringify({ botSpeechStyle: 'ROBOT', greetingBotMessageText: '' }),
    }),
  );
  assert.deepEqual(await api.request(path), { ...current, ...saved });
});

test('preview allowlist preserves active timers, hides expired rules and supports re-adding', async () => {
  let now = new Date('2026-09-17T10:00:00.000Z');
  const api = createPreviewApiTransport({ clock: { now: () => now } });
  const base = '/chats/preview-chat/domain-allowlist';
  const add = () =>
    api.request(base, {
      method: 'POST',
      body: JSON.stringify({ domain: 'timer.example', kind: 'WEB_DOMAIN' }),
    });
  const read = async () => (await api.request(`${base}/details`)) as DomainAllowlistEntry[];
  await add();
  const removeAfterAt = '2026-09-17T10:01:00.000Z';
  await api.request(`${base}/removal-schedule?domain=domain%3Atimer.example`, {
    method: 'PUT',
    body: JSON.stringify({ removeAfterAt }),
  });
  await add();
  assert.equal(
    (await read()).find((entry) => entry.domain === 'timer.example')?.removeAfterAt,
    removeAfterAt,
  );
  now = new Date(removeAfterAt);
  assert.equal(
    (await read()).some((entry) => entry.domain === 'timer.example'),
    false,
  );
  const screen = (await api.request('/chats/preview-chat/settings-screen')) as {
    domains: DomainAllowlistEntry[];
  };
  assert.equal(
    screen.domains.some((entry) => entry.domain === 'timer.example'),
    false,
  );
  await add();
  const entries = (await read()).filter((entry) => entry.domain === 'timer.example');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.removeAfterAt, null);
});

test('rules command roundtrip distinguishes a new post from editing the same post', async () => {
  const api = createPreviewApiTransport();
  const created = await publishRules(api, 'preview-chat', { mode: 'new_message' });
  const updated = await publishRules(api, 'preview-chat', { mode: 'update' });
  const next = await publishRules(api, 'preview-chat', { mode: 'new_message' });
  assert.equal(created.operation, 'created');
  assert.equal(updated.operation, 'updated');
  assert.equal(updated.messageId, created.messageId);
  assert.equal(updated.url, created.url);
  assert.equal(next.operation, 'created');
  assert.notEqual(next.messageId, created.messageId);
  assert.notEqual(next.url, created.url);
  await api.request('/chats/preview-chat/rules/publish', { method: 'DELETE' });
  await assert.rejects(publishRules(api, 'preview-chat', { mode: 'update' }));
});

test('Major preview settings keep publishing data empty', async () => {
  const api = createPreviewApiTransport();

  const chatSettings = (await api.request('/chats/preview-chat/settings-screen')) as {
    botSpeechPreviewProfile: {
      persona: string;
      characterName: string;
    };
    header: {
      primaryBotId: string | null;
      assignedBots: unknown[];
    };
    requiredSubscriptionChannels: Array<{
      primaryBotId: string | null;
      assignedBots: unknown[];
    }>;
    managedBroadcasts: Array<{
      id: string;
      targetMode: string;
      blockedChats: number;
      failureBreakdown: {
        transient: number;
        permanentTarget: number;
        quarantined: number;
        unknown: number;
      };
    }>;
  };
  const channelSettings = (await api.request('/channels/preview-channel/settings-screen')) as {
    postSignature: ChannelPostSignatureSettings;
    managedBroadcasts: Array<{
      id: string;
      targetMode: string;
      blockedChats: number;
      failureBreakdown: {
        transient: number;
        permanentTarget: number;
        quarantined: number;
        unknown: number;
      };
    }>;
  };

  assert.deepEqual(chatSettings.botSpeechPreviewProfile, {
    persona: 'male',
    characterName: 'Майор Максимов',
  });
  assert.equal(chatSettings.header.primaryBotId, null);
  assert.deepEqual(chatSettings.header.assignedBots, []);
  assert.equal(chatSettings.requiredSubscriptionChannels[0]?.primaryBotId, null);
  assert.deepEqual(chatSettings.requiredSubscriptionChannels[0]?.assignedBots, []);
  assert.deepEqual(chatSettings.managedBroadcasts, []);
  assert.deepEqual(channelSettings.managedBroadcasts, []);
  assert.deepEqual(channelSettings.postSignature, {
    revision: 0,
    enabled: false,
    customButtonsEnabled: false,
    customButtons: [],
    presentation: 'signature',
    text: 'Подписаться на канал',
    url: '',
  });
});

test('preview channel signature update is isolated from settings and Publik VK import', async () => {
  const api = createPreviewApiTransport({ search: '?profile=publisher' });
  const publisherVkPath = '/publisher/entities/channel/preview-channel/vk-parsing';
  const vkBefore = (await api.request(publisherVkPath)) as VkParsingFeed;
  const signatureBefore = await getChannelPostSignature(api, 'preview-channel');

  await updateChannelPostSignature(api, 'preview-channel', {
    expectedRevision: signatureBefore.revision ?? 0,
    enabled: true,
    presentation: 'button',
    text: 'Заказать рекламу',
    url: 'https://max.ru/advertising-manager',
  });
  const signature = await getChannelPostSignature(api, 'preview-channel');
  const screen = (await api.request('/channels/preview-channel/settings-screen')) as {
    postSignature: ChannelPostSignatureSettings;
  };
  const vkAfter = (await api.request(publisherVkPath)) as VkParsingFeed;

  assert.deepEqual(signature, {
    revision: (signatureBefore.revision ?? 0) + 1,
    enabled: true,
    customButtonsEnabled: false,
    customButtons: [],
    presentation: 'button',
    text: 'Заказать рекламу',
    url: 'https://max.ru/advertising-manager',
  });
  assert.deepEqual(screen.postSignature, signature);
  assert.equal(
    vkAfter.settings.appendChannelLinkEnabled,
    vkBefore.settings.appendChannelLinkEnabled,
  );
  assert.equal(vkAfter.settings.channelLinkText, vkBefore.settings.channelLinkText);
});

test('preview channel settings and signature reject stale shared revisions without mutation', async () => {
  const api = createPreviewApiTransport();
  const channelId = 'preview-channel';
  const initialSettings = await getChannelSettings(api, channelId);
  const initialSignature = await getChannelPostSignature(api, channelId);
  assert.equal(initialSettings.revision, 0);
  assert.equal(initialSignature.revision, 0);

  const signature = await updateChannelPostSignature(api, channelId, {
    expectedRevision: initialSignature.revision ?? 0,
    enabled: true,
    presentation: 'button',
    text: 'Заказать рекламу',
    url: 'https://max.ru/advertising-manager',
  });
  const settingsAfterSignature = await getChannelSettings(api, channelId);
  assert.equal(signature.revision, 1);
  assert.deepEqual(settingsAfterSignature, { ...initialSettings, revision: 1 });

  await assert.rejects(
    updateChannelSettings(api, channelId, {
      ...initialSettings,
      commentsEnabled: !initialSettings.commentsEnabled,
    }),
    /Настройки канала изменились/u,
  );
  assert.deepEqual(await getChannelSettings(api, channelId), settingsAfterSignature);
  assert.deepEqual(await getChannelPostSignature(api, channelId), signature);

  const savedSettings = await updateChannelSettings(api, channelId, {
    ...settingsAfterSignature,
    commentsEnabled: !initialSettings.commentsEnabled,
  });
  const signatureAfterSettings = await getChannelPostSignature(api, channelId);
  assert.equal(savedSettings.revision, 2);
  assert.equal(savedSettings.commentsEnabled, !initialSettings.commentsEnabled);
  assert.deepEqual(signatureAfterSettings, { ...signature, revision: 2 });

  await assert.rejects(
    updateChannelPostSignature(api, channelId, {
      expectedRevision: signature.revision ?? 0,
      text: 'Устаревший текст',
    }),
    /Настройки канала изменились/u,
  );
  assert.deepEqual(await getChannelSettings(api, channelId), savedSettings);
  assert.deepEqual(await getChannelPostSignature(api, channelId), signatureAfterSettings);
});

test('preview access query exposes deterministic lost and degraded settings diagnostics', async () => {
  const endpoints = [
    '/chats/preview-chat/settings-screen',
    '/channels/preview-channel/settings-screen',
  ];

  for (const endpoint of endpoints) {
    const lostApi = createPreviewApiTransport({ search: '?access=lost' });
    const lostScreen = (await lostApi.request(endpoint)) as {
      header: { accessDiagnostics: ManagedEntityAccessDiagnostics };
    };

    assert.deepEqual(lostScreen.header.accessDiagnostics, {
      state: 'bot_access_lost',
      lastDetectedAt: '2026-07-14T06:15:00.000Z',
      lastCheckedAt: '2026-07-14T06:20:00.000Z',
      freshUntil: null,
      source: 'access_edge',
      activeBotCount: 0,
      lostBots: [
        {
          botId: '777001_bot',
          botLabel: 'Майор Максимова',
          reason: 'bot_removed',
          detectedAt: '2026-07-14T06:15:00.000Z',
        },
      ],
    });

    const degradedApi = createPreviewApiTransport({ search: '?access=degraded' });
    const degradedScreen = (await degradedApi.request(endpoint)) as {
      header: { accessDiagnostics: ManagedEntityAccessDiagnostics };
    };

    assert.equal(degradedScreen.header.accessDiagnostics.state, 'bot_access_lost');
    assert.equal(degradedScreen.header.accessDiagnostics.activeBotCount, 1);
    assert.equal(degradedScreen.header.accessDiagnostics.lostBots[0]?.reason, 'bot_denied');
  }
});

test('preview settings errors preserve auth and entity-access classifications', async () => {
  const endpoints = [
    '/chats/preview-chat/settings-screen',
    '/channels/preview-channel/settings-screen',
  ];
  const cases = [
    {
      variant: 'auth-expired',
      status: 401,
      code: 'MINIAPP_AUTH_EXPIRED',
    },
    {
      variant: 'access-denied',
      status: 403,
      code: 'SETTINGS_ACCESS_USER_DENIED',
    },
  ] as const;

  for (const endpoint of endpoints) {
    for (const testCase of cases) {
      const api = createPreviewApiTransport({
        search: `?settingsError=${testCase.variant}`,
      });

      await assert.rejects(
        () => api.request(endpoint),
        (error: unknown) =>
          error instanceof ApiRequestError &&
          error.status === testCase.status &&
          error.code === testCase.code,
      );
    }
  }
});

test('preview settings error uses the direct visual route query', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        search: '?preview=1&settingsError=auth-expired',
        hash: '#/chat/preview-chat/settings?settingsError=access-denied',
      },
    },
  });

  try {
    const api = createPreviewApiTransport();
    await assert.rejects(
      () => api.request('/chats/preview-chat/settings-screen'),
      (error: unknown) =>
        error instanceof ApiRequestError &&
        error.status === 401 &&
        error.code === 'MINIAPP_AUTH_EXPIRED',
    );
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
});

test('preview apply section without target stays scoped to current chat', async () => {
  const api = createPreviewApiTransport();

  const preview = (await api.request('/chats/preview-chat/settings/apply-section-preview', {
    method: 'POST',
    body: JSON.stringify({}),
  })) as {
    targetMode: string;
    updatedChats: number;
    appliedChatIds: string[];
  };
  const applied = (await api.request('/chats/preview-chat/settings/apply-section-to-all', {
    method: 'POST',
    body: JSON.stringify({ section: 'links' }),
  })) as {
    targetMode: string;
    updatedChats: number;
    appliedChatIds: string[];
  };

  assert.equal(preview.targetMode, 'current');
  assert.equal(preview.updatedChats, 1);
  assert.deepEqual(preview.appliedChatIds, ['preview-chat']);
  assert.equal(applied.targetMode, 'current');
  assert.equal(applied.updatedChats, 1);
  assert.deepEqual(applied.appliedChatIds, ['preview-chat']);
});

test('preview allowlist canonicalizes every navigation target kind and legacy requests', async () => {
  const api = createPreviewApiTransport();
  const requests = [
    { domain: 'typed.example', kind: 'WEB_DOMAIN' },
    { domain: 'https://typed.example/path', kind: 'WEB_EXACT' },
    { domain: 'max://user/42', kind: 'MAX_PROFILE' },
    { domain: 'https://max.ru/join/typed-team', kind: 'MAX_ENTITY' },
    {
      domain: 'https://max.ru/MajorBot?startapp=chat-settings-42',
      kind: 'MINI_APP',
    },
    { domain: 'legacy.example', matchType: 'DOMAIN' },
  ] as const;

  for (const payload of requests) {
    await api.request('/chats/preview-chat/domain-allowlist', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  const details = (await api.request('/chats/preview-chat/domain-allowlist/details')) as Array<{
    target: string;
    kind: string;
    normalizedValue: string;
  }>;

  assert.deepEqual(
    details
      .filter((entry) =>
        [
          'domain:typed.example',
          'https://typed.example/path',
          'max-profile:user-id%3A42',
          'max-entity:url%3Ahttps%3A%2F%2Fmax.ru%2Fjoin%2Ftyped-team',
          'mini-app:bot%3Amajorbot',
          'domain:legacy.example',
        ].includes(entry.normalizedValue),
      )
      .map(({ target, kind, normalizedValue }) => ({ target, kind, normalizedValue })),
    [
      {
        target: 'legacy.example',
        kind: 'WEB_DOMAIN',
        normalizedValue: 'domain:legacy.example',
      },
      {
        target: 'bot:majorbot',
        kind: 'MINI_APP',
        normalizedValue: 'mini-app:bot%3Amajorbot',
      },
      {
        target: 'url:https://max.ru/join/typed-team',
        kind: 'MAX_ENTITY',
        normalizedValue: 'max-entity:url%3Ahttps%3A%2F%2Fmax.ru%2Fjoin%2Ftyped-team',
      },
      {
        target: 'user-id:42',
        kind: 'MAX_PROFILE',
        normalizedValue: 'max-profile:user-id%3A42',
      },
      {
        target: 'https://typed.example/path',
        kind: 'WEB_EXACT',
        normalizedValue: 'https://typed.example/path',
      },
      {
        target: 'typed.example',
        kind: 'WEB_DOMAIN',
        normalizedValue: 'domain:typed.example',
      },
    ],
  );
});
