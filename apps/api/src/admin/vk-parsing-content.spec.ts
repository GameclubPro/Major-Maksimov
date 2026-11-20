import { detectVkAdvertisingMarkers } from './vk-parsing-attachments';
import {
  computeVkParsingPostContentHash,
  composeVkParsingPublishText,
  describeVkParsingSkipReason,
  hasVkParsingImportedStrongMarkup,
  prepareVkParsingPublishPayload,
  resolveEffectiveVkParsingTextFormat,
  resolveVkParsingPostSkipReason,
  stripVkParsingLinksFromText,
} from './vk-parsing-content';

describe('vk-parsing-content', () => {
  const baseSettings = {
    stripLinksEnabled: false,
    skipAdsEnabled: false,
  };

  it('recognizes only paired non-empty single-line VK strong markup', () => {
    expect(
      hasVkParsingImportedStrongMarkup(
        '**АРАХИСОВАЯ ПАСТА: ПОЛЬЗА И ВРЕД**\nТекст поста\n**КАК ВЫБРАТЬ?**',
      ),
    ).toBe(true);
    expect(hasVkParsingImportedStrongMarkup('Префикс **Заголовок** и продолжение')).toBe(true);

    for (const text of [
      '*одинарные звездочки*',
      '**незакрытый текст',
      '****',
      '**   **',
      '**первая строка\nвторая строка**',
      '***жирный курсив***',
      '\\**экранированный текст**',
    ]) {
      expect(hasVkParsingImportedStrongMarkup(text)).toBe(false);
    }
  });

  it('infers markdown only for untouched imported VK text', () => {
    expect(
      resolveEffectiveVkParsingTextFormat({
        text: '**Заголовок**',
        textFormat: 'plain',
        manualContentEditedAt: null,
      }),
    ).toBe('markdown');
    expect(
      resolveEffectiveVkParsingTextFormat({
        text: '**Заголовок**',
        textFormat: 'plain',
        manualContentEditedAt: new Date('2026-07-30T10:00:00.000Z'),
      }),
    ).toBe('plain');
    expect(
      resolveEffectiveVkParsingTextFormat({
        text: 'Текст без разметки',
        textFormat: 'markdown',
        manualContentEditedAt: new Date('2026-07-30T10:00:00.000Z'),
      }),
    ).toBe('markdown');
  });

  it('appends selected links that are missing from the text', () => {
    expect(
      composeVkParsingPublishText('Новость\nhttps://vk.ru/already-there', [
        'https://vk.ru/already-there',
        'https://example.com/missing',
      ]),
    ).toBe('Новость\nhttps://vk.ru/already-there\nhttps://example.com/missing');
  });

  it('strips inline and attached links when link stripping is enabled', () => {
    const prepared = prepareVkParsingPublishPayload(
      {
        text: 'Смотрите https://example.com/a\nи vk.ru/public',
        textFormat: 'plain',
        photoUrls: ['https://sun.example/photo.jpg'],
        videoUrls: [],
        linkUrls: ['https://example.com/a'],
      },
      { stripLinksEnabled: true },
    );

    expect(prepared).toEqual({
      text: 'Смотрите\nи',
      textFormat: 'plain',
      photoUrls: ['https://sun.example/photo.jpg'],
      videoUrls: [],
      linkUrls: [],
    });
    expect(stripVkParsingLinksFromText('текст www.example.com  хвост')).toBe('текст хвост');
    expect(stripVkParsingLinksFromText('Читайте [наш канал](https://max.ru/news)')).toBe(
      'Читайте наш канал',
    );
    expect(stripVkParsingLinksFromText('Текст https://site.example/a\\_\\(b\\)\\+\\~c хвост')).toBe(
      'Текст хвост',
    );
  });

  it('preserves labels when stripping valid Markdown targets amid ordinary brackets', () => {
    expect(
      stripVkParsingLinksFromText(
        '[заметка] [сайт](HTTPS://example.com/a) [ссылка](max://user/12) \n[ещё]',
      ),
    ).toBe('[заметка] сайт ссылка\n[ещё]');
    expect(stripVkParsingLinksFromText('[журнал [открыть](max://user/12)')).toBe('журнал [открыть');
    expect(stripVkParsingLinksFromText('один\tдва \t \n \t три  четыре')).toBe(
      'один\tдва\nтри четыре',
    );
  });

  it('detects ERID in attachment text with optional separators and whitespace', () => {
    for (const title of ['ERID Z012', 'erid : Z012', 'erid= Z012']) {
      expect(
        detectVkAdvertisingMarkers({
          text: '',
          attachments: [{ type: 'link', link: { title } }],
          rawPost: {},
        }),
      ).toContain(title);
    }
    expect(
      detectVkAdvertisingMarkers({
        text: 'erid: Z01',
        attachments: [],
        rawPost: {},
      }),
    ).toEqual([]);
  });

  it('preserves explicit fallback links when link stripping is enabled', () => {
    const preservedUrl = 'https://vk.ru/wall-36819802_104';
    const prepared = prepareVkParsingPublishPayload(
      {
        text: '',
        textFormat: 'plain',
        photoUrls: [],
        videoUrls: [],
        linkUrls: [preservedUrl, 'https://example.com/regular'],
      },
      { stripLinksEnabled: true },
      { preserveLinkUrls: [preservedUrl] },
    );

    expect(prepared).toEqual({
      text: preservedUrl,
      textFormat: 'plain',
      photoUrls: [],
      videoUrls: [],
      linkUrls: [preservedUrl],
    });
  });

  it('returns empty-after-link-filter skip reason for link-only posts', () => {
    expect(
      resolveVkParsingPostSkipReason(
        {
          text: 'https://example.com/only-link',
          photoUrls: [],
          videoUrls: [],
          linkUrls: ['https://example.com/only-link'],
          attachments: [],
          raw: {},
        },
        { ...baseSettings, stripLinksEnabled: true },
      ),
    ).toBe('EMPTY_AFTER_LINK_FILTER');
  });

  it('does not skip a link-only fallback when the link is explicitly preserved', () => {
    const preservedUrl = 'https://vk.ru/wall-36819802_104';

    expect(
      resolveVkParsingPostSkipReason(
        {
          text: '',
          photoUrls: [],
          videoUrls: [],
          linkUrls: [preservedUrl],
          attachments: [],
          raw: {},
        },
        { ...baseSettings, stripLinksEnabled: true },
        { preserveLinkUrls: [preservedUrl] },
      ),
    ).toBeNull();
  });

  it('returns ad skip reason from cached flags and VK raw markers', () => {
    expect(
      resolveVkParsingPostSkipReason(
        {
          text: 'обычный текст',
          photoUrls: [],
          videoUrls: [],
          linkUrls: [],
          attachments: [],
          raw: {},
          isAdvertising: 'yes',
        },
        { ...baseSettings, skipAdsEnabled: true },
      ),
    ).toBe('AD');

    expect(
      resolveVkParsingPostSkipReason(
        {
          text: 'обычный текст',
          photoUrls: [],
          videoUrls: [],
          linkUrls: [],
          attachments: [],
          raw: { marked_as_ads: 1 },
        },
        { ...baseSettings, skipAdsEnabled: true },
      ),
    ).toBe('AD');
  });

  it('describes skip reasons with user-facing messages', () => {
    expect(describeVkParsingSkipReason('AD')).toBe('Пост пропущен фильтром рекламы.');
    expect(describeVkParsingSkipReason('EMPTY_AFTER_LINK_FILTER')).toBe(
      'Пост пропущен: после удаления ссылок не осталось содержимого.',
    );
    expect(describeVkParsingSkipReason('NO_SUPPORTED_CONTENT')).toBe(
      'Пост пропущен: в VK-записи нет поддерживаемого текста, фото, видео или ссылок.',
    );
  });

  it('keeps content hash stable for identical normalized content', () => {
    const left = computeVkParsingPostContentHash({
      text: '  Пост  ',
      photoUrls: ['https://sun.example/a.jpg'],
      videoUrls: [],
      linkUrls: ['https://example.com/a'],
      attachmentTypes: ['photo'],
      advertisingMarkers: ['erid:abc'],
    });
    const right = computeVkParsingPostContentHash({
      text: 'Пост',
      photoUrls: ['https://sun.example/a.jpg'],
      videoUrls: [],
      linkUrls: ['https://example.com/a'],
      attachmentTypes: ['photo'],
      advertisingMarkers: ['erid:abc'],
    });
    const changed = computeVkParsingPostContentHash({
      text: 'Пост',
      photoUrls: ['https://sun.example/b.jpg'],
      videoUrls: [],
      linkUrls: ['https://example.com/a'],
      attachmentTypes: ['photo'],
      advertisingMarkers: ['erid:abc'],
    });

    expect(left).toBe(right);
    expect(changed).not.toBe(left);
  });
});
