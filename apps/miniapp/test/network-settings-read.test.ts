import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiTransport } from '../src/lib/api/transport';
import { readCompleteNetworkSettings } from '../src/features/network-settings/network-settings-controller';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import { settingsSectionPaths } from '../src/features/network-settings/field-registry';
import { networkSettingsPreviewRequestSchema } from '@maxim/contracts/network-settings';
const request = {
  entityType: 'chat',
  target: { mode: 'category', favoriteType: 'important' },
  section: 'links',
} as const;
test('leaving during a read aborts the remaining pages and never publishes a partial field fold', async () => {
  const controller = new AbortController();
  let requests = 0;
  const base = fake(() => {});
  const api: ApiTransport = {
    ...base,
    request: async (path, options) => {
      requests++;
      assert.equal(options?.signal, controller.signal);
      const response = await base.request(path, options);
      controller.abort();
      return response;
    },
  };
  await assert.rejects(readCompleteNetworkSettings(api, request, undefined, controller.signal), {
    name: 'AbortError',
  });
  assert.equal(requests, 1);
});
function fake(mutate: (value: Record<string, unknown>, index: number) => void) {
  let count = 0;
  const api: ApiTransport = {
    requestKeepalive() {},
    async request(_path, options) {
      const payload = JSON.parse(String(options?.body));
      const offset = Number(payload.cursor ?? 0);
      const ids = Array.from({ length: 8 }, (_, i) => 'chat-' + i);
      const value: Record<string, unknown> = {
        ...request,
        compositionVersion: 'v1',
        recipients: ids
          .slice(offset, offset + 4)
          .map((id) => ({ entityId: id, title: id, revision: 1 })),
        recipientCount: 8,
        complete: offset === 4,
        nextCursor: offset === 4 ? null : '4',
        fields: Object.fromEntries(
          settingsSectionPaths('chat', 'links').map((path) => [path, { kind: 'mixed' }]),
        ),
      };
      mutate(value, count++);
      return value;
    },
  };
  return api;
}
test('folds the complete category beyond home pages and the explicit selection ceiling', async () => {
  const preview = createPreviewApiTransport({ search: '?networks=1&networksScenario=large' });
  let pages = 0;
  const api: ApiTransport = {
    ...preview,
    request: async (...args) => {
      pages++;
      return preview.request(...args);
    },
  };
  const result = await readCompleteNetworkSettings(api, request);
  assert.ok(result.recipientCount > 500);
  assert.equal(result.recipients.length, result.recipientCount);
  assert.equal(pages, Math.ceil(result.recipientCount / 16));
  assert.equal(result.fields.linkPolicy.kind, 'mixed');
  assert.equal(result.complete, true);
  assert.equal(result.nextCursor, null);
});
test('mixed values on any later page stay mixed and no recipient is used as source', async () => {
  const result = await readCompleteNetworkSettings(
    fake((value, index) => {
      (value.fields as Record<string, unknown>).linkBotMessageText = {
        kind: 'common',
        value: index === 0 ? 'First' : 'Second',
      };
    }),
    request,
  );
  assert.deepEqual(result.fields.linkBotMessageText, { kind: 'mixed' });
  assert.equal(result.recipients.length, 8);
});
for (const [name, mutate] of Object.entries({
  'stale composition': (v: Record<string, unknown>, i: number) => {
    if (i) v.compositionVersion = 'v2';
  },
  'duplicate recipient': (v: Record<string, unknown>, i: number) => {
    if (i) (v.recipients as Array<{ entityId: string }>)[0].entityId = 'chat-0';
  },
  'cursor loop': (v: Record<string, unknown>, i: number) => {
    if (i) {
      v.complete = false;
      v.nextCursor = '4';
    }
  },
  'incomplete final page': (v: Record<string, unknown>, i: number) => {
    if (i) (v.recipients as unknown[]).pop();
  },
  'wrong scope': (v: Record<string, unknown>) => {
    v.target = { mode: 'selected', entityIds: ['someone'] };
  },
  'missing field': (v: Record<string, unknown>) => {
    delete (v.fields as Record<string, unknown>).linkPolicy;
  },
  'malformed common value': (v: Record<string, unknown>) => {
    (v.fields as Record<string, unknown>).linkPolicy = { kind: 'common', value: 'invented' };
  },
}))
  test('rejects ' + name + ' before an editable draft is published', async () => {
    await assert.rejects(readCompleteNetworkSettings(fake(mutate), request));
  });
test('list intent is explicit, chat-links-only, and needs a witness for every exact recipient', () => {
  const base = {
    ...request,
    operationId: crypto.randomUUID(),
    compositionVersion: 'v1',
    recipients: [{ entityId: 'chat-a', title: 'A', revision: 1 }],
    changes: [],
  };
  assert.equal(networkSettingsPreviewRequestSchema.safeParse(base).success, false);
  const intent = { mode: 'replace', entries: [] };
  assert.equal(
    networkSettingsPreviewRequestSchema.safeParse({ ...base, navigationAllowlist: intent }).success,
    false,
  );
  const recipient = {
    ...base.recipients[0],
    navigationAllowlistWitness: {
      revision: '0',
      observedAt: new Date().toISOString(),
      nextExpiryAt: null,
    },
  };
  assert.equal(
    networkSettingsPreviewRequestSchema.safeParse({
      ...base,
      recipients: [recipient],
      navigationAllowlist: intent,
    }).success,
    true,
  );
  assert.equal(
    networkSettingsPreviewRequestSchema.safeParse({
      ...base,
      section: 'greeting',
      recipients: [recipient],
      navigationAllowlist: intent,
    }).success,
    false,
  );
});
