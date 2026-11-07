import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
  channelSettingsSchema,
  chatRulesSchema,
  chatSettingsSchema,
  type ChannelSettingsScreenResponse,
  type ChatSettingsScreenResponse,
} from '@maxim/contracts';
import {
  getChannelPostSignature,
  getChannelSettingsScreen,
  updateChannelPostSignature,
} from '../src/lib/api/channel-settings-client';
import {
  addDomain,
  getKaravanStorefrontAllowlist,
  handoffKaravanStorefrontAllowlist,
  revokeKaravanStorefrontAllowlistEntry,
  getSettingsScreen,
  updateSettings,
  updateBotSpeechStyle,
  patchSettingsSection,
} from '../src/lib/api/chat-settings-client';
import type { ApiTransport } from '../src/lib/api/transport';
import { linkRulesPolicySchema } from '@maxim/contracts/settings';

type ApiCall = {
  path: string;
  init?: RequestInit;
};

function createApiMock(response: unknown, calls: ApiCall[]): ApiTransport {
  return {
    async request(path: string, init?: RequestInit) {
      calls.push({ path, init });
      return response;
    },
    requestKeepalive() {
      // Not used by these client helpers.
    },
  };
}

test('link section transports policy, sanctions and initial list witness together without stop-word ownership', async () => {
  const calls: ApiCall[] = [];
  const policy = linkRulesPolicySchema.parse({
    version: 1,
    mode: 'DENY_SELECTED',
    rules: [
      {
        id: 'page',
        effect: 'DENY',
        kind: 'WEB_EXACT',
        target: 'https://example.com/ad?literal=%2525#offer',
      },
    ],
  });
  const settings = chatSettingsSchema.parse({
    settingsRevision: '2026-11-07T08:00:00.000Z',
    linkRulesPolicy: policy,
    linkRulesLegacySnapshot: {
      revision: '7',
      policy: { version: 1, mode: 'ALLOW_ALL', rules: [] },
    },
    linkWarnEnabled: false,
    linkMuteEnabled: false,
    linkBanEnabled: false,
  });
  const api = createApiMock(settings, calls);
  await patchSettingsSection(api, 'chat-1', 'links', settings, [
    'linkRulesPolicy',
    'linkRulesLegacySnapshot',
    'linkWarnEnabled',
    'linkMuteEnabled',
    'linkBanEnabled',
  ]);
  const body = JSON.parse(calls[0].init?.body as string);
  assert.equal(calls.length, 1);
  assert.equal(body.expectedRevision, settings.settingsRevision);
  assert.deepEqual(body.changes.linkRulesPolicy, policy);
  assert.equal(body.changes.linkRulesLegacySnapshot.revision, '7');
  assert.equal(body.changes.linkWarnEnabled, false);
  assert.equal(body.changes.linkMuteEnabled, false);
  assert.equal(body.changes.linkBanEnabled, false);
  assert.equal(body.changes.stopWordsPolicy, undefined);
  assert.equal(body.changes.stopWordsRevision, undefined);
});

test('speech-style save sends only the selected style and accepts an exact revision receipt', async () => {
  const calls: ApiCall[] = [];
  const receipt = {
    botSpeechStyle: 'IRONIC' as const,
    settingsRevision: '2026-10-04T10:00:00.000Z',
  };
  const api = createApiMock(receipt, calls);
  const staleDraft = chatSettingsSchema.parse({
    greetingBotMessageText: 'Старый текст',
    botSpeechStyle: 'IRONIC',
  });
  assert.deepEqual(await updateBotSpeechStyle(api, 'chat-1', staleDraft.botSpeechStyle!), receipt);
  assert.equal(calls[0]?.path, '/chats/chat-1/settings/speech-style');
  assert.equal(calls[0]?.init?.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0]?.init?.body as string), { botSpeechStyle: 'IRONIC' });
});

function createChatSettingsScreenResponse(): ChatSettingsScreenResponse {
  return {
    settings: chatSettingsSchema.parse({}),
    rules: chatRulesSchema.parse({}),
    header: {
      id: 'chat-1',
      title: 'Чат',
      entityType: 'chat',
      link: null,
      participantsCount: null,
    },
    botSpeechPreviewProfile: {
      persona: 'female',
      characterName: 'Майор Максимова',
    },
    requiredSubscriptionChannels: [],
    domains: [],
    managedBroadcasts: [],
  };
}

function createChannelSettingsScreenResponse(): ChannelSettingsScreenResponse {
  return {
    settings: channelSettingsSchema.parse({}),
    postSignature: {
      enabled: false,
      text: CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
      url: '',
    },
    header: {
      id: 'channel-1',
      title: 'Канал',
      entityType: 'channel',
      link: null,
      participantsCount: null,
    },
    managedBroadcasts: [],
  };
}

