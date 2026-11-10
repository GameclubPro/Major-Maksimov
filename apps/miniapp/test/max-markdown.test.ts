import assert from 'node:assert/strict';
import test from 'node:test';
import {
  containsSupportedMarkdownUrl,
  extractSupportedMarkdownLinks as extractBaseMarkdownLinks,
  renderPlainTextAsEditorHtml,
  renderSupportedMarkdownAsHtml as renderBaseMarkdownAsHtml,
  stripSupportedMarkdownToPlainText as stripBaseMarkdownToPlainText,
} from '../src/lib/max-markdown';
import { normalizeLegacyMultilineMarkdown } from '../src/lib/max-markdown-multiline';
import { serializeEditorLinkMarkdown } from '../src/lib/max-rich-text-link';

function renderSupportedMarkdownAsHtml(
  source: string,
  options?: Parameters<typeof renderBaseMarkdownAsHtml>[1],
): string {
  return renderBaseMarkdownAsHtml(normalizeLegacyMultilineMarkdown(source), options);
}

function stripSupportedMarkdownToPlainText(source: string): string {
  return stripBaseMarkdownToPlainText(normalizeLegacyMultilineMarkdown(source));
}

function extractSupportedMarkdownLinks(source: string): string[] {
  return extractBaseMarkdownLinks(normalizeLegacyMultilineMarkdown(source));
}

test('finds URLs in link hrefs and Markdown-escaped visible text', () => {
  assert.equal(
    containsSupportedMarkdownUrl('[Сайт](https://site.example/a_b)', 'https://site.example/a_b'),
    true,
  );
  for (const [source, url] of [
    ['https://site.example/a\\_b', 'https://site.example/a_b'],
    ['https://site.example/a\\(b\\)', 'https://site.example/a(b)'],
    ['https://site.example/a\\+b', 'https://site.example/a+b'],
    ['https://site.example/a\\~b', 'https://site.example/a~b'],
  ]) {
    assert.equal(containsSupportedMarkdownUrl(source, url), true);
  }
});

test('renders compact bold italic marker runs without leaking markdown punctuation', () => {
  assert.equal(
    renderSupportedMarkdownAsHtml('***MAX Docs***', { blockMode: 'inline' }),
    '<strong><em>MAX Docs</em></strong>',
  );
  assert.equal(
    renderSupportedMarkdownAsHtml('___++~~MAX Docs~~++___', { blockMode: 'inline' }),
    '<strong><em><u><s>MAX Docs</s></u></em></strong>',
  );
  assert.equal(stripSupportedMarkdownToPlainText('___++~~MAX Docs~~++___'), 'MAX Docs');
});

test('renders heading blocks and fenced code blocks', () => {
  assert.equal(
    renderSupportedMarkdownAsHtml('# Анонс\n\n```\nconst value = "<MAX>";\n```\n\nТекст', {
      blockMode: 'inline',
    }),
    '<strong data-max-block="heading" data-max-heading-level="1">Анонс</strong><br><br><code data-max-block="code">const value = &quot;&lt;MAX&gt;&quot;;</code><br><br>Текст',
  );
  assert.equal(
    stripSupportedMarkdownToPlainText('# Анонс\n\n```\nconst value = "<MAX>";\n```'),
    'Анонс\n\nconst value = "<MAX>";',
  );
});

test('preserves each interior blank row beside formatted text and links', () => {
  for (const blockMode of ['inline', 'editor'] as const) {
    for (const blankRows of [0, 1, 2, 4]) {
      const source = `Новокузнецк и близлежащие районы\n${'\n'.repeat(blankRows)}**Подписаться на нас 👇**\n[Барахолка Новокузнецк](https://max.ru/example)`;
      assert.equal(
        renderSupportedMarkdownAsHtml(source, { blockMode }),
        `Новокузнецк и близлежащие районы${'<br>'.repeat(blankRows + 1)}<strong>Подписаться на нас 👇</strong><br><a href="https://max.ru/example">Барахолка Новокузнецк</a>`,
        `${blockMode}: ${blankRows} blank rows`,
      );
    }
  }
});

test('preserves repeated blank rows around semantic blocks and inside code', () => {
  const source = '# Заголовок\n\n\n```\nfirst\n\nsecond\n```\n\n\n> Цитата';
  assert.equal(
    renderSupportedMarkdownAsHtml(source, { blockMode: 'inline' }),
    '<strong data-max-block="heading" data-max-heading-level="1">Заголовок</strong><br><br><br><code data-max-block="code">first\n\nsecond</code><br><br><br><span data-max-block="quote">Цитата</span>',
  );
  assert.equal(
    renderSupportedMarkdownAsHtml(source, { blockMode: 'editor' }),
    '<h1>Заголовок</h1><br><br><br><pre>first\n\nsecond</pre><br><br><br><blockquote>Цитата</blockquote>',
  );
});

