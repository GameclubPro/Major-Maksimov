import {
  buildMessageDuplicateIdentity,
  extractDuplicateMessageContent,
  canRefreshDuplicatePhotoSources,
  digestDuplicateContent,
  exactImageSourceDigest,
  isDuplicateContentComparable,
} from './message-duplicate-content';
import { WebhookParser } from '../../webhook/webhook.parser';

const content = (body: Record<string, unknown>, extra = {}) =>
  extractDuplicateMessageContent({ message: { body, ...extra } });
const identity = (body: Record<string, unknown>) =>
  buildMessageDuplicateIdentity(content(body), 'MESSAGE');
const photo = (id: string) => ({
  type: 'image',
  payload: { photo_id: id, url: `https://i.oneme.ru/${id}` },
});

describe('message duplicate canonical contents', () => {
  it.each(['array', 'dotted-key', 'root-search'])(
    'compares the same source selected by ingress in a %s envelope',
    (shape) => {
      const message = {
        sender: { user_id: 123 },
        recipient: { chat_id: -123, chat_type: 'chat' },
        timestamp: Date.now() - 1000,
        body: { mid: 'offer', text: 'Одинаковое объявление', attachments: [photo('a')] },
      };
      const envelope =
        shape === 'array'
          ? { data: { items: [message] } }
          : shape === 'dotted-key'
            ? { data: { 'item.with.dot': message } }
            : { transport: { item: message } };
      const update = new WebhookParser().parse({
        update_type: 'message_created',
        timestamp: message.timestamp,
        ...envelope,
      });
      expect(update.message?.messageId).toBe('offer');
      const extracted = extractDuplicateMessageContent(update.raw);
      expect(extracted.complete).toBe(true);
      expect(extracted.rawText).toBe(message.body.text);
      expect(extracted.sourceDigest).toBe(extractDuplicateMessageContent({ message }).sourceDigest);
      expect(buildMessageDuplicateIdentity(extracted, 'IMAGE', ['a'.repeat(64)])).not.toBeNull();
    },
  );

  it('compares a direct MAX content row during final source verification', () => {
    const row = { content: { mid: 'offer', text: 'Одинаковое объявление' } };
    const extracted = extractDuplicateMessageContent(row, false);
    expect(extracted.complete).toBe(true);
    expect(buildMessageDuplicateIdentity(extracted, 'MESSAGE')).toBe(
      identity({ text: 'Одинаковое объявление' }),
    );
  });

  it.each(['TEXT', 'MESSAGE'] as const)(
    'binds numeric quantity-unit case to %s identity and source evidence',
    (mode) => {
      for (const [first, second] of [
        ['100 MB/s', '100 Mb/s'],
        ['10 MΩ', '10 mΩ'],
        ['5 MW', '5 mW'],
        ['10 Ms', '10 ms'],
      ]) {
        const original = content({ text: `Параметр устройства составляет ${first} сегодня` });
        const edited = content({ text: `Параметр устройства составляет ${second} сегодня` });
        expect(original.sourceDigest).not.toBe(edited.sourceDigest);
        expect(buildMessageDuplicateIdentity(original, mode)).not.toBe(
          buildMessageDuplicateIdentity(edited, mode),
        );
        const cosmetic = content({ text: ` ПАРАМЕТР  устройства составляет ${first}\nСЕГОДНЯ ` });
        expect(cosmetic.sourceDigest).toBe(original.sourceDigest);
        expect(buildMessageDuplicateIdentity(cosmetic, mode)).toBe(
          buildMessageDuplicateIdentity(original, mode),
        );
      }
    },
  );
  it.each(['image_url', 'imageUrl'] as const)(
    'reads the existing MAX %s photo field variants',
    (key) => {
      for (const nested of [true, false]) {
        const fields = { photoId: 'photo', [key]: 'https://i.oneme.ru/photo' };
        const parsed = content({
          attachments: [
            { type: 'image', ...(nested ? { payload: fields } : { ...fields, payload: {} }) },
          ],
        });
        expect(parsed.complete).toBe(true);
        expect(parsed.media).toEqual([
          expect.objectContaining({ photoId: 'photo', url: 'https://i.oneme.ru/photo' }),
        ]);
      }
    },
  );
  it('never refreshes an anonymous photo from a different source URL', () => {
    const original = content({
      attachments: [{ type: 'image', payload: { url: 'https://i.oneme.ru/a' } }],
    });
    const fresh = content({
      attachments: [{ type: 'image', payload: { url: 'https://i.oneme.ru/b' } }],
    });
    expect(canRefreshDuplicatePhotoSources(original, fresh)).toBe(false);
    expect(original.sourceDigest).not.toBe(fresh.sourceDigest);
  });
  it('keeps a message-bound photo source stable across URL renewal, never across photo replacement', () => {
    const original = content({ attachments: [photo('a')] });
    const renewed = content({
      attachments: [
        { type: 'image', payload: { photo_id: 'a', url: 'https://i.oneme.ru/renewed' } },
      ],
    });
    expect(renewed.sourceDigest).toBe(original.sourceDigest);
    expect(renewed.media[0]!.identity).not.toBe(original.media[0]!.identity);
    expect(content({ attachments: [photo('b')] }).sourceDigest).not.toBe(original.sourceDigest);
    expect(buildMessageDuplicateIdentity(renewed, 'MESSAGE')).toBeNull();
  });
  it.each(['a', '\u0434\u0430', '\u{1f44d}', '1', '!'])(
    'compares nonempty short text %s',
    (text) => {
      expect(identity({ text })).toMatch(/^[a-f0-9]{64}$/);
      expect(identity({ text: ` ${text.toUpperCase()}\n` })).toBe(identity({ text }));
    },
  );
  it('does not compare empty text or discard punctuation, numbers, or emoji joiners', () => {
    expect(identity({ text: '  ' })).toBeNull();
    expect(identity({ text: '1' })).not.toBe(identity({ text: '2' }));
    expect(identity({ text: 'yes!' })).not.toBe(identity({ text: 'yes?' }));
    expect(identity({ text: '\u{1f469}\u200d\u{1f4bb}' })).not.toBe(
      identity({ text: '\u{1f469}\u{1f4bb}' }),
    );
  });
  it('treats direct text, captions, and explicit forward contents equally', () => {
    const forwarded = content(
      {},
      { link: { type: 'forward', message: { body: { text: 'hello' } } } },
    );
    expect(buildMessageDuplicateIdentity(forwarded, 'MESSAGE')).toBe(identity({ text: 'hello' }));
    expect(identity({ caption: 'hello' })).toBe(identity({ text: 'hello' }));
    expect(
      buildMessageDuplicateIdentity(
        content({}, { forwarded_message: { body: { text: 'hello' } } }),
        'MESSAGE',
      ),
    ).toBe(identity({ text: 'hello' }));
  });
  it('does not count reply quotations as content', () => {
    expect(
      buildMessageDuplicateIdentity(
        content(
          { text: 'answer' },
          { link: { type: 'reply', message: { body: { text: 'quoted' } } } },
        ),
        'MESSAGE',
      ),
    ).toBe(identity({ text: 'answer' }));
  });
  it('ignores formatting while preserving hidden links and keyboard actions', () => {
    expect(identity({ text: 'hello', markup: [{ type: 'strong', from: 0, length: 5 }] })).toBe(
      identity({ text: 'hello' }),
    );
    const hidden = (url: string) => ({
      text: 'hello',
      markup: [{ type: 'link', from: 0, length: 5, url }],
    });
    expect(identity(hidden('https://example.com/a'))).not.toBe(
      identity(hidden('https://example.com/b')),
    );
    const buttons = (payload: string) => ({
      text: 'hello',
      attachments: [
        {
          type: 'inline_keyboard',
          payload: { buttons: [[{ type: 'callback', text: 'open', payload }]] },
        },
      ],
    });
    expect(identity(buttons('a'))).not.toBe(identity(buttons('b')));
  });
  it.each(['TEXT', 'MESSAGE'] as const)(
    'binds hidden destinations to their anchors and repeated anchor positions in %s',
    (mode) => {
      const linked = (swapped: boolean, text = 'Buy iPhone Buy Samsung') =>
        content({
          text,
          markup: ['iPhone', 'Samsung'].map((anchor, index) => ({
            type: 'link',
            from: text.indexOf(anchor),
            length: anchor.length,
            url: `https://example.com/${swapped ? 1 - index : index}`,
          })),
        });
      const original = linked(false);
      const swapped = linked(true);
      const cosmetic = linked(false, '  Buy   iPhone\nBuy Samsung  ');
      expect(buildMessageDuplicateIdentity(original, mode)).not.toBe(
        buildMessageDuplicateIdentity(swapped, mode),
      );
      expect(swapped.sourceDigest).not.toBe(original.sourceDigest);
      expect(buildMessageDuplicateIdentity(cosmetic, mode)).toBe(
        buildMessageDuplicateIdentity(original, mode),
      );
      expect(cosmetic.sourceDigest).toBe(original.sourceDigest);
      const repeated = (from: number) =>
        content({
          text: 'Buy Buy',
          markup: [{ type: 'link', from, length: 3, url: 'https://example.com/item' }],
        });
      expect(buildMessageDuplicateIdentity(repeated(0), mode)).not.toBe(
        buildMessageDuplicateIdentity(repeated(4), mode),
      );
    },
  );
  it.each(['TEXT', 'MESSAGE'] as const)(
    'preserves the order of case-sensitive visible URL destinations in %s',
    (mode) => {
      const first = content({ text: 'https://example.com/One https://example.com/one' });
      const swapped = content({ text: 'https://example.com/one https://example.com/One' });
      const repeat = content({ text: '  https://example.com/one\nhttps://example.com/One  ' });
      expect(first.complete).toBe(true);
      expect(swapped.complete).toBe(true);
      expect(first.sourceDigest).not.toBe(swapped.sourceDigest);
      expect(buildMessageDuplicateIdentity(first, mode)).not.toBe(
        buildMessageDuplicateIdentity(swapped, mode),
      );
      expect(repeat.sourceDigest).toBe(swapped.sourceDigest);
      expect(buildMessageDuplicateIdentity(repeat, mode)).toBe(
        buildMessageDuplicateIdentity(swapped, mode),
      );
    },
  );
  it('keeps deployed lower-case visible URL identities and source digests', () => {
    const parsed = content({ text: 'Visit https://example.com/one' });
    const navigation = ['external_url:https://example.com/one'];
    expect(parsed.sourceDigest).toBe(
      digestDuplicateContent({
        text: 'visit https://example.com/one',
        navigation,
        actions: [],
        media: [],
      }),
    );
    expect(buildMessageDuplicateIdentity(parsed, 'TEXT')).toBe(
      digestDuplicateContent({
        version: 1,
        mode: 'TEXT',
        text: 'visit https://example.com/one',
        navigation,
        actions: [],
        media: [],
      }),
    );
  });
  it('maps forward-local hidden anchor ranges into the joined comparison text', () => {
    const markup = [{ type: 'link', from: 0, length: 3, url: 'https://example.com/item' }];
    const forwarded = content(
      { text: 'Buy' },
      { forwarded_message: { body: { text: 'Buy', markup } } },
    );
    const direct = content({
      text: 'Buy\nBuy',
      markup: [{ ...markup[0], from: 4 }],
    });
    const moved = content({ text: 'Buy\nBuy', markup });
    expect(buildMessageDuplicateIdentity(forwarded, 'TEXT')).toBe(
      buildMessageDuplicateIdentity(direct, 'TEXT'),
    );
    expect(forwarded.sourceDigest).toBe(direct.sourceDigest);
    expect(buildMessageDuplicateIdentity(forwarded, 'TEXT')).not.toBe(
      buildMessageDuplicateIdentity(moved, 'TEXT'),
    );
  });
  it('binds user mentions to their visible anchors', () => {
    const mentioned = (swapped: boolean) =>
      content({
        text: 'Alice Bob',
        markup: [
          { type: 'user_mention', from: 0, length: 5, user_id: swapped ? 202 : 101 },
          { type: 'user_mention', from: 6, length: 3, user_id: swapped ? 101 : 202 },
        ],
      });
    const first = mentioned(false);
    const swapped = mentioned(true);
    expect(first.complete).toBe(true);
    expect(swapped.complete).toBe(true);
    expect(buildMessageDuplicateIdentity(first, 'TEXT')).not.toBe(
      buildMessageDuplicateIdentity(swapped, 'TEXT'),
    );
    expect(first.sourceDigest).not.toBe(swapped.sourceDigest);
  });
  it('preserves old plain-text identities and rejects old unbound markup source digests', () => {
    const plain = content({ text: 'Buy' });
    const linked = content({
      text: 'Buy',
      markup: [{ type: 'link', from: 0, length: 3, url: 'https://example.com/item' }],
    });
    expect(buildMessageDuplicateIdentity(plain, 'TEXT')).toBe(
      digestDuplicateContent({
        version: 1,
        mode: 'TEXT',
        text: 'buy',
        navigation: [],
        actions: [],
        media: [],
      }),
    );
    expect(linked.sourceDigest).not.toBe(
      digestDuplicateContent({
        text: 'buy',
        navigation: ['external_url:https://example.com/item'],
        actions: [],
        media: [],
      }),
    );
  });
  it.each(['callback', 'link'] as const)(
    'preserves image captions policy but binds %s keyboard actions in equality and sources',
    (type) => {
      const withButton = (value: string, text = 'caption') =>
        content({
          text,
          attachments: [
            photo('a'),
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type,
                      text: 'Open',
                      ...(type === 'callback' ? { payload: value } : { url: value }),
                    },
                  ],
                ],
              },
            },
          ],
        });
      const first = withButton('https://example.com/a');
      const different = withButton('https://example.com/b');
      const same = withButton('https://example.com/a', 'Different caption');
      const plain = content({ attachments: [photo('a')] });
      const hashes = ['a'.repeat(64)];
      expect(buildMessageDuplicateIdentity(first, 'IMAGE', hashes)).not.toBe(
        buildMessageDuplicateIdentity(different, 'IMAGE', hashes),
      );
      expect(buildMessageDuplicateIdentity(first, 'IMAGE', hashes)).toBe(
        buildMessageDuplicateIdentity(same, 'IMAGE', hashes),
      );
      expect(buildMessageDuplicateIdentity(first, 'IMAGE', hashes)).not.toBe(
        buildMessageDuplicateIdentity(plain, 'IMAGE', hashes),
      );
      expect(exactImageSourceDigest(first)).not.toBe(exactImageSourceDigest(different));
      expect(exactImageSourceDigest(first)).not.toBe(exactImageSourceDigest(plain));
      expect(exactImageSourceDigest(first)).toBe(exactImageSourceDigest(same));
      expect(canRefreshDuplicatePhotoSources(first, different, true)).toBe(false);
      expect(canRefreshDuplicatePhotoSources(first, same, true)).toBe(true);
    },
  );
  it('keeps deployed photo-only digests and rejects legacy keyboard bindings', () => {
    const plain = content({ attachments: [photo('a')] });
    const hashes = ['a'.repeat(64)];
    expect(buildMessageDuplicateIdentity(plain, 'IMAGE', hashes)).toBe(
      digestDuplicateContent({ version: 1, mode: 'IMAGE', images: hashes }),
    );
    expect(exactImageSourceDigest(plain)).toBe(
      digestDuplicateContent([digestDuplicateContent(['photo', 'a'])]),
    );
    const legacyKeyboard = {
      ...plain,
      actions: [digestDuplicateContent([[{ type: 'callback', text: 'Open', payload: 'a' }]])],
    };
    expect(exactImageSourceDigest(legacyKeyboard)).not.toBe(exactImageSourceDigest(plain));
    expect(buildMessageDuplicateIdentity(legacyKeyboard, 'IMAGE', hashes)).not.toBe(
      buildMessageDuplicateIdentity(plain, 'IMAGE', hashes),
    );
  });
  it('requires independently verified media hashes, not ids, names, sizes or URLs', () => {
    const a = content({ text: 'caption', attachments: [photo('a')] });
    const b = content({ text: 'caption', attachments: [photo('b')] });
    expect(buildMessageDuplicateIdentity(a, 'MESSAGE')).toBeNull();
    expect(buildMessageDuplicateIdentity(a, 'MESSAGE', ['a'.repeat(64)])).toBe(
      buildMessageDuplicateIdentity(b, 'MESSAGE', ['a'.repeat(64)]),
    );
    expect(buildMessageDuplicateIdentity(a, 'MESSAGE', ['a'.repeat(64)])).not.toBe(
      buildMessageDuplicateIdentity(b, 'MESSAGE', ['b'.repeat(64)]),
    );
    expect(buildMessageDuplicateIdentity(a, 'TEXT')).toBe(buildMessageDuplicateIdentity(b, 'TEXT'));
  });
  it.each(['callback', 'link'] as const)(
    'requires caption text before using a shared %s keyboard as text evidence for media',
    (type) => {
      const keyboard = {
        type: 'inline_keyboard',
        payload: {
          buttons: [
            [
              {
                type,
                text: 'Open',
                ...(type === 'link' ? { url: 'https://example.com' } : { payload: 'open' }),
              },
            ],
          ],
        },
      };
      for (const attachment of [photo('a'), { type: 'file', payload: {} }]) {
        expect(
          buildMessageDuplicateIdentity(content({ attachments: [attachment, keyboard] }), 'TEXT'),
        ).toBeNull();
        expect(
          buildMessageDuplicateIdentity(
            content({ text: 'Actual caption', attachments: [attachment, keyboard] }),
            'TEXT',
          ),
        ).not.toBeNull();
      }
      expect(
        buildMessageDuplicateIdentity(content({ attachments: [keyboard] }), 'TEXT'),
      ).not.toBeNull();
    },
  );
  it('compares complete albums as one object, never a subset or split package', () => {
    const album = content({ attachments: [photo('a'), photo('b')] });
    expect(buildMessageDuplicateIdentity(album, 'MESSAGE', ['a'.repeat(64)])).toBeNull();
    expect(
      buildMessageDuplicateIdentity(album, 'MESSAGE', ['a'.repeat(64), 'b'.repeat(64)]),
    ).not.toBeNull();
    expect(content({ attachments: [photo('a')], media_group_id: 'group' }).complete).toBe(false);
  });
  it('does not let unknown attachments or malformed buttons disappear in TEXT mode', () => {
    const unknown = content({
      text: 'caption',
      attachments: [{ type: 'future_navigation', payload: {} }],
    });
    expect(buildMessageDuplicateIdentity(unknown, 'TEXT')).toBeNull();
    expect(
      buildMessageDuplicateIdentity(
        content({
          text: 'caption',
          attachments: [
            { type: 'file', payload: {} },
            { type: 'inline_keyboard', payload: { buttons: 'bad' } },
          ],
        }),
        'TEXT',
      ),
    ).toBeNull();
  });
  it('permits TEXT captions with unavailable known media, but fails closed on oversized content', () => {
    expect(
      buildMessageDuplicateIdentity(
        content({ caption: 'caption', attachments: [{ type: 'file', payload: {} }] }),
        'TEXT',
      ),
    ).not.toBeNull();
    expect(identity({ text: 'x'.repeat(8001) })).toBeNull();
    expect(identity({ attachments: Array.from({ length: 11 }, () => photo('a')) })).toBeNull();
  });

  it.each(['photo', 'video', 'audio', 'file', 'sticker', 'contact', 'location'])(
    'allows known unavailable %s only in TEXT, consistently with identity eligibility',
    (type) => {
      const parsed = content({ text: 'caption', attachments: [{ type, payload: {} }] });
      expect(parsed.reason).toBe('unsupported_attachment');
      expect(isDuplicateContentComparable(parsed, 'TEXT')).toBe(true);
      expect(buildMessageDuplicateIdentity(parsed, 'TEXT')).not.toBeNull();
      for (const mode of ['MESSAGE', 'IMAGE'] as const) {
        expect(isDuplicateContentComparable(parsed, mode)).toBe(false);
        expect(buildMessageDuplicateIdentity(parsed, mode, ['a'.repeat(64)])).toBeNull();
      }
    },
  );

  it.each([
    { text: 'caption', attachments: [{ type: 'unknown', payload: {} }] },
    { text: 'caption', attachments: [{ type: 'inline_keyboard', payload: { buttons: 'bad' } }] },
    { text: 'caption', media_group_id: 'split' },
    { text: 'caption'.repeat(2000) },
  ])('rejects incomplete or invalid content in every comparison mode', (body) => {
    const parsed = content(body);
    for (const mode of ['TEXT', 'MESSAGE', 'IMAGE'] as const) {
      expect(isDuplicateContentComparable(parsed, mode)).toBe(false);
      expect(buildMessageDuplicateIdentity(parsed, mode)).toBeNull();
    }
  });
});
