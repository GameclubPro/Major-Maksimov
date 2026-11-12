import type { ChatSettings } from '../../prisma/prisma-client';
import type { CommercialCampaignContext } from '../commercial-campaign.util';
import type { CommercialThresholdProfile } from '../rule-engine-commercial-thresholds';
import { createRuleDetectionContext } from '../rule-engine-detection-context';
import { CommercialAdDetector } from './commercial-ad.detector';
import { collectCommercialSignals } from './commercial-features';
import { normalizeCommercialRawText, normalizeCommercialText } from './commercial-normalization';
import { deriveCommercialSafeContextBucket } from './commercial-safe-context';

const STRICT_PROFILE: CommercialThresholdProfile = {
  warnThreshold: 38,
  deleteThreshold: 55,
  sensitivity: 'STRICT',
  strictness: 0.7,
};

const STRICT_SETTINGS = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'STRICT',
  commercialAdsWarnThreshold: 38,
  commercialAdsDeleteThreshold: 55,
} as unknown as ChatSettings;

const BALANCED_SETTINGS = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'BALANCED',
  commercialAdsWarnThreshold: 57,
  commercialAdsDeleteThreshold: 77,
} as unknown as ChatSettings;

const REPEATED_CAMPAIGN_CONTEXT: CommercialCampaignContext = {
  senderDistinctChatCount: 5,
  sameTextDistinctChatCount: 3,
  repeatedPhoneDistinctChatCount: 0,
  repeatedLinkDistinctChatCount: 0,
  nearTextDistinctChatCount: 3,
  repeatedDomainDistinctChatCount: 0,
  repeatedHandleDistinctChatCount: 0,
  senderDistinctChatCount5m: 4,
  senderDistinctChatCount30m: 5,
  senderDistinctChatCount120m: 5,
};

const detector = new CommercialAdDetector();

function collect(text: string, commercialCampaignContext?: CommercialCampaignContext | null) {
  const rawLoweredText = normalizeCommercialRawText(text.toLowerCase());
  return collectCommercialSignals({
    normalizedText: normalizeCommercialText(rawLoweredText),
    rawLoweredText,
    profile: STRICT_PROFILE,
    commercialCampaignContext,
  });
}

function detect(
  text: string,
  commercialCampaignContext?: CommercialCampaignContext | null,
  settings: ChatSettings = STRICT_SETTINGS,
) {
  const context = createRuleDetectionContext({ text, settings });
  return detector.detect({
    normalizedText: context.normalizedText,
    rawLoweredText: context.rawLoweredText,
    settings,
    commercialCampaignContext,
  });
}

