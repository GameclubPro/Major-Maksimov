import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertSourceAbandonmentSource,
  SOURCE_ABANDONMENT_SOURCE_CHECKS,
  SOURCE_ABANDONMENT_FORWARD_PROFILES,
} from '../../infra/scripts/assert-source-abandonment-source.mjs';
import { assertLegacyDispositionSource } from '../../infra/scripts/assert-legacy-disposition-source.mjs';
const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
test('source abandonment keeps exact-source proof and final hold readers on rollback', () => {
  assert.doesNotThrow(() => assertSourceAbandonmentSource('a'.repeat(40), read));
});
for (const [path, markers] of SOURCE_ABANDONMENT_SOURCE_CHECKS) {
  for (const marker of markers)
    test(`source rollback refuses ${path}: ${marker}`, () => {
      const source = read(path);
      const changed = source.replaceAll(marker, 'removed_guard');
      assert.notEqual(changed, source, 'mutation must change the actual reviewed source');
      assert.throws(
        () =>
          assertSourceAbandonmentSource('a'.repeat(40), (sourcePath) =>
            sourcePath === path ? changed : read(sourcePath),
          ),
        /lacks permanent/,
      );
    });
}
const forwardPath = 'apps/api/src/webhook/webhook-legacy-forward-source.ts';
const profiles = SOURCE_ABANDONMENT_FORWARD_PROFILES;

function replaceReviewed(source, original, replacement) {
  assert.ok(source.includes(original), 'fixture must contain the reviewed fragment');
  const changed = source.replace(original, replacement);
  assert.notEqual(changed, source, 'mutation must change the actual reviewed source');
  return changed;
}

