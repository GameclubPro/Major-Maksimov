import {
  isCommercialCorpusTextSanitized,
  sanitizeCommercialCorpusText,
  hasResidualCommercialContactCandidate,
} from './commercial-corpus-sanitization.util';
import { parseCommercialPhones } from '../moderation/commercial/commercial-phone';

describe('commercial corpus sanitization', () => {
  it.each(['+7 900 000 10 42', '8 900 000 10 42', '+44 20 7946 0101'])(
    'preserves a next-line price when redacting %s',
    (phone) => {
      const input = `Телефон ${phone}\n500 руб`;
      expect(sanitizeCommercialCorpusText(input, { preserveLayout: true })).toBe(
        'Телефон [phone]\n500 руб',
      );
      expect(sanitizeCommercialCorpusText(input)).toBe('Телефон [phone] 500 руб');
    },
  );

  it.each(['Телефон 9000001042 / 9000001043', '☎ 9000001042', 'Телефон +44 20 7946 0101'])(
    'detects residual private contacts independently: %s',
    (input) => {
      expect(hasResidualCommercialContactCandidate(input)).toBe(true);
      const sanitized = sanitizeCommercialCorpusText(input);
      expect(sanitized).toContain('[phone]');
      expect(hasResidualCommercialContactCandidate(sanitized)).toBe(false);
      expect(sanitizeCommercialCorpusText(sanitized)).toBe(sanitized);
    },
  );

  it('keeps phone, price and payment-card spans separate', () => {
    const input = 'Телефон 8 900 000 10 42\n500 руб\nКарта 2202.2002.0000.0001';
    expect(sanitizeCommercialCorpusText(input, { preserveLayout: true })).toBe(
      'Телефон [phone]\n500 руб\nКарта [card]',
    );
  });

  it.each([
    'Цена 2⃣0⃣0⃣, перевод [phone]. 🍓1. 2.🍓 🍓3. 4.🍓 🍓5. 6.🍓 🍓7. 8.🍓 🍓9. 10.🍓 🍓11. 12.🍓 🍓13.',
    'Цена 3⃣0⃣0⃣; приз 7️⃣Ⓜ️-2️⃣5⃣0️⃣🍺🦐 🦐🍺🦐🍺🦐🍺🦐🍺 1️⃣🦐 🍺2️⃣ 3️⃣🦐 🍺4️⃣ 5️⃣🦐 🍺6️⃣ 7⃣🦐 🍺8️⃣ 9⃣🦐 🍺1⃣0⃣',
  ])(
    'preserves complete ordinal lists instead of joining their digits into a phone: %s',
    (input) => {
      expect(sanitizeCommercialCorpusText(input, { preserveLayout: true })).toBe(input);
      expect(hasResidualCommercialContactCandidate(input)).toBe(false);
      expect(isCommercialCorpusTextSanitized(input)).toBe(true);
    },
  );

  it.each([
    ['+7 900 000 10 42', '+7 900 000 10 42'],
    ['☎ 8🟢900🟢000🟢10🟢42', '8🟢900🟢000🟢10🟢42'],
    ['📲 8🍓🍓900🍓🍓000🍓🍓10🍓🍓42', '8🍓🍓900🍓🍓000🍓🍓10🍓🍓42'],
    ['89000001042', '89000001042'],
  ])('keeps a new contact assertion separate from ordinal entries: %s', (assertion, phone) => {
    const input = `1. 2. 3. 4. 5. ${assertion}; 6. 7. 8. 9. 10.`;
    const expected = input.replace(phone, '[phone]');
    expect(sanitizeCommercialCorpusText(input)).toBe(expected);
    expect(hasResidualCommercialContactCandidate(input)).toBe(true);
    expect(isCommercialCorpusTextSanitized(expected)).toBe(true);
  });

  it.each(['☎ ', '📲 ', '+'])(
    'ends ordinal-list protection at a new explicit phone marker: %s',
    (marker) => {
      const input = `1. 2. 3. 4. 5. 6. ${marker}7. 8. 9. 10. 11. 12. 13.`;
      const expected = `1. 2. 3. 4. 5. 6. ${marker === '+' ? '' : marker}[phone].`;
      expect(sanitizeCommercialCorpusText(input)).toBe(expected);
      expect(hasResidualCommercialContactCandidate(input)).toBe(true);
      expect(isCommercialCorpusTextSanitized(expected)).toBe(true);
    },
  );

  it('keeps explicit international and ambiguous decorated contacts privacy-sensitive', () => {
    for (const input of [
      '+1 2 3 4 5 6 7 8 9 10',
      '+7 1 2 3 4 5 6 7 8 9 10',
      '7🍓🍓9🍓🍓9🍓🍓9🍓🍓1🍓🍓2🍓🍓3🍓🍓4🍓🍓5🍓🍓6🍓🍓7',
      '7️⃣Ⓜ️-2️⃣5⃣0️⃣🍺🦐 🦐🍺🦐🍺🦐🍺🦐🍺 1️⃣🦐 🍺2️⃣ 3️⃣🦐 🍺4️⃣ 5️⃣🦐 🍺6️⃣ 7⃣',
    ]) {
      expect(hasResidualCommercialContactCandidate(input)).toBe(true);
      expect(sanitizeCommercialCorpusText(input)).toBe('[phone]');
      expect(isCommercialCorpusTextSanitized(input)).toBe(false);
    }
  });

  it('retains a textual phone assertion before a longer ordinal-shaped numeric island', () => {
    const input = 'Телефон 1. 2. 3. 4. 5. 6. 7. 8. 9. 10. 11. 12. 13.';
    expect(sanitizeCommercialCorpusText(input)).toBe('Телефон 1. 2. 3. 4. 5. 6. [phone].');
    expect(hasResidualCommercialContactCandidate(input)).toBe(true);
    expect(isCommercialCorpusTextSanitized(input)).toBe(false);
  });

  it('redacts schedule-adjacent and slash-separated contacts without merging them', () => {
    const input = 'Работаем 24 на 7 89000001042 / 89000001043';
    expect(hasResidualCommercialContactCandidate(input)).toBe(true);
    const sanitized = sanitizeCommercialCorpusText(input);
    expect(sanitized).toBe('Работаем 24 на 7 [phone] / [phone]');
    expect(hasResidualCommercialContactCandidate(sanitized)).toBe(false);
  });

  it('masks a privacy candidate independently of unchanged detector identifier guards', () => {
    const input = 'Код заказа 89000001042 12345';
    expect(parseCommercialPhones(input)).toEqual([]);
    expect(hasResidualCommercialContactCandidate(input)).toBe(true);
    expect(sanitizeCommercialCorpusText(input)).toBe('Код заказа [phone] 12345');
  });

  it.each([
    ['Ботинки. Цена 600. 89000001042', 'Ботинки. Цена 600. [phone]'],
    ['Ботинки. 600. 89000001042', 'Ботинки. 600. [phone]'],
    ['Для заказа - 89000001042', 'Для заказа - [phone]'],
    ['Для заказа: 89000001042', 'Для заказа: [phone]'],
    ['Для заказа - 8🟢900🟢000🟢10🟢42', 'Для заказа - [phone]'],
    ['Телефон 89000001042 500 руб', 'Телефон [phone] 500 руб'],
    ['Телефон +7 900 000 10 42 500 руб', 'Телефон [phone] 500 руб'],
    ['2026-11-01 10:30, 15 000 руб', '2026-11-01 10:30, 15 000 руб'],
    ['Телефон 7999-12-34-567', 'Телефон [phone]'],
    ['Телефон 7999-12-31-567', 'Телефон [phone]'],
  ])(
    'keeps prices and assertion boundaries while masking privacy contacts: %s',
    (input, expected) => {
      expect(sanitizeCommercialCorpusText(input)).toBe(expected);
      expect(isCommercialCorpusTextSanitized(expected)).toBe(true);
    },
  );

  it.each([
    'Телефон 8\u200b900\u200b000\u200b10\u200b42',
    'Телефон 8\u200c900\u200c000\u200c10\u200c42',
    'Телефон 8\u200e900\u200e000\u200e10\u200e42',
    'Телефон ８９０００００１０４２',
    'Телефон ٨٩٠٠٠٠٠١٠٤٢',
    'Телефон 𝟠𝟡𝟘𝟘𝟘𝟘𝟘𝟙𝟘𝟜𝟚',
    'Теле\u200bфон 9000001042',
    'Телефон +44\u200b20\u200b7946\u200b0101',
  ])('masks Unicode contacts using original source spans: %s', (input) => {
    expect(hasResidualCommercialContactCandidate(input)).toBe(true);
    const sanitized = sanitizeCommercialCorpusText(input);
    expect(sanitized).toContain('[phone]');
    expect(hasResidualCommercialContactCandidate(sanitized)).toBe(false);
    expect(isCommercialCorpusTextSanitized(sanitized)).toBe(true);
  });

  it('preserves non-contact Unicode text and masks entire obfuscated URLs first', () => {
    expect(sanitizeCommercialCorpusText('Текст\u200b без контактов, размер １２ см')).toBe(
      'Текст\u200b без контактов, размер １２ см',
    );
    expect(sanitizeCommercialCorpusText('https://exa\u200bmple.com/89000001042')).toBe('[url]');
    expect(sanitizeCommercialCorpusText('Почта sa\u200bles@example.ru')).toBe('Почта [email]');
    expect(sanitizeCommercialCorpusText('Карта ２２０２２００２０００００００１')).toBe(
      'Карта [card]',
    );
  });

  it('preserves assertion boundaries for new replay corpora without retaining contacts', () => {
    const text = 'Новости: предложение обсуждается.\n\nОтдельно: услуги, телефон 8-900-000-10-42';
    const sanitized = sanitizeCommercialCorpusText(text, { preserveLayout: true });
    expect(sanitized).toBe(
      'Новости: предложение обсуждается.\n\nОтдельно: услуги, телефон [phone]',
    );
    expect(isCommercialCorpusTextSanitized(sanitized)).toBe(true);
  });

  it.each([' 📲 ', '\n📲 ', '\n', ', ', '; '])(
    'redacts every adjacent contact, not just an isolated number: %j',
    (separator) => {
      const text = `📲 8-900-000-10-42${separator}8-900-000-10-43`;
      expect(isCommercialCorpusTextSanitized(text)).toBe(false);
      expect(sanitizeCommercialCorpusText(text)).toBe(
        `📲 [phone]${separator}[phone]`.replace(/\s+/gu, ' '),
      );
    },
  );

  it.each([
    ['Телефон 999.123.45.67', 'Телефон [phone]'],
    ['Телефон +7 (999).123.45.67', 'Телефон [phone]'],
    ['Телефон +49 30 12345678', 'Телефон [phone]'],
    ['Связь +1 (415) 555-2671', 'Связь [phone]'],
    ['E.164 +447911123456', 'E.164 [phone]'],
    ['Связь +1🟢415🟢555🟢2671', 'Связь [phone]'],
    ['Телефон +44🟢7911🟢123456', 'Телефон [phone]'],
    ['Телефон 79991234567', 'Телефон [phone]'],
    ['Телефон +7 9O0 123 45 67', 'Телефон [phone]'],
    ['Телефон +7 9О0 123 45 67', 'Телефон [phone]'],
    ['Телефон +1 4O5 555 2671', 'Телефон [phone]'],
    ['Телефон +44 7О11 123456', 'Телефон [phone]'],
    ['Иркутск, 89148907923', 'Иркутск, [phone]'],
    ['Телефон 7️⃣9️⃣9️⃣9️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣', 'Телефон [phone]'],
    ['Услуги 8️⃣9️⃣0️⃣8️⃣6️⃣1️⃣0️⃣6️⃣1️⃣6️⃣0️⃣', 'Услуги [phone]'],
    ['Связь +7🟢999🟢123🟢45🟢67', 'Связь [phone]'],
    ['ТЕЛЕФОНУ📱☎️ 🐤7🐥9🐥9🐥9🐥1🐥2🐥3🐥4🐥5🐥6🐥7🐤', 'ТЕЛЕФОНУ📱☎️ 🐤[phone]🐤'],
    ['Тел. 8•999•123•45•67', 'Тел. [phone]'],
    ['Тел. 8|999|123|45|67', 'Тел. [phone]'],
    ['Телефон • 7•9•9•9•1•2•3•4•5•6•7', 'Телефон • [phone]'],
    ['Телефон | 7|9|9|9|1|2|3|4|5|6|7', 'Телефон | [phone]'],
    ['7|9|9|9|1|2|3|4|5|6|7 | телефон', '[phone] | телефон'],
    ['Тел. 12-34-56', 'Тел. [phone]'],
    ['12-34-56 (телефон)', '[phone] (телефон)'],
    ['Карта 2202.2002.0000.0001', 'Карта [card]'],
    ['PAN 1234567890123', 'PAN [card]'],
    ['Расчётный счёт 40702 810 1 0000 0000000', 'Расчётный счёт [account]'],
    ['40702810100000000001, р/с', '[account], р/с'],
    ['Счёт: 12345678901234567890', 'Счёт: [account]'],
    ['Сайт www.example.com/catalog', 'Сайт [url]'],
    ['Сайт offers.example.ru/catalog?q=1', 'Сайт [url]'],
    ['Профиль max://user/123456', 'Профиль [url]'],
    ['Почта sales@example.ru', 'Почта [email]'],
    ['Почта продажи@пример.рф', 'Почта [email]'],
    ['Почта support@xn--e1afmkfd.xn--p1ai', 'Почта [email]'],
    ['Почта χρήστης@παράδειγμα.ελ', 'Почта [email]'],
    ['Напишите @example_user', 'Напишите @[handle]'],
  ])('redacts private contact data in %s', (input, expected) => {
    expect(sanitizeCommercialCorpusText(input)).toBe(expected);
    expect(isCommercialCorpusTextSanitized(input)).toBe(false);
    expect(isCommercialCorpusTextSanitized(expected)).toBe(true);
  });

  it('preserves dotted prose and common local filenames', () => {
    expect(sanitizeCommercialCorpusText('Версия 1.2, файл report.pdf')).toBe(
      'Версия 1.2, файл report.pdf',
    );
  });

  it.each([
    'Размеры коробки 12-34-56 см',
    'Заказ 1234567890 уже выдан',
    'ИНН 1234567890123',
    'ИНН 770 708 38 93',
    'СНИЛС 123 456 789 00',
    'ОГРН 123456789012345',
    'Код партии 12345678901234567890',
    'Размеры 8|10|20',
    'Телефон 1🟢415🟢555🟢2671',
    'Телефон +0🟢415🟢555🟢2671',
    'Телефон +1🟢234🟢56',
    'Диапазон +123456 единиц',
    'Адрес сети 192.168.10.20',
  ])('preserves an ambiguous non-contact number in %s', (input) => {
    expect(sanitizeCommercialCorpusText(input)).toBe(input);
    expect(isCommercialCorpusTextSanitized(input)).toBe(true);
  });

  it('rejects an idempotent overlong contact candidate as privacy-unverified', () => {
    const input = 'Телефон +1🟢234🟢567🟢890🟢123🟢456';
    expect(sanitizeCommercialCorpusText(input)).toBe(input);
    expect(hasResidualCommercialContactCandidate(input)).toBe(true);
    expect(isCommercialCorpusTextSanitized(input)).toBe(false);
  });

  it.each([
    'Заказ 71234567890 уже выдан',
    'Маркировка 7🟢999🟢123🟢45🟢67 относится к партии',
    'Маркировка 7️⃣9️⃣9️⃣9️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣ относится к партии',
    'Код партии 8•999•123•45•67',
    'Код партии 8|999|123|45|67',
    'Код заказа 7 900 123 45 67, услуги уже оплачены',
    'Маркировка 8 999 123 45 67 относится к партии',
    'Маркировка +1🟢415🟢555🟢2671 относится к партии',
  ])('masks phone-shaped identifiers only at the privacy boundary: %s', (input) => {
    expect(parseCommercialPhones(input)).toEqual([]);
    expect(sanitizeCommercialCorpusText(input)).toContain('[phone]');
    expect(isCommercialCorpusTextSanitized(input)).toBe(false);
  });

  it('is idempotent across residual phone families', () => {
    const input =
      'Телефон 79991234567 | Телефон 7️⃣9️⃣9️⃣9️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣ • Телефон | 7|9|9|9|1|2|3|4|5|6|7 • Связь +7🟢999🟢123🟢45🟢67 • Связь +1🟢415🟢555🟢2671 • Телефон +44🟢7911🟢123456';
    const sanitized = sanitizeCommercialCorpusText(input);

    expect(sanitized).toBe(
      'Телефон [phone] | Телефон [phone] • Телефон | [phone] • Связь [phone] • Связь [phone] • Телефон [phone]',
    );
    expect(sanitizeCommercialCorpusText(sanitized)).toBe(sanitized);
    expect(isCommercialCorpusTextSanitized(sanitized)).toBe(true);
  });
});
