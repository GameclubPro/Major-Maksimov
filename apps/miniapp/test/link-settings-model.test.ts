import test from 'node:test';
import assert from 'node:assert/strict';
import type { LinkRule } from '@maxim/contracts/settings';
import {
  displayLinkRuleTarget,
  inferLinkRuleKind,
  linkRuleContains,
  localExpiryParts,
  ruleExpiryLabel,
} from '../src/pages/settings/link-settings-model';

const rule = (kind: LinkRule['kind'], target: string): LinkRule => ({
  id: 'rule',
  kind,
  target,
  effect: 'DENY',
  enabled: true,
  expiresAt: null,
});

test('pasted full links retain exact scope and bare domains use a site rule', () => {
  assert.equal(inferLinkRuleKind('https://example.com/'), 'WEB_EXACT');
  assert.equal(inferLinkRuleKind('http://example.com'), 'WEB_EXACT');
  assert.equal(inferLinkRuleKind('https://example.com/help?utm_source=one#answer'), 'WEB_EXACT');
  assert.equal(inferLinkRuleKind('example.com'), 'WEB_DOMAIN');
  assert.equal(inferLinkRuleKind('user-id:123456789'), 'MAX_PROFILE');
});

test('exceptions belong to a proper site boundary and preserve exact URL scope', () => {
  const parent = rule('WEB_DOMAIN', 'example.com');
  assert.equal(linkRuleContains(parent, rule('WEB_EXACT', 'https://example.com/help')), true);
  assert.equal(linkRuleContains(parent, rule('WEB_DOMAIN', 'help.example.com')), true);
  assert.equal(linkRuleContains(parent, rule('WEB_DOMAIN', 'example.com')), false);
  assert.equal(linkRuleContains(parent, rule('WEB_EXACT', 'https://notexample.com/help')), false);
  assert.equal(
    linkRuleContains(parent, rule('WEB_EXACT', 'https://example.com.evil.test/help')),
    false,
  );
  assert.equal(
    linkRuleContains(
      rule('WEB_EXACT', 'https://example.com/help'),
      rule('WEB_EXACT', 'https://example.com/help/more'),
    ),
    false,
  );
  assert.equal(linkRuleContains(parent, rule('MAX_PROFILE', 'user-id:123')), false);
});

test('typed MAX addresses are displayed without changing their identity', () => {
  assert.equal(displayLinkRuleTarget(rule('MAX_PROFILE', 'user-id:123')), 'max://user/123');
  assert.equal(displayLinkRuleTarget(rule('MAX_PROFILE', 'username:test')), '@test');
  assert.equal(displayLinkRuleTarget(rule('MINI_APP', 'bot:help_bot')), '@help_bot');
  assert.equal(
    displayLinkRuleTarget(rule('MAX_ENTITY', 'url:https://max.ru/join/one')),
    'https://max.ru/join/one',
  );
});

test('expiry editor uses local time while preserving the exact saved instant', () => {
  const instant = '2030-02-14T12:35:00.000Z';
  const { day, time } = localExpiryParts(instant);
  assert.equal(new Date(`${day}T${time}:00`).toISOString(), instant);
  assert.deepEqual(localExpiryParts(null), { day: '', time: '23:59' });
  assert.equal(ruleExpiryLabel(null, 0), 'Без срока');
  assert.equal(
    ruleExpiryLabel('2030-01-01T00:00:00Z', Date.parse('2030-01-01T00:00:00Z')),
    'Срок истёк',
  );
  assert.match(ruleExpiryLabel('2030-01-01T00:00:00Z', 0), /^До /u);
});