// FLAG: Historical source excerpts are independent of the validator's accepted markers.
// Reviewed parent of 36a2962ea41dbd4794f1f422fa5f28410582b26d; no Git history
// access is needed when this fixture runs in a shallow CI checkout.
const HISTORICAL_FORWARD_OUTER = `export function isLegacyPostSealOuterMarkup(
  body: Record<string, unknown>,
  linkValue: unknown,
): boolean {
  if (isLegacyPassiveMarkup(body.markup, body.text)) return true;
  const link = record(linkValue);
  const linked = record(link?.message);
  return Boolean(
    body.text === '' &&
    link?.type === 'forward' &&
    linked &&
    Array.isArray(body.markup) &&
    body.markup.length <= 64 &&
    isLegacyPassiveMarkup(linked.markup, linked.text) &&
    JSON.stringify(body.markup) === JSON.stringify(linked.markup),
  );
}`;
const HISTORICAL_FORWARD_INSPECT = `function inspectForwardText(
  update: Record<string, unknown>,
  settings: AdminForwardedCommandSettings | undefined,
  profile: 'legacy' | 'legacy-post-seal' | 'source-abandonment',
): LegacyForwardRefusal | null {
  const raw = record(update.raw);
  const message = record(raw?.message);
  const normalized = record(update.message);
  const modern = profile === 'source-abandonment';
  let directRefusal: ForwardBodyRefusal = 'object';
  let linkedRefusal: ForwardBodyRefusal = 'object';
  const direct = body(
    message?.body,
    false,
    modern
      ? (item) => isSourceAbandonmentOuterMarkup(item, message?.link)
      : profile === 'legacy-post-seal'
        ? (item) => isLegacyPostSealOuterMarkup(item, message?.link)
        : undefined,
    undefined,
    (reason) => {
      directRefusal = reason;
    },
  );
  const link = record(message?.link);
  const linked = body(
    link?.message,
    true,
    modern
      ? (item) => isSourceAbandonmentMarkup(item.markup, item.text)
      : profile === 'legacy-post-seal'
        ? (item) => isLegacyPassiveMarkup(item.markup, item.text)
        : undefined,
    modern
      ? (attachments) =>
          isSourceAbandonmentLinkedMedia(attachments, 'forward', 'SOURCE_ABANDONMENT')
      : undefined,
    (reason) => {
      linkedRefusal = reason;
    },
  );
  const sender = record(link?.sender);
  const omittedSender = profile === 'source-abandonment' && link?.sender === undefined;
  // FLAG: Refine only the deciding refusal, never the admitted source shapes.
  // Legacy keeps its coarse contract; modern diagnostics expose fixed codes only,
  // in the original guard order, without raw keys, values, identities or text.
  const shape = (reason: SourceAbandonmentForwardShapeRefusal): LegacyForwardRefusal =>
    modern ? reason : 'source_forward_shape';
  if (!raw || !message || !normalized) return shape('source_forward_objects');
  if (!direct) return shape(\`source_forward_direct_\${directRefusal}\`);
  if (!link) return shape('source_forward_link_object');
  if (!linked) {
    const linkedShape = (reason: ForwardBodyRefusal): SourceAbandonmentForwardShapeRefusal =>
      modern && reason === 'media'
        ? \`source_forward_linked_media_\${inspectSourceAbandonmentLinkedMediaRefusal(
            record(link.message)?.attachments,
          )}\`
        : \`source_forward_linked_\${reason}\`;
    return shape(linkedShape(linkedRefusal));
  }
  if (!sender && !omittedSender)
    return shape(
      link.sender === null ? 'source_forward_sender_null' : 'source_forward_sender_shape',
    );
  if (!onlyKeys(message, ['sender', 'recipient', 'timestamp', 'body', 'link']))
    return shape('source_forward_message_keys');
  if (!onlyKeys(link, ['type', 'sender', 'chat_id', 'message']))
    return shape('source_forward_link_keys');
  if (link.type !== 'forward') return shape('source_forward_link_type');
  if (!identity(link.chat_id))
    return shape(
      link.chat_id === undefined
        ? 'source_forward_chat_absent'
        : link.chat_id === null
          ? 'source_forward_chat_null'
          : 'source_forward_chat_identity',
    );
  if (sender) {
    if (!identity(sender.user_id)) return shape('source_forward_sender_identity');
    if (
      !onlyKeys(sender, [
        'user_id',
        'name',
        'first_name',
        'last_name',
        'username',
        'is_bot',
        'avatar_url',
        'last_activity_time',
      ])
    )
      return shape('source_forward_sender_keys');
    if (typeof sender.is_bot !== 'boolean') return shape('source_forward_sender_bot');
    if (
      ['name', 'first_name', 'last_name', 'username', 'avatar_url'].some(
        (key) =>
          sender[key] !== undefined && sender[key] !== null && typeof sender[key] !== 'string',
      )
    )
      return shape('source_forward_sender_metadata');
    if (
      sender.last_activity_time !== undefined &&
      sender.last_activity_time !== null &&
      (typeof sender.last_activity_time !== 'number' ||
        !Number.isSafeInteger(sender.last_activity_time))
    )
      return shape('source_forward_sender_activity');
  }
  if (typeof normalized.text !== 'string') return shape('source_forward_normalized_text');
  if (typeof update.botId !== 'string') return shape('source_forward_bot_type');

  if (
    Array.isArray(linked.attachments) &&
    linked.attachments.length > 0 &&
    linked.attachments.every(isLegacyImageAttachment)
  ) {
    const photos = extractVisiblePhotoMessageContent(message);
    if (photos.kind !== 'complete' || photos.content.images.length !== linked.attachments.length)
      return 'source_forward_media';
  }

  // FLAG: Reuse the actual parser, including whitespace collapse, case-insensitive
  // snippet deduplication and forward composition. Never equate arbitrary texts
  // by trimming or trust the submitted normalized text independently of raw MAX.
  if (!legacyParsedTextMatches(update)) return 'source_forward_text';

  // FLAG: A forward can name another moderation target or Karavan seller. Deny
  // commands in EVERY component as well as the composed text, before any claim,
  // lookup, audit or SEND; current settings alone cannot prove an old trigger absent.
  for (const text of [direct.text, linked.text, normalized.text] as string[]) {
    try {
      if (
        /^[/$]/u.test(text.trim()) ||
        /^старт$/iu.test(text.trim()) ||
        parseAdminForwardedModerationCommand(text) ||
        (settings && parseAdminForwardedModerationCommand(text, settings))
      )
        return 'source_forward_command';
    } catch {
      return 'source_forward_command';
    }
  }
  return null;
}`;
const HISTORICAL_SOURCE_MARKUP = `profile === 'source-abandonment'
      ? !isSourceAbandonmentOuterMarkup(body, message.link)
      : postSealForward && message.link !== undefined
        ? !isLegacyPostSealOuterMarkup(body, message.link)
        : !isLegacyPassiveMarkup(body.markup, sourceText)
  )
    return refuse('source_markup');`;