test('chat settings screen client only adds prefetch query when requested', async () => {
  const calls: ApiCall[] = [];
  const api = createApiMock(createChatSettingsScreenResponse(), calls);
  const controller = new AbortController();

  const screen = await getSettingsScreen(api, 'chat-1', { signal: controller.signal });
  await getSettingsScreen(api, 'chat-1', { signal: controller.signal, prefetch: true });

  assert.deepEqual(screen.botSpeechPreviewProfile, {
    persona: 'female',
    characterName: 'Майор Максимова',
  });
  assert.equal(screen.header.primaryBotId, null);
  assert.deepEqual(screen.header.assignedBots, []);
  assert.equal(calls[0]?.path, '/chats/chat-1/settings-screen');
  assert.equal(calls[0]?.init?.signal, controller.signal);
  assert.equal(calls[1]?.path, '/chats/chat-1/settings-screen?prefetch=1');
  assert.equal(calls[1]?.init?.signal, controller.signal);
});

test('chat settings screen client reads a legacy equal-time schedule with notices', async () => {
  const calls: ApiCall[] = [];
  const response = createChatSettingsScreenResponse();
  response.settings = chatSettingsSchema.parse({
    nightModeEnabled: true,
    nightModeStartTimeMinutes: 22 * 60,
    nightModeEndTimeMinutes: 22 * 60,
    nightModeBotMessageEnabled: true,
    nightModeOpenMessageEnabled: true,
  });
  const api = createApiMock(response, calls);

  const screen = await getSettingsScreen(api, 'chat-1');

  assert.equal(screen.settings.nightModeEnabled, true);
  assert.equal(screen.settings.nightModeStartTimeMinutes, screen.settings.nightModeEndTimeMinutes);
  assert.equal(screen.settings.nightModeBotMessageEnabled, true);
  assert.equal(screen.settings.nightModeOpenMessageEnabled, true);
});

test('chat settings retry requests an explicit live bot capability recheck', async () => {
  const calls: ApiCall[] = [];
  const settings = chatSettingsSchema.parse({ antiSpamEnabled: true });
  const api = createApiMock(settings, calls);

  await updateSettings(api, 'chat-1', settings);
  await updateSettings(api, 'chat-1', settings, { recheckBotCapabilities: true });

  assert.equal(calls[0]?.path, '/chats/chat-1/settings');
  assert.equal(calls[1]?.path, '/chats/chat-1/settings?recheckBotCapabilities=1');
});

test('section PATCH sends the original GET revision and only owned settings and media', async () => {
  const calls: ApiCall[] = [];
  const revision = '2026-10-01T10:00:00.000Z';
  const settings = chatSettingsSchema.parse({
    settingsRevision: revision,
    commercialAdsFilterEnabled: true,
  });
  settings.botSpeechMedia = {
    textFiltersBotMessageText: { mimeType: 'image/png', base64: 'YQ==', fileName: 'ad.png' },
    profanityBotMessageText: { mimeType: 'image/png', base64: 'YQ==', fileName: 'word.png' },
  };
  await patchSettingsSection(
    createApiMock(settings, calls),
    'chat-1',
    'commercialFilter',
    settings,
    ['commercialAdsFilterEnabled', 'textFiltersBotMessageText'],
    { recheckBotCapabilities: true },
  );
  assert.equal(calls[0]?.path, '/chats/chat-1/settings/section?recheckBotCapabilities=1');
  assert.equal(calls[0]?.init?.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    section: 'commercialFilter',
    expectedRevision: revision,
    changes: {
      commercialAdsFilterEnabled: true,
      textFiltersBotMessageText: '',
      botSpeechMedia: {
        textFiltersBotMessageText: settings.botSpeechMedia.textFiltersBotMessageText,
      },
    },
  });
});

test('chat settings client rejects equal times with notices but allows silent 24/7 mode', async () => {
  const calls: ApiCall[] = [];
  const api = createApiMock(chatSettingsSchema.parse({}), calls);

  for (const noticeField of [
    'nightModeBotMessageEnabled',
    'nightModeOpenMessageEnabled',
  ] as const) {
    const settings = chatSettingsSchema.parse({
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 22 * 60,
      nightModeEndTimeMinutes: 22 * 60,
      [noticeField]: true,
    });
    await assert.rejects(
      () => updateSettings(api, 'chat-1', settings),
      /Для сообщений ночного режима время открытия должно отличаться от времени закрытия\./u,
    );
  }

  assert.equal(calls.length, 0);

  const silentSettings = chatSettingsSchema.parse({
    nightModeEnabled: true,
    nightModeStartTimeMinutes: 22 * 60,
    nightModeEndTimeMinutes: 22 * 60,
    nightModeBotMessageEnabled: false,
    nightModeOpenMessageEnabled: false,
  });
  await updateSettings(api, 'chat-1', silentSettings);

  assert.equal(calls.length, 1);
});

