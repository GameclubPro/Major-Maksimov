import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import {
  CHAT_SECTION_FIELDS,
  CHANNEL_SECTION_FIELDS,
  settingsSectionPaths,
  SUPPLEMENTARY_CHAT_SECTION_FIELDS,
} from '../src/features/network-settings/field-paths';
import * as registry from '../src/features/network-settings/field-registry';

function source(relativePath: string) {
  return ts.createSourceFile(
    relativePath,
    readFileSync(new URL(relativePath, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

test('field paths stay available without loading runtime schemas or other modules', () => {
  const parsed = source('../src/features/network-settings/field-paths.ts');
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement)) {
      assert.equal(statement.importClause?.isTypeOnly, true, statement.getText(parsed));
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      assert.equal(statement.isTypeOnly, true, statement.getText(parsed));
    }
    assert.equal(ts.isImportEqualsDeclaration(statement), false);
  }
  const inspect = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      assert.notEqual(node.expression.kind, ts.SyntaxKind.ImportKeyword);
      assert.equal(ts.isIdentifier(node.expression) && node.expression.text === 'require', false);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(parsed);
});

test('eager section lists import the pure field paths boundary', () => {
  const names = new Set(['CHAT_SECTION_FIELDS', 'CHANNEL_SECTION_FIELDS', 'settingsSectionPaths']);
  for (const relativePath of [
    '../src/pages/settings-page.legacy.tsx',
    '../src/lib/api/preview-transport-network-settings.ts',
  ]) {
    const parsed = source(relativePath);
    let found = false;
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      if (
        !bindings.elements.some((element) => names.has((element.propertyName ?? element.name).text))
      )
        continue;
      found = true;
      assert.ok(ts.isStringLiteral(statement.moduleSpecifier));
      assert.ok(statement.moduleSpecifier.text.endsWith('/field-paths'), relativePath);
    }
    assert.equal(found, true, relativePath);
  }
});

test('registry retains canonical public path identity and synchronous validation for every field', () => {
  assert.equal(registry.CHAT_SECTION_FIELDS, CHAT_SECTION_FIELDS);
  assert.equal(registry.CHANNEL_SECTION_FIELDS, CHANNEL_SECTION_FIELDS);
  assert.equal(registry.settingsSectionPaths, settingsSectionPaths);
  for (const section of Object.keys(CHAT_SECTION_FIELDS) as (keyof typeof CHAT_SECTION_FIELDS)[]) {
    for (const path of settingsSectionPaths('chat', section)) {
      assert.equal(
        typeof registry.settingsFieldSchema('chat', section, path).safeParse,
        'function',
      );
    }
  }
  for (const section of Object.keys(
    CHANNEL_SECTION_FIELDS,
  ) as (keyof typeof CHANNEL_SECTION_FIELDS)[]) {
    for (const path of settingsSectionPaths('channel', section)) {
      assert.equal(
        typeof registry.settingsFieldSchema('channel', section, path).safeParse,
        'function',
      );
    }
  }
  assert.throws(() =>
    registry.parseSettingsField('chat', 'reports', 'reportsThreshold', undefined),
  );
  assert.throws(() => registry.parseSettingsField('chat', 'reports', 'reportsThreshold', 1));
  assert.equal(registry.parseSettingsField('chat', 'reports', 'reportsThreshold', 3), 3);
});

test('section paths preserve authored media while excluding derived aliases and foreign sections', () => {
  const greeting = settingsSectionPaths('chat', 'greeting');
  assert.ok(greeting.includes('greetingBotButtons'));
  assert.ok(greeting.includes('botSpeechMedia.greetingBotMessageText'));
  assert.equal(greeting.includes('greetingBotButtonUrl'), false);
  assert.equal(greeting.includes('greetingBotButtonText'), false);
  assert.equal(
    settingsSectionPaths('chat', 'requiredSubscription').includes('requiredSubscriptionEnabled'),
    false,
  );
  assert.equal(settingsSectionPaths('chat', 'night').includes('nightModeForceCloseUntil'), false);
  const stopWords = settingsSectionPaths('chat', 'stopWords');
  assert.ok(stopWords.includes('stopWordsPolicy.rules'));
  assert.ok(stopWords.includes('stopWordsPolicy.domains'));
  assert.ok(stopWords.includes('stopWordsPolicy.sanctions.media.explanation'));
  assert.ok(stopWords.includes('stopWordsPolicy.sanctions.media.warning'));
  assert.deepEqual(settingsSectionPaths('channel', 'postSignature'), [
    'enabled',
    'presentation',
    'text',
    'url',
  ]);
  assert.throws(() => settingsSectionPaths('channel', 'reports'));
  assert.throws(() => settingsSectionPaths('chat', 'comments'));
  greeting.length = 0;
  assert.ok(settingsSectionPaths('chat', 'greeting').includes('greetingBotButtons'));
});

test('supplementary settings keep their own paths and canonical field validation', () => {
  for (const [section, paths] of Object.entries(SUPPLEMENTARY_CHAT_SECTION_FIELDS)) {
    assert.deepEqual(
      settingsSectionPaths('chat', section as keyof typeof SUPPLEMENTARY_CHAT_SECTION_FIELDS),
      [...paths],
    );
    for (const path of paths)
      assert.equal(
        typeof registry.settingsFieldSchema(
          'chat',
          section as keyof typeof SUPPLEMENTARY_CHAT_SECTION_FIELDS,
          path,
        ).safeParse,
        'function',
      );
  }
  assert.equal(
    registry.parseSettingsField('chat', 'messageRetention', 'messageRetention.hours', 48),
    48,
  );
  assert.throws(() =>
    registry.parseSettingsField('chat', 'messageRetention', 'messageRetention.hours', 72),
  );
  assert.deepEqual(registry.parseSettingsField('chat', 'rules', 'rules.buttons', []), []);
  assert.throws(() =>
    registry.parseSettingsField('chat', 'rules', 'rules.buttons', [{ url: 123, text: 'Open' }]),
  );
  assert.throws(() =>
    registry.settingsFieldSchema('channel', 'postSuggestions', 'commentsEnabled'),
  );
  assert.ok(
    settingsSectionPaths('channel', 'postSuggestions').includes(
      'postSuggestionsDeleteOnUnsubscribe',
    ),
  );
});

test('phone section edits common Limits actions and their media', () => {
  assert.equal(
    registry.parseSettingsField('chat', 'phones', 'messageLimitsBotMessageEnabled', true),
    true,
  );
  assert.equal(
    registry.parseSettingsField('chat', 'phones', 'messageLimitsWarnEnabled', false),
    false,
  );
  assert.ok(
    settingsSectionPaths('chat', 'phones').includes('botSpeechMedia.messageLimitsBotMessageText'),
  );
  assert.throws(() =>
    registry.parseSettingsField('chat', 'phones', 'phoneNumbersBotMessageEnabled', true),
  );
});