const HISTORICAL_RECEIPT_BRANCH = `    if (
      event.errorMessage ===
        'Webhook preparation deferred: Legacy scope installation is not sealed' ||
      body?.text === undefined ||
      body?.text === null ||
      (link?.type === 'forward' && (body?.markup !== undefined || linkedBody?.markup !== undefined))
    ) {
      const heldMessage = await inspectHeldMessageDisposition(tx, event);
      if (!heldMessage || heldMessage === 'NOT_HELD')
        return refuse('receipt_post_seal_source_unproved');
      return writeLegacyReceiptDisposition(
        tx,
        event,
        heldMessage.authorityId,
        [],
        'POST_SEAL_MEMBER',
      );
    }`;

function replaceFunctionDefinition(source, name, replacement) {
  let start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, 'reviewed function must exist');
  if (source.slice(start - 7, start) === 'export ') start -= 7;
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'reviewed function must have a complete body');
  return replaceReviewed(source, source.slice(start, end + 2), replacement);
}

function historicalSources() {
  let forward = read(forwardPath);
  forward = replaceFunctionDefinition(forward, 'inspectForwardText', HISTORICAL_FORWARD_INSPECT);
  forward = replaceFunctionDefinition(
    forward,
    'isLegacyPostSealOuterMarkup',
    HISTORICAL_FORWARD_OUTER,
  );
  forward = replaceFunctionDefinition(forward, 'isLegacyPostSealMarkup', '');
  forward = replaceFunctionDefinition(forward, 'isLegacyPostSealLinkedMedia', '');
  const sourcePath = 'apps/api/src/webhook/webhook-legacy-source.ts';
  let source = read(sourcePath);
  const markupStart = source.indexOf(
    "profile === 'source-abandonment'\n      ? !isSourceAbandonmentOuterMarkup",
  );
  const markupEnd =
    source.indexOf("return refuse('source_markup');", markupStart) +
    "return refuse('source_markup');".length;
  assert.ok(markupStart >= 0 && markupEnd > markupStart);
  source = replaceReviewed(source, source.slice(markupStart, markupEnd), HISTORICAL_SOURCE_MARKUP);
  const receiptPath = 'apps/api/src/webhook/webhook-legacy-receipt-disposition.ts';
  let receipt = read(receiptPath);
  const branchStart = receipt.indexOf(
    "    if (\n      event.errorMessage ===\n        'Webhook preparation deferred: Legacy scope installation is not sealed'",
  );
  const branchEnd = receipt.indexOf('\n    }', branchStart) + '\n    }'.length;
  assert.ok(branchStart >= 0 && branchEnd > branchStart);
  receipt = replaceReviewed(
    receipt,
    receipt.slice(branchStart, branchEnd),
    HISTORICAL_RECEIPT_BRANCH,
  );
  receipt = replaceReviewed(
    receipt,
    '    const linkedAttachments = linkedBody?.attachments;\n',
    '',
  );
  return new Map([
    [forwardPath, forward],
    [sourcePath, source],
    [receiptPath, receipt],
  ]);
}

function forwardFixture(name) {
  return name === 'passive' ? historicalSources().get(forwardPath) : read(forwardPath);
}

function fixtureReader(name, changed = forwardFixture(name)) {
  const sources = name === 'passive' ? historicalSources() : new Map();
  sources.set(forwardPath, changed);
  return (path) => sources.get(path) ?? read(path);
}

function refusesForwardMutation(name, change, retained = []) {
  const source = forwardFixture(name);
  const changed = change(source);
  assert.notEqual(changed, source, 'mutation must change the actual reviewed source');
  for (const callback of retained)
    assert.ok(changed.includes(callback), 'the independent branch must remain intact');
  assert.throws(
    () => assertSourceAbandonmentSource('a'.repeat(40), fixtureReader(name, changed)),
    /lacks permanent.*webhook-legacy-forward-source\.ts/u,
  );
}

