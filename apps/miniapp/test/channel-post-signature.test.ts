import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseChannelPostSignatureUrl,
  resolveChannelPostSignaturePreviewUrl,
  normalizePostSignatureSettings,
  validatePostSignatureSettings,
  buildPostSignaturePatch,
  reconcilePostSignatureSave,
} from '../src/lib/channel-post-signature';

test('signature updates send only changed fields, preserving another administrator changes', () => {
  const saved = { enabled: true, presentation: 'signature' as const, text: 'Read', url: '' };
  assert.deepEqual(buildPostSignaturePatch({ ...saved, enabled: false }, saved), {
    expectedRevision: 0,
    enabled: false,
  });
  assert.deepEqual(buildPostSignaturePatch({ ...saved, presentation: 'button' }, saved), {
    expectedRevision: 0,
    presentation: 'button',
  });
});

test('a delayed save merges only newer local edits over the returned server state', () => {
  const submitted = { enabled: true, presentation: 'signature' as const, text: 'Read', url: '' };
  const latest = { ...submitted, url: 'https://example.com/new' };
  const saved = { ...submitted, text: 'Normalized', presentation: 'button' as const };
  const reconciled = reconcilePostSignatureSave(submitted, latest, saved);
  assert.deepEqual(reconciled, { ...saved, url: latest.url });
  assert.deepEqual(buildPostSignaturePatch(reconciled, saved), {
    expectedRevision: 0,
    url: latest.url,
  });
});

test('empty signature text stays invalid instead of silently restoring default copy', () => {
  const draft = { enabled: true, presentation: 'signature' as const, text: '  ', url: '' };
  assert.equal(normalizePostSignatureSettings(draft).text, '');
  assert.equal(validatePostSignatureSettings(draft).success, false);
});

test('an invalid saved custom domain stays visible but must be corrected before enabling', () => {
  const draft = {
    enabled: false,
    presentation: 'signature' as const,
    text: 'Read',
    url: '',
    customButtonsEnabled: true,
    customButtons: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        text: 'Second',
        url: 'https://example.com1/two',
      },
    ],
  };
  assert.equal(
    normalizePostSignatureSettings(draft).customButtons[0]?.url,
    draft.customButtons[0]?.url,
  );
  assert.equal(validatePostSignatureSettings(draft).success, false);
  assert.equal(
    validatePostSignatureSettings({ ...draft, customButtonsEnabled: false }).success,
    true,
  );
});

test('mode changes validate the complete label before saving without truncating it', () => {
  const draft = {
    enabled: true,
    presentation: 'signature' as const,
    text: 'x'.repeat(33),
    url: '',
  };
  assert.equal(validatePostSignatureSettings(draft).success, true);
  assert.equal(validatePostSignatureSettings({ ...draft, presentation: 'button' }).success, false);
  assert.equal(normalizePostSignatureSettings(draft).text.length, 33);
});

test('channel post signature preview rejects unsafe custom URLs without using the fallback', () => {
  const resolved = resolveChannelPostSignaturePreviewUrl(
    'javascript:alert(1)',
    'https://max.ru/our-channel',
  );

  assert.equal(resolved.url, '');
  assert.match(resolved.error ?? '', /корректную ссылку/u);
});

test('channel post signature preview uses a safe channel fallback for an empty custom URL', () => {
  assert.deepEqual(resolveChannelPostSignaturePreviewUrl('', 'https://max.ru/our-channel'), {
    error: null,
    url: 'https://max.ru/our-channel',
  });
});

test('channel post signature preview preserves a validated external custom URL', () => {
  assert.deepEqual(parseChannelPostSignatureUrl(' https://example.com/contact?source=max '), {
    error: null,
    url: 'https://example.com/contact?source=max',
  });
});