test('keeps the existing leading and trailing blank-row policy', () => {
  for (const blockMode of ['inline', 'editor'] as const) {
    assert.equal(renderSupportedMarkdownAsHtml('\n\nТекст\n\n\n', { blockMode }), 'Текст<br><br>');
    assert.equal(renderSupportedMarkdownAsHtml('\n\n', { blockMode }), '');
  }
});

test('uses the MAX publication heading markup in raw mode', () => {
  assert.equal(renderSupportedMarkdownAsHtml('# Анонс', { blockMode: 'raw' }), '<h1>Анонс</h1>');
});

test('renders official MAX highlight and quote syntax without leaking delimiters', () => {
  const source = '## Раздел\n> **Важная** цитата\n^^Фокус _сейчас_^^';

  assert.equal(
    renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' }),
    '<h2>Раздел</h2>\n<blockquote><strong>Важная</strong> цитата</blockquote>\n<mark>Фокус <em>сейчас</em></mark>',
  );
  assert.equal(
    renderSupportedMarkdownAsHtml(source, { blockMode: 'inline' }),
    '<strong data-max-block="heading" data-max-heading-level="2">Раздел</strong><br><span data-max-block="quote"><strong>Важная</strong> цитата</span><br><mark>Фокус <em>сейчас</em></mark>',
  );
  assert.equal(
    stripSupportedMarkdownToPlainText(source),
    'Раздел\n\nВажная цитата\n\nФокус сейчас',
  );
});

test('keeps inline previews phrasing-only while editor mode retains semantic blocks', () => {
  const source = '# Раздел\n> Цитата\n```\ncode\n```';
  const inline = renderSupportedMarkdownAsHtml(source, { blockMode: 'inline' });

  assert.doesNotMatch(inline, /<(?:h[1-6]|blockquote|pre)(?:\s|>)/u);
  assert.match(inline, /data-max-block="heading"/u);
  assert.match(inline, /data-max-block="quote"/u);
  assert.match(inline, /data-max-block="code"/u);
  assert.equal(
    renderSupportedMarkdownAsHtml(source, { blockMode: 'editor' }),
    '<h1>Раздел</h1><blockquote>Цитата</blockquote><pre>code</pre>',
  );
});

test('keeps escaped heading, quote, and highlight punctuation literal', () => {
  const source = '\\# заголовок\n\\> цитата\n\\^\\^не выделять\\^\\^';

  assert.equal(
    renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' }),
    '# заголовок\n&gt; цитата\n^^не выделять^^',
  );
  assert.equal(stripSupportedMarkdownToPlainText(source), '# заголовок\n> цитата\n^^не выделять^^');
});

test('keeps plain VK-looking markdown literal in the rich editor source', () => {
  assert.equal(
    renderPlainTextAsEditorHtml('**скидка**\n# заголовок\n<x> & y'),
    '**скидка**<br># заголовок<br>&lt;x&gt; &amp; y',
  );
});

test('renders every nested rich text modifier combination without leaking markers', () => {
  for (const source of buildNestedModifierSamples()) {
    assert.doesNotMatch(
      renderSupportedMarkdownAsHtml(source, { blockMode: 'inline' }),
      /(?:\*\*|__|\+\+|~~)/u,
    );
    assert.equal(stripSupportedMarkdownToPlainText(source), 'MAX Docs');
  }
});