const modernCalls = {
  outer: 'isSourceAbandonmentOuterMarkup(item, message?.link)',
  linked: 'isSourceAbandonmentMarkup(item.markup, item.text)',
  media: "isSourceAbandonmentLinkedMedia(attachments, 'forward', 'SOURCE_ABANDONMENT')",
};
const legacyCalls = {
  passive: {
    outer: 'isLegacyPostSealOuterMarkup(item, message?.link)',
    linked: 'isLegacyPassiveMarkup(item.markup, item.text)',
  },
  created: {
    outer: `isLegacyPostSealOuterMarkup(
              item,
              message?.link,
              createdLegacyForward ? update.type : undefined,
            )`,
    linked: 'isLegacyPostSealMarkup(item.markup, item.text, createdLegacyForward)',
    media: 'isLegacyPostSealLinkedMedia',
  },
};

for (const [name, profile] of Object.entries(profiles)) {
  test(`complete ${name} forward reader remains compatible with both rollback floors`, () => {
    const source = forwardFixture(name);
    if (name === 'passive') {
      assert.ok(source.includes('isLegacyPassiveMarkup(item.markup, item.text)'));
      assert.ok(source.includes('isLegacyPostSealOuterMarkup(item, message?.link)'));
      assert.ok(!source.includes('const createdLegacyForward ='));
    }
    assert.doesNotThrow(() => assertSourceAbandonmentSource('a'.repeat(40), fixtureReader(name)));
    assert.doesNotThrow(() => assertLegacyDispositionSource('a'.repeat(40), fixtureReader(name)));
  });

  test(`${name} forward reader keeps the exact modern profile selector`, () => {
    refusesForwardMutation(
      name,
      (source) =>
        replaceReviewed(
          source,
          "const modern = profile === 'source-abandonment';",
          "const modern = profile !== 'legacy';",
        ),
      Object.values(profile.bindings),
    );
  });

  for (const [kind, binding] of Object.entries(profile.bindings)) {
    const mutateBinding = (source, change) => replaceReviewed(source, binding, change(binding));
    test(`${name} ${kind} reader refuses a disabled modern condition`, () => {
      refusesForwardMutation(
        name,
        (source) => mutateBinding(source, (value) => replaceReviewed(value, 'modern\n', 'false\n')),
        [legacyCalls[name][kind] ?? modernCalls[kind]],
      );
    });
    test(`${name} ${kind} reader refuses a replaced modern validator`, () => {
      refusesForwardMutation(
        name,
        (source) =>
          mutateBinding(source, (value) => replaceReviewed(value, modernCalls[kind], 'true')),
        legacyCalls[name][kind] ? [legacyCalls[name][kind]] : [],
      );
    });
    test(`${name} ${kind} reader keeps the strict default`, () => {
      refusesForwardMutation(
        name,
        (source) =>
          mutateBinding(source, (value) => {
            assert.ok(value.endsWith(': undefined'));
            return value.slice(0, -': undefined'.length) + ': () => true';
          }),
        [modernCalls[kind], ...(legacyCalls[name][kind] ? [legacyCalls[name][kind]] : [])],
      );
    });
    if (legacyCalls[name][kind]) {
      const condition =
        kind === 'media' ? 'createdLegacyForward' : "profile === 'legacy-post-seal'";
      test(`${name} ${kind} reader refuses an unconditional legacy fallback`, () => {
        refusesForwardMutation(
          name,
          (source) => mutateBinding(source, (value) => replaceReviewed(value, condition, 'true')),
          [modernCalls[kind], legacyCalls[name][kind]],
        );
      });
      test(`${name} ${kind} reader refuses a permissive legacy validator`, () => {
        refusesForwardMutation(
          name,
          (source) =>
            mutateBinding(source, (value) =>
              replaceReviewed(value, legacyCalls[name][kind], 'true'),
            ),
          [modernCalls[kind]],
        );
      });
    }
    const other = name === 'created' ? 'passive' : 'created';
    test(`${name} reader refuses the ${other} ${kind} callback mixed into its profile`, () => {
      refusesForwardMutation(name, (source) =>
        replaceReviewed(source, binding, profiles[other].bindings[kind]),
      );
    });
  }
  for (const [key, marker] of Object.entries(profile.guards))
    test(`${name} reader requires its complete ${key} guard`, () => {
      refusesForwardMutation(name, (source) => replaceReviewed(source, marker, 'removed_guard'));
    });
}

