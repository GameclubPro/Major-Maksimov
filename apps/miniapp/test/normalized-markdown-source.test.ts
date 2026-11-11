import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createMarkdownNormalizerResource,
  resolveNormalizedMarkdownSource,
} from '../src/lib/use-normalized-markdown-source';

test('keeps the original markdown intact while the multiline normalizer loads', async () => {
  let finishLoad:
    | ((module: { normalizeLegacyMultilineMarkdown: (source: string) => string }) => void)
    | null = null;
  const resource = createMarkdownNormalizerResource(
    () =>
      new Promise((resolve) => {
        finishLoad = resolve;
      }),
  );
  const source = '**Первая\nВторая\nТретья**';
  const pending = resource.load();

  assert.equal(resource.getStatus(), 'loading');
  assert.deepEqual(resolveNormalizedMarkdownSource(resource, source, true), {
    status: 'loading',
    value: source,
  });

  assert.ok(finishLoad);
  finishLoad({ normalizeLegacyMultilineMarkdown: (value) => value.replaceAll('\n', '**\n**') });
  await pending;
  assert.deepEqual(resolveNormalizedMarkdownSource(resource, source, true), {
    status: 'ready',
    value: '**Первая**\n**Вторая**\n**Третья**',
  });
});

test('preserves the original source after rejection and supports a clean retry', async () => {
  let attempts = 0;
  const statuses: string[] = [];
  const resource = createMarkdownNormalizerResource(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('chunk unavailable');
    return {
      normalizeLegacyMultilineMarkdown: (value: string) => value.replaceAll('\n', '**\n**'),
    };
  });
  const unsubscribe = resource.subscribe(() => statuses.push(resource.getStatus()));
  const source = '**Первая\nВторая**';

  await resource.load();
  assert.deepEqual(resolveNormalizedMarkdownSource(resource, source, true), {
    status: 'error',
    value: source,
  });

  await resource.retry();
  assert.deepEqual(resolveNormalizedMarkdownSource(resource, source, true), {
    status: 'ready',
    value: '**Первая**\n**Вторая**',
  });
  assert.equal(attempts, 2);
  assert.ok(statuses.includes('error'));
  assert.equal(statuses.at(-1), 'ready');
  unsubscribe();
});

test('never replaces source text when a loaded normalizer throws', async () => {
  const resource = createMarkdownNormalizerResource(async () => ({
    normalizeLegacyMultilineMarkdown: () => {
      throw new Error('invalid source');
    },
  }));
  const source = '**Первая\nВторая**';

  await resource.load();
  assert.deepEqual(resolveNormalizedMarkdownSource(resource, source, true), {
    status: 'error',
    value: source,
  });
});

test('preview chunk failures do not expose raw markdown markers', () => {
  const previewSource = readFileSync(
    new URL('../src/components/max-markdown-preview.tsx', import.meta.url),
    'utf8',
  );
  const errorBranch = previewSource.match(
    /if \(normalizedSource\.status === 'error'\) \{([\s\S]*?)\n {2}\}/u,
  )?.[1];

  assert.ok(errorBranch);
  assert.match(errorBranch, /Не удалось отобразить форматированный текст/u);
  assert.doesNotMatch(errorBranch, /\{source\}/u);
});

test('composer keeps the normalization retry independent from disabled outer tools', () => {
  const composerSource = readFileSync(
    new URL('../src/components/broadcast-content-composer.tsx', import.meta.url),
    'utf8',
  );

  assert.match(composerSource, /const editorDisabled = disabled;/u);
  assert.match(
    composerSource,
    /const isBusy = disabled \|\| isPreparingImage \|\| !normalizationReady;/u,
  );
  assert.match(
    composerSource,
    /<MaxRichTextEditor[\s\S]*?disabled=\{editorDisabled\}[\s\S]*?onNormalizationReadyChange/u,
  );
});

test('single-line card previews remain ready when the multiline resource failed', async () => {
  const resource = createMarkdownNormalizerResource(async () => {
    throw new Error('chunk unavailable');
  });
  await resource.load();
  const source = '**Первая\nВторая**'.replace(/\s+/gu, ' ').trim();
  assert.deepEqual(resolveNormalizedMarkdownSource(resource, source, true), {
    status: 'ready',
    value: source,
  });
});
