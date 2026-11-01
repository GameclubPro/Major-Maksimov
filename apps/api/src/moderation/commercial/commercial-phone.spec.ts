import type { ChatSettings } from '../../prisma/prisma-client';
import { createRuleDetectionContext } from '../rule-engine-detection-context';
import { CommercialAdDetector } from './commercial-ad.detector';
import { extractCommercialCampaignPhones } from '../commercial-campaign.util';
import { sanitizeCommercialCorpusText } from '../../scripts/commercial-corpus-sanitization.util';
import {
  hasCommercialPhoneLikeText,
  normalizeCommercialPhoneConfusables,
  parseCommercialPhones,
  replaceCommercialPhoneLikeText,
} from './commercial-phone';

const STRICT_SETTINGS = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'STRICT',
  commercialAdsWarnThreshold: 38,
  commercialAdsDeleteThreshold: 55,
} as unknown as ChatSettings;

const detector = new CommercialAdDetector();

function detect(text: string) {
  const context = createRuleDetectionContext({ text, settings: STRICT_SETTINGS });
  return detector.detect({
    normalizedText: context.normalizedText,
    rawLoweredText: context.rawLoweredText,
    settings: STRICT_SETTINGS,
    commercialCampaignContext: null,
  });
}

describe('commercial phone matching', () => {
  it.each(['+7 900 000 10 42', '8 900 000 10 42', '+44 20 7946 0101'])(
    'does not add a next-line price to %s',
    (phone) => {
      const text = `Телефон ${phone}\n500 руб`;
      const contacts = parseCommercialPhones(text);
      expect(contacts).toHaveLength(1);
      expect(contacts[0].normalizedNumber).toBe(
        phone.startsWith('8') ? '79000001042' : phone.replace(/\D/gu, ''),
      );
      expect(text.slice(contacts[0].start, contacts[0].end)).toBe(phone);
      expect(replaceCommercialPhoneLikeText(text)).toBe('Телефон [phone]\n500 руб');
    },
  );

  it.each([' / ', '/', '\n'])('separates contextual local contacts with %j', (separator) => {
    const text = `Телефон 9000001042${separator}9000001043`;
    expect(parseCommercialPhones(text).map(({ normalizedNumber }) => normalizedNumber)).toEqual([
      '9000001042',
      '9000001043',
    ]);
    expect(replaceCommercialPhoneLikeText(text)).toBe(`Телефон [phone]${separator}[phone]`);
  });

  it.each(['☎', '☎️', '📱', '📲'])('accepts an explicit phone pictogram %s', (context) => {
    expect(replaceCommercialPhoneLikeText(`${context} 9000001042`)).toBe(`${context} [phone]`);
  });

  it('does not turn an unlabeled pair of identifiers into contacts', () => {
    expect(parseCommercialPhones('Коды 1234567890 / 1234567891')).toEqual([]);
  });
  it.each([' / ', '/', '\n', ' 📲 '])('returns separate source spans for %j', (separator) => {
    const text = `Звоните: 89000001042${separator}89000001043${separator}89000001044`;
    const contacts = parseCommercialPhones(text);
    expect(contacts.map(({ normalizedNumber }) => normalizedNumber)).toEqual([
      '79000001042',
      '79000001043',
      '79000001044',
    ]);
    expect(contacts.map(({ start, end }) => text.slice(start, end))).toEqual([
      '89000001042',
      '89000001043',
      '89000001044',
    ]);
    expect(replaceCommercialPhoneLikeText(text)).toBe(
      `Звоните: [phone]${separator}[phone]${separator}[phone]`,
    );
  });

  it.each(['24 на 7', '24/7'])('separates the %s schedule from its phone', (schedule) => {
    const text = `Работаем ${schedule} 89000001042`;
    expect(parseCommercialPhones(text).map(({ normalizedNumber }) => normalizedNumber)).toEqual([
      '79000001042',
    ]);
    expect(replaceCommercialPhoneLikeText(text)).toBe(`Работаем ${schedule} [phone]`);
  });

  it.each([' 📲 ', '\n📲 ', '\n', ', ', '; '])(
    'keeps adjacent complete contacts separate with %j',
    (separator) => {
      const text = `📲 8-900-000-10-42${separator}8-900-000-10-43`;
      expect(hasCommercialPhoneLikeText(text)).toBe(true);
      expect(replaceCommercialPhoneLikeText(text)).toBe(`📲 [phone]${separator}[phone]`);
    },
  );

  it.each([
    'Код партии 8🟢900🟢000🟢10🟢42🟢12345',
    'Код партии 8900000104212345',
    'Код заказа 8-900-000-10-42 12345',
  ])('does not extract a contact from a longer numeric sequence: %s', (text) => {
    expect(hasCommercialPhoneLikeText(text)).toBe(false);
    expect(replaceCommercialPhoneLikeText(text)).toBe(text);
  });

  it.each([
    ['+7 900 123 45 67', '+7 900 123 45 67'],
    ['+7 9O0 123 45 67', '+7 900 123 45 67'],
    ['+7 9О0 123 45 67', '+7 900 123 45 67'],
  ])('normalizes confusable zeroes only in a full phone-like span', (input, expected) => {
    expect(normalizeCommercialPhoneConfusables(input)).toBe(expected);
  });

  it.each([
    'Телефон 999.123.45.67',
    'Связь +1 (415) 555-2671',
    'Связь +1 4O5 555 2671',
    'Телефон +44 7О11 123456',
    'По поводу заказа пишите по номеру 8️⃣9️⃣8️⃣9️⃣8️⃣8️⃣8️⃣2️⃣0️⃣8️⃣9️⃣',
    'Связь +7🟢999🟢123🟢45🟢67',
    'Тел. 8•999•123•45•67',
    'Тел. 12-34-56',
    'Иркутск, 89148907923',
  ])('recognizes a bounded contact number family: %s', (text) => {
    expect(hasCommercialPhoneLikeText(text)).toBe(true);
    expect(replaceCommercialPhoneLikeText(text)).toContain('[phone]');
  });

  it.each([
    'Ozon заказ 9O0 уже выдан',
    'Заказ 1234567890 уже выдан',
    'Заказ 71234567890 уже выдан',
    'Маркировка 999.123.45.67 относится к партии',
    'Размеры коробки 12-34-56 см',
    'Адрес сети 192.168.10.20',
    'ИНН 770 708 38 93',
    'СНИЛС 123 456 789 00',
    'Код заказа 123 456 78 90',
    'Код заказа 7 900 123 45 67, услуги уже оплачены',
    'Маркировка 8 999 123 45 67 относится к партии',
  ])('preserves an ambiguous non-contact value: %s', (text) => {
    expect(hasCommercialPhoneLikeText(text)).toBe(false);
    expect(replaceCommercialPhoneLikeText(text)).toBe(text);
    expect(normalizeCommercialPhoneConfusables(text)).toBe(text);
  });

  it('keeps service decisions stable across phone homoglyphs', () => {
    const baseline = detect('ГРУЗОПЕРЕВОЗКИ +7 900 123 45 67');

    expect(baseline).not.toBeNull();
    expect(detect('ГРУЗОПЕРЕВОЗКИ +7 9O0 123 45 67')?.actionBand).toBe(baseline?.actionBand);
    expect(detect('ГРУЗОПЕРЕВОЗКИ +7 9О0 123 45 67')?.actionBand).toBe(baseline?.actionBand);
  });

  it('feeds production phone shapes into bounded property recall', () => {
    const raw = detect('ЖК МЕЧТА 36,1м 7 этаж Вся в ДКП Цена 4 900 000 Иркутск, 89148907923 Илона');
    const placeholder = detect(
      'ЖК МЕЧТА 36,1м 7 этаж Вся в ДКП Цена 4 900 000 Телефон [phone] Илона',
    );

    expect(raw?.matchedSignals).toContain('property-agent:property-professional-spec');
    expect(raw?.actionBand).toBe(placeholder?.actionBand);
  });

  it('keeps a professional property card without a literal price label', () => {
    const result = detect('ЖК МЕЧТА 36,1м 7 этаж Вся в ДКП 4 900 000 ₽ Иркутск, 89148907923 Илона');

    expect(result?.matchedSignals).toContain('property-agent:property-professional-spec');
    expect(result?.actionBand).toBe('WARN');
  });

  it('does not promote a private shorthand property card only because its raw phone is recognized', () => {
    const result = detect(
      'КМР, ул. Лавочкина. Монолит кирпич, 7/7 эт. 1 к.кв. 35 м2, ремонт, мебель. 3 450 000 ₽, вся сумма в ДКП. Елена +7 900 000 00 67. Звоните, на смс долго отвечаю.',
    );

    expect(result).toBeNull();
  });

  it('recognizes an explicitly contextual short local service number', () => {
    const result = detect('Услуги сантехника, тел. 12-34-56');

    expect(result?.matchedSignals).toContain('contact:phone');
    expect(result?.actionBand).toBe('WARN');
  });

  it('does not turn a formatted tax identifier into commercial contact evidence', () => {
    const result = detect('ИНН 770 708 38 93, стоимость услуги указана в акте');

    expect(result).toBeNull();
  });

  it.each([
    'Код заказа 7 900 123 45 67, услуги уже оплачены',
    'Маркировка 8 999 123 45 67 относится к партии',
  ])('does not feed a formatted identifier tail into contact evidence: %s', (text) => {
    expect(detect(text)?.matchedSignals ?? []).not.toContain('contact:phone');
  });

  it.each([
    'https://example.test/item/79000001042',
    'https://example.test/?order=+79000001042',
    'example.test/item/79000001042',
    'max://profile/79000001042',
    'urn:invoice:79000001042',
    'ftp://files.example.test/79000001042',
    '79000001042@example.test',
    'item+79000001042@example.test',
    'item79000001042',
    '79000001042item',
    'Заказ +79000001042 уже выдан',
    'Маркировка +1 (415) 555-2671 относится к партии',
    'Артикул 79000001042',
    'SKU +79000001042',
    'Код телефона +79000001042',
    'Объем +1234567 м³',
    'Цена +79000001042 рублей',
    'Масса +7 900 000 10 42 кг',
    '79000001042 м²',
    '79000001042 MB',
    'MΩ: +79000001042',
    'MΩ: Телефон +79000001042',
    'Телефон 79000001042 кг',
    'Телефон +79000001042 руб.',
    'Заказ ( +79000001042 ) уже выдан',
    'Объем ( +1234567 ) м³',
    'Цена\u2060 +79000001042 рублей',
    'Заказ +79000001042\u2060 кг',
    'Ток нА +79000001042',
    'Ток нА: +79000001042',
    'Телефон +79000001042 В',
    'Длительность +79000001042 с',
    '+1234567,5 м³',
    '+1234567,51234567890 м³',
  ])('excludes non-contact boundary evidence: %s', (text) => {
    expect(parseCommercialPhones(text)).toEqual([]);
    expect(hasCommercialPhoneLikeText(text)).toBe(false);
    expect(extractCommercialCampaignPhones(text)).toEqual([]);
    expect(replaceCommercialPhoneLikeText(text)).toBe(text);
    expect(detect(text)?.matchedSignals ?? []).not.toContain('contact:phone');
  });

  it('preserves original phone spans and campaign contacts beside excluded URL and email values', () => {
    const text =
      '📦 https://example.test/79000001042, 79000001043@example.test. Звоните +7 900 000 10 44';
    const contacts = parseCommercialPhones(text);
    expect(contacts).toEqual([
      {
        start: text.indexOf('+7 900 000 10 44'),
        end: text.length,
        normalizedNumber: '79000001044',
      },
    ]);
    expect(extractCommercialCampaignPhones(text)).toEqual(['79000001044']);
    expect(replaceCommercialPhoneLikeText(text)).toBe(
      '📦 https://example.test/79000001042, 79000001043@example.test. Звоните [phone]',
    );
  });

  it.each(['Заказ +79000001042 уже выдан', 'Объем +1234567 м³'])(
    'keeps conservative privacy masking independent of contact qualification: %s',
    (text) => {
      expect(parseCommercialPhones(text)).toEqual([]);
      expect(sanitizeCommercialCorpusText(text)).toContain('[phone]');
    },
  );

  it.each([
    'tel:+79000001042',
    'sms:+79000001042',
    'callto:+79000001042',
    'Телефон для заказов +79000001042',
    'Для заказа телефон +79000001042',
    'Заказ выдан. Телефон +79000001042',
    'Телефон +79000001042. Заказ принят',
    'Телефон +79000001042\nЧасы работы с 9 до 18',
    'Телефон +79000001042\nАртикул товара 123',
    'Комиссия агентам 250000₽ в цене. +7 900 000 10 42',
    'Телефон +7 900 000 10 42, заказ в личку, доставка',
    'ПЕРЕВОД на +7 900 000 10 42, Тбанк',
    'Звоните на +7 900 000 10 42',
    'Для связи с +7 900 000 10 42',
    'Телефон +7 900 000 10 42 в WhatsApp',
    'Телефон +7 900 000 10 42 с 9 до 18',
  ])('preserves explicit phone contacts: %s', (text) => {
    expect(parseCommercialPhones(text).map((contact) => contact.normalizedNumber)).toEqual([
      '79000001042',
    ]);
  });
});