for (const [label, before, after] of [
  ['post-seal profile', "profile === 'legacy-post-seal' &&", "profile !== 'source-abandonment' &&"],
  ['normalized event type', "update.type === 'message_created' &&", 'true &&'],
  ['raw event type', "raw?.update_type === 'message_created' &&", 'true &&'],
  ['forward relation', "record(message?.link)?.type === 'forward'", 'true'],
])
  test(`created forward requires ${label} before allowing links or shares`, () => {
    refusesForwardMutation(
      'created',
      (source) =>
        replaceReviewed(
          source,
          profiles.created.guards.created,
          replaceReviewed(profiles.created.guards.created, before, after),
        ),
      Object.values(profiles.created.bindings),
    );
  });

for (const [label, guard, before, after] of [
  ['link opt-in', 'markup', 'allowLinks &&', 'true &&'],
  ['markup count', 'markup', 'value.length <= 64 &&', 'true &&'],
  [
    'passive/link-only entries',
    'markup',
    "(entry) => record(entry)?.type === 'link' || isLegacyPassiveMarkup([entry], text)",
    '() => true',
  ],
  ['strict modern link validation', 'markup', 'isSourceAbandonmentMarkup(value, text)', 'true'],
  ['media count', 'media', 'value.length > 10', 'false'],
  ['single share', 'media', 'value.length === 1 &&', 'true &&'],
  ['share type', 'media', "record(value[0])?.type === 'share'", 'true'],
  ['strict share validation', 'media', 'isSourceAbandonmentDirectMedia(value, undefined)', 'true'],
  ['outer created type', 'outer', "updateType === 'message_created' &&", 'true &&'],
  ['outer empty caption', 'outer', "body.text === '' &&", 'true &&'],
  [
    'outer exact mirrored markup',
    'outer',
    'JSON.stringify(body.markup) === JSON.stringify(linked.markup)',
    'true',
  ],
])
  test(`created forward retains ${label}`, () => {
    refusesForwardMutation(
      'created',
      (source) =>
        replaceReviewed(
          source,
          profiles.created.guards[guard],
          replaceReviewed(profiles.created.guards[guard], before, after),
        ),
      Object.values(profiles.created.bindings),
    );
  });

for (const [path, markers] of Object.entries(profiles.created.dependencies))
  for (const [index, marker] of markers.entries())
    test(`created forward requires strict source/receipt wiring ${path}:${index}`, () => {
      const changed = replaceReviewed(read(path), marker, 'removed_created_forward_wiring');
      assert.throws(
        () =>
          assertSourceAbandonmentSource('a'.repeat(40), (sourcePath) =>
            sourcePath === path ? changed : read(sourcePath),
          ),
        /lacks permanent/,
      );
    });

for (const path of [
  'apps/api/src/webhook/webhook-legacy-source.ts',
  'apps/api/src/webhook/webhook-legacy-receipt-disposition.ts',
])
  test(`created forward rejects historical cross-file wiring: ${path}`, () => {
    const historical = historicalSources().get(path);
    assert.notEqual(historical, read(path));
    assert.throws(
      () =>
        assertSourceAbandonmentSource('a'.repeat(40), (sourcePath) =>
          sourcePath === path ? historical : read(sourcePath),
        ),
      /lacks permanent/,
    );
  });

