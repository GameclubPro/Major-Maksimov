import assert from 'node:assert/strict';
import test from 'node:test';
import type { KaravanConnectionBindingInput } from '@maxim/contracts/karavan-marketplace-connection';
import type { ApiTransport } from '../src/lib/api/transport';
import {
  getKaravanBindingOperation,
  getKaravanConnection,
  getKaravanMarketplace,
  importKaravanBinding,
  resumeKaravanBinding,
  startKaravanBinding,
} from '../src/lib/api/karavan-marketplace-client';

const input: KaravanConnectionBindingInput = {
  marketplaceId: '11111111-1111-4111-8111-111111111111',
  commandId: '22222222-2222-4222-8222-222222222222',
  expectedBindingGeneration: 1,
  action: 'recover_chat',
  expectedConnectionRevision: 7,
};
const operation = {
  operationId: input.commandId,
  state: 'unknown',
  request: input,
  result: null,
  errorCode: null,
};
function transport(result: unknown) {
  const calls: { path: string; init: Parameters<ApiTransport['request']>[1] }[] = [];
  const api: ApiTransport = {
    async request(path, init) {
      calls.push({ path, init });
      return result;
    },
    requestKeepalive() {},
  };
  return { api, calls };
}

test('a new binding sends its frozen command and observed connection revision once', async () => {
  const { api, calls } = transport(operation);
  const original = structuredClone(input);
  await startKaravanBinding(api, '-123', Object.freeze(original));
  assert.deepEqual(original, input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/chats/-123/karavan-marketplace/connection/binding');
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[0].init?.retryMutationOnTransportError, false);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), input);
});

test('snapshot and exact receipt checks use read requests without mutation or fallback', async () => {
  const snapshot = {
    version: 2,
    revision: 8,
    blocked: false,
    operation: { kind: 'binding', operation },
  };
  const read = transport(snapshot);
  assert.deepEqual(await getKaravanConnection(read.api, '-123'), snapshot);
  assert.equal(read.calls[0].init?.method, undefined);
  const status = transport(operation);
  assert.deepEqual(
    await getKaravanBindingOperation(status.api, '-123', input.commandId),
    operation,
  );
  assert.equal(status.calls[0].init, undefined);
  assert.equal(status.calls[0].path.endsWith(`/connection/operations/${input.commandId}`), true);
});

test('legacy adoption and explicit continuation are separate commands and preserve old input semantics', async () => {
  const legacy = { ...input };
  delete legacy.expectedConnectionRevision;
  const adoption = transport({ ...operation, request: legacy });
  await importKaravanBinding(adoption.api, '-123', legacy);
  assert.equal(adoption.calls[0].path.endsWith('/connection/import-binding'), true);
  assert.deepEqual(JSON.parse(String(adoption.calls[0].init?.body)), legacy);
  const resume = transport(operation);
  await resumeKaravanBinding(resume.api, '-123', input.commandId);
  assert.equal(
    resume.calls[0].path.endsWith(`/connection/operations/${input.commandId}/resume`),
    true,
  );
  assert.equal(resume.calls[0].init?.method, 'POST');
  assert.equal(resume.calls[0].init?.retryMutationOnTransportError, false);
  assert.equal(resume.calls[0].init?.body, undefined);
});

test('a mismatched command identity or changed original request cannot become a recovery result', async () => {
  const wrongId = transport({ ...operation, operationId: '33333333-3333-4333-8333-333333333333' });
  await assert.rejects(startKaravanBinding(wrongId.api, '-123', input), /подключение изменилось/u);
  const changed = transport({ ...operation, request: { ...input, expectedBindingGeneration: 2 } });
  await assert.rejects(importKaravanBinding(changed.api, '-123', input), /подключение изменилось/u);
  const wrongRequestId = transport({
    ...operation,
    request: { ...input, commandId: crypto.randomUUID() },
  });
  await assert.rejects(
    getKaravanBindingOperation(wrongRequestId.api, '-123', input.commandId),
    /подключение изменилось/u,
  );
});

test('an older server response stays readable while the connection capability remains explicitly absent', async () => {
  const module = {
    enabled: true,
    actorMaxUserId: '1001',
    sellerBotUrl: 'https://max.ru/synthetic_seller_bot',
    marketplace: null,
    binding: null,
    setupOperation: null,
    permissions: [],
    counts: { listings: 0, pendingApplications: 0, chats: 0 },
    canManage: false,
  };
  const { api, calls } = transport(module);
  const result = await getKaravanMarketplace(api, '-123');
  assert.equal(result.enabled, true);
  if (result.enabled) assert.equal(result.connection, undefined);
  assert.equal(calls.length, 1);
});
