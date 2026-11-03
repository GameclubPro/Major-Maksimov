import { extractBlockedPhoneNumbers } from './phone-blocking-evidence';

describe('phone blocking evidence', () => {
  it.each([' ', '\t', '\n', '\r\n', '\u00a0'])(
    'separates adjacent phones across %j',
    (separator) => {
      expect(
        extractBlockedPhoneNumbers(`Телефоны: 8 (999) 123-45-67${separator}8 (999) 111-22-33`),
      ).toEqual(['79991234567', '79991112233']);
      expect(extractBlockedPhoneNumbers(`89991234567${separator}89991112233`)).toEqual([
        '79991234567',
        '79991112233',
      ]);
    },
  );

  it('handles several grouped phones and normalizes duplicate domestic forms', () => {
    expect(extractBlockedPhoneNumbers('8 999 123 45 67 8 999 111 22 33 8 999 333 44 55')).toEqual([
      '79991234567',
      '79991112233',
      '79993334455',
    ]);
    expect(extractBlockedPhoneNumbers('+7 (999) 123-45-67, 8 999 123 45 67, 9991234567')).toEqual([
      '79991234567',
    ]);
  });

  it.each([' ', '\n', '\u00a0'])(
    'separates a national phone beginning with parentheses after %j',
    (separator) => {
      expect(extractBlockedPhoneNumbers(`8 (999) 123-45-67${separator}(999) 111-22-33`)).toEqual([
        '79991234567',
        '79991112233',
      ]);
      expect(extractBlockedPhoneNumbers(`(999) 123-45-67${separator}(495) 111-22-33`)).toEqual([
        '79991234567',
        '4951112233',
      ]);
    },
  );

  it.each([
    ['+44 20 7946 0958', '442079460958'],
    ['+1 (202) 555-0123', '12025550123'],
    ['телефон офиса 495 123 45 67', '4951234567'],
    ['(495) 123-45-67', '4951234567'],
    ['(999) 123-45-67', '79991234567'],
    ['whatsapp 4951234567', '4951234567'],
    ['code A+7 (999) 123-45-67 today', '79991234567'],
  ])('preserves ordinary phone recognition: %s', (text, phone) => {
    expect(extractBlockedPhoneNumbers(text)).toEqual([phone]);
  });

  it.each([
    'ИНН 9991234567',
    'ИНН 123456789012',
    'инн: 89991234567',
    'И.Н.Н. № 9991234567',
    'Артикул 89991234567',
    'арт. №89991234567',
    'артик.: A-89991234567',
    'Артикул «89991234567»',
    'ИНН\u2066:\u2069 9991234567',
    'ИНН 999 123 4567',
    'ИНН 1234 5678 9012',
    'Артикул 8 (999) 123-45-67',
    'арт. +7 999 123 45 67',
  ])('exempts only the explicitly labelled identifier: %s', (text) => {
    expect(extractBlockedPhoneNumbers(text)).toEqual([]);
    expect(extractBlockedPhoneNumbers(`${text} 8 (999) 111-22-33`)).toEqual(['79991112233']);
  });

  it.each(['ИНН 123', 'Артикул 123', 'арт. 42'])(
    'does not extend a short identifier into the following independent phone: %s',
    (identifier) => {
      expect(extractBlockedPhoneNumbers(`${identifier} 8 (999) 111-22-33`)).toEqual([
        '79991112233',
      ]);
    },
  );

  it.each([
    'https://example.com/orders/79991234567',
    'http://example.com/?phone=79991234567#89991234567',
    'example.com/79991234567',
    'www.example.com/79991234567',
    'wa.me/79991234567',
    'https://wa.me/79991234567',
    'tel:+79991234567',
    'sms:+79991234567',
    'TEL:+7(999)123-45-67',
    'ftp://example.com/79991234567',
    'tg://user?id=79991234567',
    'max://user/79991234567',
    'mailto:user79991234567@example.com',
    'custom:79991234567',
    'te\u200bl:\u2066+79991234567',
    '\u2066tel:+79991234567\u2069',
    'https://exa\u200bmple.com/79991234567',
  ])('exempts numbers inside URL %s without hiding the next phone', (url) => {
    expect(extractBlockedPhoneNumbers(url)).toEqual([]);
    expect(extractBlockedPhoneNumbers(`${url} 8 (999) 111-22-33`)).toEqual(['79991112233']);
  });

  it.each(['https://example.com', 'http://example.com', 'https://exa\u200bmple.com'])(
    'preserves the shared attached-sentence boundary after %s',
    (url) => {
      expect(extractBlockedPhoneNumbers(`${url}.Телефон:89991112233`)).toEqual(['79991112233']);
      expect(extractBlockedPhoneNumbers(`${url}/89991112233`)).toEqual([]);
    },
  );

  it.each(['tel:+79991234567', 'TEL:+7(999)123-45-67', 'sms:+79991234567'])(
    'ends a wrapped contact URL before the independent following phone: %s',
    (url) => {
      expect(extractBlockedPhoneNumbers(`(${url}),89991112233`)).toEqual(['79991112233']);
    },
  );

  it.each([
    'https://example.com/orders/(89991234567)',
    'http://example.com/orders/(89991234567)/details',
    'example.com/orders/(89991234567)',
    'https://exa\u200bmple.com/orders/(89991234567)',
  ])('exempts balanced URL parentheses without swallowing an independent phone: %s', (url) => {
    expect(extractBlockedPhoneNumbers(url)).toEqual([]);
    expect(extractBlockedPhoneNumbers(`${url} 8 (999) 111-22-33`)).toEqual(['79991112233']);
    expect(extractBlockedPhoneNumbers(`(${url}),89991112233`)).toEqual(['79991112233']);
  });

  it('keeps original UTF-16 ranges around emoji, controls and multiple exemptions', () => {
    const text =
      '👨‍👩‍👧‍👦 https://exa\u200bmple.com/79991234567 8 (999) 111-22-33 ' +
      '📦 Артикул\u2066:\u2069 89991234567; 8 (999) 333-44-55; te\u200bl:+79995556677';
    expect(extractBlockedPhoneNumbers(text)).toEqual(['79991112233', '79993334455']);
  });

  it.each([
    'Номер заказа 1234567890 для получения оборудования',
    'Вес +1234567890 кг',
    'КПП 9991234567',
    'ОГРН 89991234567',
    'Суперартикул 89991234567',
  ])('does not introduce unrelated identifier exemptions: %s', (text) => {
    expect(extractBlockedPhoneNumbers(text)).toHaveLength(1);
  });

  it.each([
    'Периоды 2024-2025-2026 и 12.05.2026, диапазон 100-200-300.',
    'Телефон: 8999123456789991112233',
    'Телефон: 7999123456779991112233',
    '123456789',
    '4951234567',
  ])('does not manufacture phones from dates, ranges or continuous digits: %s', (text) => {
    expect(extractBlockedPhoneNumbers(text)).toEqual([]);
  });
});
