import { describe, expect, it } from 'vitest';
import {
  CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
  CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH,
  CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH,
  channelPostSignatureSettingsSchema,
  channelCustomPostButtonsSchema,
  channelCustomPostButtonInputSchema,
  updateChannelPostSignatureRequestSchema,
} from '../src/channel-post-signature.js';

describe('channel post signature contracts', () => {
  it('keeps a fail-safe disabled default with stable link text', () => {
    expect(channelPostSignatureSettingsSchema.parse({})).toEqual({
      customButtonsEnabled: false,
      customButtons: [],
      enabled: false,
      presentation: 'signature',
      text: CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
      url: '',
    });
  });

  it('supports a bounded full-width channel button presentation', () => {
    expect(
      channelPostSignatureSettingsSchema.parse({
        enabled: true,
        presentation: 'button',
        text: '📞 Заказать рекламу',
        url: 'https://example.test/ads',
      }),
    ).toEqual({
      customButtonsEnabled: false,
      customButtons: [],
      enabled: true,
      presentation: 'button',
      text: '📞 Заказать рекламу',
      url: 'https://example.test/ads',
    });

    expect(() =>
      channelPostSignatureSettingsSchema.parse({
        enabled: true,
        presentation: 'button',
        text: 'x'.repeat(33),
        url: 'https://example.test/ads',
      }),
    ).toThrow();
  });

  it('trims saved text and rejects empty or oversized labels', () => {
    expect(
      updateChannelPostSignatureRequestSchema.parse({
        expectedRevision: 3,
        text: '  Читать канал  ',
      }),
    ).toEqual({
      expectedRevision: 3,
      text: 'Читать канал',
    });
    expect(
      updateChannelPostSignatureRequestSchema.safeParse({ expectedRevision: 3, text: '   ' })
        .success,
    ).toBe(false);
    expect(
      updateChannelPostSignatureRequestSchema.safeParse({
        expectedRevision: 3,
        text: 'a'.repeat(CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('normalizes an explicit HTTP(S) destination and allows clearing it', () => {
    expect(
      updateChannelPostSignatureRequestSchema.parse({
        expectedRevision: 3,
        url: '  HTTP://MAX.RU/advertising/../contact?from=channel  ',
      }),
    ).toEqual({ expectedRevision: 3, url: 'http://max.ru/contact?from=channel' });
    expect(
      updateChannelPostSignatureRequestSchema.parse({ expectedRevision: 3, url: '   ' }),
    ).toEqual({ expectedRevision: 3, url: '' });
  });

  it.each([
    'max://user/admin-1',
    'javascript:alert(1)',
    'https://admin:secret@max.ru/contact',
    'https://max.ru/contact https://example.test',
    `https://max.ru/${'a'.repeat(CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH)}`,
  ])('rejects an unsafe or oversized explicit destination %s', (url) => {
    expect(
      updateChannelPostSignatureRequestSchema.safeParse({ expectedRevision: 3, url }).success,
    ).toBe(false);
  });

  it('requires at least one field in a partial update', () => {
    expect(updateChannelPostSignatureRequestSchema.safeParse({}).success).toBe(false);
    expect(updateChannelPostSignatureRequestSchema.safeParse({ enabled: true }).success).toBe(
      false,
    );
    expect(updateChannelPostSignatureRequestSchema.safeParse({ expectedRevision: 3 }).success).toBe(
      false,
    );
    expect(
      updateChannelPostSignatureRequestSchema.parse({ expectedRevision: 3, enabled: true }),
    ).toEqual({
      expectedRevision: 3,
      enabled: true,
    });
  });
});

describe('persistent channel buttons', () => {
  const button = {
    id: '11111111-1111-4111-8111-111111111111',
    text: 'Каталог',
    url: 'https://example.com/catalog#new',
  };
  it('preserves independent enablement, order, query and fragment', () => {
    const result = channelPostSignatureSettingsSchema.parse({
      customButtonsEnabled: true,
      customButtons: [button],
    });
    expect(result.enabled).toBe(false);
    expect(result.customButtons).toEqual([button]);
    expect(
      updateChannelPostSignatureRequestSchema.parse({ expectedRevision: 1, text: 'Read' }),
    ).not.toHaveProperty('customButtons');
  });
  it('rejects duplicate identities, duplicate destinations, excessive count and unsafe URLs', () => {
    expect(channelCustomPostButtonsSchema.safeParse([button, button]).success).toBe(false);
    expect(channelCustomPostButtonsSchema.safeParse(Array(9).fill(button)).success).toBe(false);
    for (const url of [
      'javascript:alert(1)',
      'https://name:password@example.com/',
      'https://max.ru/bot?start=pmh-secret',
    ])
      expect(channelCustomPostButtonsSchema.safeParse([{ ...button, url }]).success).toBe(false);
    expect(channelCustomPostButtonsSchema.safeParse([{ ...button, text: ' ' }]).success).toBe(
      false,
    );
  });
  it('allows distinct page sections and canonicalizes surrounding spaces', () => {
    expect(
      channelCustomPostButtonsSchema.parse([
        button,
        {
          ...button,
          id: '22222222-2222-4222-8222-222222222222',
          url: ' https://example.com/catalog#sale ',
        },
      ])[1]?.url,
    ).toBe('https://example.com/catalog#sale');
  });
  it.each([
    'https://example.com1/catalog',
    'https://example.123abc/',
    'https://-example.com/',
    'https://example-.com/',
    'https://example..com/',
    'https://localhost/',
  ])('rejects a MAX-incompatible hostname on write but retains the saved value: %s', (url) => {
    const savedButton = { ...button, url };
    expect(
      channelPostSignatureSettingsSchema.parse({ customButtons: [savedButton] }).customButtons,
    ).toEqual([savedButton]);
    expect(channelCustomPostButtonInputSchema.safeParse(savedButton).success).toBe(false);
    const result = updateChannelPostSignatureRequestSchema.safeParse({
      expectedRevision: 1,
      customButtons: [savedButton],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['customButtons', 0, 'url']);
  });
  it.each([
    'https://example.com/path1?x=2#3',
    'https://shop2.example.com/',
    'https://пример.рф/каталог',
    'http://192.0.2.1:8080/path',
    'https://[2001:db8::1]/path',
  ])('retains valid domain, IDN and IP syntax: %s', (url) => {
    expect(channelCustomPostButtonInputSchema.safeParse({ ...button, url }).success).toBe(true);
  });
});
