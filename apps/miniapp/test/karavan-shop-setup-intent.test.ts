import assert from 'node:assert/strict';
import test from 'node:test';
import {
  legacyShopSetupDraftKey,
  restoreShopSetupDraft,
  shopSetupChangeRequiresAcceptance,
  shopSetupDraftKey,
  type ShopSetupDraft,
} from '../src/pages/settings/karavan-shop/setup-intent';

const marketplaceId = '094897a3-9244-4f61-a8e6-c4e44fc23b20';
const otherMarketplaceId = '12e81525-eacf-45a2-a099-7fb8629bfb78';
const draft: ShopSetupDraft = {
  mode: 'new',
  existingId: null,
  name: 'Соседи',
  rules: 'Правила магазина',
  categories: ['services'],
  subcategories: ['services.repair'],
  initialized: true,
  admissionPolicy: 'applications',
  chatIds: ['-123'],
};

test('setup drafts are scoped to actor, chat, intention and fixed marketplace', () => {
  const keys = [
    shopSetupDraftKey('1', '-123', { kind: 'create' }),
    shopSetupDraftKey('2', '-123', { kind: 'create' }),
    shopSetupDraftKey('1', '-456', { kind: 'create' }),
    shopSetupDraftKey('1', '-123', { kind: 'connect_existing' }),
    shopSetupDraftKey('1', '-123', { kind: 'replace', previousMarketplaceId: marketplaceId }),
    shopSetupDraftKey('1', '-123', { kind: 'add_chats', marketplaceId }),
    shopSetupDraftKey('1', '-123', { kind: 'add_chats', marketplaceId: otherMarketplaceId }),
  ];
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(
    legacyShopSetupDraftKey('1', '-123', { kind: 'create' }),
    'karavan-setup-draft:v1:1:-123',
  );
});

test('restoring a legacy draft cannot widen ordinary creation to multiple chats', () => {
  assert.deepEqual(restoreShopSetupDraft(JSON.stringify(draft), '-123', { kind: 'create' }), draft);
  assert.equal(
    restoreShopSetupDraft(JSON.stringify({ ...draft, chatIds: ['-123', '-456'] }), '-123', {
      kind: 'create',
    }),
    null,
  );
  assert.equal(restoreShopSetupDraft(JSON.stringify(draft), '-456', { kind: 'create' }), null);
  assert.equal(
    restoreShopSetupDraft(JSON.stringify(draft), '-123', { kind: 'connect_existing' }),
    null,
  );
});

test('format selection and the exact administrative storefront survive draft recovery', () => {
  const storefront = { ...draft, format: 'storefront', administrationStoreId: marketplaceId };
  assert.deepEqual(
    restoreShopSetupDraft(JSON.stringify(storefront), '-123', { kind: 'create' }),
    storefront,
  );
  const unchosen = { ...draft, format: null, administrationStoreId: null };
  assert.deepEqual(
    restoreShopSetupDraft(JSON.stringify(unchosen), '-123', { kind: 'create' }),
    unchosen,
  );
  assert.equal(
    restoreShopSetupDraft(JSON.stringify({ ...storefront, format: 'personal' }), '-123', {
      kind: 'create',
    }),
    null,
  );
  assert.equal(
    restoreShopSetupDraft(
      JSON.stringify({ ...storefront, administrationStoreId: 'arbitrary-link' }),
      '-123',
      { kind: 'create' },
    ),
    null,
  );
  assert.equal(
    Object.hasOwn(
      restoreShopSetupDraft(JSON.stringify(draft), '-123', { kind: 'create' })!,
      'format',
    ),
    false,
  );
});

test('adding chats restores only the fixed existing marketplace, never creation or replacement', () => {
  const existing = {
    ...draft,
    mode: 'existing',
    existingId: marketplaceId,
    chatIds: ['-123', '-456'],
  };
  const intent = { kind: 'add_chats' as const, marketplaceId };
  assert.deepEqual(restoreShopSetupDraft(JSON.stringify(existing), '-123', intent), existing);
  assert.equal(restoreShopSetupDraft(JSON.stringify(draft), '-123', intent), null);
  assert.equal(
    restoreShopSetupDraft(
      JSON.stringify({ ...existing, existingId: otherMarketplaceId }),
      '-123',
      intent,
    ),
    null,
  );
  assert.equal(
    restoreShopSetupDraft(
      JSON.stringify({ ...existing, chatIds: ['-123', '-123'] }),
      '-123',
      intent,
    ),
    null,
  );
});

test('connect and replace drafts stay on the entry chat and cannot restore the previous shop as the new target', () => {
  const existing = { ...draft, mode: 'existing', existingId: marketplaceId };
  assert.deepEqual(
    restoreShopSetupDraft(JSON.stringify(existing), '-123', { kind: 'connect_existing' }),
    existing,
  );
  assert.equal(
    restoreShopSetupDraft(JSON.stringify(existing), '-123', {
      kind: 'replace',
      previousMarketplaceId: marketplaceId,
    }),
    null,
  );
  assert.equal(
    restoreShopSetupDraft(JSON.stringify({ ...existing, chatIds: ['-123', '-456'] }), '-123', {
      kind: 'connect_existing',
    }),
    null,
  );
  assert.equal(restoreShopSetupDraft('{broken', '-123', { kind: 'create' }), null);
});

test('renaming preserves acceptance while changes to rules or connections require review again', () => {
  assert.equal(shopSetupChangeRequiresAcceptance({ name: 'Новое название' }), false);
  for (const patch of [
    { rules: 'Новые правила' },
    { categories: ['products'] },
    { admissionPolicy: 'invitation' as const },
    { existingId: marketplaceId },
    { chatIds: ['-123', '-456'] },
    { format: 'storefront' as const },
    { administrationStoreId: marketplaceId },
  ])
    assert.equal(shopSetupChangeRequiresAcceptance(patch), true);
});
