import {
  containsSupportedMarkdownSyntax,
  containsSupportedMarkdownUrl,
  extractSupportedMarkdownLinks,
  prepareFormattedTextForMaxDelivery,
  prepareMarkdownForMaxDelivery,
  renderSupportedMarkdownAsHtml,
  stripSupportedMarkdownToPlainText,
} from './max-markdown.util';

describe('renderSupportedMarkdownAsHtml', () => {
  it('uses bounded HTML and falls back to bounded native MAX markdown', () => {
    expect(prepareMarkdownForMaxDelivery('**MAX**', 32)).toEqual({
      text: '<strong>MAX</strong>',
      textFormat: 'html',
    });
    expect(prepareMarkdownForMaxDelivery('&&', 4)).toEqual({
      text: '&&',
      textFormat: 'markdown',
    });
    expect(prepareMarkdownForMaxDelivery('&&&&&', 4)).toBeNull();
    expect(prepareFormattedTextForMaxDelivery('<b>x</b>', 'html', 8)).toEqual({
      text: '<b>x</b>',
      textFormat: 'html',
    });
    expect(prepareFormattedTextForMaxDelivery('<b>x</b>', 'html', 7)).toBeNull();
  });

  it('preserves indentation, trailing spaces and whitespace-only rows for outgoing posts', () => {
    expect(
      renderSupportedMarkdownAsHtml('  **Пост**  \n   \n# Заголовок  \n', { blockMode: 'raw' }),
    ).toBe(
      '&nbsp;&nbsp;<strong>Пост</strong>&nbsp;&nbsp;\n&nbsp;&nbsp;&nbsp;\n<h1>Заголовок&nbsp;&nbsp;</h1>\n',
    );
  });

  it('renders supported formatting and links to html', () => {
    expect(
      renderSupportedMarkdownAsHtml(
        '**Заголовок**\nТекст с _курсивом_, ++подчеркиванием++, ~~зачеркиванием~~ и `кодом`.\n\n[Открыть MAX](https://max.ru/)',
      ),
    ).toBe(
      '<p><strong>Заголовок</strong><br>Текст с <em>курсивом</em>, <u>подчеркиванием</u>, <s>зачеркиванием</s> и <code>кодом</code>.</p><p><a href="https://max.ru/">Открыть MAX</a></p>',
    );
  });

  it('escapes html in plain text and keeps unsupported links as text', () => {
    expect(renderSupportedMarkdownAsHtml('<b>x</b> [bad](javascript:alert(1))')).toBe(
      '<p>&lt;b&gt;x&lt;/b&gt; [bad](javascript:alert(1))</p>',
    );
  });

  it('renders semantic markdown headings and inserts wraps into raw url labels', () => {
    expect(
      renderSupportedMarkdownAsHtml(
        '# Заголовок\n\n[https://dev.max.ru/docs-api/very/long/path](https://dev.max.ru/docs-api/very/long/path)',
      ),
    ).toBe(
      '<h1>Заголовок</h1><p><a href="https://dev.max.ru/docs-api/very/long/path">https:\u200B/\u200B/\u200Bdev.\u200Bmax.\u200Bru/\u200Bdocs-\u200Bapi/\u200Bvery/\u200Blong/\u200Bpath</a></p>',
    );
  });

  it('renders links as underlined preview labels when requested', () => {
    expect(
      renderSupportedMarkdownAsHtml('**[MAX Docs](https://dev.max.ru/)**', {
        linkMode: 'underline',
      }),
    ).toBe('<p><strong><u>MAX Docs</u></strong></p>');
  });

  it('renders nested bold italic underline links for publication and preview modes', () => {
    expect(renderSupportedMarkdownAsHtml('[**_++MAX Docs++_**](https://dev.max.ru/docs-api)')).toBe(
      '<p><a href="https://dev.max.ru/docs-api"><strong><em><u>MAX Docs</u></em></strong></a></p>',
    );
    expect(
      renderSupportedMarkdownAsHtml('[**_++MAX Docs++_**](https://dev.max.ru/docs-api)', {
        linkMode: 'underline',
      }),
    ).toBe('<p><u><strong><em><u>MAX Docs</u></em></strong></u></p>');
  });

  it('renders compact bold italic marker runs without leaking markdown punctuation', () => {
    expect(renderSupportedMarkdownAsHtml('***MAX Docs***')).toBe(
      '<p><strong><em>MAX Docs</em></strong></p>',
    );
    expect(renderSupportedMarkdownAsHtml('___++~~MAX Docs~~++___')).toBe(
      '<p><strong><em><u><s>MAX Docs</s></u></em></strong></p>',
    );
    expect(stripSupportedMarkdownToPlainText('___++~~MAX Docs~~++___')).toBe('MAX Docs');
  });

  it('renders every nested rich text modifier combination without leaking markers', () => {
    for (const source of buildNestedModifierSamples()) {
      expect(renderSupportedMarkdownAsHtml(source)).not.toMatch(/(?:\*\*|__|\+\+|~~|\^\^)/u);
      expect(stripSupportedMarkdownToPlainText(source)).toBe('MAX Docs');
    }
  });

  it('preserves paragraphs, indentation and repeated spaces in html output', () => {
    expect(
      renderSupportedMarkdownAsHtml('**Анонс**\n\n  Второй абзац с  двойным пробелом\tи табом'),
    ).toBe(
      '<p><strong>Анонс</strong></p><p>&nbsp;&nbsp;Второй абзац с&nbsp;&nbsp;двойным пробелом&nbsp;&nbsp;&nbsp;&nbsp;и табом</p>',
    );
  });

  it('renders raw html output for MAX publication without paragraph tags', () => {
    expect(
      renderSupportedMarkdownAsHtml(
        '🔥[**_++MAX Docs++_**](https://dev.max.ru/docs-api)\n\n  Второй абзац с  пробелами',
        { blockMode: 'raw' },
      ),
    ).toBe(
      '🔥<a href="https://dev.max.ru/docs-api"><strong><em><u>MAX Docs</u></em></strong></a>\n\n&nbsp;&nbsp;Второй абзац с&nbsp;&nbsp;пробелами',
    );
  });

  it('renders strong spans that cross paragraph boundaries without leaking markers', () => {
    const source = '**Первая строка\n\nВторая строка**';

    expect(renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' })).toBe(
      '<strong>Первая строка</strong>\n\n<strong>Вторая строка</strong>',
    );
    expect(stripSupportedMarkdownToPlainText(source)).toBe('Первая строка\n\nВторая строка');
  });

  it.each([
    ['***', '<strong><em>', '</em></strong>'],
    ['___', '<strong><em>', '</em></strong>'],
    ['**', '<strong>', '</strong>'],
    ['__', '<strong>', '</strong>'],
    ['*', '<em>', '</em>'],
    ['_', '<em>', '</em>'],
    ['++', '<u>', '</u>'],
    ['~~', '<s>', '</s>'],
  ] as const)(
    'renders multiline %s spans as independent MAX HTML entities',
    (marker, openTag, closeTag) => {
      const source = `${marker}Первая строка\n\nВторая строка${marker}`;
      expect(renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' })).toBe(
        `${openTag}Первая строка${closeTag}\n\n${openTag}Вторая строка${closeTag}`,
      );
      expect(stripSupportedMarkdownToPlainText(source)).toBe('Первая строка\n\nВторая строка');
      expect(
        renderSupportedMarkdownAsHtml(`${marker}Одна строка\n\n${marker}`, {
          blockMode: 'raw',
        }),
      ).toBe(`${openTag}Одна строка${closeTag}\n\n`);
    },
  );

  it('renders multiline links and nested modifier permutations without generated markers', () => {
    expect(
      renderSupportedMarkdownAsHtml('[Первая\n\nВторая](https://example.com/path)', {
        blockMode: 'raw',
      }),
    ).toBe(
      '<a href="https://example.com/path">Первая</a>\n\n<a href="https://example.com/path">Вторая</a>',
    );
    expect(
      renderSupportedMarkdownAsHtml('[Первая\n\n](https://example.com/path)', {
        blockMode: 'raw',
      }),
    ).toBe('<a href="https://example.com/path">Первая</a>\n\n');
    for (const source of [
      '**_Первая\n\nВторая_**',
      '_**Первая\n\nВторая**_',
      '[**_Первая\n\nВторая_**](https://example.com/path)',
      '**[Первая\n\nВторая](https://example.com/path)**',
    ]) {
      const rendered = renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' });
      expect(rendered).not.toMatch(/(?:\*\*|__|\+\+|~~|\[[^\]]*\]\()/u);
      expect(stripSupportedMarkdownToPlainText(source)).toBe('Первая\n\nВторая');
    }
  });

  it('recognizes multiline strong spans after punctuation or emoji prefixes', () => {
    expect(renderSupportedMarkdownAsHtml('🔥**Первая\n\nВторая**', { blockMode: 'raw' })).toBe(
      '🔥<strong>Первая</strong>\n\n<strong>Вторая</strong>',
    );
    expect(
      renderSupportedMarkdownAsHtml('Префикс: **Первая\nВторая**.', { blockMode: 'raw' }),
    ).toBe('Префикс: <strong>Первая</strong>\n<strong>Вторая</strong>.');
    expect(
      renderSupportedMarkdownAsHtml('Префикс **Первая\n\nВторая** хвост', { blockMode: 'raw' }),
    ).toBe('Префикс <strong>Первая</strong>\n\n<strong>Вторая</strong> хвост');
  });

  it('does not reinterpret ordinary single-line strong pairs as multiline spans', () => {
    expect(
      renderSupportedMarkdownAsHtml(
        '👋 **Ваша публикация удалена.**\n\n**✏️ Условие. **\n\n**💙 **Нужно подписаться',
        { blockMode: 'raw' },
      ),
    ).toBe(
      '👋 <strong>Ваша публикация удалена.</strong>\n\n<strong>✏️ Условие. </strong>\n\n<strong>💙 </strong>Нужно подписаться',
    );
  });

  it('handles a strong span whose closing marker is on its own line', () => {
    const source = '**Одна строка\n\n**';

    expect(renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' })).toBe(
      '<strong>Одна строка</strong>\n\n',
    );
    expect(
      renderSupportedMarkdownAsHtml('**Одна строка\n\n**\nСледующая', { blockMode: 'raw' }),
    ).toBe('<strong>Одна строка</strong>\n\nСледующая');
  });

  it('does not normalize escaped or fenced strong markers', () => {
    expect(renderSupportedMarkdownAsHtml('\\**literal\n\n\\**', { blockMode: 'raw' })).toBe(
      '**literal\n\n**',
    );
    expect(renderSupportedMarkdownAsHtml('```\n**literal\n\n**\n```', { blockMode: 'raw' })).toBe(
      '<pre>**literal\n\n**</pre>',
    );
    expect(renderSupportedMarkdownAsHtml('_A\n```\ncode\n```\nB_', { blockMode: 'raw' })).toBe(
      '_A\n<pre>code</pre>\nB_',
    );
    expect(stripSupportedMarkdownToPlainText('_A\n```\ncode\n```\nB_')).toBe('_A\n\ncode\n\nB_');
  });

  it('does not reinterpret bullets, dividers, URL punctuation, or overlapping malformed runs', () => {
    for (const source of [
      '* пункт 1\n* пункт 2',
      '_ пункт 1\n_ пункт 2',
      '***\nраздел\n***',
      '___\nраздел\n___',
      'https://example.com/a_b\nnext_',
    ]) {
      expect(renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' })).toBe(source);
    }
    expect(renderSupportedMarkdownAsHtml('__A_\nA__', { blockMode: 'raw' }).length).toBeLessThan(
      64,
    );
  });

  it.each([
    ['_A\nsnake_case\nB_', '<em>A</em>\n<em>snake_case</em>\n<em>B</em>', 'A\nsnake_case\nB'],
    ['++A\nC++17\nB++', '<u>A</u>\n<u>C++17</u>\n<u>B</u>', 'A\nC++17\nB'],
    [
      '_A\nhttps://example.com/a_b\nB_',
      '<em>A</em>\n<em>https://example.com/a_b</em>\n<em>B</em>',
      'A\nhttps://example.com/a_b\nB',
    ],
  ])('preserves same-marker punctuation inside a multiline span', (source, html, plain) => {
    expect(renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' })).toBe(html);
    expect(stripSupportedMarkdownToPlainText(source)).toBe(plain);
  });

  it.each([
    ['***', '<strong><em>', '</em></strong>'],
    ['___', '<strong><em>', '</em></strong>'],
    ['**', '<strong>', '</strong>'],
    ['__', '<strong>', '</strong>'],
    ['*', '<em>', '</em>'],
    ['_', '<em>', '</em>'],
    ['++', '<u>', '</u>'],
    ['~~', '<s>', '</s>'],
  ] as const)(
    'closes multiline %s formatting after a URL on the final line',
    (marker, openTag, closeTag) => {
      const source = `${marker}A\nhttps://e.test/B${marker}`;
      expect(renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' })).toBe(
        `${openTag}A${closeTag}\n${openTag}https://e.test/B${closeTag}`,
      );
      expect(stripSupportedMarkdownToPlainText(source)).toBe('A\nhttps://e.test/B');
    },
  );

  it('keeps MAX profile URL underscores literal across line breaks', () => {
    const source = 'max://user/_first\nsecond_';
    expect(renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' })).toBe(source);
    expect(stripSupportedMarkdownToPlainText(source)).toBe(source);
  });

  it('bounds overlapping multiline marker normalization for malformed legacy input', () => {
    const runs = ['*', '**', '***', '_', '__', '___', '++', '~~'];
    for (const left of runs) {
      for (const middle of runs) {
        for (const right of runs) {
          const source = `${left}A${middle}\nB${right}`;
          const rendered = renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' });
          expect(rendered.length).toBeLessThanOrEqual(source.length * 16);
        }
      }
    }
  });

  it('keeps maximum-length adversarial multiline input bounded', () => {
    const source = `${'_a\n'.repeat(1_300)}z_`;
    const startedAt = performance.now();
    const rendered = renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' });

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(rendered).toBe(source);
  });

  it('renders heading and fenced code blocks for MAX publication', () => {
    expect(
      renderSupportedMarkdownAsHtml('# Анонс\n\n```\nconst value = "<MAX>";\n```\n\nТекст', {
        blockMode: 'raw',
      }),
    ).toBe('<h1>Анонс</h1>\n\n<pre>const value = &quot;&lt;MAX&gt;&quot;;</pre>\n\nТекст');
    expect(stripSupportedMarkdownToPlainText('# Анонс\n\n```\nconst value = "<MAX>";\n```')).toBe(
      'Анонс\n\nconst value = "<MAX>";',
    );
  });

  it('renders official MAX highlight and quote syntax without leaking delimiters', () => {
    const source = '## Раздел\n> **Важная** цитата\n^^Фокус _сейчас_^^';

    expect(renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' })).toBe(
      '<h2>Раздел</h2>\n<blockquote><strong>Важная</strong> цитата</blockquote>\n<mark>Фокус <em>сейчас</em></mark>',
    );
    expect(renderSupportedMarkdownAsHtml(source)).toBe(
      '<h2>Раздел</h2><blockquote><strong>Важная</strong> цитата</blockquote><p><mark>Фокус <em>сейчас</em></mark></p>',
    );
    expect(stripSupportedMarkdownToPlainText(source)).toBe(
      'Раздел\n\nВажная цитата\n\nФокус сейчас',
    );
    expect(containsSupportedMarkdownSyntax(source)).toBe(true);
  });

  it('keeps escaped heading, quote, and highlight punctuation literal', () => {
    const source = '\\# заголовок\n\\> цитата\n\\^\\^не выделять\\^\\^';

    expect(renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' })).toBe(
      '# заголовок\n&gt; цитата\n^^не выделять^^',
    );
    expect(stripSupportedMarkdownToPlainText(source)).toBe(
      '# заголовок\n> цитата\n^^не выделять^^',
    );
  });

  it('renders escaped markdown punctuation as literal text', () => {
    expect(renderSupportedMarkdownAsHtml('**Анонс** C\\+\\+ \\[beta\\] \\(v2\\) \\_raw\\_')).toBe(
      '<p><strong>Анонс</strong> C++ [beta] (v2) _raw_</p>',
    );
    expect(
      stripSupportedMarkdownToPlainText('**Анонс** C\\+\\+ \\[beta\\] \\(v2\\) \\_raw\\_'),
    ).toBe('Анонс C++ [beta] (v2) _raw_');
  });

  it('strips supported markdown to plain text', () => {
    expect(
      stripSupportedMarkdownToPlainText(
        '**Заголовок**\nТекст с _курсивом_, ++подчеркиванием++, ~~зачеркиванием~~ и `кодом`.\n\n[Открыть MAX](https://max.ru/)',
      ),
    ).toBe('Заголовок\nТекст с курсивом, подчеркиванием, зачеркиванием и кодом.\n\nОткрыть MAX');
  });

  it('extracts safe markdown links while ignoring code and unsupported schemes', () => {
    expect(
      extractSupportedMarkdownLinks(
        '[Витрина](https://shop.example/path) `https://code.example`\n```\n[x](https://hidden.example)\n```\n[Профиль](max://user/42) [bad](javascript:alert(1))',
      ),
    ).toEqual(['https://shop.example/path', 'max://user/42']);
  });

  it('renders and extracts links with escaped closing brackets in their labels', () => {
    const source = '[A \\] B](https://e.test/)';
    expect(renderSupportedMarkdownAsHtml(source)).toBe(
      '<p><a href="https://e.test/">A ] B</a></p>',
    );
    expect(stripSupportedMarkdownToPlainText(source)).toBe('A ] B');
    expect(extractSupportedMarkdownLinks(source)).toEqual(['https://e.test/']);
    expect(containsSupportedMarkdownSyntax(source)).toBe(true);
  });

  it('finds URLs in link hrefs and Markdown-escaped visible text', () => {
    expect(
      containsSupportedMarkdownUrl('[Сайт](https://site.example/a_b)', 'https://site.example/a_b'),
    ).toBe(true);
    for (const [source, url] of [
      ['https://site.example/a\\_b', 'https://site.example/a_b'],
      ['https://site.example/a\\(b\\)', 'https://site.example/a(b)'],
      ['https://site.example/a\\+b', 'https://site.example/a+b'],
      ['https://site.example/a\\~b', 'https://site.example/a~b'],
    ]) {
      expect(containsSupportedMarkdownUrl(source, url)).toBe(true);
    }
  });
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
