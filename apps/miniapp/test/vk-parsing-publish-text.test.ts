import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VK_PARSING_MAX_CHANNEL_LINK_URL_LENGTH,
  VK_PARSING_MAX_PUBLISH_TEXT_LENGTH,
} from '@maxim/contracts';
import {
  resolveVkParsingFallbackLink,
  resolveVkParsingInitialLinkSelection,
} from '../src/components/vk-parsing/link-selection';
import {
  measureVkParsingPublishTextLength,
  stripVkParsingLinksFromText,
} from '../src/components/vk-parsing/publish-text';

test('VK publish length keeps plain text literal without a signature', () => {
  assert.equal(
    measureVkParsingPublishTextLength({
      text: '**скидка** & <цена>',
      textFormat: 'plain',
      linkUrls: [],
      stripLinksEnabled: false,
      appendChannelLinkEnabled: false,
      channelLinkText: '',
    }),
    '**скидка** & <цена>'.length,
  );
});

test('VK publish length includes escaped plain HTML and the reserved channel URL', () => {
  const label = 'Наш <канал>';
  const expected = [
    '&amp;&amp;',
    `<a href="${'x'.repeat(VK_PARSING_MAX_CHANNEL_LINK_URL_LENGTH)}">Наш &lt;канал&gt;</a>`,
  ].join('\n\n').length;

  assert.equal(
    measureVkParsingPublishTextLength({
      text: '&&',
      textFormat: 'plain',
      linkUrls: [],
      stripLinksEnabled: false,
      appendChannelLinkEnabled: true,
      channelLinkText: label,
    }),
    expected,
  );
  assert.ok(expected < VK_PARSING_MAX_PUBLISH_TEXT_LENGTH);
});

test('VK publish length uses server-parity raw HTML for formatted headings', () => {
  assert.equal(
    measureVkParsingPublishTextLength({
      text: '# Анонс',
      textFormat: 'markdown',
      linkUrls: [],
      stripLinksEnabled: false,
      appendChannelLinkEnabled: false,
      channelLinkText: '',
    }),
    '<h1>Анонс</h1>'.length,
  );
});

test('VK publish length matches server formatting for legacy multiline markdown', () => {
  const text = '**Первая\nВторая**';
  const rendered = '<strong>Первая</strong>\n<strong>Вторая</strong>';

  assert.equal(
    measureVkParsingPublishTextLength({
      text,
      textFormat: 'markdown',
      linkUrls: [],
      stripLinksEnabled: false,
      appendChannelLinkEnabled: false,
      channelLinkText: '',
    }),
    rendered.length,
  );
});

test('VK publish length includes selected links appended by the API', () => {
  const text = 'Текст';
  const link = `https://example.com/${'x'.repeat(80)}`;
  assert.equal(
    measureVkParsingPublishTextLength({
      text,
      textFormat: 'plain',
      linkUrls: [link],
      stripLinksEnabled: false,
      appendChannelLinkEnabled: false,
      channelLinkText: '',
    }),
    `${text}\n${link}`.length,
  );
});

test('VK publish length treats selected markdown URLs as safe HTML anchors', () => {
  const text = '**Смотрите**';
  const link = 'https://example.com/a_b_c';
  const expected = `<strong>Смотрите</strong>\n<a href="${link}">${link}</a>`.length;

  assert.equal(
    measureVkParsingPublishTextLength({
      text,
      textFormat: 'markdown',
      linkUrls: [link],
      stripLinksEnabled: false,
      appendChannelLinkEnabled: false,
      channelLinkText: '',
    }),
    expected,
  );
});

test('VK publish length does not append a selected URL already visible through escapes', () => {
  const url = 'https://example.com/a_b';
  const text = 'Смотрите https://example.com/a\\_b';

  assert.equal(
    measureVkParsingPublishTextLength({
      text,
      textFormat: 'markdown',
      linkUrls: [url],
      stripLinksEnabled: false,
      appendChannelLinkEnabled: false,
      channelLinkText: '',
    }),
    text.length,
  );
});

test('VK link stripping removes one Markdown-escaped bare URL atomically', () => {
  assert.equal(
    stripVkParsingLinksFromText('Текст https://site.example/a\\_\\(b\\)\\+\\~c хвост'),
    'Текст хвост',
  );
});

test('VK publish length canonicalizes the fallback channel URL like the API', () => {
  const text = 'Пост';
  const channelLink = 'http://www.max.ru/our-channel?from=preview#latest';
  const signature = '<a href="https://max.ru/our-channel">Наш канал</a>';

  assert.equal(
    measureVkParsingPublishTextLength({
      text,
      textFormat: 'plain',
      linkUrls: [],
      stripLinksEnabled: false,
      appendChannelLinkEnabled: true,
      channelLinkText: 'Наш канал',
      channelLinkUrl: channelLink,
    }),
    `${text}\n\n${signature}`.length,
  );
});

