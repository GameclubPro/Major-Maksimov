import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiRequestError } from '../src/lib/api-request-error';
import {
  isDefiniteFirstShopRejection,
  shopMutationFailureKind,
} from '../src/pages/settings/karavan-shop/command-failure';

const failure = (status: number, code: string) =>
  new ApiRequestError(status, JSON.stringify({ code }), 'Ошибка');

for (const [code, status] of [
  ['MARKETPLACE_FORMAT_LIMIT', 409],
  ['ADMINISTRATION_STORE_OWNER_REQUIRED', 403],
  ['ADMINISTRATION_STORE_REQUIRED', 409],
  ['ADMINISTRATION_STORE_NOT_READY', 409],
  ['PLACEMENT_REVIEW_REQUIRED', 409],
  ['SELLER_STOREFRONT_LIMIT', 409],
  ['MARKETPLACE_NETWORK_LIMIT', 409],
  ['MARKETPLACE_LIMIT', 409],
  ['MARKETPLACE_CHAT_REQUIRED', 409],
  ['MARKETPLACE_EMPTY_CONFIRMATION', 409],
  ['MARKETPLACE_RULES_ACCEPTANCE_REQUIRED', 400],
  ['MARKETPLACE_REORDER_INVALID', 400],
] as const) {
  test(`${code} permits correcting the first rejected action while preserving earlier uncertainty`, () => {
    const error = failure(status, code);
    assert.equal(shopMutationFailureKind(error), 'validation');
    assert.equal(isDefiniteFirstShopRejection(error, 1), true);
    assert.equal(isDefiniteFirstShopRejection(error, 2), false);
    assert.equal(shopMutationFailureKind(failure(503, code)), 'unknown');
    assert.equal(isDefiniteFirstShopRejection(failure(503, code), 1), false);
  });
}

for (const [code, status] of [
  ['MARKETPLACE_FORMAT_CHANGED', 409],
  ['MARKETPLACE_ARCHIVED', 409],
  ['MARKETPLACE_APPLICATION_STALE', 409],
  ['MARKETPLACE_APPLICATION_ALREADY_DECIDED', 409],
  ['MARKETPLACE_APPLICATION_NOT_FOUND', 404],
  ['PLACEMENT_NOT_FOUND', 404],
  ['MARKETPLACE_RULES_UNAVAILABLE', 409],
  ['MARKETPLACE_ORDER_CHANGED', 409],
  ['MARKETPLACE_STATUS_INVALID', 409],
] as const) {
  test(`${code} requires fresh state without retaining an unattempted first action`, () => {
    const error = failure(status, code);
    assert.equal(shopMutationFailureKind(error), 'refresh');
    assert.equal(isDefiniteFirstShopRejection(error, 1), true);
    assert.equal(isDefiniteFirstShopRejection(error, 2), false);
  });
}

test('independent review requires a different administrator and releases only the first rejected action', () => {
  const error = failure(403, 'MARKETPLACE_INDEPENDENT_REVIEW_REQUIRED');
  assert.equal(shopMutationFailureKind(error), 'forbidden');
  assert.equal(isDefiniteFirstShopRejection(error, 1), true);
  assert.equal(isDefiniteFirstShopRejection(error, 2), false);
});

test('unknown outcomes, arbitrary provider codes and lost authority keep their original boundaries', () => {
  assert.equal(shopMutationFailureKind(failure(503, 'KARAVAN_COMMAND_UNKNOWN')), 'unknown');
  assert.equal(isDefiniteFirstShopRejection(failure(503, 'KARAVAN_COMMAND_UNKNOWN'), 1), false);
  assert.equal(isDefiniteFirstShopRejection(failure(409, 'UNRECOGNIZED_PROVIDER_ERROR'), 1), false);
  assert.equal(shopMutationFailureKind(failure(403, 'MARKETPLACE_FORBIDDEN')), 'forbidden');
  assert.equal(shopMutationFailureKind(failure(409, 'MARKETPLACE_BINDING_CHANGED')), 'forbidden');
  assert.equal(shopMutationFailureKind(failure(409, 'MARKETPLACE_REVISION_CONFLICT')), 'refresh');
});