test('chat settings client sends typed targets and preserves legacy allowlist requests', async () => {
  const calls: ApiCall[] = [];
  const api = createApiMock(undefined, calls);

  await addDomain(api, 'chat-1', {
    domain: 'user-id:42',
    kind: 'MAX_PROFILE',
  });
  await addDomain(api, 'chat-1', {
    domain: 'docs.max.ru',
    matchType: 'DOMAIN',
  });

  assert.equal(calls[0]?.path, '/chats/chat-1/domain-allowlist');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(calls[0]?.init?.body, JSON.stringify({ domain: 'user-id:42', kind: 'MAX_PROFILE' }));
  assert.equal(
    calls[1]?.init?.body,
    JSON.stringify({ domain: 'docs.max.ru', matchType: 'DOMAIN' }),
  );
});

test('Karavan storefront allowlist client uses cursor pagination and typed mutations', async () => {
  const calls: ApiCall[] = [];
  const listApi = createApiMock(
    {
      items: [],
      hasMore: false,
      nextCursor: null,
    },
    calls,
  );

  await getKaravanStorefrontAllowlist(listApi, 'chat-1', {
    signal: new AbortController().signal,
    cursor: 'cursor-1',
    limit: 25,
  });
  const mutationApi = createApiMock({ botUrl: 'https://max.ru/maxim-bot' }, calls);
  const handoffResponse = await handoffKaravanStorefrontAllowlist(mutationApi, 'chat-1');
  assert.equal(handoffResponse.botUrl, 'https://max.ru/maxim-bot');

  const revokeApi = createApiMock({ revoked: true }, calls);
  const revokeResponse = await revokeKaravanStorefrontAllowlistEntry(
    revokeApi,
    'chat-1',
    'entry/1',
  );
  assert.equal(revokeResponse.revoked, true);

  assert.equal(
    calls[0]?.path,
    '/chats/chat-1/karavan-storefront/allowlist?cursor=cursor-1&limit=25',
  );
  assert.equal(calls[0]?.init?.signal instanceof AbortSignal, true);
  assert.equal(calls[1]?.path, '/chats/chat-1/karavan-storefront/allowlist/handoff');
  assert.equal(calls[1]?.init?.method, 'POST');
  assert.equal(calls[1]?.init?.body, '{}');
  assert.equal(calls[2]?.path, '/chats/chat-1/karavan-storefront/allowlist/entry%2F1');
  assert.equal(calls[2]?.init?.method, 'DELETE');
});

test('channel post signature client preserves a custom URL across GET and PATCH', async () => {
  const calls: ApiCall[] = [];
  const signature = {
    enabled: true,
    presentation: 'button' as const,
    text: 'Заказать рекламу',
    url: 'https://max.ru/advertising-manager',
  };
  const api = createApiMock(signature, calls);

  const current = await getChannelPostSignature(api, 'channel-1');
  const updated = await updateChannelPostSignature(api, 'channel-1', {
    ...signature,
    expectedRevision: 4,
  });

  assert.deepEqual(current, signature);
  assert.deepEqual(updated, current);
  assert.equal(calls[0]?.path, '/channels/channel-1/post-signature');
  assert.equal(calls[1]?.path, '/channels/channel-1/post-signature');
  assert.equal(calls[1]?.init?.method, 'PATCH');
  assert.equal(calls[1]?.init?.body, JSON.stringify({ expectedRevision: 4, ...current }));
});

test('channel settings screen client only adds prefetch query when requested', async () => {
  const calls: ApiCall[] = [];
  const api = createApiMock(createChannelSettingsScreenResponse(), calls);
  const controller = new AbortController();

  await getChannelSettingsScreen(api, 'channel-1', { signal: controller.signal });
  await getChannelSettingsScreen(api, 'channel-1', {
    signal: controller.signal,
    prefetch: true,
  });

  assert.equal(calls[0]?.path, '/channels/channel-1/settings-screen');
  assert.equal(calls[0]?.init?.signal, controller.signal);
  assert.equal(calls[1]?.path, '/channels/channel-1/settings-screen?prefetch=1');
  assert.equal(calls[1]?.init?.signal, controller.signal);
});
