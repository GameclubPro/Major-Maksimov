import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isMaxApiNoticeActive,
  MAX_API_NOTICE,
  maxApiNoticeAcknowledgementKey,
} from '../src/lib/max-api-notice';

test('MAX API notice has one absolute six-hour window and never restarts per launch', () => {
  assert.equal(MAX_API_NOTICE.expiresAt - MAX_API_NOTICE.startsAt, 6 * 60 * 60 * 1000);
  assert.equal(isMaxApiNoticeActive(MAX_API_NOTICE.startsAt - 1), false);
  assert.equal(isMaxApiNoticeActive(MAX_API_NOTICE.startsAt), true);
  assert.equal(isMaxApiNoticeActive(MAX_API_NOTICE.expiresAt - 1), true);
  assert.equal(isMaxApiNoticeActive(MAX_API_NOTICE.expiresAt), false);
  assert.equal(isMaxApiNoticeActive(MAX_API_NOTICE.expiresAt + 24 * 60 * 60 * 1000), false);
});

test('notice acknowledgement is isolated by user and incident, shared across bot profiles', () => {
  assert.notEqual(maxApiNoticeAcknowledgementKey('alice'), maxApiNoticeAcknowledgementKey('bob'));
  assert.ok(maxApiNoticeAcknowledgementKey('alice').includes(MAX_API_NOTICE.id));
});
