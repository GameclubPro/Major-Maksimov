import assert from 'node:assert/strict';
import test from 'node:test';
import { chatSettingsSchema, stopWordsPolicySchema } from '@maxim/contracts/settings';
import { ApiRequestError } from '../src/lib/api-request-error';
import type { ApiTransport } from '../src/lib/api/transport';
import {
  applySettingsSectionWithConfirmedSource,
  refreshSavedStopWordsSource,
  type SettingsApplySavedSource,
} from '../src/pages/settings/settings-section-apply-submit';

const draftRevision = '2026-10-01T10:00:00.000Z';
const savedRevision = '2026-10-01T11:00:00.000Z';

test('report bulk submission retains the saved source when confirmed-target apply fails', async () => {
  const sourceSettings = chatSettingsSchema.parse({ settingsRevision: draftRevision });
  const saved = { ...sourceSettings, settingsRevision: savedRevision };
  const snapshots: Array<SettingsApplySavedSource | null> = [];
  let applyBody: Record<string, unknown> | undefined;
  const api: ApiTransport = {
    request: async (path, options) => {
      if (path.endsWith('/settings/section')) return saved;
      assert.equal(path, '/chats/source/settings/apply-section-to-all');
      assert.equal(snapshots.at(-1)?.settings.settingsRevision, savedRevision);
      assert.equal(options?.retryMutationOnTransportError, false);
      applyBody = JSON.parse(String(options?.body));
      throw new Error('target unavailable');
    },
    requestKeepalive: () => {},
  };
  await assert.rejects(
    applySettingsSectionWithConfirmedSource(
      api,
      {
        sourceChatId: 'source',
        section: 'reports',
        sourceSettings,
        target: { mode: 'selectedChats', favoriteTypes: [], chatIds: ['target'] },
        confirmedTargetChatIds: ['target'],
      },
      (snapshot) => snapshots.push(snapshot),
    ),
    /target unavailable/u,
  );
  assert.equal(snapshots[0], null);
  assert.equal(snapshots.at(-1)?.sourceChatId, 'source');
  assert.equal(applyBody?.expectedSourceSettingsRevision, savedRevision);
  assert.deepEqual(applyBody?.confirmedTargetChatIds, ['target']);
});

test('failed stop-word recovery preserves the last confirmed source snapshot', async () => {
  const savedSource: SettingsApplySavedSource = {
    sourceChatId: 'source',
    section: 'stopWords',
    settings: chatSettingsSchema.parse({ settingsRevision: savedRevision }),
  };
  const api: ApiTransport = {
    request: async () => {
      throw new Error('transport unavailable');
    },
    requestKeepalive: () => {},
  };
  assert.equal(await refreshSavedStopWordsSource(api, savedSource), savedSource);
});

test('new link policy copy fences the acknowledged source and preserves it on target failure', async () => {
  const sourceSettings = chatSettingsSchema.parse({
    settingsRevision: draftRevision,
    linkRulesPolicy: {
      version: 1,
      mode: 'DENY_SELECTED',
      rules: [{ id: 'one', effect: 'DENY', kind: 'WEB_EXACT', target: 'https://example.com/one' }],
    },
  });
  const saved = { ...sourceSettings, settingsRevision: savedRevision };
  let snapshot: SettingsApplySavedSource | null = null;
  let applyBody: Record<string, unknown> | undefined;
  const api: ApiTransport = {
    async request(path, options) {
      if (path.endsWith('/settings/section')) {
        const body = JSON.parse(String(options?.body));
        assert.deepEqual(body.changes.linkRulesPolicy, sourceSettings.linkRulesPolicy);
        return saved;
      }
      assert.equal(path, '/chats/source/settings/apply-section-to-all');
      applyBody = JSON.parse(String(options?.body));
      throw new Error('target unavailable');
    },
    requestKeepalive() {},
  };
  await assert.rejects(
    applySettingsSectionWithConfirmedSource(
      api,
      {
        sourceChatId: 'source',
        section: 'links',
        sourceSettings,
        target: { mode: 'selectedChats', favoriteTypes: [], chatIds: ['target'] },
      },
      (value) => {
        snapshot = value;
      },
    ),
    /target unavailable/u,
  );
  assert.equal(applyBody?.expectedSourceSettingsRevision, savedRevision);
  assert.equal(Object.hasOwn(applyBody!, 'confirmedTargetChatIds'), false);
  assert.deepEqual(
    (snapshot as SettingsApplySavedSource | null)?.settings.linkRulesPolicy,
    sourceSettings.linkRulesPolicy,
  );
});

