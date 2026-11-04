import assert from 'node:assert/strict';
import test from 'node:test';
import { marketplaceManagementRequestSchema } from '@maxim/contracts/karavan-marketplace-management';
import {
  isShopWriteOperation,
  shopCommandHash,
  shopJournalKey,
  reserveShopCommand,
} from '../src/pages/settings/karavan-shop/command-journal';
import { dispatchShopRequest, prepareShopRequest } from '../src/lib/api/karavan-shop-client';
const scope = {
  actorMaxUserId: '1',
  chatId: '-123',
  marketplaceId: '11111111-1111-4111-8111-111111111111',
  expectedBindingGeneration: 1,
};
const request = prepareShopRequest(
  { chatId: scope.chatId, marketplaceId: scope.marketplaceId, expectedBindingGeneration: 1 },
  {
    operation: 'image',
    input: {
      commandId: '22222222-2222-4222-8222-222222222222',
      fileName: 'cover.jpg',
      mimeType: 'image/jpeg',
      dataBase64: 'AQID',
    },
  },
);
test('the original shop command hash covers scope, command identity and final image bytes', async () => {
  const hash = await shopCommandHash(request);
  assert.equal(await shopCommandHash(structuredClone(request)), hash);
  assert.notEqual(await shopCommandHash({ ...request, chatId: '-456' }), hash);
  assert.notEqual(await shopCommandHash({ ...request, expectedBindingGeneration: 2 }), hash);
  assert.notEqual(
    await shopCommandHash(
      marketplaceManagementRequestSchema.parse({
        ...request,
        command: { ...request.command, input: { ...request.command.input, dataBase64: 'AQIE' } },
      }),
    ),
    hash,
  );
  for (const changed of [
    { ...scope, actorMaxUserId: '2' },
    { ...scope, chatId: '-456' },
    { ...scope, expectedBindingGeneration: 2 },
  ])
    assert.notEqual(shopJournalKey(changed), shopJournalKey(scope));
});
test('unavailable durable storage prevents a shop command from being reserved', async () => {
  assert.equal(globalThis.indexedDB, undefined);
  await assert.rejects(
    reserveShopCommand(scope, request, {
      owner: 'appearance-image',
      page: 'appearance',
      imageTarget: 'coverImageUrl',
    }),
    /сохранённое действие/u,
  );
});
test('reads are excluded from the product-write journal and mismatched responses remain unknown', async () => {
  for (const operation of [
    'appearance',
    'pins',
    'catalog',
    'invitations',
    'detail',
    'listings',
    'applications',
    'content',
    'rules_preview',
    'format_preview',
    'administration_stores',
    'seller_grant_target',
    'seller_grants',
  ] as const)
    assert.equal(isShopWriteOperation(operation), false);
  for (const operation of [
    'appearance_apply',
    'pins_save',
    'image',
    'invitation_create',
    'decide',
    'rules_update',
    'settings',
    'status',
    'format_update',
    'administration_store_change',
    'seller_grant_create',
    'seller_grant_revoke',
  ] as const)
    assert.equal(isShopWriteOperation(operation), true);
  let sent = '';
  await assert.rejects(
    dispatchShopRequest(
      {
        request: async (_path, init) => {
          sent = String(init?.body);
          return { operation: 'rules_cancel', data: { policyRevision: 2 } };
        },
        requestKeepalive() {},
      },
      request,
    ),
    /Ответ магазина изменился/u,
  );
  assert.deepEqual(JSON.parse(sent), request);
});