describe('commercial public and object-condition safe contexts', () => {
  it.each([STRICT_SETTINGS, BALANCED_SETTINGS])(
    'protects a quoted paid offer explicitly reported as a scam',
    (settings) => {
      const text =
        'В чате написали: «Ремонтируем стиральные машины. Выезд мастера 1000 рублей. Звоните +7 900 000 10 42». Это мошенники, не звоните.';
      const result = detect(text, undefined, settings);
      expect(result?.actionable ?? false).toBe(false);
      expect(['ALLOW', 'REVIEW_ONLY']).toContain(result?.actionBand ?? 'ALLOW');
    },
  );

  it.each([
    'Ремонтируем стиральные машины. Выезд мастера 1000 рублей. Звоните +7 900 000 10 42.',
    'В чате написали: «Ремонтируем стиральные машины. Звоните +7 900 000 10 42». Это мошенники, не звоните. Отдельно: наша мастерская ремонтирует холодильники. Выезд мастера 2000 рублей, звоните +7 900 000 10 43.',
  ])('keeps an actual own service offer actionable: %s', (text) => {
    expect(detect(text, undefined, BALANCED_SETTINGS)?.actionable).toBe(true);
  });

  it.each(['\u2061', '\u2063', '\u00ad'])(
    'keeps service detection stable through invisible Unicode: %j',
    (separator) => {
      const plain =
        'Ремонтируем стиральные машины. Выезд мастера 1000 рублей. Звоните +7 900 000 10 42.';
      const obfuscated = plain.replace(/(?<=[а-яё])(?=[а-яё])/giu, separator);
      expect(detect(obfuscated, undefined, BALANCED_SETTINGS)?.actionBand).toBe(
        detect(plain, undefined, BALANCED_SETTINGS)?.actionBand,
      );
      expect(detect(obfuscated, undefined, BALANCED_SETTINGS)?.actionable).toBe(true);
    },
  );

  it('does not read apartment appliances plus cosmetic repair as an appliance-repair offer', () => {
    const text =
      '🌼 Продается 2-х квартира, очень теплая, 4 этаж. В ванной умещается стиральная машинка. Остается вся мебель, холодильник, телевизор. Требуется косметический ремонт. Вся информация по тел. [phone], пишите, звоните. Собственник, торг.';
    const state = collect(text, REPEATED_CAMPAIGN_CONTEXT);

    expect(state.hasPropertyPrivateContext).toBe(true);
    expect(state.matchedSignals).not.toContain('service-specialty:appliance-repair');
    expect(detect(text, REPEATED_CAMPAIGN_CONTEXT)).toBeNull();
  });

  it('preserves an explicit appliance-repair self-offer inside property wording', () => {
    const state = collect(
      'Продается квартира. Предлагаю ремонт холодильников на дому, диагностика и гарантия. Цена от 2000 руб., звоните +7 900 000 00 00.',
    );

    expect(state.hasPropertyPrivateContext).toBe(true);
    expect(state.matchedSignals).toContain('service-specialty:appliance-repair');
  });

  it('does not classify a provider service for a home as a private property sale', () => {
    const text =
      'Меня зовут Ольга, менеджер компании Ростелеком. Подключаем безлимитный интернет: оптоволокно прямо в дом. Видеонаблюдение для безопасности вашего дома, участка. Контролируйте дом или участок со смартфона. Мобильная связь за 300 руб. Уточнить тарифы и оставить заявку: звоните [phone].';
    const state = collect(text);

    expect(state.negativeSignals).toContain('private:property-sale');
    expect(state.matchedSignals).toContain('service-specialty:internet-connection-service');
    expect(
      deriveCommercialSafeContextBucket({
        text,
        matchedSignals: state.matchedSignals,
        negativeSignals: state.negativeSignals,
        hasCommercialHit: true,
      }),
    ).toBe('none');
  });

  it('keeps a heavily structured anonymous rental in review', () => {
    const text =
      'Сдается 1 комнатная квартира площадью 35 м² на 1/3 эт. дома. В комнате диван, шкаф и телевизор. В кухне гарнитур, холодильник, плита и микроволновая печь. В ванной комнате плитка и стиральная машина. Сдам на длительный срок порядочным жильцам. Арендная плата 18000 руб, залог 18000 руб. Все вопросы по телефону [phone]. Квартира полностью готова к проживанию, коммунальные услуги оплачиваются отдельно.';
    const result = detect(text);

    expect(result?.matchedSignals).toContain('property-agent:structured-rental-review');
    expect(result?.safeContextBucket).toBe('private_one_off_sale');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
  });

  it('keeps a private furnished rental in review when repair describes the apartment', () => {
    const text =
      'Сдам приятную, светлую квартиру, с хорошим ремонтом в Северске. Есть всё необходимое для жизни холодильник, стиральная машина, микроволновая печь, плита (при необходимости могу дать и посуду), маленький телевизор, вай-фай, диван (раскладывается и становится как большая кровать, если нужно могу дать и постельное бельё), можно въехать и сразу жить. Сдаю на длительный срок порядочным и чистоплотным людям. Без домашних животных. Стоимость 18000р + ком. услуги оплачиваться вами отдельно. Посмотреть можно в любое удобное для вас время, звоните и договоримся по номеру [phone]';
    const result = detect(text);

    expect(result?.matchedSignals).not.toContain('service-specialty:appliance-repair-self-offer');
    expect(result?.safeContextBucket).toBe('private_one_off_sale');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
  });

  it('warn-caps a structured construction offer without calling it a private sale', () => {
    const text =
      'Ремонт под ключ квартир и домов. Берем на себя все этапы ремонта. Опытные мастера, монтаж отопления, гарантия и прозрачная смета. Подпишитесь и получите скидку: [url] [phone].';
    const result = detect(text);

    expect(result?.matchedSignals).toContain('service-specialty:marketplace-construction-service');
    expect(result?.safeContextBucket).toBe('none');
    expect(result?.actionBand).toBe('WARN');
    expect(result?.suppressionReasons).toContain('bounded-recall-warn-cap');
  });

  it('does not treat professional doorstep retail delivery as a private measurement', () => {
    const text =
      'Продаём в Хабаровске: икра кеты малосолёная, цена 7000 руб. за кг; кета потрошёная, цена 500 руб. за кг. Доставка по Хабаровску до подъезда бесплатно, пишите или звоните +7 900 000 00 02.';
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).not.toContain('private-goods:measurements');
    expect(state.matchedSignals).toContain('goods-retail:professional-retail-structure');
    expect(result?.safeContextBucket).toBe('none');
    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
  });

  it('keeps a repeated used-goods listing non-actionable beside retail recall evidence', () => {
    const text =
      'Школьные вещи на девочку и мальчика в отличном состоянии. Рюкзаки по 300 руб., учебники по 500 руб. Звоните +7 900 000 00 03.';
    const result = detect(text, REPEATED_CAMPAIGN_CONTEXT);

    expect(result?.negativeSignals).toContain('private-goods:resale-condition');
    expect(result?.matchedSignals).toContain('goods-retail:professional-retail-structure');
    expect(result?.safeContextBucket).toBe('private_one_off_sale');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
    expect(result?.suppressionReasons).toContain('safe-context:private_one_off_sale');
  });

  it('does not hide a construction crew service offer as ordinary job seeking', () => {
    const text =
      'Строительная бригада ищет работы. Строим дома, бани и беседки под ключ, ремонтируем кровлю и фасады. Пенсионерам скидка, звоните +7 900 000 00 04.';
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).toContain('job-seeking:job-seeking:search');
    expect(state.matchedSignals).toContain('service-specialty:construction-crew-self-offer');
    expect(result?.safeContextBucket).toBe('none');
    expect(result?.actionBand).toBe('WARN');
  });

  it('keeps a repeated contractor request outside campaign retail recall', () => {
    const text =
      'Ищу мастера по поклейке обоев\nОбъем: 9 рулонов\nБюджет: 3 500 руб. за весь объем\nКонтакты: [phone]';
    const state = collect(text, REPEATED_CAMPAIGN_CONTEXT);

    expect(state.negativeSignals).toEqual(
      expect.arrayContaining(['search:ищу маст', 'search-pattern:request:specialist']),
    );
    expect(state.matchedSignals).not.toContain('recall-cap:warn:professional-retail-structure');
    expect(state.matchedSignals).not.toContain('combo:intent+deal');
    expect(state.matchedSignals).not.toContain('combo:campaign+self-promo');
    expect(detect(text, REPEATED_CAMPAIGN_CONTEXT)).toBeNull();
  });

  it.each([
    [
      'online furniture store',
      'Ищете стильную мебель онлайн? Юра мебельный — онлайн‑магазин мебели от проверенных поставщиков: более 100 цветов, бесплатная доставка. Нужна помощь с выбором? Напишите в личку, группа [url], контакт [phone].',
    ],
    [
      'seller fulfillment follow-up',
      'Сегодня вечером доставка бройлеров 450 р. [phone]. Для заказа звоните. Кто заказывал заранее позвоню.',
    ],
    [
      'direct manufacturer order',
      'Хочешь экономить на покупках? Покупай напрямую у производителя. Доставка по всей России, оплата при получении. Нужна помощь в оформлении, пиши [phone].',
    ],
    [
      'apiary catalog',
      'Продам свежий цветочный мёд с собственной пасеки. Также в продаже соты, пыльца и орехи в меду. Заказать можно по телефону [phone], доставка бесплатная.',
    ],
    [
      'plant nursery orders',
      'Питомник: принимаем заказы на гортензии 1500 руб., сирень 900 руб. и ели 2500 руб. Отправку саженцев можно оформить Яндекс доставкой. Телефон [phone].',
    ],
  ])('does not cap an explicit source-side offer as a %s request', (_label, text) => {
    const state = collect(text);

    expect(state.negativeSignals.some((signal) => signal.startsWith('search'))).toBe(true);
    expect(
      deriveCommercialSafeContextBucket({
        text,
        matchedSignals: state.matchedSignals,
        negativeSignals: state.negativeSignals,
        hasCommercialHit: true,
      }),
    ).toBe('none');
  });

  it.each([
    [
      'Ищу мастера по установке кондиционера. Бюджет до 5000 руб., пишите в личку.',
      'request_or_recommendation',
    ],
    [
      'Кто занимается уборкой офисов? Нужна команда, цена до 10000 руб., телефон для связи [phone].',
      'request_or_recommendation',
    ],
    [
      'Кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб., мой телефон [phone].',
      'request_or_recommendation',
    ],
    [
      'Подскажите магазин мяса с доставкой, бюджет 5000 руб., предложения в личку.',
      'request_or_recommendation',
    ],
    [
      'Подскажите магазин растений: нужен каталог и доставка, бюджет 3000 руб., мой телефон [phone].',
      'request_or_recommendation',
    ],
    [
      'Подскажите магазин автозапчастей: нужен ассортимент и доставка, бюджет 20000 руб., мой телефон [phone].',
      'request_or_recommendation',
    ],
    [
      'Подскажите, где продается диван с доставкой? Бюджет 50000 руб., мой телефон [phone].',
      'request_or_recommendation',
    ],
    [
      'Подскажите онлайн-магазин мебели с доставкой, бюджет 50000 руб., мой телефон [phone].',
      'request_or_recommendation',
    ],
    [
      'Ищу интернет-магазин мебели с доставкой, бюджет 50000 руб., мой телефон [phone].',
      'request_or_recommendation',
    ],
    [
      'Подскажите хороший интернет магазин растений: нужен каталог и доставка, бюджет 3000 руб., мой телефон [phone].',
      'request_or_recommendation',
    ],
  ] as const)('preserves a priced demand-side request: %s', (text, expectedBucket) => {
    expect(['ALLOW', 'REVIEW_ONLY']).toContain(detect(text)?.actionBand ?? 'ALLOW');
    if (expectedBucket) {
      const state = collect(text);
      expect(
        deriveCommercialSafeContextBucket({
          text,
          matchedSignals: state.matchedSignals,
          negativeSignals: state.negativeSignals,
          hasCommercialHit: true,
        }),
      ).toBe(expectedBucket);
    }
  });

  it.each([
    'Ищу мастера по ремонту холодильника. Я работаю дома, мой телефон [phone].',
    'Кто ремонтирует холодильники? Я работаю дома, нужен мастер, бюджет до 5000 руб., мой телефон [phone].',
    'Подскажите магазин мебели, который предлагает доставку. Бюджет 50000 руб., мой телефон [phone].',
    'Подскажите, где в продаже есть мебель с доставкой. Бюджет 50000 руб., мой телефон [phone].',
    'Подскажите магазин мебели, где мы закажем диван с доставкой? Бюджет 50000 руб., мой телефон [phone].',
    'Подскажите, закажите мне диван с доставкой, бюджет 50000 руб., мой телефон [phone].',
    'Закажите мне диван с доставкой, бюджет 50000 руб., мой телефон [phone].',
  ])('keeps an attributed or buyer-side phrase inside a demand request: %s', (text) => {
    const state = collect(text);

    expect(
      deriveCommercialSafeContextBucket({
        text,
        matchedSignals: state.matchedSignals,
        negativeSignals: state.negativeSignals,
        hasCommercialHit: true,
      }),
    ).toBe('request_or_recommendation');
    expect(detect(text)).toBeNull();
  });

  it.each([
    'Кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб. Компания Чисто оказывает клининг от 5000 руб., звоните ей [phone].',
    'Кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб. Компания Чисто оказывает клининг от 5000 руб., звоните по их номеру [phone].',
    'Кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб. Компания Чисто оказывает клининг от 5000 руб., как вам цена?',
    'Кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб. Компания Чисто оказывает клининг, отзывы хорошие, их телефон [phone].',
  ])('keeps an attributed company service mention non-actionable: %s', (text) => {
    expect(detect(text)).toBeNull();
  });

  it('keeps a delivery request inside one sentence on the demand side', () => {
    const text = 'Можно доставку по всей России оформить на завтра?';
    const state = collect(text);

    expect(state.negativeSignals).toContain('search-pattern:request:delivery');
    expect(detect(text)).toBeNull();
  });

  it('allows a who-provides request whose wording contains generic service intent', () => {
    expect(
      detect(
        'Кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб., мой телефон [phone].',
      ),
    ).toBeNull();
  });

  it.each([
    'Подскажите мастера со скидкой на уборку, бюджет до 10000 руб., мой телефон [phone].',
    'Добрый день, подскажите мастера со скидкой на уборку, бюджет до 10000 руб., мой телефон [phone].',
    'Подскажите мастера со скидкой на уборку, у нас бюджет до 10000 руб., мой телефон [phone].',
    'Подскажите мастера: у нас бюджет до 10000 руб., нужна скидка, мой телефон [phone].',
  ])('keeps a buyer discount request on the demand side: %s', (text) => {
    const state = collect(text);

    expect(state.matchedSignals).toContain('promo:скидк');
    expect(
      deriveCommercialSafeContextBucket({
        text,
        matchedSignals: state.matchedSignals,
        negativeSignals: state.negativeSignals,
        hasCommercialHit: true,
      }),
    ).toBe('request_or_recommendation');
    expect(detect(text)).toBeNull();
  });

  it('keeps a greeted who-provides question on the demand side', () => {
    const text =
      'Всем добрый день! Подскажите, пожалуйста, кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб., мой телефон [phone].';
    const state = collect(text);

    expect(state.negativeSignals).toContain('search-pattern:request:who-provides-service');
    expect(detect(text)).toBeNull();
  });

  it('keeps a greeted where-to-buy request on the demand side', () => {
    const text =
      'Здравствуйте! Ищу, где купить мебель в наличии. Бюджет 50000 руб., пишите предложения мне [phone].';
    const state = collect(text);

    expect(state.negativeSignals).toContain('search-pattern:request:where-to-buy');
    expect(detect(text)).toBeNull();
  });

  it('does not protect a greeted furniture seller as a where-to-buy request', () => {
    const text =
      'Здравствуйте! У нас шкафы и диваны в наличии, цена от 20000 руб., доставка, звоните [phone].';
    const result = detect(text);

    expect(result?.actionBand).toBe('WARN');
    expect(result?.actionable).toBe(true);
  });

  it.each([
    'Кто занимается уборкой офисов? Мы убираем офисы каждый день, цена от 10000 руб., звоните [phone].',
    'Кто занимается установкой кондиционеров? Я устанавливаю под ключ, цена от 5000 руб., пишите в личку.',
    'Кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб. Мы оказываем клининг, цена от 5000 руб., звоните [phone].',
    'Кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб. Компания Чисто оказывает клининг от 5000 руб., звоните [phone].',
    'Кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб. Наша команда оказывает клининг от 5000 руб., звоните [phone].',
    'Кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб. ✅ А наша компания оказывает клининг от 5000 руб., пишите нам [phone].',
    'Кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб. ООО Чисто оказывает клининг от 5000 руб., звоните [phone].',
    'Кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб. Наша компания оказывает клининг. Цена от 5000 руб. Звоните [phone].',
    'Кто оказывает услуги клининга? Нужна команда, бюджет до 10000 руб. Компания Чисто оказывает клининг от 5000 руб. Звоните [phone].',
    'Кто устанавливает кондиционеры? Наша компания устанавливает их от 5000 руб., звоните [phone].',
    'Кто выполняет ремонт квартир? Наша команда выполняет ремонт от 7000 руб., пишите [phone].',
    'Кто оказывает услуги клининга? Наша компания предоставляет клининг от 5000 руб., звоните [phone].',
    'Кто оказывает услуги клининга? Наша компания занимается клинингом от 5000 руб., пишите [phone].',
    'Кто ремонтирует холодильники? Наша компания ремонтирует холодильники от 5000 руб., звоните [phone].',
  ])('preserves a source-side offer after a who-provides question: %s', (text) => {
    expect(['WARN', 'DELETE']).toContain(detect(text)?.actionBand);
  });

  it.each([
    'Нужен ремонт холодильника? Услуги мастера, цена 3000 руб., звоните [phone].',
    'Нужен юрист? Юридические услуги, консультация 3000 руб., звоните [phone].',
    'Нужен ремонт холодильника? Услуги мастера. Цена 3000 руб. Звоните [phone].',
    'Нужен юрист? Юридические услуги. Консультация 3000 руб., звоните [phone].',
  ])('preserves a paid service offer after a rhetorical question: %s', (text) => {
    const state = collect(text);

    expect(
      deriveCommercialSafeContextBucket({
        text,
        matchedSignals: state.matchedSignals,
        negativeSignals: state.negativeSignals,
        hasCommercialHit: true,
      }),
    ).toBe('none');
    expect(['WARN', 'DELETE']).toContain(detect(text)?.actionBand);
  });

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])(
    'preserves paid service offers after Unicode or repeated rhetorical questions in %s mode',
    (_label, settings) => {
      for (const text of [
        'Нужен юрист？ Юридические услуги, консультация 3000 руб., звоните [phone].',
        'Нужен ремонт? Холодильник сломался? Услуги мастера, цена 3000 руб., звоните [phone].',
      ]) {
        const result = detect(text, null, settings);

        expect(result?.safeContextBucket).toBe('none');
        expect(result?.actionBand).toBe('WARN');
        expect(result?.actionable).toBe(true);
      }
    },
  );

  it.each([
    'Нужен ремонт холодильника? Подскажите услуги мастера до 3000 руб., мой телефон [phone].',
    'Нужен юрист? Подскажите, где оказывают юридические услуги до 3000 руб., звоните мне [phone].',
    'Нужен юрист? Подскажите юридические услуги до 3000 руб., пишите предложения [phone].',
    'Нужен ремонт холодильника? Ищу услуги мастера до 3000 руб., звоните мастеру [phone].',
    'Нужен ремонт холодильника? Услуги мастера до 3000 руб., звоните по его номеру [phone].',
    'Нужен ремонт холодильника? Услуги мастера до 3000 руб., звоните по номеру из объявления [phone].',
    'Нужен ремонт холодильника? Услуги мастера до 3000 руб., пишите по контакту мастера [phone].',
    'Нужен ремонт холодильника? Услуги мастера до 3000 руб., обращайтесь к нему [phone].',
    'Кто оказывает услуги клининга? Ищу команду, бюджет 10000. Компания Чисто больше не оказывает услуги клининга. Раньше цена была 5000 руб. Не звоните по номеру [phone].',
  ])('keeps a buyer-side service follow-up non-actionable: %s', (text) => {
    const result = detect(text);

    expect(['ALLOW', 'REVIEW_ONLY']).toContain(result?.actionBand ?? 'ALLOW');
    expect(result?.actionable ?? false).toBe(false);
  });

  it('does not turn a public fundraising request into a source-side offer', () => {
    const text =
      'Снова сбор для бойцов на передовой: нужны автомобили и квадрокоптеры, общая сумма 1 500 000 рублей. Им больше не к кому обратиться. Вступайте в группу и переводите любой добровольный взнос по реквизитам [card]. Ссылка на группу [url].';
    const state = collect(text);

    expect(state.negativeSignals).toContain('search:к кому обратиться');
    expect(
      deriveCommercialSafeContextBucket({
        text,
        matchedSignals: state.matchedSignals,
        negativeSignals: state.negativeSignals,
        hasCommercialHit: true,
      }),
    ).toBe('request_or_recommendation');
    expect(['ALLOW', 'REVIEW_ONLY']).toContain(detect(text)?.actionBand ?? 'ALLOW');
  });

  it('does not hide a structured remote vacancy as ordinary job seeking', () => {
    const result = detect(
      'Девушки, кому нужна подработка и дополнительный доход, пишите. Работа удаленная, в вашем графике, легко совмещать, все официально. Подробности в MAX [phone].',
    );

    expect(result?.matchedSignals).toContain('recruitment:mixed-script-remote-vacancy');
    expect(result?.safeContextBucket).toBe('none');
    expect(result?.actionBand).toBe('WARN');
  });

  it('does not read the fuel abbreviation inside medtech wording', () => {
    const state = collect('По данным мониторинга, средняя цена на медтехнику выросла за неделю.');

    expect(state.negativeSignals).not.toContain('context:fuel-price-analysis');
  });

  it.each([
    'Сегодня обсуждали ремонт фасада. Телефон подрядчика +7 900 123-45-67.',
    'Ремонт кровли запланирован на август. Телефон подрядчика +7 900 123-45-67.',
    'Ремонт дома идет по графику. Телефон диспетчера +7 900 123-45-67.',
    'Ремонт холодильника уже завершен. Телефон мастера +7 900 123-45-67.',
    'Городские службы ведут ремонт кровли. Телефон диспетчера +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Городские службы начали ремонт фасада. Телефон диспетчера +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Городские службы приступили к ремонту дороги. Телефон диспетчера +7 900 123-45-67. Подписаться | Предложить новость [url].',
  ])('does not turn an informational service contact into campaign self-promotion: %s', (text) => {
    const result = detect(text, REPEATED_CAMPAIGN_CONTEXT);

    expect(['ALLOW', 'REVIEW_ONLY']).toContain(result?.actionBand ?? 'ALLOW');
  });

  it('does not let apparel sizing hide nationwide retail order flow', () => {
    const text =
      'Футболка турецкая, люкс качество, размер от 58 до 62. Доставка по всей России транспортной компанией, пишите в личку или звоните +7 900 000 00 05.';
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).toContain('private-goods:apparel-size');
    expect(state.matchedSignals).toContain('goods-retail:apparel-retail-order-flow');
    expect(result?.safeContextBucket).toBe('none');
    expect(result?.actionable).toBe(true);
  });

  it('keeps a single private apparel listing safe despite nationwide delivery', () => {
    const text =
      'Продам новое платье, размер 46. Отправка транспортной компанией по России, цена 5000 руб., телефон +7 900 000 00 06.';
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).toContain('private-goods:apparel-size');
    expect(state.matchedSignals).toContain('goods-retail:apparel-retail-order-flow');
    expect(result?.safeContextBucket).toBe('private_one_off_sale');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
    expect(result?.actionable).toBe(false);
  });

  it('does not treat one merchandising phrase as professional fulfillment', () => {
    const text =
      'Продам новое платье, размер 46, фабричное качество. Цена 5000 руб., телефон +7 900 000 00 10.';
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).toContain('private-goods:apparel-size');
    expect(state.matchedSignals).toContain('goods-retail:apparel-retail-order-flow');
    expect(result?.safeContextBucket).toBe('private_one_off_sale');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
    expect(result?.actionable).toBe(false);
  });

  it('keeps professional apparel retail actionable when the seller says продаю', () => {
    const text =
      'Продаю турецкие футболки, люкс качество, размер от 48 до 62. Доставка по России, цена 2500 руб., телефон +7 900 000 00 08.';
    const state = collect(text);
    const result = detect(text);

    expect(state.matchedSignals).toContain('intent:продаю');
    expect(state.matchedSignals).toContain('goods-retail:apparel-retail-order-flow');
    expect(state.negativeSignals).toContain('private-goods:apparel-size');
    expect(result?.safeContextBucket).toBe('none');
    expect(result?.actionable).toBe(true);
  });

  it('keeps a gifted unworn apparel listing private despite retail wording', () => {
    const text =
      'Продается новое платье, размер 46, подарили, но не ношу. Люкс качество, доставка по России транспортной компанией, цена 5000 руб., телефон +7 900 000 00 09.';
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).toEqual(
      expect.arrayContaining([
        'private-goods:apparel-size',
        'private-goods:private-apparel-personal-narrative',
      ]),
    );
    expect(state.matchedSignals).toContain('goods-retail:apparel-retail-order-flow');
    expect(result?.safeContextBucket).toBe('private_one_off_sale');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
    expect(result?.actionable).toBe(false);
  });

  it('keeps non-escalation marketplace wording inside an explicit used sale', () => {
    const text =
      'Продам свой диван б/у. На Авито есть карточка товара, цена 10000 руб., телефон +7 900 000 00 07.';
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).toEqual(
      expect.arrayContaining(['private:б/у', 'private-goods:furniture-single']),
    );
    expect(state.matchedSignals).toContain('risk:marketplace-seller');
    expect(result?.hasEscalationRiskEvidence).toBe(false);
    expect(result?.safeContextBucket).toBe('private_one_off_sale');
    expect(result?.actionBand).toBe('REVIEW_ONLY');
    expect(result?.actionable).toBe(false);
  });

  it('keeps an independent service offer actionable beside a fraud warning', () => {
    const text =
      'Осторожно: мошенники предлагают кредит без отказа. Не переводите им деньги. Отдельно: ремонт холодильников, цена 2000 руб., звоните +7 900 123-45-67.';
    const baseline = detect('Ремонт холодильников, цена 2000 руб., звоните +7 900 123-45-67.');
    const result = detect(text);

    expect(result?.safeContextBucket).toBe('none');
    expect(result?.analysisText).toContain('ремонт холодильников');
    expect(result?.matchedSignals).not.toContain('locality:escalation-offer');
    expect(result?.actionBand).toBe(baseline?.actionBand);
    expect(result?.actionable).toBe(true);
  });

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])(
    'does not turn a completed buyer search into an owned offer in %s mode',
    (_label, settings) => {
      const text =
        'Ищу поставщика клининга, бюджет до 10000 руб., предложения пишите мне [phone]. Но мы уже нашли.';

      expect(detect(text, null, settings)).toBeNull();
    },
  );

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])(
    'keeps an all-question third-party service inquiry non-actionable in %s mode',
    (_label, settings) => {
      const text =
        'Компания Чисто оказывает клининг? Цена от 3000 руб? Звоните в компанию Чисто [phone]?';

      expect(detect(text, null, settings)).toBeNull();
    },
  );

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])(
    'keeps natural third-party provider questions non-actionable in %s mode',
    (_label, settings) => {
      for (const text of [
        'Дорогие соседи, пожалуйста подскажите, компания Чисто оказывает клининг? Цена от 3000 руб. Их телефон [phone].',
        'Компания Чистота В Каждом Доме Плюс оказывает клининг? Цена от 3000 руб. Их телефон [phone].',
        'Фирма Чисто оказывает клининг? Цена от 3000 руб. Их телефон [phone].',
        'Сервис Чисто оказывает клининг? Цена от 3000 руб. Их телефон [phone].',
      ]) {
        expect(detect(text, null, settings)).toBeNull();
      }
    },
  );

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])(
    'does not turn a buyer price proposal into a source-side offer in %s mode',
    (_label, settings) => {
      const text =
        'Ищу поставщика цемента, бюджет до 50000, предложения пишите мне. Предлагаю цену 500 руб. за мешок, пишите мне [phone].';

      expect(detect(text, null, settings)).toBeNull();
    },
  );

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])('keeps a collective buyer price proposal non-actionable in %s mode', (_label, settings) => {
    const text =
      'Ищу поставщика цемента для нашей компании, бюджет до 50000, предложения пишите мне. Мы предлагаем цену 500 руб. за мешок, пишите мне [phone].';

    expect(detect(text, null, settings)).toBeNull();
  });

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])('does not treat buyer payment execution as a seller offer in %s mode', (_label, settings) => {
    const text =
      'Ищу поставщика цемента для нашей компании, бюджет до 50000, предложения пишите мне. Мы выполняем оплату по цене 500 руб. за мешок, пишите мне [phone].';

    expect(detect(text, null, settings)).toBeNull();
  });

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])('recognizes a manager-directed all-question inquiry in %s mode', (_label, settings) => {
    const text =
      'Компания Чисто оказывает клининг? Цена от 3000 руб? Пишите менеджеру компании Чисто [phone]?';

    expect(detect(text, null, settings)).toBeNull();
  });

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])(
    'keeps a manager-directed inquiry non-actionable with declarative follow-ups in %s mode',
    (_label, settings) => {
      const text =
        'Компания Чисто оказывает клининг? Цена от 3000 руб. Пишите менеджеру компании Чисто [phone].';

      expect(detect(text, null, settings)).toBeNull();
    },
  );

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])('keeps an all-question owned order offer actionable in %s mode', (_label, settings) => {
    for (const cta of [
      'Телефон для заказа [phone]?',
      'Запись по телефону [phone].',
      'Заявки по телефону [phone].',
      'Заказ по телефону [phone].',
      'Бронирование [phone].',
      'Телефон для записи [phone].',
    ]) {
      const text = `Компания Чисто оказывает клининг? Цена от 3000 руб. ${cta}`;

      expect(detect(text, null, settings)?.actionable).toBe(true);
    }
  });

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])(
    'keeps an independent offer after a third-party question actionable in %s mode',
    (_label, settings) => {
      for (const offer of [
        'Я продаю цемент по 500 руб., доставка, телефон [phone].',
        'Я продаю цемент по 500 руб., доставка, телефон [phone]?',
        'У нас мебель в наличии от 20000 руб., доставка, телефон [phone].',
        'У нас мебель в наличии от 20000 руб., доставка, телефон [phone]?',
        'Мы ремонтируем холодильники от 3000 руб., телефон [phone].',
        'Мы ремонтируем холодильники от 3000 руб., телефон [phone]?',
      ]) {
        const result = detect(`Компания Чисто оказывает клининг? ${offer}`, null, settings);
        const baseline = detect(offer, null, settings);

        expect(baseline?.actionable).toBe(true);
        expect(result?.actionBand).toBe(baseline?.actionBand);
        expect(result?.actionable).toBe(true);
      }
    },
  );

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])(
    'keeps an independent offer before a third-party question actionable in %s mode',
    (_label, settings) => {
      for (const offer of [
        'Я продаю цемент по 500 руб., доставка, телефон [phone].',
        'У нас мебель в наличии от 20000 руб., доставка, телефон [phone].',
        'Мы ремонтируем холодильники от 3000 руб., телефон [phone].',
      ]) {
        const result = detect(`${offer} Компания Чисто оказывает клининг?`, null, settings);
        const baseline = detect(offer, null, settings);

        expect(baseline?.actionable).toBe(true);
        expect(result?.actionBand).toBe(baseline?.actionBand);
        expect(result?.actionable).toBe(true);
      }
    },
  );

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])('ignores an unrelated CTA around a third-party inquiry in %s mode', (_label, settings) => {
    const inquiry = 'Компания Чисто оказывает клининг? Цена от 3000 руб. Их телефон [phone].';
    for (const text of [
      `По вопросам собрания звоните мне [phone]. ${inquiry}`,
      `Телефон для записи к врачу [phone]. ${inquiry}`,
      `Закажите пропуск у охраны [url]. ${inquiry}`,
      `Справочная: обращайтесь к секретарю [phone]. ${inquiry}`,
      `${inquiry} По вопросам собрания звоните мне [phone].`,
    ]) {
      expect(detect(text, null, settings)).toBeNull();
    }
  });

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])(
    'keeps an attributed phone after a third-party question non-actionable in %s mode',
    (_label, settings) => {
      const text = 'Компания Чисто оказывает клининг? Цена от 3000 руб. Их телефон [phone].';

      expect(detect(text, null, settings)).toBeNull();
    },
  );

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])(
    'keeps a negated response CTA inside a third-party inquiry non-actionable in %s mode',
    (_label, settings) => {
      const text = 'Компания Чисто оказывает клининг? Цена от 3000 руб. Не звоните [phone].';

      expect(detect(text, null, settings)).toBeNull();
    },
  );

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])('carries buyer terms through a third-party inquiry in %s mode', (_label, settings) => {
    for (const text of [
      'Компания Чисто оказывает клининг? Мой бюджет 3000 руб. Предложения пишите мне [phone].',
      'Компания Чисто оказывает клининг? Цена до 3000 руб. Пишите мне [phone].',
      'Компания Чисто оказывает клининг? Я предлагаю оплату 3000 руб. Пишите мне [phone].',
    ]) {
      expect(detect(text, null, settings)).toBeNull();
    }
  });

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])(
    'ignores non-order response purposes after a third-party inquiry in %s mode',
    (_label, settings) => {
      for (const text of [
        'Компания Чисто оказывает клининг? Цена от 3000 руб. По жалобам на компанию пишите мне [phone].',
        'Компания Чисто оказывает клининг? Цена от 3000 руб. Для исследования цен пишите мне [phone].',
        'Компания Чисто оказывает клининг? Цена от 3000 руб. Для протокола собрания пишите мне [phone].',
        'Компания Чисто оказывает клининг? Цена от 3000 руб. Для архива отзывов пишите мне [phone].',
      ]) {
        expect(detect(text, null, settings)).toBeNull();
      }
    },
  );

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])(
    'keeps an explicit order CTA actionable after an attributed inquiry in %s mode',
    (_label, settings) => {
      const text =
        'Компания Чисто оказывает клининг? Цена от 3000 руб. Их телефон [phone]. Закажите уборку [url].';

      expect(detect(text, null, settings)?.actionable).toBe(true);
    },
  );

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])(
    'keeps a bounded service-detail sequence connected to its CTA in %s mode',
    (_label, settings) => {
      const text =
        'Компания Чисто оказывает клининг? Цена от 3000 руб. Выезд по городу. Гарантия качества. Закажите уборку [url].';

      expect(detect(text, null, settings)?.actionable).toBe(true);
    },
  );

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])(
    'does not suppress an all-question service offer with an explicit CTA in %s mode',
    (_label, settings) => {
      const text =
        'Нужна уборка? Компания Чисто оказывает клининг? Цена от 3000 руб? Закажите уборку [url]?';

      expect(detect(text, null, settings)?.actionable).toBe(true);
    },
  );

  it.each([
    ['strict', STRICT_SETTINGS],
    ['balanced', BALANCED_SETTINGS],
  ])(
    'keeps an owned delivery offer after a rhetorical request actionable in %s mode',
    (_label, settings) => {
      const text =
        'Нужна доставка цемента? Мы доставляем круглосуточно, цена 5000 руб., пишите мне [phone].';

      expect(detect(text, null, settings)?.actionable).toBe(true);
    },
  );

  it('keeps an explicit source-side offer after a buyer request actionable', () => {
    const text =
      'Ищу поставщика цемента, бюджет до 10000 руб., предложения пишите мне [phone]. Но мы сами продаем цемент по 865 руб., звоните [phone].';

    expect(detect(text)?.actionable).toBe(true);
  });

  it('does not extract a topic marker from Russian secondary quotes', () => {
    const text =
      'Редакция цитирует пример рекламы: „Новости магазина. Отдельно: кредит онлайн без отказа, оставьте заявку [url]“. Это цитата, не предложение.';

    expect(detect(text)).toBeNull();
  });

  it('keeps an offer after a closed Russian secondary quote actionable', () => {
    const text =
      'Редакция цитирует продавца: „Продаем мебель, звоните [phone]“. Это цитата, не предложение. Отдельно: ремонт холодильников, цена 2000 руб., звоните [phone].';

    expect(detect(text)?.actionable).toBe(true);
  });

  it('keeps a repeated custom-forging offer at warn', () => {
    const text =
      'Кованая роза, цена 700 рублей за штуку. Могу изготовить букеты в любом количестве, по вопросам обращаться в лс.';
    const result = detect(text, REPEATED_CAMPAIGN_CONTEXT);

    expect(result?.matchedSignals).toContain('service-specialty:custom-forged-flower');
    expect(result?.matchedSignals).not.toContain('goods-retail:structured-retail-review');
    expect(result?.actionBand).toBe('WARN');
  });

  it('allows a repeated free community exercise invitation', () => {
    const text =
      '🎉 Приглашаю на утреннюю зарядку! 🎉 Завтра в 8:30 вместе встретим день с пользой. Легкий комплекс упражнений поможет проснуться. Присоединяйтесь, будет здорово! #зарядка #ЗОЖ';
    const state = collect(text, REPEATED_CAMPAIGN_CONTEXT);

    expect(state.negativeSignals).toContain('context:public-training-or-event');
    expect(
      deriveCommercialSafeContextBucket({
        text,
        matchedSignals: state.matchedSignals,
        negativeSignals: state.negativeSignals,
        hasCommercialHit: true,
      }),
    ).toBe('public_training_or_help');
    expect(detect(text, REPEATED_CAMPAIGN_CONTEXT)).toBeNull();
  });

  it('does not hide a paid community exercise offer', () => {
    const text =
      'Фитнес-студия приглашает на утреннюю зарядку. Стоимость занятия 500 руб., запись по телефону +7 900 000 00 01.';
    const state = collect(text);

    expect(state.negativeSignals).not.toContain('context:public-training-or-event');
    expect(detect(text)).not.toBeNull();
  });

  it.each([
    [
      'animal boarding collection',
      'ПОМОГИТЕ ОПЛАТИТЬ ПЕРЕДЕРЖКУ для спасенной собаки Юны. Стоимость передержки 7500 руб. в месяц. Сбор на Сбербанк с пометкой "Юна пожертвование" по номеру [phone].',
      'public_training_or_help',
    ],
    [
      'shelter treatment debt collection',
      'В приюте остаются 84 собаки и 27 кошек. У приюта накопился долг перед клиникой за лечение животных и корм. МЫ ОЧЕНЬ ПРОСИМ ПОМОЩИ. Нужно закрыть долг, реквизиты для пожертвований: Сбербанк, перевод по номеру [phone].',
      'public_training_or_help',
    ],
    [
      'long-form local incident report',
      'Смерч повредил бетонные ограждения и кровлю нескольких домов, сообщили очевидцы. Городские службы начали устранять последствия. На время ремонта опасный участок огородили. Специалисты обследовали поврежденные конструкции, убрали упавшие ветки, восстановили электроснабжение и проверили опоры. После завершения обследования доступ откроют в обычном режиме. Пострадавших нет, обстановка находится под контролем. Подписаться | Предложить новость [url] [url]',
      'news_or_analytics',
    ],
  ])('derives a safe context for an audited %s', (_label, text, bucket) => {
    const state = collect(text);

    expect(state.negativeSignals).toContain(
      bucket === 'news_or_analytics'
        ? 'context:local-news-subscribe'
        : 'context:public-help-request',
    );
    expect(
      deriveCommercialSafeContextBucket({
        text,
        matchedSignals: state.matchedSignals,
        negativeSignals: state.negativeSignals,
        hasCommercialHit: true,
      }),
    ).toBe(bucket);
    expect(['ALLOW', 'REVIEW_ONLY']).toContain(detect(text)?.actionBand ?? 'ALLOW');
  });

  it('does not hide breeder retail behind charity wording', () => {
    const text =
      'Питомник предлагает породистого щенка. Щенок ищет семью, цена 50 000 руб., открыта бронь. Телефон [phone]. Просим помочь оплатить передержку переводом по номеру [phone].';
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).not.toContain('context:public-help-request');
    expect(result?.safeContextBucket).toBe('none');
    expect(['WARN', 'DELETE', 'DELETE_AND_ESCALATE']).toContain(result?.actionBand);
  });

  it.each([
    'Нужна помощь питомцу? Ветеринарная клиника проводит лечение и операции. Запись по номеру [phone], стоимость 2000 руб.',
    'Компания предлагает передержку собак с ежедневным уходом. Стоимость 1500 руб. в сутки, запись по номеру [phone].',
  ])('requires a donation anchor before suppressing a paid animal service: %s', (text) => {
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).not.toContain('context:public-help-request');
    expect(result).not.toBeNull();
    expect(result?.safeContextBucket).toBe('none');
    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
  });

  it('does not derive editorial safety from a service CTA with a copied news footer', () => {
    const text =
      'СТРОИТЕЛЬНАЯ БРИГАДА: кровля, фасады и ремонт квартир под ключ. Пенсионерам скидка 15%, звоните [phone]. Компания сообщила, что городские службы рекомендуют наш сервис. Подписаться | Предложить новость [url].';
    const state = collect(text);

    expect(state.matchedSignals).toContain('intent:строительная-бригада');
    expect(state.negativeSignals).not.toContain('context:local-news-subscribe');
  });

  it('does not derive editorial safety from a structured service offer with a phone', () => {
    const text =
      'Компания СтройПроф выполняет ремонт кровли и фасадов. Телефон +7 900 123-45-67. Подписаться | Предложить новость [url].';
    const state = collect(text);
    const result = detect(text);

    expect(state.matchedSignals).toContain('intent:выполняем-работы');
    expect(state.matchedSignals).toContain('contact:phone');
    expect(state.negativeSignals).not.toContain('context:local-news-subscribe');
    expect(result).not.toBeNull();
  });

  it.each([
    'Администрация сообщила, что подрядчик выполняет ремонт кровли и фасадов. Телефон диспетчера +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'МЧС сообщило, что оперативный штаб выполняет восстановительные работы. Телефон штаба +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Власти сообщили, что подрядчик выполняет ремонт кровли и фасадов. Номер подрядчика +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Городские службы рассказали, что подрядчик выполняет ремонт фасадов. Телефон подрядной организации +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Администрация сообщает, что подрядчик выполняет ремонт кровли. Телефон подрядчика +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Городские службы выполняют ремонт кровли и фасадов. Телефон диспетчера +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Администрация сообщает, что подрядчик выполняет ремонт кровли. По вопросам звоните на горячую линию +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Администрация сообщает, что подрядчик выполняет ремонт кровли, по вопросам звоните на горячую линию +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Городские службы ведут ремонт кровли. По вопросам звоните диспетчеру +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Городские службы проводят работы по ремонту фасада. Телефон диспетчера +7 900 123-45-67. Подписаться | Предложить новость [url].',
  ])('keeps an attributed public-service report editorial: %s', (text) => {
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).toContain('context:local-news-subscribe');
    expect(['ALLOW', 'REVIEW_ONLY']).toContain(result?.actionBand ?? 'ALLOW');
  });

  it.each([
    'Мы подрядчик администрации: выполняем ремонт квартир и кровли. Телефон диспетчера +7 900 123-45-67. Подписаться | Предложить новость [url].',
    'Компания СтройПроф выполняет ремонт квартир и кровли. Телефон диспетчера +7 900 123-45-67. Городские службы сообщили о завершении работ. Подписаться | Предложить новость [url].',
  ])('does not join unrelated official wording to hide a service advertisement: %s', (text) => {
    const state = collect(text);
    const result = detect(text);

    expect(state.negativeSignals).not.toContain('context:local-news-subscribe');
    expect(result).not.toBeNull();
    expect(['WARN', 'DELETE']).toContain(result?.actionBand);
  });

  it.each([
    [
      'humanitarian aid',
      'Мы обращаемся к жителям за гуманитарной и материальной помощью для наших ребят. Нужны медикаменты и теплые вещи; гуманитарную помощь можно приносить в ДК.',
      'context:public-help-request',
      'public_training_or_help',
    ],
    [
      'fire donation appeal',
      'В нашей семье произошел пожар, дом и все имущество уничтожены. Кто чем может помочь, любая помощь важна. Помощь погорельцам: [phone].',
      'context:public-help-request',
      'public_training_or_help',
    ],
    [
      'long public scam warning',
      'Сейчас массово применяют новую схему мошенничества, ориентированную на детей и подростков. Им звонят под видом сотрудников ФСБ или МВД. Поговорите со своими детьми и объясните, что силовые структуры никогда не вовлекают детей в операции.',
      'context:public-fraud-warning',
      'spam_complaint_or_fraud_warning',
    ],
    [
      'pet giveaway',
      'Возможно, ваш ребенок мечтал о котенке. Спасенная кошка родила котят, все игривые и ласковые. Пишите в лс.',
      'context:animal-adoption',
      'request_or_recommendation',
    ],
    [
      'fuel news analysis',
      'Правительство разрешило выпускать топливо класса К5 с характеристиками Евро-3. Что изменилось: выросло содержание серы и присадок. Чем это грозит автомобилю: износом двигателя и катализатора.',
      'context:fuel-availability-report',
      'news_or_analytics',
    ],
    [
      'fuel price analysis',
      'По данным еженедельного мониторинга, средняя цена бензина АИ-95 выросла на 1,2 процента, а стоимость дизельного топлива снизилась на 0,4 процента. Подписаться на новости [url].',
      'context:fuel-price-analysis',
      'news_or_analytics',
    ],
  ])('derives a safe context for %s', (_label, text, negativeSignal, bucket) => {
    const state = collect(text);

    expect(state.negativeSignals).toContain(negativeSignal);
    expect(
      deriveCommercialSafeContextBucket({
        text,
        matchedSignals: state.matchedSignals,
        negativeSignals: state.negativeSignals,
        hasCommercialHit: true,
      }),
    ).toBe(bucket);
  });
});