test('stop-word source copy uses acknowledged CAS and refreshes its receipt without promoting general revision', async () => {
  const policy = stopWordsPolicySchema.parse({ enabled: true, domains: ['source.example'] });
  const sourceSettings = chatSettingsSchema.parse({
    settingsRevision: draftRevision,
    stopWordsPolicy: policy,
    stopWordsRevision: 7,
  });
  const snapshots: Array<SettingsApplySavedSource | null> = [];
  const calls: string[] = [];
  const api: ApiTransport = {
    async request(path, init) {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.endsWith('/stop-words') && init?.method === 'PUT') {
        assert.deepEqual(JSON.parse(String(init.body)), { policy, expectedRevision: 7 });
        return {
          policy,
          revision: 8,
          settingsRevision: savedRevision,
          imageScanStatus: 'shadow',
          storageStatus: 'valid',
        };
      }
      if (path.endsWith('/settings/apply-section-to-all')) {
        assert.equal(snapshots.at(-1)?.settings.settingsRevision, draftRevision);
        assert.equal(JSON.parse(String(init?.body)).expectedSourceRevision, 8);
        return {
          section: 'stopWords',
          sourceChatId: 'source',
          targetMode: 'all',
          updatedChats: 2,
          appliedChatIds: ['source', 'target'],
        };
      }
      assert.equal(path, '/chats/source/stop-words');
      return {
        policy,
        revision: 9,
        settingsRevision: '2026-10-01T12:00:00.000Z',
        imageScanStatus: 'shadow',
        storageStatus: 'valid',
      };
    },
    requestKeepalive() {},
  };
  const result = await applySettingsSectionWithConfirmedSource(
    api,
    {
      sourceChatId: 'source',
      section: 'stopWords',
      sourceSettings,
      target: { mode: 'all', favoriteTypes: [], chatIds: [] },
    },
    (snapshot) => snapshots.push(snapshot),
  );
  assert.deepEqual(calls, [
    'PUT /chats/source/stop-words',
    'POST /chats/source/settings/apply-section-to-all',
    'GET /chats/source/stop-words',
  ]);
  assert.equal(result.sourceSettings.settingsRevision, draftRevision);
  assert.equal(result.sourceSettings.stopWordsRevision, 9);
  assert.equal(result.stopWordsReceipt?.settingsRevision, '2026-10-01T12:00:00.000Z');
});

test('invalid stop source copy requires exact explicit replacement before any mutation', async () => {
  const sourceSettings = chatSettingsSchema.parse({
    settingsRevision: draftRevision,
    stopWordsPolicy: stopWordsPolicySchema.parse({}),
    stopWordsRevision: 7,
  });
  for (const stopWordsReplacement of [
    undefined,
    { chatId: 'other', expectedRevision: 7 },
    { chatId: 'source', expectedRevision: 6 },
  ]) {
    let writes = 0;
    const api: ApiTransport = {
      request: async () => {
        writes++;
      },
      requestKeepalive() {},
    };
    await assert.rejects(
      applySettingsSectionWithConfirmedSource(
        api,
        {
          sourceChatId: 'source',
          section: 'stopWords',
          sourceSettings,
          target: { mode: 'all', favoriteTypes: [], chatIds: [] },
          stopWordsStorageStatus: 'invalid',
          stopWordsReplacement,
        },
        () => {},
      ),
      (error: unknown) =>
        error instanceof ApiRequestError && error.code === 'STOP_WORDS_POLICY_REVIEW_REQUIRED',
    );
    assert.equal(writes, 0);
  }
});

test('stop target copy failure retains the confirmed source and original general fence', async () => {
  const policy = stopWordsPolicySchema.parse({ enabled: true });
  const sourceSettings = chatSettingsSchema.parse({
    settingsRevision: draftRevision,
    stopWordsPolicy: policy,
    stopWordsRevision: 7,
  });
  let confirmed: SettingsApplySavedSource | null = null;
  const api: ApiTransport = {
    async request(path) {
      if (path.endsWith('/stop-words'))
        return {
          policy,
          revision: 8,
          settingsRevision: savedRevision,
          imageScanStatus: 'shadow',
          storageStatus: 'valid',
        };
      throw new Error('copy failed');
    },
    requestKeepalive() {},
  };
  await assert.rejects(
    applySettingsSectionWithConfirmedSource(
      api,
      {
        sourceChatId: 'source',
        section: 'stopWords',
        sourceSettings,
        target: { mode: 'all', favoriteTypes: [], chatIds: [] },
      },
      (snapshot) => {
        confirmed = snapshot;
      },
    ),
    /copy failed/u,
  );
  assert.equal(
    (confirmed as SettingsApplySavedSource | null)?.settings.settingsRevision,
    draftRevision,
  );
  assert.equal((confirmed as SettingsApplySavedSource | null)?.settings.stopWordsRevision, 8);
});

test('leaving the source scope after its receipt prevents starting target copy', async () => {
  const policy = stopWordsPolicySchema.parse({ enabled: true });
  const sourceSettings = chatSettingsSchema.parse({
    settingsRevision: draftRevision,
    stopWordsPolicy: policy,
    stopWordsRevision: 7,
  });
  const calls: string[] = [];
  let current = true;
  let confirmed: SettingsApplySavedSource | null = null;
  const api: ApiTransport = {
    async request(path) {
      calls.push(path);
      assert.equal(path, '/chats/source/stop-words');
      return {
        policy,
        revision: 8,
        settingsRevision: savedRevision,
        imageScanStatus: 'shadow',
        storageStatus: 'valid',
      };
    },
    requestKeepalive() {},
  };
  await assert.rejects(
    applySettingsSectionWithConfirmedSource(
      api,
      {
        sourceChatId: 'source',
        section: 'stopWords',
        sourceSettings,
        target: { mode: 'all', favoriteTypes: [], chatIds: [] },
        isCurrentScope: () => current,
      },
      (snapshot) => {
        confirmed = snapshot;
        if (snapshot) current = false;
      },
    ),
  );
  assert.deepEqual(calls, ['/chats/source/stop-words']);
  assert.equal((confirmed as SettingsApplySavedSource | null)?.settings.stopWordsRevision, 8);
});