test('normalizes legacy multiline modifiers and links without leaking markers', () => {
  const samples = [
    ['**🔥 Первая\n\nВторая**', '<strong>', '🔥 Первая\n\nВторая'],
    ['_🔥 Первая\nВторая_', '<em>', '🔥 Первая\nВторая'],
    ['++🔥 Первая\nВторая++', '<u>', '🔥 Первая\nВторая'],
    ['~~🔥 Первая\nВторая~~', '<s>', '🔥 Первая\nВторая'],
    [
      '[🔥 Первая\nВторая](https://example.com/path)',
      '<a href="https://example.com/path">',
      '🔥 Первая\nВторая',
    ],
  ] as const;

  for (const [source, expectedTag, expectedPlainText] of samples) {
    const html = renderSupportedMarkdownAsHtml(source, { blockMode: 'inline' });
    assert.match(html, new RegExp(expectedTag.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.doesNotMatch(html, /(?:\*\*|\+\+|~~|\[[^\]]*\n)/u);
    assert.equal(stripSupportedMarkdownToPlainText(source), expectedPlainText);
  }
});

test('normalizes nested legacy multiline formatting around UTF-16 text', () => {
  const source = '**_[🔥 Первая\nВторая](https://example.com/emoji)_**';
  const html = renderSupportedMarkdownAsHtml(source, { blockMode: 'inline' });

  assert.equal(
    html,
    '<strong><em><a href="https://example.com/emoji">🔥 Первая</a></em></strong><br><strong><em><a href="https://example.com/emoji">Вторая</a></em></strong>',
  );
  assert.equal(stripSupportedMarkdownToPlainText(source), '🔥 Первая\nВторая');
  assert.deepEqual(extractSupportedMarkdownLinks(source), ['https://example.com/emoji']);
});

test('keeps escaped and fenced multiline marker text literal', () => {
  const escaped = '\\**literal\n\n\\** \\_text\n\\_ \\++under\n\\++ \\~~strike\n\\~~';
  const fenced = ['```', '**literal', '', '**', '```'].join('\n');

  assert.equal(
    renderSupportedMarkdownAsHtml(escaped, { blockMode: 'inline' }),
    '**literal<br><br>** _text<br>_ ++under<br>++ ~~strike<br>~~',
  );
  assert.equal(
    renderSupportedMarkdownAsHtml(fenced, { blockMode: 'inline' }),
    '<code data-max-block="code">**literal\n\n**</code>',
  );
});

test('keeps the legacy own-line strong close free of visible markers', () => {
  const source = '**Одна строка\n\n**';

  assert.equal(
    renderSupportedMarkdownAsHtml(source, { blockMode: 'inline' }),
    '<strong>Одна строка</strong><br><br>',
  );
  assert.equal(stripSupportedMarkdownToPlainText(source), 'Одна строка');
});

test('does not reinterpret lists, dividers, whitespace markers, or URL underscores', () => {
  const sources = [
    '* пункт 1\n* пункт 2',
    '_ подпись\n_ продолжение',
    '***\nраздел\n***',
    '___\n___',
    'https://example.com/first_part\nhttps://example.com/second_part',
    'https://example.com/_first\nsecond_',
  ];

  for (const source of sources) {
    const html = renderSupportedMarkdownAsHtml(source, { blockMode: 'inline' });
    assert.equal(html.includes('<em>'), false, source);
    assert.equal(html.includes('<strong>'), false, source);
  }
  assert.equal(renderSupportedMarkdownAsHtml('___\n___', { blockMode: 'inline' }), '___<br>___');
  assert.equal(stripSupportedMarkdownToPlainText('___\n___'), '___\n___');
});

test('matches server multiline semantics for all supported inline markers', () => {
  const markers = [
    ['***', '<strong><em>', '</em></strong>'],
    ['___', '<strong><em>', '</em></strong>'],
    ['**', '<strong>', '</strong>'],
    ['__', '<strong>', '</strong>'],
    ['*', '<em>', '</em>'],
    ['_', '<em>', '</em>'],
    ['++', '<u>', '</u>'],
    ['~~', '<s>', '</s>'],
    ['^^', '<mark>', '</mark>'],
  ] as const;

  for (const [marker, openTag, closeTag] of markers) {
    const source = `${marker}Первая строка\n\nВторая строка${marker}`;
    assert.equal(
      renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' }),
      `${openTag}Первая строка${closeTag}\n\n${openTag}Вторая строка${closeTag}`,
    );
    assert.equal(stripSupportedMarkdownToPlainText(source), 'Первая строка\n\nВторая строка');
    assert.equal(
      renderSupportedMarkdownAsHtml(`${marker}Одна строка\n\n${marker}`, {
        blockMode: 'raw',
      }),
      `${openTag}Одна строка${closeTag}\n\n`,
    );

    const urlSource = `${marker}A\nhttps://e.test/B${marker}`;
    assert.equal(
      renderSupportedMarkdownAsHtml(urlSource, { blockMode: 'raw' }),
      `${openTag}A${closeTag}\n${openTag}https://e.test/B${closeTag}`,
    );
    assert.equal(stripSupportedMarkdownToPlainText(urlSource), 'A\nhttps://e.test/B');
  }
});

test('matches server multiline link and nesting semantics', () => {
  assert.equal(
    renderSupportedMarkdownAsHtml('[Первая\n\n](https://example.com/path)', {
      blockMode: 'raw',
    }),
    '<a href="https://example.com/path">Первая</a>\n\n',
  );
  for (const source of [
    '**_Первая\n\nВторая_**',
    '_**Первая\n\nВторая**_',
    '[**_Первая\n\nВторая_**](https://example.com/path)',
    '**[Первая\n\nВторая](https://example.com/path)**',
  ]) {
    const rendered = renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' });
    assert.doesNotMatch(rendered, /(?:\*\*|__|\+\+|~~|\[[^\]]*\]\()/u);
    assert.equal(stripSupportedMarkdownToPlainText(source), 'Первая\n\nВторая');
  }
});

test('preserves same-marker punctuation inside multiline spans', () => {
  const samples = [
    ['_A\nsnake_case\nB_', '<em>A</em>\n<em>snake_case</em>\n<em>B</em>', 'A\nsnake_case\nB'],
    ['++A\nC++17\nB++', '<u>A</u>\n<u>C++17</u>\n<u>B</u>', 'A\nC++17\nB'],
    [
      '_A\nhttps://example.com/a_b\nB_',
      '<em>A</em>\n<em>https://example.com/a_b</em>\n<em>B</em>',
      'A\nhttps://example.com/a_b\nB',
    ],
  ] as const;

  for (const [source, html, plain] of samples) {
    assert.equal(renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' }), html);
    assert.equal(stripSupportedMarkdownToPlainText(source), plain);
  }
});

test('keeps fenced, HTTP, and MAX URL marker runs outside multiline formatting', () => {
  const fenced = '_A\n```\ncode\n```\nB_';
  assert.equal(
    renderSupportedMarkdownAsHtml(fenced, { blockMode: 'raw' }),
    '_A\n<pre>code</pre>\nB_',
  );
  assert.equal(stripSupportedMarkdownToPlainText(fenced), '_A\n\ncode\n\nB_');

  for (const source of ['https://example.com/_first\nsecond_', 'max://user/_first\nsecond_']) {
    assert.equal(renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' }), source);
    assert.equal(stripSupportedMarkdownToPlainText(source), source);
  }
});

test('keeps malformed multiline marker work and output bounded', () => {
  const runs = ['*', '**', '***', '_', '__', '___', '++', '~~'];
  for (const left of runs) {
    for (const middle of runs) {
      for (const right of runs) {
        const source = `${left}A${middle}\nB${right}`;
        assert.ok(
          renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' }).length <= source.length * 16,
        );
      }
    }
  }

  const source = `${'_a\n'.repeat(1_300)}z_`;
  const startedAt = performance.now();
  assert.equal(renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' }), source);
  assert.ok(performance.now() - startedAt < 250);
});

test('round-trips escaped editor delimiters and link labels', () => {
  const inlineSamples = [
    ['_A \\_ B_', '<em>A _ B</em>', 'A _ B'],
    ['++A \\+\\+ B++', '<u>A ++ B</u>', 'A ++ B'],
    ['~~A \\~\\~ B~~', '<s>A ~~ B</s>', 'A ~~ B'],
    ['^^A \\^\\^ B^^', '<mark>A ^^ B</mark>', 'A ^^ B'],
  ] as const;
  for (const [source, html, plain] of inlineSamples) {
    assert.equal(renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' }), html);
    assert.equal(stripSupportedMarkdownToPlainText(source), plain);
  }

  const link = serializeEditorLinkMarkdown('A \\] B', 'https://e.test/');
  assert.equal(link, '[A \\] B](https://e.test/)');
  assert.equal(
    renderSupportedMarkdownAsHtml(link, { blockMode: 'raw' }),
    '<a href="https://e.test/">A ] B</a>',
  );
  assert.equal(stripSupportedMarkdownToPlainText(link), 'A ] B');
  assert.deepEqual(extractSupportedMarkdownLinks(link), ['https://e.test/']);
});

test('keeps bot template placeholders literal when requested', () => {
  assert.equal(
    renderSupportedMarkdownAsHtml('{message_status} {required_invites_count}', {
      blockMode: 'inline',
      preserveCurlyBracePlaceholders: true,
    }),
    '{message_status} {required_invites_count}',
  );
});

test('renders bot placeholders as readable editor tokens without changing their keys', () => {
  assert.equal(
    renderSupportedMarkdownAsHtml('{user}, сообщение {message_status}: {reason}.', {
      blockMode: 'inline',
      preserveCurlyBracePlaceholders: true,
      curlyBracePlaceholderLabels: {
        user: 'Имя',
        message_status: 'Статус',
        reason: 'Причина',
      },
    }),
    '<span class="max-rich-text-editor__placeholder-token" data-max-placeholder="user" contenteditable="false">Имя</span>, сообщение <span class="max-rich-text-editor__placeholder-token" data-max-placeholder="message_status" contenteditable="false">Статус</span>: <span class="max-rich-text-editor__placeholder-token" data-max-placeholder="reason" contenteditable="false">Причина</span>.',
  );
});

function buildNestedModifierSamples(): string[] {
  const wrappers: Array<[string, string]> = [
    ['**', '**'],
    ['_', '_'],
    ['++', '++'],
    ['~~', '~~'],
    ['^^', '^^'],
  ];

  return permute(wrappers).map((permutation) =>
    permutation.reduce((content, [prefix, suffix]) => `${prefix}${content}${suffix}`, 'MAX Docs'),
  );
}

function permute<T>(items: T[]): T[][] {
  if (items.length === 0) {
    return [[]];
  }

  return items.flatMap((item, index) =>
    permute([...items.slice(0, index), ...items.slice(index + 1)]).map((permutation) => [
      item,
      ...permutation,
    ]),
  );
}
