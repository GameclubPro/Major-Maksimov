import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiRequestError } from '../src/lib/api-request-error';
import { shopMutationFailureKind } from '../src/pages/settings/karavan-shop/command-failure';
import {
  sameShopRules,
  orderedShopCategories,
  shopRulesRequireAcceptance,
  shopRulesNeedConfirmation,
  type ShopRules,
} from '../src/pages/settings/karavan-shop/category-changes';

const rules: ShopRules = {
  text: 'Правила магазина',
  allowedCategoryIds: ['services', 'real_estate'],
  allowedSubcategoryIds: ['services.repair', 'services.cleaning'],
  categoryOrder: ['services', 'real_estate'],
};
const failure = (status: number, code?: string) =>
  new ApiRequestError(status, JSON.stringify({ code }), 'Ошибка');

test('mutation outcomes distinguish editable validation, stale data, lost authority and uncertain effects', () => {
  assert.equal(
    shopMutationFailureKind(failure(422, 'MARKETPLACE_CATEGORIES_INVALID')),
    'validation',
  );
  assert.equal(shopMutationFailureKind(failure(400)), 'validation');
  assert.equal(shopMutationFailureKind(failure(409, 'MARKETPLACE_REVISION_CONFLICT')), 'refresh');
  assert.equal(shopMutationFailureKind(failure(400, 'MARKETPLACE_RULES_DATE_INVALID')), 'refresh');
  assert.equal(shopMutationFailureKind(failure(403, 'MARKETPLACE_FORBIDDEN')), 'forbidden');
  assert.equal(shopMutationFailureKind(failure(409, 'MARKETPLACE_BINDING_CHANGED')), 'forbidden');
  assert.equal(shopMutationFailureKind(failure(503, 'KARAVAN_COMMAND_REJECTED')), 'refresh');
  assert.equal(shopMutationFailureKind(failure(503, 'KARAVAN_COMMAND_UNKNOWN')), 'unknown');
  assert.equal(shopMutationFailureKind(failure(503, 'MARKETPLACE_REVISION_CONFLICT')), 'unknown');
  assert.equal(shopMutationFailureKind(failure(408)), 'unknown');
  assert.equal(shopMutationFailureKind(new Error('Network unavailable')), 'unknown');
});

test('semantic rules equality ignores selection insertion order and schema-trimmed text but retains visible ordering', () => {
  assert.equal(
    sameShopRules(rules, {
      ...rules,
      text: ` ${rules.text} `,
      allowedCategoryIds: [...rules.allowedCategoryIds].reverse(),
      allowedSubcategoryIds: [...rules.allowedSubcategoryIds].reverse(),
    }),
    true,
  );
  assert.equal(
    sameShopRules(rules, { ...rules, categoryOrder: [...rules.categoryOrder].reverse() }),
    false,
  );
  assert.equal(
    sameShopRules(rules, { ...rules, allowedSubcategoryIds: ['services.repair'] }),
    false,
  );
});

test('category order retains explicit ranks and exposes unranked categories in the public feed order', () => {
  const unordered = { ...rules, categoryOrder: [] };
  assert.deepEqual(orderedShopCategories(unordered), ['real_estate', 'services']);
  assert.equal(
    sameShopRules(unordered, { ...unordered, categoryOrder: ['real_estate', 'services'] }),
    true,
  );
  assert.equal(sameShopRules(unordered, rules), false);
  assert.deepEqual(
    orderedShopCategories({
      ...rules,
      allowedCategoryIds: ['services', 'grocery', 'real_estate'],
      categoryOrder: ['services'],
    }),
    ['services', 'grocery', 'real_estate'],
  );
});

test('only changed policy text or narrower admission requires fresh seller acceptance', () => {
  assert.equal(
    shopRulesRequireAcceptance(rules, {
      ...rules,
      categoryOrder: [...rules.categoryOrder].reverse(),
    }),
    false,
  );
  assert.equal(
    shopRulesRequireAcceptance(rules, {
      ...rules,
      allowedSubcategoryIds: [...rules.allowedSubcategoryIds, 'services.delivery'],
    }),
    false,
  );
  assert.equal(
    shopRulesRequireAcceptance(rules, { ...rules, allowedSubcategoryIds: ['services.repair'] }),
    true,
  );
  assert.equal(shopRulesRequireAcceptance(rules, { ...rules, text: 'Новые правила' }), true);
});

test('safe category changes apply directly; hidden offers and the seller notice period retain explicit confirmation', () => {
  const none = { hiddenOffers: 0, affectedStores: 0, emptiedStores: 0 };
  assert.equal(shopRulesNeedConfirmation(none, false), false);
  assert.equal(shopRulesNeedConfirmation(none, true), true);
  assert.equal(shopRulesNeedConfirmation({ ...none, hiddenOffers: 1 }, false), true);
  assert.equal(shopRulesNeedConfirmation({ ...none, emptiedStores: 1 }, false), true);
});