test('VK publish length uses an external custom signature URL instead of the reserved maximum', () => {
  const text = 'Пост';
  const customUrl = 'https://example.com/advertising/contact?source=max';
  const signature = `<a href="${customUrl}">Заказать рекламу</a>`;

  assert.equal(
    measureVkParsingPublishTextLength({
      text,
      textFormat: 'plain',
      linkUrls: [],
      stripLinksEnabled: false,
      appendChannelLinkEnabled: true,
      channelLinkText: 'Заказать рекламу',
      channelLinkUrl: 'https://max.ru/our-channel',
      customChannelLinkUrl: customUrl,
    }),
    `${text}\n\n${signature}`.length,
  );
});

test('VK publish length preserves query and hash in an explicit MAX signature URL', () => {
  const customUrl = 'https://max.ru/advertising-manager?source=channel#contact';
  const signature = `<a href="${customUrl}">Связаться</a>`;

  assert.equal(
    measureVkParsingPublishTextLength({
      text: 'Пост',
      textFormat: 'plain',
      linkUrls: [],
      stripLinksEnabled: false,
      appendChannelLinkEnabled: true,
      channelLinkText: 'Связаться',
      channelLinkUrl: 'https://max.ru/our-channel',
      customChannelLinkUrl: customUrl,
    }),
    `Пост\n\n${signature}`.length,
  );
});

test('VK publish length counts HTML expansion in a valid custom signature URL', () => {
  const customUrl = `https://example.com/contact?${Array.from(
    { length: 25 },
    (_, index) => `p${index}=x`,
  ).join('&')}`;
  const escapedCustomUrl = customUrl.replace(/&/gu, '&amp;');
  const signature = `<a href="${escapedCustomUrl}">Связаться</a>`;

  assert.ok(customUrl.length <= VK_PARSING_MAX_CHANNEL_LINK_URL_LENGTH);
  assert.ok(escapedCustomUrl.length > VK_PARSING_MAX_CHANNEL_LINK_URL_LENGTH);
  assert.equal(
    measureVkParsingPublishTextLength({
      text: 'Пост',
      textFormat: 'plain',
      linkUrls: [],
      stripLinksEnabled: false,
      appendChannelLinkEnabled: true,
      channelLinkText: 'Связаться',
      channelLinkUrl: 'https://max.ru/our-channel',
      customChannelLinkUrl: customUrl,
    }),
    `Пост\n\n${signature}`.length,
  );
});

test('VK publish length strips inline links but keeps the selected video fallback', () => {
  const fallbackUrl = `https://vk.com/wall-1_42?preview=${'x'.repeat(80)}`;
  const expected = `Текст\n${fallbackUrl}`;

  assert.equal(
    measureVkParsingPublishTextLength({
      text: 'Текст https://example.com/remove',
      textFormat: 'plain',
      linkUrls: [fallbackUrl, 'https://example.com/remove'],
      stripLinksEnabled: true,
      appendChannelLinkEnabled: false,
      channelLinkText: '',
      preserveLinkUrls: [fallbackUrl],
    }),
    expected.length,
  );
});

test('VK publish length keeps the request guard after stripping markdown links', () => {
  const text = '**Текст** [магазин](https://example.com/remove)';
  assert.equal(
    measureVkParsingPublishTextLength({
      text,
      textFormat: 'markdown',
      linkUrls: ['https://example.com/remove'],
      stripLinksEnabled: true,
      appendChannelLinkEnabled: false,
      channelLinkText: '',
    }),
    text.length,
  );
});

test('VK strip mode keeps only an unsupported video or clip fallback link selected', () => {
  const post = {
    url: 'https://vk.com/wall-1_42',
    photoUrls: [],
    videoUrls: [],
    linkUrls: ['https://vk.com/wall-1_42', 'https://example.com/remove'],
    unsupportedAttachments: [{ type: 'clip', label: 'Клип', count: 1 }],
  } as never;

  assert.equal(resolveVkParsingFallbackLink(post), post.url);
  assert.deepEqual(resolveVkParsingInitialLinkSelection(post, true), [post.url]);
  assert.deepEqual(resolveVkParsingInitialLinkSelection(post, false), post.linkUrls);
});

test('VK fallback link is not promised when publishable media is available', () => {
  const post = {
    url: 'https://vk.com/wall-1_42',
    photoUrls: ['https://cdn.example.com/photo.jpg'],
    videoUrls: [],
    linkUrls: ['https://vk.com/wall-1_42'],
    unsupportedAttachments: [{ type: 'video', label: 'Видео', count: 1 }],
  } as never;

  assert.equal(resolveVkParsingFallbackLink(post), null);
  assert.deepEqual(resolveVkParsingInitialLinkSelection(post, true), []);
});

test('VK preview counts source attribution after stripping body links', () => {
  const sourceLinkHtml = '<a href="https://vk.com/wall-1_2">Источник</a>';
  assert.equal(
    measureVkParsingPublishTextLength({
      text: 'Текст & https://example.com',
      textFormat: 'plain',
      linkUrls: [],
      stripLinksEnabled: true,
      appendChannelLinkEnabled: false,
      channelLinkText: '',
      sourceLinkHtml,
    }),
    `Текст &amp;\n\n${sourceLinkHtml}`.length,
  );
});
