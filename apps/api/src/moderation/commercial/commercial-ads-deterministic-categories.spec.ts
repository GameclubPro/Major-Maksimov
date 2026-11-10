import type { ChatSettings } from '../../prisma/prisma-client';
import { CommercialAdDetector } from './commercial-ad.detector';
import { deterministicCommercialCategories } from './commercial-ads-deterministic-categories';
import {
  normalizeCommercialRawText,
  normalizePreparedCommercialText,
} from './commercial-normalization';

const detector = new CommercialAdDetector();
function detect(text: string) {
  const rawLoweredText = normalizeCommercialRawText(text);
  const detection = detector.detect({
    rawLoweredText,
    normalizedText: normalizePreparedCommercialText(rawLoweredText),
    settings: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
    } as ChatSettings,
    commercialCampaignContext: null,
  });
  if (!detection) throw new Error('Fixture must reach the actual detector');
  return detection;
}

describe('deterministic categories describe offers rather than ranking or incidental vocabulary', () => {
  it.each([
    [
      'Таблички «Устанавливаем окна» в наличии. Большой ассортимент, цена 1000 руб. Принимаем заказы.',
      ['BUSINESS'],
    ],
    [
      'Краска в наличии. Большой ассортимент, цена 2000 руб. Отдельно ремонтируем квартиры под ключ. Принимаем заказы.',
      ['SERVICES', 'BUSINESS'],
    ],
    [
      'Ремонтируем стиральные машины. Комплектующие в наличии для выполнения ремонта. Гарантия, запись по телефону.',
      ['SERVICES'],
    ],
    [
      'Ремонтируем мебель. Ткань для перетяжки в наличии. Работаем по договору, гарантия. Принимаем заказы.',
      ['SERVICES'],
    ],
    ['Краска в наличии. Большой ассортимент, цена 2000 руб. Принимаем заказы.', ['BUSINESS']],
    [
      'Игрушки в наличии, большой ассортимент. Принимаем заказы, доставка бесплатная.',
      ['BUSINESS'],
    ],
    ['Бетон в наличии. Большой ассортимент, цена 2000 руб. Принимаем заказы.', ['BUSINESS']],
    ['Краска в наличии. Большой ассортимент, цена 2000 руб. Пишите.', ['BUSINESS']],
    [
      'Наш магазин продает таблички «Устанавливаем окна». Цена 1000 руб. Принимаем заказы.',
      ['BUSINESS'],
    ],
    [
      'Продаем краску. Отзыв клиента: «Ремонтируем квартиры, все работы». Это цитата. Заказывайте.',
      ['BUSINESS'],
    ],
    [
      'Наш магазин продаёт краску. Поможем подобрать цвет, доставка включена. Принимаем заказы.',
      ['BUSINESS'],
    ],
    [
      'Продаём краску. Отдельно выполняем покраску. Вступайте в наш канал с каталогом.',
      ['SERVICES', 'BUSINESS', 'COMMUNITIES'],
    ],
    [
      'Вступайте в наш канал с каталогом. Отдельно выполняем покраску. Продаём краску.',
      ['SERVICES', 'BUSINESS', 'COMMUNITIES'],
    ],
    ['Продаем бетон и брусчатку. Принимаем заказы, цена 3000 руб.', ['BUSINESS']],
    ['Наш магазин продает готовые торты. Доставка бесплатная. Принимаем заказы.', ['BUSINESS']],
    ['Наш магазин продает краску Мастер. Принимаем заказы.', ['BUSINESS']],
    ['Продаем крепеж для установки и монтажа. Цена 2000 руб. Принимаем заказы.', ['BUSINESS']],
    ['Ремонтируем стиральные машины на заказ. Отправлю каталог. Гарантия.', ['SERVICES']],
    ['Ремонтируем стиральные машины. Мы не продаем технику. Гарантия.', ['SERVICES']],
    ['Ремонтируем стиральные машины. Это не наш магазин. Гарантия.', ['SERVICES']],
    [
      'Наш магазин продает краску. Ремонтные наборы в ассортименте. Принимаем заказы.',
      ['BUSINESS'],
    ],
    ['Продаем краску. Маникюрные ножницы в наличии. Принимаем заказы.', ['BUSINESS']],
    ['Продаем краску. Шиномонтажный станок в наличии. Принимаем заказы.', ['BUSINESS']],
    [
      'Продаем краску. Предлагаем ремонт квартир под ключ. Гарантия, выезд ежедневно.',
      ['SERVICES', 'BUSINESS'],
    ],
    ['Продаем краску и предлагаем услуги покраски. Принимаем заказы.', ['SERVICES', 'BUSINESS']],
    [
      'Продам новый курс по английскому языку, скидка 50%, пишите в лс, цена 3000 руб.',
      ['SERVICES'],
    ],
    ['Курс английского языка. Продаем обучение онлайн. Цена 3000 руб.', ['SERVICES']],
    [
      'Наш коммерческий канал со скидками и каталогом https://max.ru/myshop. Подписывайтесь!',
      ['COMMUNITIES'],
    ],
    ['Продам курс, скидка 50%, пишите в лс, цена 3000 руб.', ['SERVICES']],
    ['Наш магазин продает краску. Приглашаем на распродажу со скидками.', ['BUSINESS']],
    ['Продаем краску. Фотограф, съемка праздников на заказ.', ['SERVICES', 'BUSINESS']],
    ['Продаем краску. Не вступайте в наш канал с каталогом.', ['BUSINESS']],
    [
      'Наш магазин продает краску. Курсовая устойчивость, товар для автосервиса. Принимаем заказы.',
      ['BUSINESS'],
    ],
    ['Рекламное размещение в канале. Охват 10000, прайс 1000 руб. Пишите.', ['COMMUNITIES']],
    [
      'Пример рекламы для модераторов: «Вступайте в наш канал с каталогом». Это цитата, не предложение. Мы продаем краску. Заказывайте.',
      ['BUSINESS'],
    ],
    ['Оказываем услуги. Работаем по договору. Принимаем заказы.', ['SERVICES']],
    ['Наш магазин открыт ежедневно. Пишите.', ['BUSINESS']],
  ])('%s', (text, expected) => {
    expect(deterministicCommercialCategories(detect(`${text} +7 900 000 10 42`))).toEqual(expected);
  });

  it('does not let an isolated short analysis restore incomplete original coverage', () => {
    const detection = detect(
      'Наш магазин продаёт краску. Поможем подобрать цвет, доставка включена. Принимаем заказы. +7 900 000 10 42',
    );
    expect(
      deterministicCommercialCategories({
        ...detection,
        analysisText: detection.rawText,
        rawText: `${detection.rawText}${'а'.repeat(8001)}`,
      }),
    ).toEqual([]);
  });
});