const receiptPath = 'apps/api/src/webhook/webhook-legacy-receipt-disposition.ts';
for (const [label, before, after] of [
  [
    'SHARE selection without markup',
    "linkedAttachments.some((attachment) => record(attachment)?.type === 'share')",
    'false',
  ],
  ['original-source inspection', 'await inspectHeldMessageDisposition(tx, event)', 'null'],
  ['absence refusal', "if (!heldMessage || heldMessage === 'NOT_HELD')", 'if (false)'],
  ['proven authority', 'heldMessage.authorityId', 'authority.id'],
])
  test(`created forward keeps ${label} on the SHARE receipt path`, () => {
    const statement = profiles.created.dependencies[receiptPath][1];
    const changed = replaceReviewed(
      read(receiptPath),
      statement,
      replaceReviewed(statement, before, after),
    );
    assert.throws(
      () =>
        assertSourceAbandonmentSource('a'.repeat(40), (path) =>
          path === receiptPath ? changed : read(path),
        ),
      /lacks permanent/,
    );
  });

test('modern source rows cannot become a member-wide hold through rollback', () => {
  assert.throws(
    () =>
      assertSourceAbandonmentSource('a'.repeat(40), (path) =>
        path.endsWith('webhook-legacy-hold.service.ts')
          ? read(path).replace(
              '  async hasChatHolds(',
              '  async hasChatHolds(/* webhook_source_abandonments */',
            )
          : read(path),
      ),
    /blanket participant/,
  );
});
test('rollback refuses a legacy content reader after modern previews and replies are supported', () => {
  assert.throws(
    () =>
      assertSourceAbandonmentSource('a'.repeat(40), (path) =>
        path.endsWith('webhook-source-abandonment.ts')
          ? read(path).replaceAll(
              'inspectSourceAbandonmentAnySource',
              'inspectLegacyRecoverySource',
            )
          : read(path),
      ),
    /lacks permanent.*webhook-source-abandonment\.ts/u,
  );
});
test('rollback refuses a human-only reader after authorless channel holds are installed', () => {
  assert.throws(
    () =>
      assertSourceAbandonmentSource('a'.repeat(40), (path) =>
        path.endsWith('webhook-source-abandonment-channel.ts')
          ? read(path).replace(
              'inspectChannelAuthorlessSource(owner, onRefusal, settings, postSeal)',
              'inspectSourceAbandonmentSource(owner, onRefusal, settings)',
            )
          : read(path),
      ),
    /lacks permanent.*webhook-source-abandonment-channel\.ts/u,
  );
});
test('rollback refuses to reconstruct a synthetic author for a held channel', () => {
  assert.throws(
    () =>
      assertSourceAbandonmentSource('a'.repeat(40), (path) =>
        path.endsWith('webhook-source-abandonment.ts')
          ? read(path).replace(
              '{ sourceProfile: SOURCE_ABANDONMENT_CHANNEL_PROFILE, userId: null }',
              "{ sourceProfile: SOURCE_ABANDONMENT_CHANNEL_PROFILE, userId: 'invented' }",
            )
          : read(path),
      ),
    /lacks permanent.*webhook-source-abandonment\.ts/u,
  );
});
test('rollback retains direct media recognition in the modern owner and late mirror profile', () => {
  assert.throws(
    () =>
      assertSourceAbandonmentSource('a'.repeat(40), (path) =>
        path.endsWith('webhook-source-abandonment-media.ts')
          ? read(path).replace('if (isLegacyDirectMedia(value)) return true;', '')
          : read(path),
      ),
    /lacks permanent.*webhook-source-abandonment-media\.ts/u,
  );
});

test('rollback retains explicit-only strict linked reply audio admission', () => {
  assert.throws(
    () =>
      assertSourceAbandonmentSource('a'.repeat(40), (path) =>
        path.endsWith('webhook-source-abandonment-media.ts')
          ? read(path).replace("purpose === 'SOURCE_ABANDONMENT' && ", '')
          : read(path),
      ),
    /lacks permanent.*webhook-source-abandonment-media\.ts/u,
  );
});
for (const target of ['owner', 'event']) {
  test(`rollback retains the v6 pristine reader for ${target}`, () => {
    assert.throws(
      () =>
        assertSourceAbandonmentSource('a'.repeat(40), (path) =>
          path.endsWith('webhook-pristine-discard.ts')
            ? read(path).replace(
                `inspectPristineOperatorDiscardSource(${target}, settings ?? undefined)`,
                `inspectSourceAbandonmentSource(${target}, undefined, settings ?? undefined)`,
              )
            : read(path),
        ),
      /lacks permanent.*webhook-pristine-discard\.ts/u,
    );
  });
}
