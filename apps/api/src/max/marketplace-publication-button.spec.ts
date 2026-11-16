import {
  appendMarketplacePublicationButton,
  appendMarketplaceEditableAttachments,
  withMarketplaceModerationMessage,
  marketplaceModuleForRule,
  isMarketplacePublicationTarget,
} from './marketplace-publication-button';
import type { MaxSendMessageOptions } from './max-client.service';

const url =
  'https://max.ru/svyazka_bot?startapp=listing_channel_10000000-0000-4000-8000-000000000001';

describe('optional marketplace publication button', () => {
  it.each([
    'PUBLICATION',
    'VK_IMPORT',
    'APPROVED_SUGGESTION',
    'GREETING',
    'MODERATION_NOTICE',
  ] as const)('permits only the actual public target for %s', (purpose) => {
    expect(isMarketplacePublicationTarget('-10', { entityId: '-10', purpose })).toBe(true);
    expect(isMarketplacePublicationTarget('10', { entityId: '-10', purpose })).toBe(false);
    expect(isMarketplacePublicationTarget('-11', { entityId: '-10', purpose })).toBe(false);
    expect(isMarketplacePublicationTarget('-10', undefined)).toBe(false);
  });

  it('preserves media, rich text and all authored rows, adds exactly one final row without mutating input', () => {
    const original: MaxSendMessageOptions = {
      textFormat: 'html',
      imagePayload: { token: 'fixture' },
      messageLink: { type: 'reply', mid: 'fixture-mid' },
      buttons: [
        [{ type: 'callback', text: 'Комментарии', payload: 'comments' }],
        [{ type: 'link', text: 'Мой сайт', url: 'https://example.com' }],
      ],
    };
    const snapshot = structuredClone(original);
    const result = appendMarketplacePublicationButton(original, url);
    expect(result.outcome).toBe('ADDED');
    expect(result.options).toEqual({
      ...snapshot,
      buttons: [...snapshot.buttons!, [{ type: 'link', text: 'Заказать рекламу', url }]],
    });
    expect(original).toEqual(snapshot);
    expect(appendMarketplacePublicationButton(result.options, `${url}#preview`).outcome).toBe(
      'DUPLICATE',
    );
  });

  it('keeps legacy single-button inputs', () => {
    const button = { type: 'link' as const, text: 'Заказать', url: 'https://example.com' };
    expect(appendMarketplacePublicationButton({ button }, url).options.buttons?.[0]).toEqual([
      button,
    ]);
  });

  it('omits the optional row when actual MAX layout, including full-width links, fills capacity', () => {
    const options: MaxSendMessageOptions = {
      buttons: Array.from({ length: 30 }, (_, i) => [
        { type: 'link', text: `Ссылка ${i}`, url: `https://example.com/${i}` },
      ]),
    };
    expect(appendMarketplacePublicationButton(options, url)).toEqual({
      options,
      outcome: 'KEYBOARD_FULL',
    });
    const splitRows: MaxSendMessageOptions = { buttons: [options.buttons!.flat()] };
    expect(appendMarketplacePublicationButton(splitRows, url).outcome).toBe('ADDED');
    const longLabels: MaxSendMessageOptions = {
      buttons: [
        options.buttons!.flat().map((button) => ({ ...button, text: 'Открыть свою витрину 🏪' })),
      ],
    };
    expect(appendMarketplacePublicationButton(longLabels, url).outcome).toBe('KEYBOARD_FULL');
  });

  it.each([
    'https://evil.test/profile',
    'http://max.ru/bot',
    'https://secret@max.ru/bot',
    'https://max.ru:9443/bot',
    'javascript:alert(1)',
  ])('rejects noncanonical profile target %s', (badUrl) => {
    const options = {};
    expect(appendMarketplacePublicationButton(options, badUrl)).toEqual({
      options,
      outcome: 'INVALID_LINK',
    });
  });
});

describe('locked channel keyboard decoration', () => {
  const media = { type: 'image', payload: { token: 'image', extra: 'preserve' } };
  const custom = {
    type: 'callback',
    text: 'Release',
    payload: 'release-proof',
    intent: 'positive',
  };
  it('keeps attachments, unknown payload fields and authored buttons byte-for-byte', () => {
    const source = [
      media,
      { type: 'inline_keyboard', payload: { buttons: [[custom]], marker: 'preserve' } },
    ];
    const snapshot = structuredClone(source);
    const result = appendMarketplaceEditableAttachments(source, url);
    expect(source).toEqual(snapshot);
    expect(result.outcome).toBe('ADDED');
    expect(result.attachments).toEqual([
      media,
      {
        type: 'inline_keyboard',
        payload: {
          marker: 'preserve',
          buttons: [[custom], [{ type: 'link', text: 'Заказать рекламу', url }]],
        },
      },
    ]);
    expect(appendMarketplaceEditableAttachments(result.attachments, url)).toEqual({
      attachments: result.attachments,
      outcome: 'DUPLICATE',
    });
  });
  it('preserves a full existing keyboard and malformed/multiple envelopes without an edit', () => {
    for (const source of [
      [
        media,
        {
          type: 'inline_keyboard',
          payload: { buttons: Array.from({ length: 30 }, () => [custom]) },
        },
      ],
      [{ type: 'inline_keyboard', payload: null }],
      [
        { type: 'inline_keyboard', payload: { buttons: [] } },
        { type: 'inline_keyboard', payload: { buttons: [] } },
      ],
    ])
      expect(appendMarketplaceEditableAttachments(source, url)).toEqual({
        attachments: source,
        outcome: 'KEYBOARD_FULL',
      });
  });
  it('marks only explicit greeting/notice callers without enabling any notice', () => {
    const source: MaxSendMessageOptions = {
      textFormat: 'html',
      buttons: [[{ type: 'callback', text: 'Rules', payload: 'rules' }]],
    };
    for (const purpose of ['GREETING', 'MODERATION_NOTICE'] as const) {
      expect(withMarketplaceModerationMessage(source, '-10', purpose)).toEqual({
        ...source,
        marketplacePublication: {
          entityId: '-10',
          purpose,
        },
      });
    }
    expect(source).not.toHaveProperty('marketplacePublication');
  });
});

describe('editable advertising caption', () => {
  it('uses the supplied caption for sends and locked channel decoration', () => {
    expect(
      appendMarketplacePublicationButton({}, url, 'Реклама здесь').options.buttons?.at(-1)?.[0]
        .text,
    ).toBe('Реклама здесь');
    expect(appendMarketplaceEditableAttachments([], url, 'Реклама здесь').attachments).toEqual([
      {
        type: 'inline_keyboard',
        payload: { buttons: [[{ type: 'link', text: 'Реклама здесь', url }]] },
      },
    ]);
  });
  it('retains the originating module on automatic sanction notices', () => {
    const options = withMarketplaceModerationMessage({}, '-10', 'MODERATION_NOTICE', 'DUPLICATES');
    expect(
      withMarketplaceModerationMessage(options, '-10', 'MODERATION_NOTICE').marketplacePublication
        ?.module,
    ).toBe('DUPLICATES');
  });
});

describe('message-limit advertising scope', () => {
  it.each([
    'VOICE_BLOCKED',
    'PHOTO_BLOCKED',
    'VIDEO_BLOCKED',
    'FILE_BLOCKED',
    'FORWARDED_MESSAGE_BLOCKED',
    'PHOTO_RATE_LIMIT',
    'STICKER_RATE_LIMIT',
  ])('keeps %s under message limits', (rule) => {
    expect(marketplaceModuleForRule(rule)).toBe('MESSAGE_LIMITS');
  });
});
